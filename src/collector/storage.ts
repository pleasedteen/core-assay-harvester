/** Durable, crash-safe storage for collected snapshots and deliveries. */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
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
  /** Immutable delivery file published by this run, if its commit happened. */
  deliveryFile: string | null;
}

export interface DeliveryPointer {
  /** The run whose completion is committed by this pointer. */
  runId: string;
  file: string;
  snapshotId: string;
  reports: number;
  bytes: number;
  sha256: string;
  createdAt: string;
}

export interface CleanupReport {
  removed: string[];
  failed: string[];
}

const RUN_STATE = "state.json";
const DELIVERY_POINTER = "current-delivery.json";
const TMP_SUFFIX = ".tmp";
/** Maximum number of immutable delivery files retained after cleanup. */
export const DELIVERY_RETENTION = 3;

async function writeFileAtomic(filePath: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}${TMP_SUFFIX}`;
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
   * Write the immutable delivery file for a completed run, then commit it by
   * atomically swapping the pointer and (in the same state write) marking the
   * run complete. Two separate atomic replacements cannot be atomic together,
   * so the pointer records the run id it belongs to: recovery and `progress`
   * compare it with the persisted run to tell whether *this* run was committed.
   *
   * The write is therefore: (1) fsync the new immutable file, (2) atomically
   * replace the pointer, (3) persist the run as complete with `deliveryFile`.
   * If the process dies after (2) but before (3), the pointer already names the
   * run and recovery can finish the commit; if it dies before (2), the pointer
   * still names the previous delivery and this run stays resumable.
   */
  async publishDelivery(run: PersistedRun, reportNos: string[]): Promise<DeliveryPointer> {
    const body = await this.buildDeliveryBody(run.snapshotId, reportNos);
    const deliveriesDir = path.join(this.root, "deliveries");
    await fs.mkdir(deliveriesDir, { recursive: true });
    // Every delivery is a new immutable file. A reader that has opened an older
    // file keeps reading a complete, self-consistent body even if cleanup later
    // unlinks the name.
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const fileName = `delivery-${run.snapshotId}-${stamp}-${randomUUID().slice(0, 8)}.jsonl`;
    const finalPath = path.join(deliveriesDir, fileName);
    await writeFileAtomic(finalPath, body);
    const pointer: DeliveryPointer = {
      runId: run.runId,
      file: fileName,
      snapshotId: run.snapshotId,
      reports: reportNos.length,
      bytes: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex"),
      createdAt: new Date().toISOString(),
    };
    await writeFileAtomic(path.join(this.root, DELIVERY_POINTER), `${JSON.stringify(pointer, null, 2)}\n`);
    return pointer;
  }

  /** Serialize all reports of one snapshot in a stable report-number order. */
  private async buildDeliveryBody(snapshotId: string, reportNos: string[]): Promise<string> {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const reportNo of [...reportNos].sort()) {
      if (seen.has(reportNo)) throw new Error(`Duplicate report ${reportNo} in delivery`);
      seen.add(reportNo);
      const raw = await readJson<ReportRecord>(this.reportFile(snapshotId, reportNo));
      if (!raw) throw new Error(`Missing stored report ${reportNo}`);
      if (raw.snapshotId !== snapshotId) {
        throw new Error(`Stored report ${reportNo} belongs to snapshot ${raw.snapshotId}`);
      }
      lines.push(JSON.stringify(raw));
    }
    return `${lines.join("\n")}\n`;
  }

  async readDeliveryPointer(): Promise<DeliveryPointer | null> {
    return readJson<DeliveryPointer>(path.join(this.root, DELIVERY_POINTER));
  }

  /**
   * Open the delivery named by the current pointer and return a handle plus
   * the exact size/sha256 of the file that handle refers to. The caller reads
   * from the handle, so the headers it sends always describe the bytes it
   * serves even if a publish or cleanup happens meanwhile.
   *
   * If the pointer rotates and cleanup unlinks the old name between reading the
   * pointer and opening the file, retry with the newer pointer instead of
   * failing the request.
   */
  async openDelivery(maxAttempts = 4): Promise<{ pointer: DeliveryPointer; handle: FileHandle; size: number } | null> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const pointer = await this.readDeliveryPointer();
      if (!pointer) return null;
      let handle: FileHandle;
      try {
        handle = await fs.open(path.join(this.root, "deliveries", pointer.file), "r");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const latest = await this.readDeliveryPointer();
        if (!latest || latest.file !== pointer.file) continue;
        // The pointer still names a file that does not exist: there is no
        // complete delivery we can honestly serve.
        return null;
      }
      try {
        const stat = await handle.stat();
        if (stat.size !== pointer.bytes) {
          throw new Error(
            `Delivery file ${pointer.file} is ${stat.size} bytes but pointer says ${pointer.bytes}`,
          );
        }
        return { pointer, handle, size: stat.size };
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    }
    throw new Error("Delivery pointer kept rotating; could not open a stable delivery");
  }

  /**
   * Keep at most `DELIVERY_RETENTION` delivery files, never deleting the one
   * the current pointer names. Unlinking a file a slow reader already opened
   * is safe on POSIX: that reader keeps its complete snapshot.
   *
   * Returns which files were removed and which could not be removed, so the
   * caller can report a cleanup failure instead of silently ignoring it. Files
   * that vanish under us (e.g. a concurrent cleanup) are not failures.
   */
  async cleanupDeliveries(retention = DELIVERY_RETENTION): Promise<CleanupReport> {
    const deliveriesDir = path.join(this.root, "deliveries");
    const report: CleanupReport = { removed: [], failed: [] };
    let names: string[];
    try {
      names = (await fs.readdir(deliveriesDir)).filter((name) => name.endsWith(".jsonl"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return report;
      throw error;
    }
    const pointer = await this.readDeliveryPointer();
    // Keep exactly the newest `retention` files, and always the one the pointer
    // names even if it is somehow older than that window. Names start with the
    // snapshot id, so they are NOT chronological: rank by mtime instead.
    const ranked = await Promise.all(
      names.map(async (name) => {
        const stat = await fs.stat(path.join(deliveriesDir, name)).catch(() => null);
        return { name, mtime: stat?.mtimeMs ?? 0 };
      }),
    );
    ranked.sort((left, right) => right.mtime - left.mtime || right.name.localeCompare(left.name));
    const keep = new Set<string>();
    if (pointer) keep.add(pointer.file);
    for (const { name } of ranked) {
      if (keep.size >= Math.max(1, retention)) break;
      keep.add(name);
    }
    for (const name of names) {
      if (keep.has(name)) continue;
      try {
        await fs.unlink(path.join(deliveriesDir, name));
        report.removed.push(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        report.failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return report;
  }

  /** Remove temporary files left behind by an interrupted atomic write. */
  async cleanupTemporaryFiles(): Promise<CleanupReport> {
    const report: CleanupReport = { removed: [], failed: [] };
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith(TMP_SUFFIX)) {
          try {
            await fs.unlink(full);
            report.removed.push(full);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            report.failed.push(`${full}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    };
    await walk(this.root);
    return report;
  }
}

export function toProgress(
  run: PersistedRun | null,
  liveState: ProgressSnapshot["state"] | null,
  expectedReportsFallback = 0,
  lastErrorFallback: string | null = null,
  committedRunId: string | null = null,
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
      delivered: false,
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
    delivered: committedRunId !== null && committedRunId === run.runId,
  };
}
