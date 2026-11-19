/** Signature-aware HTTP client for the mock assay site. */

import * as cheerio from "cheerio/slim";
import {
  NONCE_HEADER,
  RETRY_AFTER_MS_HEADER,
  SESSION_HEADER,
  SIGNATURE_HEADER,
  SNAPSHOT_HEADER,
  computeSignature,
} from "../shared/protocol.js";
import { ParseError } from "./parse.js";

export interface DirectoryEntry {
  reportNo: string;
  revision: number;
  url: string;
}

export interface DirectoryPage {
  snapshotId: string;
  indexUrl: string;
  entries: DirectoryEntry[];
}

export class SiteFetchError extends Error {
  constructor(
    message: string,
    readonly kind: "network" | "http" | "invalid",
    readonly status: number | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "SiteFetchError";
  }
}

/** The current session's nonce is unusable; the crawler must re-enter the snapshot. */
export class SessionLostError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SessionLostError";
  }
}

/** A paging token was rejected or replayed; the report must be re-read from its body. */
export class TokenRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenRejectedError";
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.hash = "";
  url.search = "";
  url.pathname = "/";
  return url.toString();
}

export function parseDirectoryPage(html: string, baseUrl: string): DirectoryPage {
  const $ = cheerio.load(html);
  const snapshotId =
    $('meta[name="x-snapshot-id"]').attr("content") ?? $(".snapshot").attr("data-snapshot-id") ?? "";
  if (!snapshotId) throw new ParseError("Directory page has no snapshot id");

  const entries: DirectoryEntry[] = [];
  const seen = new Set<string>();
  $("a[data-role=report], table.directory a[href^='/reports/'], table.directory a[href*='/reports/']").each(
    (_index, anchor) => {
      const href = $(anchor).attr("href");
      if (!href) return;
      const reportNo = ($(anchor).attr("data-report-no") ?? $(anchor).text()).trim();
      if (!/^[A-Za-z0-9._-]+$/.test(reportNo)) return;
      if (seen.has(reportNo)) return;
      const row = $(anchor).closest("tr");
      const revisionText = row.find(".revision").first().text().trim() || row.find("td").eq(2).text().trim();
      const revision = Number(revisionText);
      if (!Number.isInteger(revision) || revision < 1) {
        throw new ParseError(`Directory entry ${reportNo} has no valid revision`);
      }
      seen.add(reportNo);
      entries.push({ reportNo, revision, url: new URL(href, baseUrl).toString() });
    },
  );
  if (entries.length === 0) throw new ParseError("Directory page contains no report entries");
  return { snapshotId, indexUrl: new URL("/reports", baseUrl).toString(), entries };
}

export interface SignedClientOptions {
  baseUrl: string;
  /** When set, new sessions always re-enter this snapshot (null = follow current). */
  snapshotId: string | null;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Cooldown shared by every session of one collection; see RateLimitGate. */
  gate?: RateLimitGate;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_RETRY_AFTER_MS = 60_000;

/**
 * One cooldown shared by every session of a single collection.
 *
 * The site rate-limits requests, not sessions: when any session is told to
 * retry after N ms, every session must hold its *next* request until that
 * deadline. Requests already on the wire are unaffected and may finish
 * normally. A later 429 can only extend the deadline, never shorten it.
 */
export class RateLimitGate {
  private resumeAt = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Record a rate-limit response and block every later request until it expires. */
  async block(retryAfterMs: number): Promise<void> {
    const delay = Number.isFinite(retryAfterMs) ? retryAfterMs : 0;
    const until = this.now() + Math.min(MAX_RETRY_AFTER_MS, Math.max(0, delay));
    if (until > this.resumeAt) this.resumeAt = until;
    await this.wait();
  }

  /** Wait out the current cooldown, if any. Called before signing each request. */
  async wait(): Promise<void> {
    while (this.resumeAt > this.now()) {
      await this.sleep(this.resumeAt - this.now());
    }
  }

