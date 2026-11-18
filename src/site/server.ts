/** Deterministic mock assay-report site with dynamic signatures and one-time paging tokens. */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ALGORITHM_HEADER,
  NONCE_HEADER,
  RETRY_AFTER_MS_HEADER,
  SESSION_HEADER,
  SIGNATURE_ALGORITHM,
  SIGNATURE_HEADER,
  SNAPSHOT_HEADER,
  computeSignature,
} from "../shared/protocol.js";
import type { Layout } from "../shared/types.js";
import { REPORT_NOS, buildReport, type ReportSeed } from "./content.js";
import {
  appendixPageCount,
  renderAppendixPage,
  renderBodyPage,
  renderErrorPage,
  renderIndex,
  splitPages,
} from "./render.js";

type LayoutMode = "mixed" | Layout;
type FaultType =
  | "rateLimit"
  | "banSession"
  | "dropResponse"
  | "delay"
  | "corruptReport"
  | "unavailableReport";

interface Fault {
  type: FaultType;
  /** Optional substring the request path must contain. */
  matchPath?: string;
  /** How many matching requests the fault applies to (default 1). */
  times?: number;
  /** Remaining applications; initialised from `times`. */
  remaining?: number;
  retryAfterMs?: number;
  /** Delay in milliseconds for type === "delay". */
  ms?: number;
  reportNo?: string;
}

interface Snapshot {
  id: string;
  sequence: number;
  createdAt: string;
  revisions: Record<string, number>;
  layoutMode: LayoutMode;
}

interface TokenRecord {
  token: string;
  sessionId: string;
  reportNo: string;
  page: number;
  used: boolean;
}

interface SiteSession {
  id: string;
  nonce: string;
  snapshotId: string;
  banned: boolean;
  createdAt: string;
  signedRequests: number;
}

interface RequestLogEntry {
  at: string;
  method: string;
  url: string;
  status: number;
  sessionId: string | null;
  snapshotId: string | null;
  note: string;
}

export interface SiteOptions {
  /** Fixed port; 0 picks an ephemeral port. */
  port?: number;
  host?: string;
  seedSnapshot?: { layoutMode?: LayoutMode; revisions?: Record<string, number> };
}

export interface SiteHandle {
  url: string;
  port: number;
  server: Server;
  close(): Promise<void>;
  state(): {
    currentSnapshot: string;
    snapshots: Snapshot[];
    sessions: Array<{ id: string; snapshotId: string; banned: boolean; signedRequests: number }>;
    requests: RequestLogEntry[];
    faults: Fault[];
  };
}

const SESSION_LIMIT = 500;
const REQUEST_LOG_LIMIT = 2_000;

export class MockAssaySite {
  private readonly server: Server;
  private readonly snapshots: Snapshot[] = [];
  private currentSnapshotId = "";
  private readonly sessions = new Map<string, SiteSession>();
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly faults: Fault[] = [];
  private readonly requests: RequestLogEntry[] = [];
  private signedCounter = 0;
  private readonly corruptedReports = new Map<string, number>();
  private readonly unavailableReports = new Map<string, number>();

