/** HTTP control plane for the collector service. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ProgressSnapshot } from "../shared/types.js";
import { Collector } from "./runner.js";

export interface CollectorServiceOptions {
  dataDir: string;
  host?: string;
  port?: number;
  collector: Collector;
}

export interface CollectorHandle {
  url: string;
  port: number;
  server: Server;
  collector: Collector;
  close(): Promise<void>;
}

const API = {
  collect: "/api/collect",
  progress: "/api/progress",
  download: "/api/download",
  health: "/api/health",
} as const;

export async function startCollectorService(options: CollectorServiceOptions): Promise<CollectorHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const collector = options.collector;
  await collector.init();

  const server = createServer((req, res) => {
    void handle(req, res, collector);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    server,
    collector,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(`${body}\n`);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: code, message });
}

async function handle(req: IncomingMessage, res: ServerResponse, collector: Collector): Promise<void> {
  const url = new URL(req.url ?? "/", "http://collector.local");
  const route = url.pathname.replace(/\/+$/, "") || "/";
  try {
    if (route === API.health && req.method === "GET") {
      sendJson(res, 200, { ok: true, dataDir: collector.storeRef.root });
      return;
    }

    if (route === API.progress && req.method === "GET") {
      const progress: ProgressSnapshot = collector.progress();
      const pointer = await collector.storeRef.readDeliveryPointer();
      sendJson(res, 200, {
        progress,
        delivery: pointer
          ? {
              available: true,
              snapshotId: pointer.snapshotId,
              reports: pointer.reports,
              bytes: pointer.bytes,
              sha256: pointer.sha256,
              createdAt: pointer.createdAt,
            }
          : { available: false },
        downloadUrl: pointer ? "/api/download" : null,
      });
      return;
    }

    if (route === API.collect && req.method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendError(res, 400, "invalid_json", error instanceof Error ? error.message : "invalid body");
        return;
      }
      const siteUrl = typeof body.siteUrl === "string" ? body.siteUrl : "";
      if (!siteUrl) {
        sendError(res, 400, "site_url_required", "Body must contain { siteUrl }");
        return;
      }
      try {
        new URL(siteUrl);
      } catch {
        sendError(res, 400, "invalid_site_url", `Not a valid URL: ${siteUrl}`);
        return;
      }
      const snapshotId = typeof body.snapshotId === "string" ? body.snapshotId : null;
      const fresh = body.fresh === true;
      let concurrency: number | undefined;
      if (body.concurrency !== undefined) {
        concurrency = typeof body.concurrency === "number" ? body.concurrency : Number.NaN;
        if (!Number.isInteger(concurrency) || concurrency < 1) {
          sendError(res, 400, "invalid_concurrency", "concurrency must be a positive integer");
          return;
        }
      }

      const progress = collector.progress();
      if (collector.isRunning()) {
        if (progress.siteUrl && normalize(progress.siteUrl) !== normalize(siteUrl)) {
          sendError(res, 409, "already_running", "A collection for another site is in progress");
          return;
        }
        sendJson(res, 202, { accepted: true, alreadyRunning: true, runId: progress.runId });
        return;
      }

      try {
        const { runId } = await collector.start({ siteUrl, fresh, snapshotId, concurrency });
        void collector.wait();
        const current = collector.progress();
        sendJson(res, 202, {
          accepted: true,
          runId,
          snapshotId: current.snapshotId,
          expectedReports: current.expectedReports,
          resumed: current.state === "running" && current.resumedFrom !== null,
        });
      } catch (error) {
        sendError(res, 500, "start_failed", error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (route === API.download && req.method === "GET") {
      // Read the pointer, then the immutable file it names. If a publish
      // rotates and prunes the file in between, retry with the newer pointer.
      let pointer = await collector.storeRef.readDeliveryPointer();
      if (!pointer) {
        sendJson(res, 404, {
          error: "no_delivery",
          message: "尚无完整成果可供下载（首次完整交付尚未完成）。",
        });
        return;
      }
      let body: Buffer;
      try {
        body = await collector.storeRef.readDelivery(pointer);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        pointer = await collector.storeRef.readDeliveryPointer();
        if (!pointer) {
          sendJson(res, 404, { error: "no_delivery", message: "尚无完整成果可供下载。" });
          return;
        }
        body = await collector.storeRef.readDelivery(pointer);
      }
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": `attachment; filename="assay-${pointer.snapshotId}.jsonl"`,
        "content-length": body.byteLength,
        "x-snapshot-id": pointer.snapshotId,
        "x-delivery-sha256": pointer.sha256,
        "x-delivery-reports": String(pointer.reports),
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }

    sendError(res, 404, "not_found", `No route ${req.method} ${route}`);
  } catch (error) {
    if (!res.headersSent) {
      sendError(res, 500, "internal_error", error instanceof Error ? error.message : String(error));
    } else {
      res.end();
    }
  }
}

function normalize(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname === "/api/collect" || pathname === "/api") pathname = "";
  return `${parsed.origin}${pathname}`;
}
