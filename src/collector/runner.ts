/** Snapshot-pinned collection orchestrator with durable, resumable progress. */

import { randomUUID } from "node:crypto";
import type { ReportRecord } from "../shared/types.js";
import {
  SignedClient,
  TokenRejectedError,
  SiteFetchError,
  SessionLostError,
  normalizeBaseUrl,
} from "./client.js";
import { mergeReportParts, ParseError, parsePage, type PagePart } from "./parse.js";
import {
  CollectorStore,
  type PersistedRun,
  type RunEntry,
  toProgress,
  type EntryStatus,
} from "./storage.js";
import type { ProgressSnapshot } from "../shared/types.js";

export interface CollectorOptions {
  dataDir: string;
  /** Base URL of the mock site. */
  siteUrl: string;
  /** Optional snapshot to pin for a fresh run; normally discovered from the directory. */
  snapshotId?: string | null;
  /** Per-report attempt budget (session loss, paging token rejection, transient errors). */
  reportAttempts?: number;
}

export interface StartOptions {
  siteUrl?: string;
  /** Start a new run instead of resuming an incomplete one. */
  fresh?: boolean;
  /** Pin the new run to a specific snapshot (must exist on the site). */
  snapshotId?: string | null;
}

export interface RunResult {
  runId: string;
  state: PersistedRun["state"];
  snapshotId: string;
  expectedReports: number;
  deliveredReports: number;
  missing: Array<{ reportNo: string; reason: string }>;
  failed: Array<{ reportNo: string; reason: string }>;
  deliveryPublished: boolean;
  cleanup: string[];
}

class CollectAborted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectAborted";
  }
}

export class Collector {
  private readonly store: CollectorStore;
  private readonly options: {
    dataDir: string;
    siteUrl: string;
    snapshotId: string | null;
    reportAttempts: number;
  };
  private activeRun: PersistedRun | null = null;
  private liveState: ProgressSnapshot["state"] | null = null;
  private activePromise: Promise<RunResult> | null = null;
  private starting = false;
  private lastError: string | null = null;
  private readonly reportAttempts: number;
  /** Run id named by the current delivery pointer; null when there is none. */
  private committedRunId: string | null = null;
  /** Last cleanup problem, surfaced in progress but never fatal to a run. */
  private cleanupError: string | null = null;

  constructor(options: CollectorOptions) {
    this.options = {
      dataDir: options.dataDir,
      siteUrl: normalizeBaseUrl(options.siteUrl),
      snapshotId: options.snapshotId ?? null,
      reportAttempts: options.reportAttempts ?? 5,
    };
    this.store = new CollectorStore(options.dataDir);
    this.reportAttempts = this.options.reportAttempts;
  }

  get storeRef(): CollectorStore {
    return this.store;
  }

  /** Restore persisted state. A run left "running" means the process died mid-flight. */
  async init(): Promise<void> {
    // Finish (or discard) any commit the previous process left half-done, and
    // remove stale temp files, before reading state into memory.
    await this.recover();
    const run = await this.store.loadRun();
    if (!run) return;
    if (run.state === "running") {
      run.state = "interrupted";
      run.lastError = "Previous collector process stopped while the run was in progress.";
      await this.store.saveRun(run);
    }
    this.activeRun = run;
    this.lastError = run.lastError;
    await this.refreshCommitState();
  }

  /**
   * Reconcile the persisted run with the delivery pointer after a restart.
   *
   * The pointer names the run it commits. If it names the persisted run but the
   * run state still says `running`/`interrupted`, the previous process died
   * between swapping the pointer and persisting `complete`; the commit already
   * happened, so mark the run complete rather than re-collecting it. Conversely
   * a `complete` run whose pointer names a different (or no) run means its
   * commit did not survive, so it is downgraded to `interrupted` and the next
   * `collect` re-publishes from the reports already on disk.
   */
  private async recover(): Promise<void> {
    await this.store.cleanupTemporaryFiles().then(
      (report) => this.recordCleanup(report.failed),
      (error) => this.recordCleanup([describe(error)]),
    );
    const [run, pointer] = await Promise.all([this.store.loadRun(), this.store.readDeliveryPointer()]);
    if (run) {
      const committed = pointer?.runId === run.runId;
      if (run.state === "complete" && !committed) {
        run.state = "interrupted";
        run.finishedAt = null;
        run.lastError = "Delivery pointer does not name this run; completion must be re-committed.";
        await this.store.saveRun(run);
      } else if (run.state !== "complete" && committed) {
        run.state = "complete";
        run.deliveryFile = pointer.file;
        run.finishedAt = pointer.createdAt;
        run.lastError = null;
        await this.store.saveRun(run);
      }
    }
    const cleanup = await this.store.cleanupDeliveries().catch((error) => {
      this.recordCleanup([describe(error)]);
      return null;
    });
    if (cleanup) this.recordCleanup(cleanup.failed);
  }