  private constructor(seed?: SiteOptions["seedSnapshot"]) {
    const layoutMode = seed?.layoutMode ?? "mixed";
    const revisions: Record<string, number> = {};
    for (const reportNo of REPORT_NOS) revisions[reportNo] = seed?.revisions?.[reportNo] ?? 1;
    const first: Snapshot = {
      id: "snap-0001",
      sequence: 1,
      createdAt: new Date(0).toISOString(),
      revisions,
      layoutMode,
    };
    this.snapshots.push(first);
    this.currentSnapshotId = first.id;
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  static async start(options: SiteOptions = {}): Promise<SiteHandle> {
    const site = new MockAssaySite(options.seedSnapshot);
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 0;
    await new Promise<void>((resolve, reject) => {
      site.server.once("error", reject);
      site.server.listen(port, host, () => resolve());
    });
    const address = site.server.address() as AddressInfo;
    const url = `http://${host}:${address.port}`;
    return {
      url,
      port: address.port,
      server: site.server,
      close: () => site.close(),
      state: () => ({
        currentSnapshot: site.currentSnapshotId,
        snapshots: site.snapshots.map((snapshot) => ({ ...snapshot, revisions: { ...snapshot.revisions } })),
        sessions: [...site.sessions.values()].map((session) => ({
          id: session.id,
          snapshotId: session.snapshotId,
          banned: session.banned,
          signedRequests: session.signedRequests,
        })),
        requests: site.requests.map((entry) => ({ ...entry })),
        faults: site.faults.map((fault) => ({ ...fault })),
      }),
    };
  }

  private close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private snapshotById(id: string): Snapshot | undefined {
    return this.snapshots.find((snapshot) => snapshot.id === id);
  }

  private currentSnapshot(): Snapshot {
    return this.snapshotById(this.currentSnapshotId)!;
  }

  private log(entry: Omit<RequestLogEntry, "at">): void {
    this.requests.push({ at: new Date().toISOString(), ...entry });
    if (this.requests.length > REQUEST_LOG_LIMIT) this.requests.splice(0, this.requests.length - REQUEST_LOG_LIMIT);
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
    res.end(body);
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://site.local");
    const path = url.pathname;
    try {
      const delayFault = this.faults.find(
        (fault) => fault.type === "delay" && (!fault.matchPath || path.includes(fault.matchPath)),
      );
      if (delayFault) {
        delayFault.remaining = (delayFault.remaining ?? 1) - 1;
        if (delayFault.remaining <= 0) this.faults.splice(this.faults.indexOf(delayFault), 1);
        await new Promise((resolve) => setTimeout(resolve, delayFault.ms ?? 500));
      }
      if (path === "/healthz") {
        this.sendJson(res, 200, { ok: true, snapshot: this.currentSnapshotId });
        return;
      }
      if (path.startsWith("/__control/")) {
        await this.handleControl(req, res, path, url);
        return;
      }
      if (path === "/reports" || path === "/reports/") {
        this.handleIndex(req, res, url);
        return;
      }
      const appendixMatch = /^\/reports\/([^/]+)\/appendix\/(\d+)$/.exec(path);
      if (appendixMatch && req.method === "GET") {
        this.handleAppendix(req, res, url, decodeURIComponent(appendixMatch[1]!), Number(appendixMatch[2]));
        return;
      }
      const reportMatch = /^\/reports\/([^/]+)$/.exec(path);
      if (reportMatch && req.method === "GET") {
        this.handleBody(req, res, url, decodeURIComponent(reportMatch[1]!));
        return;
      }
      this.log({ method: req.method ?? "GET", url: req.url ?? "", status: 404, sessionId: null, snapshotId: null, note: "not_found" });
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end(renderErrorPage("页面不存在", "请求的页面不存在。"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        this.sendJson(res, 500, { error: "internal_error", message });
      } else {
        res.end();
      }
    }
  }

  /** Bootstrap: always issues a fresh session (optionally pinned to a historical snapshot). */
  private handleIndex(req: IncomingMessage, res: ServerResponse, url: URL): void {
    // The directory is also the signed-request entry point. The collector
    // re-enters it with a pinned snapshot while holding a live session; that
    // request must still prove the session and consume its nonce.
    if (req.headers[SESSION_HEADER]) {
      const auth = this.authenticate(req, res, url);
      if (!auth) return;
      if (auth.dropResponse) {
        this.dropResponse(req, res, auth.session, auth.snapshot);
        return;
      }
      const snapshot = auth.snapshot;
      const html = renderIndex(snapshot.id, snapshot.revisions);
      this.log({ method: req.method ?? "GET", url: req.url ?? "", status: 200, sessionId: auth.session.id, snapshotId: snapshot.id, note: "index" });
      this.respondHtml(res, html, auth.session, snapshot);
      return;
    }
    const requested = url.searchParams.get("snapshot") ?? undefined;
    const snapshot = requested ? this.snapshotById(requested) : this.currentSnapshot();
    if (!snapshot) {
      this.log({ method: req.method ?? "GET", url: req.url ?? "", status: 404, sessionId: null, snapshotId: null, note: "unknown_snapshot" });
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end(renderErrorPage("快照不存在", `未找到历史快照 ${requested ?? ""}。`));
      return;
    }
    const session = this.createSession(snapshot.id);
    const html = renderIndex(snapshot.id, snapshot.revisions);
    this.log({ method: req.method ?? "GET", url: req.url ?? "", status: 200, sessionId: session.id, snapshotId: snapshot.id, note: "index" });
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      [SESSION_HEADER]: session.id,
      [NONCE_HEADER]: session.nonce,
      [SNAPSHOT_HEADER]: snapshot.id,
      [ALGORITHM_HEADER]: SIGNATURE_ALGORITHM,
    });
    res.end(html);
  }

