/** Test helpers: real local HTTP services and delivery parsing. */

import type { ChildProcessByStdio } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockAssaySite, type SiteHandle, type SiteOptions } from "../src/site/server.js";
import { Collector } from "../src/collector/runner.js";
import { startCollectorService, type CollectorHandle } from "../src/collector/server.js";
import type { ProgressSnapshot, ReportRecord } from "../src/shared/types.js";

export type CollectorChild = ChildProcessByStdio<null, Readable, Readable>;

export async function tempDataDir(label = "collector"): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `assay-${label}-`));
}

export interface Harness {
  site: SiteHandle;
  service: CollectorHandle;
  dataDir: string;
  close(): Promise<void>;
}

export async function startHarness(
  siteOptions: SiteOptions = {},
  dataDir?: string,
): Promise<Harness> {
  const site = await MockAssaySite.start(siteOptions);
  const dir = dataDir ?? (await tempDataDir());
  const collector = new Collector({ dataDir: dir, siteUrl: site.url });
  const service = await startCollectorService({ collector, dataDir: dir });
  const ownsDataDir = dataDir === undefined;
  return {
    site,
    service,
    dataDir: dir,
    close: async () => {
      await service.close();
      await site.close();
      if (ownsDataDir) await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function startCollect(
  serviceUrl: string,
  siteUrl: string,
  options: { fresh?: boolean; snapshotId?: string } = {},
): Promise<Response> {
  return fetch(`${serviceUrl}/api/collect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ siteUrl, ...options }),
  });
}

export async function getProgress(serviceUrl: string): Promise<{
  progress: ProgressSnapshot;
  delivery: { available: boolean; snapshotId?: string; reports?: number };
}> {
  const response = await fetch(`${serviceUrl}/api/progress`);
  if (response.status !== 200) throw new Error(`progress HTTP ${response.status}`);
  return (await response.json()) as {
    progress: ProgressSnapshot;
    delivery: { available: boolean; snapshotId?: string; reports?: number };
  };
}

export async function waitForState(
  serviceUrl: string,
  states: ProgressSnapshot["state"][],
  timeoutMs = 15_000,
): Promise<ProgressSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let latest: ProgressSnapshot | null = null;
  while (Date.now() < deadline) {
    latest = (await getProgress(serviceUrl)).progress;
    if (states.includes(latest.state)) return latest;
    await sleep(30);
  }
  throw new Error(
    `Timed out waiting for state ${states.join("/")}; last state=${latest?.state} ` +
      `delivered=${latest?.deliveredReports}/${latest?.expectedReports} error=${latest?.lastError}`,
  );
}

export interface DownloadResult {
  status: number;
  records: ReportRecord[];
  raw: string;
  headers: Headers;
}

export async function download(serviceUrl: string): Promise<DownloadResult> {
  const response = await fetch(`${serviceUrl}/api/download`);
  const raw = await response.text();
  if (!response.ok) {
    return { status: response.status, records: [], raw, headers: response.headers };
  }
  const records = raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ReportRecord);
  return { status: response.status, records, raw, headers: response.headers };
}

export async function armFault(siteUrl: string, fault: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${siteUrl}/__control/fault`, {
    method: "POST",
    body: JSON.stringify(fault),
  });
  if (response.status !== 201) {
    throw new Error(`arming fault failed: ${response.status} ${await response.text()}`);
  }
}

export async function publish(
  siteUrl: string,
  body: { reportNos?: string[]; layout?: "mixed" | "classic" | "compact" } = {},
): Promise<{ id: string; revisions: Record<string, number> }> {
  const response = await fetch(`${siteUrl}/__control/publish`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (response.status !== 201) throw new Error(`publish failed: ${response.status}`);
  const payload = (await response.json()) as { snapshot: { id: string; revisions: Record<string, number> } };
  return payload.snapshot;
}

export async function siteRequests(siteUrl: string): Promise<
  Array<{ status: number; note: string; url: string; sessionId: string | null; snapshotId: string | null }>
> {
  const response = await fetch(`${siteUrl}/__control/requests`);
  const payload = (await response.json()) as {
    requests: Array<{ status: number; note: string; url: string; sessionId: string | null; snapshotId: string | null }>;
  };
  return payload.requests;
}

export async function storedReportFiles(dataDir: string, snapshotId: string): Promise<string[]> {
  try {
    return (await readdir(path.join(dataDir, "snapshots", snapshotId, "reports"))).filter((file) =>
      file.endsWith(".json"),
    );
  } catch {
    return [];
  }
}

/** All regular delivery files currently on disk (directories excluded). */
export async function deliveryFiles(dataDir: string): Promise<string[]> {
  const dir = path.join(dataDir, "deliveries");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const stat = await statSafe(path.join(dir, name));
    if (stat?.isFile()) files.push(name);
  }
  return files.sort();
}

async function statSafe(filePath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

export async function readPersistedRun(dataDir: string): Promise<
  | {
      runId: string;
      state: string;
      snapshotId: string;
      deliveryFile: string | null;
      entries: Array<{ reportNo: string; revision: number; status: string; sampleCount?: number }>;
    }
  | null
> {
  try {
    return JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8"));
  } catch {
    return null;
  }
}

export async function writePersistedRun(dataDir: string, run: unknown): Promise<void> {
  await writeFile(path.join(dataDir, "state.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

export async function readDeliveryPointerFile(
  dataDir: string,
): Promise<{ runId: string; file: string; snapshotId: string; reports: number; bytes: number; sha256: string } | null> {
  try {
    return JSON.parse(await readFile(path.join(dataDir, "current-delivery.json"), "utf8"));
  } catch {
    return null;
  }
}

export async function removeFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

export async function readStoredReport(
  dataDir: string,
  snapshotId: string,
  reportNo: string,
): Promise<ReportRecord> {
  return JSON.parse(
    await readFile(path.join(dataDir, "snapshots", snapshotId, "reports", `${reportNo}.json`), "utf8"),
  ) as ReportRecord;
}

export function assertNoDuplicateReports(records: ReportRecord[]): void {
  const seen = new Set<string>();
  for (const record of records) {
    const key = `${record.snapshotId}/${record.reportNo}`;
    if (seen.has(key)) throw new Error(`Duplicate record ${key}`);
    seen.add(key);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Count report-body requests per report number in a site request log. */
export function bodyRequestCounts(
  requests: Array<{ note: string; url: string }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const request of requests) {
    if (request.note !== "report_body") continue;
    const match = /^\/reports\/([^/?]+)$/.exec(request.url.split("?")[0] ?? "");
    if (!match) continue;
    const reportNo = decodeURIComponent(match[1]!);
    counts.set(reportNo, (counts.get(reportNo) ?? 0) + 1);
  }
  return counts;
}
