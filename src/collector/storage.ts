/** Durable, crash-safe storage for collected snapshots and deliveries. */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProgressSnapshot, ReportRecord } from "../shared/types.js";

export type EntryStatus = "pending" | "delivered" | "missing" | "failed";

export interface RunEntry {
  reportNo: string;
  revision: number;
  status: EntryStatus;
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
  reports: number;
  bytes: number;
  sha256: string;
  createdAt: string;
}

/**
 * A durably confirmed report page. The body is page 0; appendix pages keep the
 * number shown in their URL. Each fragment is written atomically with fsync,
 * so a killed process resumes with every page that was fully acknowledged.
 */
export interface PageFragment {
  reportNo: string;
  revision: number;
  snapshotId: string;
  /** 0 for the report body, 1..N for appendix pages. */
  page: number;
  url: string;
  html: string;
  savedAt: string;
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

  private checkpointDir(snapshotId: string, reportNo: string): string {
    return path.join(this.snapshotDir(snapshotId), "checkpoints", reportNo);
  }

  private fragmentFile(snapshotId: string, reportNo: string, page: number): string {
    return path.join(this.checkpointDir(snapshotId, reportNo), `page-${String(page).padStart(4, "0")}.json`);
  }

  /** Persist one confirmed page (atomic temp + fsync + rename). */
  async writePageFragment(snapshotId: string, fragment: PageFragment): Promise<void> {
    await writeFileAtomic(
      this.fragmentFile(snapshotId, fragment.reportNo, fragment.page),
      `${JSON.stringify(fragment)}\n`,
    );
  }

  /**
   * Load all fragments for a report in page order, keeping only fragments whose
   * snapshot/revision still match the run. A missing directory simply means no
   * page has been confirmed yet.
   */
  async readPageFragments(
    snapshotId: string,
    reportNo: string,
    revision: number,
  ): Promise<PageFragment[]> {
    const dir = this.checkpointDir(snapshotId, reportNo);
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((name) => /^page-\d+\.json$/.test(name)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const fragments: PageFragment[] = [];
    for (const name of names) {
      const fragment = await readJson<PageFragment>(path.join(dir, name));
      if (
        !fragment ||
        fragment.snapshotId !== snapshotId ||
        fragment.reportNo !== reportNo ||
        fragment.revision !== revision ||
        typeof fragment.html !== "string" ||
        typeof fragment.url !== "string"
      ) {
        continue;
      }
      fragments.push(fragment);
    }
    return fragments.sort((a, b) => a.page - b.page);
  }

  /** Remove all page checkpoints once the merged report record is published. */
  async clearPageFragments(snapshotId: string, reportNo: string): Promise<void> {
    const dir = this.checkpointDir(snapshotId, reportNo);
    await fs.rm(dir, { recursive: true, force: true });
  }

  /**
   * Build a delivery file from all reports and atomically swap the pointer.
   * The previous delivery remains downloadable until the swap.
   */
  async publishDelivery(snapshotId: string, reportNos: string[]): Promise<DeliveryPointer> {
    const lines: string[] = [];
    const reports: ReportRecord[] = [];
    for (const reportNo of [...reportNos].sort()) {
      const raw = await readJson<ReportRecord>(this.reportFile(snapshotId, reportNo));
      if (!raw) throw new Error(`Missing stored report ${reportNo}`);
      if (raw.snapshotId !== snapshotId) {
        throw new Error(`Stored report ${reportNo} belongs to snapshot ${raw.snapshotId}`);
      }
      reports.push(raw);
      lines.push(JSON.stringify(raw));
    }
    const body = `${lines.join("\n")}\n`;
    const deliveriesDir = path.join(this.root, "deliveries");
    await fs.mkdir(deliveriesDir, { recursive: true });
    // Every delivery is a new immutable file. A reader holding an older
    // pointer therefore never races with a concurrent publish.
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const fileName = `delivery-${snapshotId}-${stamp}-${randomUUID().slice(0, 8)}.jsonl`;
    const finalPath = path.join(deliveriesDir, fileName);
    await writeFileAtomic(finalPath, body);
    const sha256 = createHash("sha256").update(body).digest("hex");
    const pointer: DeliveryPointer = {
      file: fileName,
      snapshotId,
      reports: reports.length,
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
  return {
    runId: run.runId,
    state: liveState ?? run.state,
    snapshotId: run.snapshotId,
    siteUrl: run.siteUrl,
    indexUrl: run.indexUrl,
    expectedReports: run.expectedReports || expectedReportsFallback,
    deliveredReports: delivered.length,
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