  /** Milliseconds until requests may resume (0 when open). */
  remainingMs(): number {
    return Math.max(0, this.resumeAt - this.now());
  }
}

/**
 * A session-bound client. Each request is signed with
 *   sha256(sessionId \n nonce \n METHOD \n target)
 * where `nonce` is the one-time value returned by the previous successful
 * response. Any successful response rotates the nonce server-side, so the
 * client only signs with the latest value it has observed.
 */
export class SignedClient {
  private sessionId: string | null = null;
  private nonce: string | null = null;
  private readonly baseUrl: string;
  private snapshotId: string | null;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly gate: RateLimitGate;

  constructor(options: SignedClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.snapshotId = options.snapshotId;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.gate = options.gate ?? new RateLimitGate({ sleep: this.sleep });
  }

  /** Bootstrap an unsigned directory request and adopt its session and snapshot. */
  async open(): Promise<DirectoryPage> {
    const directory = await this.fetchDirectory();
    if (this.snapshotId && directory.snapshotId !== this.snapshotId) {
      throw new SiteFetchError(
        `Site entered snapshot ${directory.snapshotId}, expected pinned snapshot ${this.snapshotId}`,
        "invalid",
      );
    }
    this.snapshotId = directory.snapshotId;
    return directory;
  }

  private async fetchDirectory(): Promise<DirectoryPage> {
    const url = new URL("/reports", this.baseUrl);
    if (this.snapshotId) url.searchParams.set("snapshot", this.snapshotId);
    let response: Response | null = null;
    let lastFailure = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.gate.wait();
      try {
        response = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(this.requestTimeoutMs),
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        lastFailure = `Directory request failed: ${describe(error)}`;
        response = null;
        await this.sleep(backoff(attempt));
        continue;
      }
      if (response.status === 429) {
        const retryMs = Math.min(2_000, Math.max(50, Number(response.headers.get(RETRY_AFTER_MS_HEADER)) || 150));
        lastFailure = "Directory request was rate limited";
        await this.gate.block(retryMs);
        response = null;
        continue;
      }
      break;
    }
    if (!response) {
      throw new SiteFetchError(lastFailure || "Directory request failed", "network", null, null);
    }
    const html = await response.text();
    if (!response.ok) {
      throw new SiteFetchError(
        `Directory request failed with HTTP ${response.status}`,
        "http",
        response.status,
        errorCode(html),
      );
    }
    const sessionId = response.headers.get(SESSION_HEADER);
    const nonce = response.headers.get(NONCE_HEADER);
    const snapshotId = response.headers.get(SNAPSHOT_HEADER) ?? "";
    if (!sessionId || !nonce) {
      throw new SiteFetchError("Directory response did not provide a session", "invalid");
    }
    const directory = parseDirectoryPage(html, this.baseUrl);
    if (snapshotId && directory.snapshotId !== snapshotId) {
      throw new SiteFetchError("Directory snapshot header and body disagree", "invalid");
    }
    this.sessionId = sessionId;
    this.nonce = nonce;
    return directory;
  }

  async reconnect(): Promise<DirectoryPage> {
    this.sessionId = null;
    this.nonce = null;
    return this.open();
  }

