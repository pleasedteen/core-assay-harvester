/** Snapshot-pinned collection orchestrator with durable, resumable progress. */

import { randomUUID } from "node:crypto";
import type { ReportDeclaration, ReportRecord } from "../shared/types.js";
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
import { describeDiscrepancies, verifyAgainstDeclaration } from "./verify.js";
import type { ProgressSnapshot } from "../shared/types.js";

/** Raised when a fetched or cached report disagrees with its declaration. */
export class VerificationError extends Error {
  constructor(
    readonly reportNo: string,
    readonly discrepancies: ReturnType<typeof verifyAgainstDeclaration>,
  ) {
    super(`Declaration verification failed for ${reportNo}: ${describeDiscrepancies(discrepancies)}`);
    this.name = "VerificationError";
  }
}

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
  failed: Array<{ reportNo: string; reason: string; discrepancies?: ReturnType<typeof verifyAgainstDeclaration> }>;
  deliveryPublished: boolean;
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
    const run = await this.store.loadRun();
    if (!run) return;
    if (run.state === "running") {
      run.state = "interrupted";
      run.lastError = "Previous collector process stopped while the run was in progress.";
      await this.store.saveRun(run);
    }
    this.activeRun = run;
    this.lastError = run.lastError;
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
    run.startedAt = run.startedAt || new Date().toISOString();
    run.lastError = null;
    await this.store.saveRun(run);
    this.activeRun = run;
    this.liveState = "running";
    this.lastError = null;

    this.activePromise = this.execute(run)
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        run.state = "failed";
        run.lastError = message;
        this.lastError = message;
        await this.store.saveRun(run);
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
      declarations: directory.declarations,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      lastError: null,
      resumedFrom: null,
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
    // The directory manifest is the only authority used to verify the cache.
    run.declarations = directory.declarations;
    run.expectedReports = directory.entries.length;
    const declarationByReport = new Map(
      directory.declarations.map((declaration) => [declaration.reportNo, declaration]),
    );
    await this.store.saveRun(run);

    for (const entry of run.entries) {
      const declaration = declarationByReport.get(entry.reportNo);
      // Any complete record already on disk for this snapshot/revision is
      // trusted only if it still satisfies the site's directory declaration.
      // Verification reads the cached report only — no body or appendix page
      // is requested for an intact cache entry. A report that cannot be
      // verified is re-collected below.
      const stored = await this.store.readReport(run.snapshotId, entry.reportNo, entry.revision);
      if (stored) {
        const cacheIssues = declaration ? verifyAgainstDeclaration(stored, declaration) : [];
        if (cacheIssues.length === 0) {
          const wasDelivered = entry.status === "delivered";
          entry.status = "delivered";
          entry.sampleCount = stored.samples.length;
          delete entry.reason;
          delete entry.discrepancies;
          if (!wasDelivered) await this.store.saveRun(run);
          continue;
        }
        // The cached copy is stale relative to the declaration: drop its
        // "delivered" claim and re-collect the report.
        entry.status = "pending";
        entry.reason = `Cached report fails declaration verification, re-collecting: ${describeDiscrepancies(cacheIssues)}`;
        await this.store.saveRun(run);
      } else if (entry.status === "delivered") {
        entry.status = "pending";
        await this.store.saveRun(run);
      }

      try {
        const record = await this.collectReport(client, run, entry, declaration);
        await this.store.writeReport(run.snapshotId, record);
        entry.status = "delivered";
        entry.sampleCount = record.samples.length;
        delete entry.reason;
        delete entry.discrepancies;
      } catch (error) {
        if (error instanceof CollectAborted) throw error;
        const { status, reason, discrepancies } = classifyFailure(error);
        entry.status = status;
        entry.reason = reason;
        if (discrepancies) entry.discrepancies = discrepancies;
        else delete entry.discrepancies;
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

    // Complete snapshot: atomically publish a new delivery, leaving the
    // previous one fully downloadable until the pointer swap.
    const pointer = await this.store.publishDelivery(
      run.snapshotId,
      delivered.map((entry) => entry.reportNo),
    );
    run.state = "complete";
    run.finishedAt = new Date().toISOString();
    run.lastError = null;
    this.lastError = null;
    await this.store.saveRun(run);
    if (pointer.reports !== delivered.length) {
      throw new CollectAborted(
        `Delivery contains ${pointer.reports} reports, expected ${delivered.length}`,
      );
    }
    return this.resultFromRun(run, true);
  }

  /** Fetch body + all appendices, retrying the whole report when its session/token is invalidated. */
  private async collectReport(
    client: SignedClient,
    run: PersistedRun,
    entry: RunEntry,
    declaration: ReportDeclaration | undefined,
  ): Promise<ReportRecord> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.reportAttempts; attempt++) {
      try {
        return await this.fetchAndMerge(client, run, entry, declaration);
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
    declaration: ReportDeclaration | undefined,
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
    // Reconcile the parsed body and every appendix page with the directory
    // manifest: sample rows, per-sample detection items, duplicates and
    // quantifiable detection limits. A report with zero samples is itself a
    // declaration discrepancy, not a parse error.
    if (declaration) {
      const discrepancies = verifyAgainstDeclaration(merged.record, declaration);
      if (discrepancies.length > 0) {
        throw new VerificationError(entry.reportNo, discrepancies);
      }
    }
    if (merged.record.samples.length === 0) {
      throw new ParseError(`Report ${entry.reportNo} has no samples`);
    }
    return {
      ...merged.record,
      collectedAt: new Date().toISOString(),
    };
  }

  progress(): ProgressSnapshot {
    if (this.liveState === "running" && this.activeRun) {
      return { ...toProgress(this.activeRun, "running"), lastError: this.lastError };
    }
    return toProgress(this.activeRun, null, 0, this.lastError);
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
        .map((entry) => ({
          reportNo: entry.reportNo,
          reason: entry.reason ?? "unknown",
          ...(entry.discrepancies ? { discrepancies: entry.discrepancies } : {}),
        })),
      deliveryPublished,
    };
  }
}

function classifyFailure(error: unknown): {
  status: Exclude<EntryStatus, "pending" | "delivered">;
  reason: string;
  discrepancies?: ReturnType<typeof verifyAgainstDeclaration>;
} {
  if (error instanceof VerificationError) {
    return {
      status: "failed",
      reason: `Declaration verification failed: ${describeDiscrepancies(error.discrepancies)}`,
      discrepancies: error.discrepancies,
    };
  }
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
