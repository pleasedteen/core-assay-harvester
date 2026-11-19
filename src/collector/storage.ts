/** Durable, crash-safe storage for collected snapshots and deliveries. */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Layout, ProgressSnapshot, ReportRecord } from "../shared/types.js";

export type EntryStatus = "pending" | "delivered" | "missing" | "failed";

export interface RunEntry {
  reportNo: string;
  revision: number;
  /** Layout declared by the pinned directory for this run's snapshot. */
  layout?: Layout | null;
  status: EntryStatus;
  /**
   * True when this entry is satisfied by reusing a record from the last
   * complete delivery instead of fetching body/appendix pages again.
   */
  reused?: boolean;
  reason?: string;
  sampleCount?: number;
}

export interface PersistedRun {
  version: 1;
  runId: string;
  state: "running" | "interrupted" | "failed" | "complete";
  snapshotId: string;
  siteUrl: string;
  indexUrl: string;
  expectedReports: number;
  entries: RunEntry[];
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  lastError: string | null;
  resumedFrom: string | null;
}

export interface DeliveryPointer {
  file: string;
  snapshotId: string;
  /** Normalized site URL the delivery was collected from; reuse requires a match. */
  siteUrl?: string;
  reports: number;
  bytes: number;
  sha256: string;
  createdAt: string;
}

/** A report carried over from the previous complete delivery, byte-identical. */
export interface ReusedDeliveryRecord {
  reportNo: string;
  record: ReportRecord;
  /** The exact JSONL line as it appeared in the previous delivery file. */
  line: string;
}

/** What the next delivery is built from: freshly fetched reports plus reused ones. */
export interface DeliveryPlan {
  snapshotId: string;
  siteUrl: string;
  /** Report numbers to read from this snapshot's on-disk store. */
  fetched: string[];
  /** Records carried over from the previous complete delivery. */
  reused: ReusedDeliveryRecord[];
}

const RUN_STATE = "state.json";
const DELIVERY_POINTER = "current-delivery.json";
const TMP_SUFFIX = ".tmp";