  private async refreshCommitState(): Promise<void> {
    const pointer = await this.store.readDeliveryPointer();
    this.committedRunId = pointer?.runId ?? null;
  }

  private recordCleanup(failures: string[]): void {
    this.cleanupError = failures.length > 0 ? `cleanup failed: ${failures.join("; ")}` : null;
  }

  isRunning(): boolean {
    return this.activePromise !== null || this.starting;
  }

  async start(options: StartOptions = {}): Promise<{ started: boolean; runId: string }> {
    if (this.isRunning()) {
      throw new Error("A collection is already running");
    }
    this.starting = true;
    try {
      return await this.startInternal(options);
    } finally {
      this.starting = false;
    }
  }

  private async startInternal(options: StartOptions): Promise<{ started: boolean; runId: string }> {
    if (options.siteUrl) {
      this.options.siteUrl = normalizeBaseUrl(options.siteUrl);
    }
    if (options.snapshotId !== undefined) {
      this.options.snapshotId = options.snapshotId;
    }
    const existing = this.activeRun;
    const pinConflict = Boolean(
      existing && options.snapshotId && existing.snapshotId !== options.snapshotId,
    );
    let run: PersistedRun;
    if (existing && existing.state !== "complete" && !options.fresh && !pinConflict) {
      run = existing;
      run.state = "running";
      run.resumedFrom = existing.resumedFrom ?? existing.startedAt;
      for (const entry of run.entries) {
        if (entry.status === "missing" || entry.status === "failed" || entry.status === "pending") {
          entry.status = "pending";
          delete entry.reason;
        }
      }
    } else {
      if (existing) await this.store.archiveRun(existing);
      run = await this.createFreshRun();
      this.activeRun = null;
    }
    await this.refreshCommitState();
    run.startedAt = run.startedAt || new Date().toISOString();
    run.lastError = null;
    await this.store.saveRun(run);
    this.activeRun = run;
    this.liveState = "running";
    this.lastError = null;

    this.activePromise = this.execute(run)
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        // A throw after the pointer swap must not undo a committed delivery.
        await this.refreshCommitState();
        if (this.committedRunId === run.runId) {
          run.state = "complete";
          this.lastError = null;
          await this.store.saveRun(run).catch(() => undefined);
          return this.resultFromRun(run, true);
        }
        // The run failed before committing. If it reached "all reports on
        // disk" (e.g. died right before the pointer swap) we still must not
        // claim success; record the reason and leave the previous delivery.
        run.state = "failed";
        run.lastError = message;
        this.lastError = message;
        await this.store.saveRun(run).catch(() => undefined);
        return this.resultFromRun(run, false);
      })
      .finally(() => {
        this.liveState = null;
        this.activePromise = null;
      });
    return { started: true, runId: run.runId };
  }

  async wait(): Promise<RunResult | null> {
    if (!this.activePromise) return null;
    return this.activePromise;
  }

  private async createFreshRun(): Promise<PersistedRun> {
    const client = new SignedClient({
      baseUrl: this.options.siteUrl,
      snapshotId: this.options.snapshotId,
    });
    const directory = await client.open();
    const now = new Date().toISOString();
    return {
      version: 1,
      runId: `run-${now.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
      state: "running",
      snapshotId: directory.snapshotId,
      siteUrl: this.options.siteUrl,
      indexUrl: directory.indexUrl,
      expectedReports: directory.entries.length,
      entries: directory.entries.map((entry) => ({
        reportNo: entry.reportNo,
        revision: entry.revision,
        status: "pending" as EntryStatus,
      })),
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      lastError: null,
      resumedFrom: null,
      deliveryFile: null,
    };
  }

  private async execute(run: PersistedRun): Promise<RunResult> {
    const client = new SignedClient({
      baseUrl: run.siteUrl,
      snapshotId: run.snapshotId,
    });
    let directory;
    try {
      directory = await client.open();
    } catch (error) {
      if (isPermanentFetchError(error)) {
        run.state = "failed";
        run.lastError = `Could not enter snapshot ${run.snapshotId}: ${describe(error)}`;
        run.finishedAt = new Date().toISOString();
        this.lastError = run.lastError;
        await this.store.saveRun(run);
        return this.resultFromRun(run, false);
      }
      throw new CollectAborted(`Could not enter snapshot ${run.snapshotId}: ${describe(error)}`);
    }
    if (directory.snapshotId !== run.snapshotId) {
      throw new CollectAborted(
        `Site returned snapshot ${directory.snapshotId} but run is pinned to ${run.snapshotId}`,
      );
    }

    // Reconcile the run's expectations with the pinned directory listing.
    const byReport = new Map(directory.entries.map((entry) => [entry.reportNo, entry]));
    for (const entry of run.entries) {
      const listed = byReport.get(entry.reportNo);
      if (!listed) {
        entry.status = "missing";
        entry.reason = "Report is no longer listed in the pinned snapshot";
        continue;
      }
      if (listed.revision !== entry.revision) {
        entry.status = "pending";
        entry.revision = listed.revision;
        delete entry.reason;
      }
    }
    for (const listed of directory.entries) {
      if (!run.entries.some((entry) => entry.reportNo === listed.reportNo)) {
        run.entries.push({ reportNo: listed.reportNo, revision: listed.revision, status: "pending" });
      }
    }
    run.expectedReports = directory.entries.length;
    await this.store.saveRun(run);

    for (const entry of run.entries) {
      // Any complete record already on disk for this snapshot/revision is
      // trusted and never requested again. This also covers a crash between
      // writing a report and persisting its status.
      const stored = await this.store.readReport(run.snapshotId, entry.reportNo, entry.revision);
      if (stored) {
        const wasDelivered = entry.status === "delivered";
        entry.status = "delivered";
        entry.sampleCount = stored.samples.length;
        delete entry.reason;
        if (!wasDelivered) await this.store.saveRun(run);
        continue;
      }
      if (entry.status === "delivered") {
        entry.status = "pending";
        await this.store.saveRun(run);
      }

      try {
        const record = await this.collectReport(client, run, entry);
        await this.store.writeReport(run.snapshotId, record);
        entry.status = "delivered";
        entry.sampleCount = record.samples.length;
        delete entry.reason;
      } catch (error) {
        if (error instanceof CollectAborted) throw error;
        const { status, reason } = classifyFailure(error);
        entry.status = status;
        entry.reason = reason;
        this.lastError = `${entry.reportNo}: ${reason}`;
        run.lastError = this.lastError;
      }
      await this.store.saveRun(run);
    }

    const delivered = run.entries.filter((entry) => entry.status === "delivered");
    const problems = run.entries.filter(
      (entry) => entry.status !== "delivered" && entry.status !== "pending",
    );
    if (problems.length > 0 || delivered.length !== run.expectedReports) {
      run.state = "failed";
      const summary = problems
        .map((entry) => `${entry.reportNo}: ${entry.status}${entry.reason ? ` (${entry.reason})` : ""}`)
        .join("; ");
      run.lastError =
        `Snapshot ${run.snapshotId} is incomplete: ${delivered.length}/${run.expectedReports} reports delivered` +
        (summary ? `; ${summary}` : "");
      run.finishedAt = new Date().toISOString();
      this.lastError = run.lastError;
      await this.store.saveRun(run);
      return this.resultFromRun(run, false);
    }

    // Complete snapshot: write the immutable delivery, swap the pointer that
    // names this run, then persist `complete`. Until the pointer swap the
    // previous delivery stays downloadable; after it, the pointer itself says
    // this run was committed, so a crash before the state write is recoverable.
    const pointer = await this.store.publishDelivery(
      run,
      delivered.map((entry) => entry.reportNo),
    );
    run.deliveryFile = pointer.file;
    run.state = "complete";
    run.finishedAt = pointer.createdAt;
    run.lastError = null;
    this.lastError = null;
    try {
      await this.store.saveRun(run);
    } catch (error) {
      // The pointer already committed this run; recovery will finish the state
      // write on restart. Surface it, but never report the delivery as failed.
      this.recordCleanup([`state write after commit: ${describe(error)}`]);
    }
    this.committedRunId = run.runId;
    if (pointer.reports !== delivered.length) {
      throw new CollectAborted(
        `Delivery contains ${pointer.reports} reports, expected ${delivered.length}`,
      );
    }
    const cleanup = await this.store.cleanupDeliveries().catch((error) => {
      this.recordCleanup([describe(error)]);
      return null;
    });
    if (cleanup) this.recordCleanup(cleanup.failed);
    return this.resultFromRun(run, true);
  }

  /** Fetch body + all appendices, retrying the whole report when its session/token is invalidated. */
  private async collectReport(
    client: SignedClient,
    run: PersistedRun,
    entry: RunEntry,
  ): Promise<ReportRecord> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.reportAttempts; attempt++) {
      try {
        return await this.fetchAndMerge(client, run, entry);
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof TokenRejectedError ||
          error instanceof SessionLostError ||
          (error instanceof SiteFetchError && error.kind === "network");
        if (!retryable) throw error;
        if (error instanceof SessionLostError || error instanceof SiteFetchError) {
          await client.reconnect();
        }
        await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
      }
    }
    throw new CollectAborted(
      `Report ${entry.reportNo} failed after ${this.reportAttempts} attempts: ${describe(lastError)}`,
    );
  }

  private async fetchAndMerge(
    client: SignedClient,
    run: PersistedRun,
    entry: RunEntry,
  ): Promise<ReportRecord> {
    const bodyUrl = new URL(`/reports/${encodeURIComponent(entry.reportNo)}`, run.siteUrl);
    const parts: PagePart[] = [];
    const seen = new Set<string>();

    let currentUrl: string | null = bodyUrl.toString();
    let pagesFetched = 0;
    while (currentUrl) {
      const { html, finalUrl } = await client.get(currentUrl);
      if (seen.has(finalUrl)) throw new ParseError(`Paging loop detected at ${finalUrl}`);
      seen.add(finalUrl);
      parts.push({ url: finalUrl, html });
      pagesFetched += 1;
      if (pagesFetched > 50) throw new ParseError(`Too many appendix pages for ${entry.reportNo}`);

      const parsed = parsePage(html, { expectedSnapshotId: run.snapshotId, sourceUrl: finalUrl });
      if (parts.length > 1 && parsed.pageKind !== "appendix") {
        throw new ParseError(`Expected an appendix page at ${finalUrl}, got another document`);
      }
      if (parsed.snapshotId !== run.snapshotId) {
        throw new ParseError(
          `Page ${finalUrl} belongs to snapshot ${parsed.snapshotId}, expected ${run.snapshotId}`,
        );
      }
      if (parsed.revision !== entry.revision) {
        throw new ParseError(
          `Page ${finalUrl} has revision ${parsed.revision}, directory says ${entry.revision}`,
        );
      }
      currentUrl = parsed.nextLink ? new URL(parsed.nextLink, finalUrl).toString() : null;
    }

    const merged = mergeReportParts(parts, {
      expectedSnapshotId: run.snapshotId,
      expectedRevision: entry.revision,
    });
    if (merged.record.samples.length === 0) {
      throw new ParseError(`Report ${entry.reportNo} has no samples`);
    }
    return {
      ...merged.record,
      collectedAt: new Date().toISOString(),
    };
  }

  progress(): ProgressSnapshot {
    const run = this.activeRun;
    // The pointer swap is the commit point. If it names this run, report the
    // run as complete (and delivered) immediately, so `progress` and
    // `/api/download` can never disagree while the state write catches up.
    const committed = run !== null && this.committedRunId === run.runId;
    const liveState: ProgressSnapshot["state"] | null = committed
      ? "complete"
      : this.liveState === "running"
        ? "running"
        : null;
    const base = toProgress(run, liveState, 0, this.lastError, this.committedRunId);
    // A cleanup problem is surfaced as lastError only when the run itself has
    // nothing more important to report.
    return this.cleanupError && !base.lastError ? { ...base, lastError: this.cleanupError } : base;
  }

  private resultFromRun(run: PersistedRun, deliveryPublished: boolean): RunResult {
    return {
      runId: run.runId,
      state: run.state,
      snapshotId: run.snapshotId,
      expectedReports: run.expectedReports,
      deliveredReports: run.entries.filter((entry) => entry.status === "delivered").length,
      missing: run.entries
        .filter((entry) => entry.status === "missing")
        .map((entry) => ({ reportNo: entry.reportNo, reason: entry.reason ?? "unavailable" })),
      failed: run.entries
        .filter((entry) => entry.status === "failed")
        .map((entry) => ({ reportNo: entry.reportNo, reason: entry.reason ?? "unknown" })),
      deliveryPublished,
      cleanup: this.cleanupError ? [this.cleanupError] : [],
    };
  }
}

function classifyFailure(error: unknown): { status: Exclude<EntryStatus, "pending" | "delivered">; reason: string } {
  if (error instanceof SiteFetchError && error.status === 404) {
    return { status: "missing", reason: `Site reports the report unavailable (${error.code ?? "404"})` };
  }
  if (error instanceof ParseError) {
    return { status: "failed", reason: `Parse failure: ${error.message}` };
  }
  if (error instanceof CollectAborted) {
    return { status: "failed", reason: error.message };
  }
  if (error instanceof SiteFetchError) {
    return { status: "failed", reason: `${error.kind} failure: ${error.message}` };
  }
  return { status: "failed", reason: describe(error) };
}

function isPermanentFetchError(error: unknown): boolean {
  return error instanceof SiteFetchError && error.status !== null && error.status >= 400 && error.status < 500;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