  /**
   * Fetch a page with signature validation and bounded recovery for
   * rate limits, expired sessions, banned sessions and dropped connections.
   * Throws SessionLostError when the session cannot be recovered here (the
   * caller must restart the report from its body so that paging tokens are
   * reissued for the new session).
   */
  async get(targetUrl: string): Promise<{ html: string; finalUrl: string }> {
    const target = new URL(targetUrl, this.baseUrl);
    if (target.origin !== new URL(this.baseUrl).origin) {
      throw new SiteFetchError(`Refusing off-site URL ${targetUrl}`, "invalid");
    }

    let lastError: unknown = null;
    let reconnects = 0;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (!this.sessionId || !this.nonce) {
        try {
          await this.reconnect();
        } catch (error) {
          lastError = error;
          await this.sleep(backoff(attempt));
          continue;
        }
      }

      const targetPath = `${target.pathname}${target.search}`;
      // Hold every session (not just this one) until a site-wide cooldown
      // caused by any rate-limit response has elapsed. Requests already sent
      // are not cancelled and may complete normally.
      await this.gate.wait();
      const signature = computeSignature(this.sessionId!, this.nonce!, "GET", targetPath);
      let response: Response;
      try {
        response = await fetch(target, {
          method: "GET",
          headers: {
            [SESSION_HEADER]: this.sessionId!,
            [NONCE_HEADER]: this.nonce!,
            [SIGNATURE_HEADER]: signature,
            "cache-control": "no-store",
          },
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (error) {
        // A dropped connection is ambiguous: the server may have accepted and
        // consumed the nonce. Reconnect before retrying.
        lastError = new SessionLostError(`Connection dropped for ${targetPath}: ${describe(error)}`, error);
        this.sessionId = null;
        this.nonce = null;
        reconnects += 1;
        if (reconnects > 3) throw lastError;
        await this.sleep(backoff(attempt));
        continue;
      }

      let bodyText: string;
      try {
        bodyText = await response.text();
      } catch (error) {
        // The response started but the body was cut off. The server has
        // already rotated the nonce, so the current session cannot continue.
        lastError = new SessionLostError(`Response body interrupted for ${targetPath}: ${describe(error)}`, error);
        this.sessionId = null;
        this.nonce = null;
        reconnects += 1;
        if (reconnects > 3) throw lastError;
        await this.sleep(backoff(attempt));
        continue;
      }

      // The nonce is rotated by the server for every authenticated request,
      // including rejected ones (a rejected paging token still consumed the
      // nonce). Always adopt the value handed back for the next request.
      const nextNonce = response.headers.get(NONCE_HEADER);
      if (nextNonce) this.nonce = nextNonce;

      if (response.status === 200) {
        return { html: bodyText, finalUrl: target.toString() };
      }

      if (response.status === 429) {
        const retryHeader = response.headers.get(RETRY_AFTER_MS_HEADER);
        const retryMs = Math.min(2_000, Math.max(50, Number(retryHeader) || 150));
        lastError = new SiteFetchError("Rate limited", "http", 429, "rate_limited");
        // The whole collection pauses; the nonce is untouched by a 429.
        await this.gate.block(retryMs);
        continue;
      }

      const code = errorCode(bodyText);
      if (response.status === 401 || (response.status === 403 && (code === "session_banned" || code === "unknown_session"))) {
        lastError = new SessionLostError(
          `Session rejected (${response.status} ${code ?? "unknown"})`,
        );
        this.sessionId = null;
        this.nonce = null;
        reconnects += 1;
        if (reconnects > 3) throw lastError;
        await this.sleep(backoff(attempt));
        continue;
      }
      if (response.status === 409 && code === "token_replayed") {
        throw new TokenRejectedError(`Paging token already used for ${targetPath}`);
      }
      if (response.status === 403 && (code === "bad_token" || code === "bad_token_page")) {
        throw new TokenRejectedError(`Paging token rejected for ${targetPath}`);
      }
      if (response.status >= 500) {
        lastError = new SiteFetchError(`Site error ${response.status}`, "http", response.status, code);
        this.sessionId = null;
        this.nonce = null;
        await this.sleep(backoff(attempt));
        continue;
      }
      throw new SiteFetchError(
        `Request ${targetPath} failed with HTTP ${response.status}`,
        "http",
        response.status,
        code,
      );
    }
    throw new SiteFetchError(
      `Request ${targetUrl} exhausted attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      "network",
    );
  }
}

function errorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) return `${error.message} (${cause.message})`;
    return error.message;
  }
  return String(error);
}

function backoff(attempt: number): number {
  return Math.min(400, 25 * 2 ** attempt);
}