  private createSession(snapshotId: string): SiteSession {
    const session: SiteSession = {
      id: `sess_${randomBytes(9).toString("hex")}`,
      nonce: randomBytes(18).toString("hex"),
      snapshotId,
      banned: false,
      createdAt: new Date().toISOString(),
      signedRequests: 0,
    };
    this.sessions.set(session.id, session);
    if (this.sessions.size > SESSION_LIMIT) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    return session;
  }

  private rotateNonce(session: SiteSession): void {
    session.nonce = randomBytes(18).toString("hex");
  }

  /**
   * Validates session + one-time nonce + signature. Returns null when the
   * request is acceptable, otherwise an error response description.
   */
  private authenticate(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): { session: SiteSession; snapshot: Snapshot; dropResponse: boolean } | null {
    this.signedCounter += 1;
    const fault = this.takeFault(url.pathname);

    const sessionHeader = req.headers[SESSION_HEADER];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;

    if (fault?.type === "rateLimit") {
      const retryAfterMs = fault.retryAfterMs ?? 100;
      this.sendJson(
        res,
        429,
        { error: "rate_limited", message: "请求过于频繁，请按提示重试。", retryAfterMs },
        {
          [RETRY_AFTER_MS_HEADER]: String(retryAfterMs),
          "retry-after": String(Math.ceil(retryAfterMs / 1000)),
          [SNAPSHOT_HEADER]: session?.snapshotId ?? "",
        },
      );
      this.log({ method: req.method ?? "GET", url: req.url ?? "", status: 429, sessionId: session?.id ?? null, snapshotId: session?.snapshotId ?? null, note: "fault_rate_limit" });
      return null;
    }

    if (!session) {
      this.sendJson(res, 401, { error: "unknown_session", message: "会话无效，请重新进入目录。" });
      this.log({ method: req.method ?? "GET", url: req.url ?? "", status: 401, sessionId: null, snapshotId: null, note: "unknown_session" });
      return null;
    }

    const snapshot = this.snapshotById(session.snapshotId);
    if (!snapshot) {
      this.sendJson(res, 410, { error: "snapshot_gone", message: "会话绑定的快照已不可用。" });
      this.log({ method: req.method ?? "GET", url: req.url ?? "", status: 410, sessionId: session.id, snapshotId: session.snapshotId, note: "snapshot_gone" });
      return null;
    }

    if (fault?.type === "banSession") {
      session.banned = true;
      this.sendJson(res, 403, { error: "session_banned", message: "会话已被封禁，请重新建立会话。" }, {
        [SNAPSHOT_HEADER]: session.snapshotId,
      });
      this.log({ method: req.method ?? "GET", url: req.url ?? "", status: 403, sessionId: session.id, snapshotId: session.snapshotId, note: "fault_ban_session" });
      return null;
    }

    if (session.banned) {
      this.sendJson(res, 403, { error: "session_banned", message: "会话已被封禁，请重新建立会话。" });
      this.log({ method: req.method ?? "GET", url: req.url ?? "", status: 403, sessionId: session.id, snapshotId: session.snapshotId, note: "session_banned" });
      return null;
    }

    const nonceHeader = req.headers[NONCE_HEADER];
    const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;
    const sigHeader = req.headers[SIGNATURE_HEADER];
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;

    if (!nonce || !signature) {
      this.sendJson(res, 401, { error: "signature_required", message: "缺少会话签名。" });
      this.log({ method: req.method ?? "GET", url: req.url ?? "", status: 401, sessionId: session.id, snapshotId: session.snapshotId, note: "missing_signature" });
      return null;
    }

    const expectedNonce = session.nonce;
    const expectedSignature = computeSignature(session.id, expectedNonce, req.method ?? "GET", req.url ?? "/");
    const nonceOk = safeEqual(nonce, expectedNonce);
    const signatureOk = safeEqual(signature, expectedSignature);
    if (!nonceOk || !signatureOk) {
      this.sendJson(res, 401, { error: "bad_signature", message: "签名校验失败或凭证已过期。" });
      this.log({ method: req.method ?? "GET", url: req.url ?? "", status: 401, sessionId: session.id, snapshotId: session.snapshotId, note: "bad_signature" });
      return null;
    }

    // A valid request consumes the nonce: the next request must use the nonce
    // returned by this response.
    this.rotateNonce(session);
    session.signedRequests += 1;

    // A dropped response simulates the server accepting and processing the
    // request, then losing the connection before any bytes reach the client.
    // The nonce (and, for appendix pages, the paging token) is consumed.
    return { session, snapshot, dropResponse: fault?.type === "dropResponse" };
  }