async function writeFileAtomic(filePath: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}${TMP_SUFFIX}`;
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class CollectorStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private runFile(): string {
    return path.join(this.root, RUN_STATE);
  }

  private snapshotDir(snapshotId: string): string {
    return path.join(this.root, "snapshots", snapshotId);
  }

  reportFile(snapshotId: string, reportNo: string): string {
    return path.join(this.snapshotDir(snapshotId), "reports", `${reportNo}.json`);
  }

  async loadRun(): Promise<PersistedRun | null> {
    return readJson<PersistedRun>(this.runFile());
  }

  async saveRun(run: PersistedRun): Promise<void> {
    run.updatedAt = new Date().toISOString();
    await writeFileAtomic(this.runFile(), `${JSON.stringify(run, null, 2)}\n`);
  }

  /** Keep an immutable copy of a finished run before a new one replaces it. */
  async archiveRun(run: PersistedRun): Promise<void> {
    await writeFileAtomic(
      path.join(this.root, "runs", `${run.runId}.json`),
      `${JSON.stringify(run, null, 2)}\n`,
    );
  }

  async writeReport(snapshotId: string, record: ReportRecord): Promise<void> {
    await writeFileAtomic(this.reportFile(snapshotId, record.reportNo), `${JSON.stringify(record)}\n`);
  }

  /** Returns a still-valid, complete report record or null. */
  async readReport(snapshotId: string, reportNo: string, revision: number): Promise<ReportRecord | null> {
    const record = await readJson<ReportRecord>(this.reportFile(snapshotId, reportNo));
    if (!record) return null;
    if (record.reportNo !== reportNo || record.revision !== revision || record.snapshotId !== snapshotId) return null;
    if (!Array.isArray(record.samples) || record.samples.length === 0) return null;
    for (const sample of record.samples) {
      if (!sample.sampleId || !Array.isArray(sample.items) || sample.items.length === 0) return null;
    }
    return record;
  }

  /**
   * Parse a delivery file into its records, keeping each record's exact line
   * so a later delivery can carry it over byte-for-byte. Returns null when
   * the file is unreadable or malformed: reuse is an optimization and the
   * caller must then fall back to fetching.
   */
  async readDeliveryRecords(
    pointer: DeliveryPointer,
  ): Promise<Map<string, ReusedDeliveryRecord> | null> {
    let text: string;
    try {
      text = await fs.readFile(path.join(this.root, "deliveries", pointer.file), "utf8");
    } catch {
      return null;
    }
    const records = new Map<string, ReusedDeliveryRecord>();
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let record: ReportRecord;
      try {
        record = JSON.parse(line) as ReportRecord;
      } catch {
        return null;
      }
      if (!isReusableRecord(record)) return null;
      records.set(record.reportNo, { reportNo: record.reportNo, record, line });
    }
    return records;
  }

  /**
   * Build a delivery file from freshly fetched reports (read from the
   * snapshot store) plus records reused from the previous complete delivery,
   * then atomically swap the pointer. The previous delivery remains
   * downloadable until the swap.
   */
  async publishDelivery(plan: DeliveryPlan): Promise<DeliveryPointer> {
    const reusedByReport = new Map(plan.reused.map((entry) => [entry.reportNo, entry]));
    for (const reportNo of plan.fetched) {
      if (reusedByReport.has(reportNo)) {
        throw new Error(`Report ${reportNo} is both fetched and reused`);
      }
    }
    const lines: string[] = [];
    let reports = 0;
    const ordered = [...plan.fetched, ...reusedByReport.keys()].sort();
    for (const reportNo of ordered) {
      const reused = reusedByReport.get(reportNo);
      if (reused) {
        // Reused records keep the snapshot id, source URLs and collection
        // time of the run that actually fetched them.
        if (reused.record.reportNo !== reportNo || reused.record.samples.length === 0) {
          throw new Error(`Reused record for ${reportNo} is not usable`);
        }
        lines.push(reused.line);
        reports += 1;
        continue;
      }
      const raw = await readJson<ReportRecord>(this.reportFile(plan.snapshotId, reportNo));
      if (!raw) throw new Error(`Missing stored report ${reportNo}`);
      if (raw.snapshotId !== plan.snapshotId) {
        throw new Error(`Stored report ${reportNo} belongs to snapshot ${raw.snapshotId}`);
      }
      reports += 1;
      lines.push(JSON.stringify(raw));
    }
    const body = `${lines.join("\n")}\n`;
    const deliveriesDir = path.join(this.root, "deliveries");
    await fs.mkdir(deliveriesDir, { recursive: true });
    // Every delivery is a new immutable file. A reader holding an older
    // pointer therefore never races with a concurrent publish.
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const fileName = `delivery-${plan.snapshotId}-${stamp}-${randomUUID().slice(0, 8)}.jsonl`;
    const finalPath = path.join(deliveriesDir, fileName);
    await writeFileAtomic(finalPath, body);
    const sha256 = createHash("sha256").update(body).digest("hex");
    const pointer: DeliveryPointer = {
      file: fileName,
      snapshotId: plan.snapshotId,
      siteUrl: plan.siteUrl,
      reports,
      bytes: Buffer.byteLength(body),
      sha256,
      createdAt: new Date().toISOString(),
    };
    await writeFileAtomic(path.join(this.root, DELIVERY_POINTER), `${JSON.stringify(pointer, null, 2)}\n`);
    await this.pruneDeliveries(deliveriesDir, fileName, 3);
    return pointer;
  }

  /** Keep only the newest few delivery files, never the one just published. */
  private async pruneDeliveries(deliveriesDir: string, keepName: string, keepCount: number): Promise<void> {
    const names = (await fs.readdir(deliveriesDir))
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .reverse();
    const keep = new Set(names.slice(0, keepCount));
    keep.add(keepName);
    for (const name of names) {
      if (keep.has(name)) continue;
      await fs.unlink(path.join(deliveriesDir, name)).catch(() => undefined);
    }
  }

  async readDeliveryPointer(): Promise<DeliveryPointer | null> {
    return readJson<DeliveryPointer>(path.join(this.root, DELIVERY_POINTER));
  }

  async readDelivery(pointer: DeliveryPointer): Promise<Buffer> {
    return fs.readFile(path.join(this.root, "deliveries", pointer.file));
  }
}

export function toProgress(
  run: PersistedRun | null,
  liveState: ProgressSnapshot["state"] | null,
  expectedReportsFallback = 0,
  lastErrorFallback: string | null = null,
): ProgressSnapshot {
  if (!run) {
    return {
      runId: null,
      state: "idle",
      snapshotId: null,
      siteUrl: null,
      indexUrl: null,
      expectedReports: 0,
      deliveredReports: 0,
      reused: [],
      pending: [],
      missing: [],
      failed: [],
      startedAt: null,
      updatedAt: null,
      finishedAt: null,
      lastError: null,
      resumedFrom: null,
    };
  }
  const delivered = run.entries.filter((entry) => entry.status === "delivered");
  const failed = run.entries
    .filter((entry) => entry.status === "failed")
    .map((entry) => ({ reportNo: entry.reportNo, reason: entry.reason ?? "unknown" }));
  const missing = run.entries
    .filter((entry) => entry.status === "missing")
    .map((entry) => ({ reportNo: entry.reportNo, reason: entry.reason ?? "missing from snapshot" }));
  const pending = run.entries.filter((entry) => entry.status === "pending").map((entry) => entry.reportNo);
  const reused = run.entries.filter((entry) => entry.reused).map((entry) => entry.reportNo);
  return {
    runId: run.runId,
    state: liveState ?? run.state,
    snapshotId: run.snapshotId,
    siteUrl: run.siteUrl,
    indexUrl: run.indexUrl,
    expectedReports: run.expectedReports || expectedReportsFallback,
    deliveredReports: delivered.length,
    reused,
    pending,
    missing,
    failed,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
    lastError: run.lastError ?? lastErrorFallback,
    resumedFrom: run.resumedFrom,
  };
}

/** Light structural check before a delivered record is trusted for reuse. */
function isReusableRecord(record: ReportRecord): boolean {
  if (typeof record.reportNo !== "string" || record.reportNo === "") return false;
  if (!Number.isInteger(record.revision) || record.revision < 1) return false;
  if (typeof record.snapshotId !== "string" || record.snapshotId === "") return false;
  if (record.layout !== "classic" && record.layout !== "compact") return false;
  if (typeof record.collectedAt !== "string" || record.collectedAt === "") return false;
  if (typeof record.source?.bodyUrl !== "string" || !Array.isArray(record.source?.appendixUrls)) {
    return false;
  }
  return Array.isArray(record.samples) && record.samples.length > 0;
}
