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
  type PageFragment,
} from "./storage.js";
import type { ProgressSnapshot } from "../shared/types.js";

/**
 * Safety bound on the number of pages walked for one report. Real long reports
 * may exceed the legacy 50-appendix-page limit; this only stops paging loops.
 */
const MAX_PAGES_PER_REPORT = 200;

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
    run.expectedReports = directory.entries.length;
    await this.store.saveRun(run);

    for (const entry of run.entries) {
      // Any complete record already on disk for this snapshot/revision is
      // trusted and never requested again. This also covers a crash between
      // writing a report and persisting its status.
      const stored = await this.store.readReport(run.snapshotId, entry.reportNo, entry.revision);
      if (stored) {
        // Leftover fragments from the run that completed this record are
        // obsolete; the complete report file is the durable source of truth.
        await this.store.clearPageFragments(run.snapshotId, entry.reportNo);
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
        await this.store.clearPageFragments(run.snapshotId, entry.reportNo);
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
  ): Promise<ReportRecord> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.reportAttempts; attempt++) {
      try {
        // On the first attempt we may hold pages confirmed by an earlier
        // process. Every later attempt follows a lost session or a rejected
        // token, so the current session cannot use any earlier appendix
        // token: re-enter through the body with an explicit resume entry.
        const resumeViaBody = attempt > 1;
        return await this.fetchAndMerge(client, run, entry, resumeViaBody);
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
    resumeViaBody: boolean,
  ): Promise<ReportRecord> {
    // Every page already confirmed on disk (across earlier sessions or a
    // previous process) is trusted and never requested again. Fragments must
    // form an ordered prefix: body (page 0) followed by appendix pages 1..N.
    // A gap means the durable history is unusable, so the report restarts
    // from its body and the stale fragments are overwritten as pages recur.
    const fragments = await this.store.readPageFragments(run.snapshotId, entry.reportNo, entry.revision);
    const confirmedPages = new Map<number, PageFragment>();
    let contiguous = fragments.length > 0 && fragments[0]!.page === 0;
    if (contiguous) {
      fragments.forEach((fragment, index) => {
        if (fragment.page !== index) contiguous = false;
      });
    }
    if (contiguous) {
      for (const fragment of fragments) confirmedPages.set(fragment.page, fragment);
    }
    // Session/token recovery always goes through a resume entry; a process
    // restart resumes purely from whatever durable prefix exists.
    const useResumeEntry = resumeViaBody || confirmedPages.size > 1;

    const parts: PagePart[] = [];
    const savedAt = new Date().toISOString();
    const persist = async (page: number, url: string, html: string): Promise<void> => {
      const fragment: PageFragment = {
        reportNo: entry.reportNo,
        revision: entry.revision,
        snapshotId: run.snapshotId,
        page,
        url,
        html,
        savedAt,
      };
      await this.store.writePageFragment(run.snapshotId, fragment);
      confirmedPages.set(page, fragment);
    };

    // ---- Body (page 0) -------------------------------------------------
    const bodyUrl = new URL(`/reports/${encodeURIComponent(entry.reportNo)}`, run.siteUrl);
    let resumePage = 0; // highest confirmed appendix page
    let bodyPart: PagePart;
    if (confirmedPages.has(0)) {
      const bodyFragment = confirmedPages.get(0)!;
      bodyPart = { url: bodyFragment.url, html: bodyFragment.html };
      for (const page of [...confirmedPages.keys()].filter((p) => p > 0).sort((a, b) => a - b)) {
        const fragment = confirmedPages.get(page)!;
        parts.push({ url: fragment.url, html: fragment.html });
        resumePage = page;
      }
    } else {
      const { html, finalUrl } = await client.get(bodyUrl.toString());
      this.assertPage(html, finalUrl, run, entry, "body");
      await persist(0, finalUrl, html);
      bodyPart = { url: finalUrl, html };
    }
    parts.unshift(bodyPart);

    // ---- First appendix entry ------------------------------------------
    // Normal crawl: follow the appendix-1 link discovered in the body, so
    // paging entries always come from page content. Recovery/resume: ask the
    // body for a fresh single-use token to the first unconfirmed page.
    let currentUrl: string | null;
    if (useResumeEntry) {
      const resumeEntryUrl = `${bodyUrl.toString()}?resumePage=${resumePage + 1}`;
      const { html: resumeHtml, finalUrl: resumeFinalUrl } = await client.get(resumeEntryUrl);
      this.assertPage(resumeHtml, resumeFinalUrl, run, entry, "body");
      const resumeParsed = parsePage(resumeHtml, {
        expectedSnapshotId: run.snapshotId,
        sourceUrl: resumeFinalUrl,
      });
      // No resume link means the confirmed prefix already covers every page.
      currentUrl = resumeParsed.resumeLink
        ? new URL(resumeParsed.resumeLink, resumeFinalUrl).toString()
        : null;
    } else {
      const bodyParsed = parsePage(bodyPart.html, {
        expectedSnapshotId: run.snapshotId,
        sourceUrl: bodyPart.url,
      });
      currentUrl = bodyParsed.nextLink ? new URL(bodyParsed.nextLink, bodyPart.url).toString() : null;
    }

    let totalPages = parts.length;
    while (currentUrl) {
      const { html, finalUrl } = await client.get(currentUrl);
      this.assertPage(html, finalUrl, run, entry, "appendix");
      const parsed = parsePage(html, { expectedSnapshotId: run.snapshotId, sourceUrl: finalUrl });
      const pageNumber = this.appendixPageNumber(finalUrl);

      // Durable confirmation happens before the in-memory merge, so a crash
      // at any point resumes exactly after the last fsync'd page.
      await persist(pageNumber, finalUrl, html);
      parts.push({ url: finalUrl, html });
      totalPages += 1;
      if (totalPages > MAX_PAGES_PER_REPORT) {
        throw new ParseError(`Too many appendix pages for ${entry.reportNo}`);
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

  /** Parse and validate one freshly fetched page against the pinned run. */
  private assertPage(
    html: string,
    finalUrl: string,
    run: PersistedRun,
    entry: RunEntry,
    expectedKind: "body" | "appendix",
  ): void {
    const parsed = parsePage(html, { expectedSnapshotId: run.snapshotId, sourceUrl: finalUrl });
    if (expectedKind === "appendix" && parsed.pageKind !== "appendix") {
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
  }

  private appendixPageNumber(url: string): number {
    const match = /\/appendix\/(\d+)(?:[?#]|$)/.exec(new URL(url).pathname);
    if (!match) throw new ParseError(`Appendix URL has no page number: ${url}`);
    return Number(match[1]);
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
        .map((entry) => ({ reportNo: entry.reportNo, reason: entry.reason ?? "unknown" })),
      deliveryPublished,
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