  /** Log the request as accepted, then destroy the socket without a response. */
  private dropResponse(
    req: IncomingMessage,
    res: ServerResponse,
    session: SiteSession,
    snapshot: Snapshot,
  ): void {
    this.log({ method: req.method ?? "GET", url: req.url ?? "", status: 0, sessionId: session.id, snapshotId: snapshot.id, note: "fault_drop_response" });
    setTimeout(() => {
      res.socket?.destroy();
    }, 5);
  }

  private takeFault(pathname: string): Fault | null {
    const index = this.faults.findIndex(
      (fault) => fault.type !== "corruptReport" && (!fault.matchPath || pathname.includes(fault.matchPath)),
    );
    if (index < 0) return null;
    const fault = this.faults[index]!;
    fault.remaining = (fault.remaining ?? 1) - 1;
    if (fault.remaining <= 0) this.faults.splice(index, 1);
    return fault;
  }

  private handleBody(req: IncomingMessage, res: ServerResponse, url: URL, reportNo: string): void {
    const auth = this.authenticate(req, res, url);
    if (!auth) return;
    const { session, snapshot } = auth;
    const revision = snapshot.revisions[reportNo];
    if (revision === undefined) {
      this.sendJson(res, 404, { error: "report_not_found", message: `报告 ${reportNo} 不在当前快照中。` }, {
        [SNAPSHOT_HEADER]: snapshot.id,
        [NONCE_HEADER]: session.nonce,
      });
      this.log({ method: "GET", url: req.url ?? "", status: 404, sessionId: session.id, snapshotId: snapshot.id, note: "report_not_in_snapshot" });
      return;
    }

    const unavailableRemaining = this.unavailableReports.get(reportNo) ?? 0;
    if (unavailableRemaining > 0) {
      if (unavailableRemaining === 1) this.unavailableReports.delete(reportNo);
      else this.unavailableReports.set(reportNo, unavailableRemaining - 1);
      this.sendJson(res, 404, { error: "report_unavailable", message: `报告 ${reportNo} 在该快照中暂不可用。` }, {
        [SNAPSHOT_HEADER]: snapshot.id,
        [NONCE_HEADER]: session.nonce,
      });
      this.log({ method: "GET", url: req.url ?? "", status: 404, sessionId: session.id, snapshotId: snapshot.id, note: "fault_unavailable" });
      return;
    }

    const corruptRemaining = this.corruptedReports.get(reportNo) ?? 0;
    if (corruptRemaining > 0) {
      if (corruptRemaining === 1) this.corruptedReports.delete(reportNo);
      else this.corruptedReports.set(reportNo, corruptRemaining - 1);
      const html = renderErrorPage(`${reportNo} 报告正文`, "内容暂时无法提供。");
      this.log({ method: "GET", url: req.url ?? "", status: 200, sessionId: session.id, snapshotId: snapshot.id, note: "fault_corrupt" });
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        [SESSION_HEADER]: session.id,
        [NONCE_HEADER]: session.nonce,
        [SNAPSHOT_HEADER]: snapshot.id,
      });
      res.end(html);
      return;
    }

    const report = buildReport(reportNo, revision);
    const pages = splitPages(report);
    const bodySamples = pages[0]!;
    const token = this.issueToken(session, reportNo, 1);
    const appendixHref =
      pages.length > 1 ? `/reports/${encodeURIComponent(reportNo)}/appendix/1?token=${token.token}` : null;
    const html = this.renderForSnapshot(snapshot, report, (layoutReport) =>
      renderBodyPage(layoutReport, snapshot.id, bodySamples, appendixHref),
    );
    if (auth.dropResponse) {
      this.dropResponse(req, res, session, snapshot);
      return;
    }
    this.log({ method: "GET", url: req.url ?? "", status: 200, sessionId: session.id, snapshotId: snapshot.id, note: "report_body" });
    this.respondHtml(res, html, session, snapshot);
  }

  private handleAppendix(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    reportNo: string,
    page: number,
  ): void {
    const auth = this.authenticate(req, res, url);
    if (!auth) return;
    const { session, snapshot } = auth;

    const tokenValue = url.searchParams.get("token");
    if (!tokenValue) {
      this.sendJson(res, 400, { error: "token_required", message: "缺少翻页凭证。" }, {
        [SNAPSHOT_HEADER]: snapshot.id,
        [NONCE_HEADER]: session.nonce,
      });
      this.log({ method: "GET", url: req.url ?? "", status: 400, sessionId: session.id, snapshotId: snapshot.id, note: "token_required" });
      return;
    }
    const record = this.tokens.get(tokenValue);
    if (!record || record.sessionId !== session.id) {
      this.sendJson(res, 403, { error: "bad_token", message: "翻页凭证无效或不属于当前会话。" }, {
        [SNAPSHOT_HEADER]: snapshot.id,
        [NONCE_HEADER]: session.nonce,
      });
      this.log({ method: "GET", url: req.url ?? "", status: 403, sessionId: session.id, snapshotId: snapshot.id, note: "bad_token" });
      return;
    }
    if (record.used) {
      this.sendJson(res, 409, { error: "token_replayed", message: "翻页凭证已使用，仅限一次性。" }, {
        [SNAPSHOT_HEADER]: snapshot.id,
        [NONCE_HEADER]: session.nonce,
      });
      this.log({ method: "GET", url: req.url ?? "", status: 409, sessionId: session.id, snapshotId: snapshot.id, note: "token_replayed" });
      return;
    }
    if (record.reportNo !== reportNo || record.page !== page) {
      this.sendJson(res, 403, { error: "bad_token", message: "翻页凭证与请求页面不匹配。" }, {
        [SNAPSHOT_HEADER]: snapshot.id,
        [NONCE_HEADER]: session.nonce,
      });
      this.log({ method: "GET", url: req.url ?? "", status: 403, sessionId: session.id, snapshotId: snapshot.id, note: "bad_token_page" });
      return;
    }
    record.used = true;

    const revision = snapshot.revisions[reportNo];
    if (revision === undefined) {
      this.sendJson(res, 404, { error: "report_not_found", message: `报告 ${reportNo} 不在当前快照中。` }, {
        [SNAPSHOT_HEADER]: snapshot.id,
        [NONCE_HEADER]: session.nonce,
      });
      this.log({ method: "GET", url: req.url ?? "", status: 404, sessionId: session.id, snapshotId: snapshot.id, note: "report_not_in_snapshot" });
      return;
    }

    const report = buildReport(reportNo, revision);
    const pages = splitPages(report);
    const pageSamples = pages[page];
    if (page < 1 || page > appendixPageCount(report) || !pageSamples) {
      this.sendJson(res, 404, { error: "page_not_found", message: "附表页不存在。" }, {
        [SNAPSHOT_HEADER]: snapshot.id,
        [NONCE_HEADER]: session.nonce,
      });
      this.log({ method: "GET", url: req.url ?? "", status: 404, sessionId: session.id, snapshotId: snapshot.id, note: "page_not_found" });
      return;
    }
    const nextToken = page < appendixPageCount(report) ? this.issueToken(session, reportNo, page + 1) : null;
    const nextHref = nextToken
      ? `/reports/${encodeURIComponent(reportNo)}/appendix/${page + 1}?token=${nextToken.token}`
      : null;
    const html = this.renderForSnapshot(snapshot, report, (layoutReport) =>
      renderAppendixPage(layoutReport, snapshot.id, page, pageSamples, nextHref),
    );
    // The paging token is single-use even when the response is lost, so a
    // retry with the same URL is rejected and the client must re-enter from
    // the report body to obtain a fresh token.
    if (auth.dropResponse) {
      this.dropResponse(req, res, session, snapshot);
      return;
    }
    this.log({ method: "GET", url: req.url ?? "", status: 200, sessionId: session.id, snapshotId: snapshot.id, note: `appendix_${page}` });
    this.respondHtml(res, html, session, snapshot);
  }

  private renderForSnapshot(
    snapshot: Snapshot,
    report: ReportSeed,
    render: (report: ReportSeed) => string,
  ): string {
    const layout: Layout | undefined =
      snapshot.layoutMode === "mixed" ? report.layout : snapshot.layoutMode;
    return render(layout ? { ...report, layout } : report);
  }

  private respondHtml(res: ServerResponse, html: string, session: SiteSession, snapshot: Snapshot): void {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      [SESSION_HEADER]: session.id,
      [NONCE_HEADER]: session.nonce,
      [SNAPSHOT_HEADER]: snapshot.id,
      [ALGORITHM_HEADER]: SIGNATURE_ALGORITHM,
    });
    res.end(html);
  }

  private issueToken(session: SiteSession, reportNo: string, page: number): TokenRecord {
    const token = `tok_${randomBytes(12).toString("hex")}`;
    const record: TokenRecord = { token, sessionId: session.id, reportNo, page, used: false };
    this.tokens.set(token, record);
    return record;
  }

  private async handleControl(req: IncomingMessage, res: ServerResponse, path: string, _url: URL): Promise<void> {
    if (req.method !== "POST" && path !== "/__control/state" && path !== "/__control/requests") {
      this.sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    switch (path) {
      case "/__control/state": {
        this.sendJson(res, 200, {
          currentSnapshot: this.currentSnapshotId,
          snapshots: this.snapshots,
          sessions: [...this.sessions.values()].map(({ id, snapshotId, banned, signedRequests }) => ({
            id,
            snapshotId,
            banned,
            signedRequests,
          })),
          faults: this.faults,
        });
        return;
      }
      case "/__control/requests": {
        this.sendJson(res, 200, { requests: this.requests, signedCounter: this.signedCounter });
        return;
      }
      case "/__control/publish": {
        const body = JSON.parse(await this.readBody(req) || "{}") as {
          reportNos?: string[];
          layout?: LayoutMode;
        };
        const previous = this.currentSnapshot();
        const nextSequence = Math.max(...this.snapshots.map((snapshot) => snapshot.sequence)) + 1;
        const revisions = { ...previous.revisions };
        for (const reportNo of body.reportNos ?? [...REPORT_NOS]) {
          if (revisions[reportNo] === undefined) {
            this.sendJson(res, 400, { error: "unknown_report", message: reportNo });
            return;
          }
          revisions[reportNo] = revisions[reportNo]! + 1;
        }
        const snapshot: Snapshot = {
          id: `snap-${String(nextSequence).padStart(4, "0")}`,
          sequence: nextSequence,
          createdAt: new Date().toISOString(),
          revisions,
          layoutMode: body.layout ?? previous.layoutMode,
        };
        this.snapshots.push(snapshot);
        this.currentSnapshotId = snapshot.id;
        this.sendJson(res, 201, { snapshot });
        return;
      }
      case "/__control/fault": {
        const body = JSON.parse((await this.readBody(req)) || "{}") as Partial<Fault> & { type?: string };
        const allowed = ["rateLimit", "banSession", "dropResponse", "delay", "corruptReport", "unavailableReport"];
        if (!body.type || !allowed.includes(body.type)) {
          this.sendJson(res, 400, { error: "bad_fault", message: `type must be one of ${allowed.join("|")}` });
          return;
        }
        if (body.type === "corruptReport" || body.type === "unavailableReport") {
          if (!body.reportNo) {
            this.sendJson(res, 400, { error: "bad_fault", message: "reportNo required" });
            return;
          }
          const times = Math.max(1, body.times ?? 1);
          const target = body.type === "corruptReport" ? this.corruptedReports : this.unavailableReports;
          target.set(body.reportNo, times);
          this.sendJson(res, 201, { armed: { type: body.type, reportNo: body.reportNo, times } });
          return;
        }
        const fault: Fault = {
          type: body.type,
          matchPath: body.matchPath,
          times: Math.max(1, body.times ?? 1),
          remaining: Math.max(1, body.times ?? 1),
          retryAfterMs: body.retryAfterMs,
          ms: body.ms,
        };
        this.faults.push(fault);
        this.sendJson(res, 201, { armed: fault });
        return;
      }
      case "/__control/faults/clear": {
        this.faults.length = 0;
        this.corruptedReports.clear();
        this.unavailableReports.clear();
        this.sendJson(res, 200, { cleared: true });
        return;
      }
      default:
        this.sendJson(res, 404, { error: "unknown_control", path });
    }
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    // Still hash to keep timing roughly constant for unequal lengths.
    createHash("sha256").update(leftBuffer).digest();
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
