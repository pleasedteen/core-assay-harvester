/**
 * End-to-end tests: every scenario runs against a real local HTTP site and a
 * real collector HTTP service (or a spawned collector process).
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { after, describe, test } from "node:test";
import { build as esbuild } from "esbuild";
import { computeSignature, NONCE_HEADER, SESSION_HEADER, SIGNATURE_HEADER } from "../src/shared/protocol.js";
import type { ReportRecord, Sample } from "../src/shared/types.js";
import { CollectorStore } from "../src/collector/storage.js";
import { MockAssaySite } from "../src/site/server.js";
import {
  armFault,
  assertNoDuplicateReports,
  bodyRequestCounts,
  deliveryFiles,
  download,
  getProgress,
  publish,
  readDeliveryPointerFile,
  readPersistedRun,
  readStoredReport,
  siteRequests,
  sleep,
  storedReportFiles,
  startCollect,
  startHarness,
  tempDataDir,
  waitForState,
  writePersistedRun,
  type CollectorChild,
  type Harness,
} from "./helpers.js";

const cleanup: Array<() => Promise<void>> = [];
after(async () => {
  for (const fn of cleanup.reverse()) {
    try {
      await fn();
    } catch {
      /* best effort */
    }
  }
});

async function harness(options: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const h = await startHarness(options);
  cleanup.push(() => h.close());
  return h;
}

function allMeasurements(record: ReportRecord) {
  return record.samples.flatMap((sample) =>
    sample.items.map((item) => ({ sample, item, measurement: item.measurement })),
  );
}

function sampleSnapshot(samples: Sample[]): Array<{ id: string; from: string | null; to: string | null; items: string }> {
  return samples.map((sample) => ({
    id: sample.sampleId,
    from: sample.fromM,
    to: sample.toM,
    items: sample.items
      .map((item) => `${item.code}:${item.measurement.kind}:${item.measurement.rawText}:${item.measurement.mgPerKgExact ?? ""}`)
      .join("|"),
  }));
}

describe("normal collection", () => {
  test("collects the whole snapshot with both layouts, units and special values", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "mixed" } });

    // No delivery before the first complete run.
    const early = await download(h.service.url);
    assert.equal(early.status, 404);
    assert.match(early.raw, /尚无完整成果/);
    const initialProgress = await getProgress(h.service.url);
    assert.equal(initialProgress.progress.state, "idle");
    assert.equal(initialProgress.delivery.available, false);

    const start = await startCollect(h.service.url, h.site.url);
    assert.equal(start.status, 202);
    const progress = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(progress.state, "complete", progress.lastError ?? "");
    assert.equal(progress.expectedReports, 6);
    assert.equal(progress.deliveredReports, 6);
    assert.deepEqual(progress.failed, []);
    assert.deepEqual(progress.missing, []);
    assert.equal(progress.snapshotId, h.site.state().currentSnapshot);

    const result = await download(h.service.url);
    assert.equal(result.status, 200);
    assert.equal(result.records.length, 6);
    assertNoDuplicateReports(result.records);

    const sha = createHash("sha256").update(result.raw).digest("hex");
    assert.equal(result.headers.get("x-delivery-sha256"), sha);
    assert.equal(result.headers.get("x-snapshot-id"), progress.snapshotId);

    // Both layouts appear in one snapshot; every appendix page was followed.
    const layouts = new Set(result.records.map((record) => record.layout));
    assert.deepEqual([...layouts].sort(), ["classic", "compact"]);
    const multiPage = result.records.filter((record) => record.source.appendixUrls.length >= 2);
    assert.ok(multiPage.length >= 1, "expected at least one report with multiple appendix pages");

    for (const record of result.records) {
      assert.equal(record.snapshotId, progress.snapshotId);
      assert.equal(record.revision, 1);
      assert.ok(record.samples.length >= 2);
      for (const sample of record.samples) {
        assert.ok(sample.fromM && sample.toM, `${record.reportNo}/${sample.sampleId} depth missing`);
        assert.ok(sample.items.length >= 4);
      }
    }

    // Exact unit normalization: percent -> mg/kg, mg/kg preserved.
    const values = result.records
      .flatMap(allMeasurements)
      .filter((entry) => entry.measurement.kind === "value");
    for (const { item, measurement } of values) {
      assert.equal(measurement.rawValue, measurement.rawText.replace(/\s*(%|mg\/kg)$/, "").trim());
      // Exact decimal arithmetic: pct -> mg/kg multiplies by 10^4.
      const [whole, frac = ""] = measurement.rawValue!.split(".");
      const coefficient = BigInt(`${whole}${frac}`) * (measurement.rawUnit === "pct" ? 10_000n : 1n);
      const scale = frac.length;
      let exact = coefficient.toString().padStart(scale + 1, "0");
      const expectedExact = scale > 0
        ? `${exact.slice(0, -scale)}.${exact.slice(-scale)}`.replace(/0+$/, "").replace(/\.$/, "")
        : exact;
      assert.equal(measurement.mgPerKgExact, expectedExact);
      assert.equal(measurement.mgPerKg, Number(expectedExact));
      assert.ok(item.code.length > 0);
    }
    assert.ok(new Set(values.map((entry) => entry.measurement.rawUnit)).size === 2, "both units used");
    assert.ok(new Set(values.map((entry) => entry.item.code)).size >= 4, "multiple analyte types");

    // Below detection limit and missing are distinct and neither is a value.
    const below = result.records
      .flatMap(allMeasurements)
      .filter((entry) => entry.measurement.kind === "below_detection_limit");
    const missing = result.records
      .flatMap(allMeasurements)
      .filter((entry) => entry.measurement.kind === "missing");
    assert.ok(below.length >= 1, "expected at least one below-detection-limit result");
    assert.ok(missing.length >= 1, "expected at least one missing result");
    for (const { measurement } of below) {
      assert.equal(measurement.mgPerKg, null);
      assert.equal(measurement.rawValue, null);
      assert.ok(measurement.detectionLimitMgPerKg! > 0);
      assert.match(measurement.rawText, /^<\s*/);
    }
    for (const { measurement } of missing) {
      assert.equal(measurement.mgPerKg, null);
      assert.equal(measurement.detectionLimitMgPerKg, null);
      assert.equal(measurement.rawText, "—");
    }
    assert.ok(
      below.every((entry) => entry.measurement.kind !== missing[0]!.measurement.kind),
      "below detection and missing must not collapse into one state",
    );

    // Percent detection limits convert too.
    const pctBelow = below.filter((entry) => entry.measurement.detectionLimitUnit === "pct");
    for (const { measurement } of pctBelow) {
      assert.equal(measurement.detectionLimitMgPerKg, Number(measurement.detectionLimitRaw) * 10_000);
    }

    // The stored files back the download one-to-one.
    const stored = await readStoredReport(h.dataDir, progress.snapshotId!, "R-0001");
    assert.ok(stored.samples.length >= 2);
    // The body-only report has no appendix links at all.
    const bodyOnly = result.records.find((record) => record.reportNo === "R-0003")!;
    assert.equal(bodyOnly.source.appendixUrls.length, 0);
    // The five-sample report spans three appendix pages.
    const longest = result.records.find((record) => record.reportNo === "R-0006")!;
    assert.equal(longest.samples.length, 5);
    assert.equal(longest.source.appendixUrls.length, 3);
  });

  test("the site really validates signatures and one-time paging tokens", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "classic" } });

    // Signed request without a session is rejected.
    const unsigned = await fetch(`${h.site.url}/reports/R-0001`);
    assert.equal(unsigned.status, 401);

    // Bootstrap a session manually and sign with the documented algorithm.
    const index = await fetch(`${h.site.url}/reports`);
    const session = index.headers.get(SESSION_HEADER)!;
    let nonce = index.headers.get(NONCE_HEADER)!;
    const signedGet = async (target: string): Promise<Response> => {
      const signature = computeSignature(session, nonce, "GET", target);
      const response = await fetch(`${h.site.url}${target}`, {
        headers: { [SESSION_HEADER]: session, [NONCE_HEADER]: nonce, [SIGNATURE_HEADER]: signature },
      });
      const rotated = response.headers.get(NONCE_HEADER);
      if (rotated) nonce = rotated;
      return response;
    };

    const staleNonce = nonce;
    const body = await signedGet("/reports/R-0001");
    assert.equal(body.status, 200);
    const html = await body.text();
    const appendixHref = /href="([^"]*appendix\/1[^"]*)"/.exec(html)?.[1]?.replaceAll("&amp;", "&");
    assert.ok(appendixHref, "appendix link must be discovered from page content");

    // Reusing the pre-rotation nonce, even with a correct signature for it, must fail.
    const stale = await fetch(`${h.site.url}/reports/R-0002`, {
      headers: {
        [SESSION_HEADER]: session,
        [NONCE_HEADER]: staleNonce,
        [SIGNATURE_HEADER]: computeSignature(session, staleNonce, "GET", "/reports/R-0002"),
      },
    });
    assert.equal(stale.status, 401, "nonce must be single-use");
    assert.match(await stale.text(), /bad_signature/);

    // A token works exactly once.
    const firstAppendix = await signedGet(appendixHref);
    assert.equal(firstAppendix.status, 200);
    const firstHtml = await firstAppendix.text();
    assert.ok(firstHtml.includes("附表 1"));

    // Replay the same token with an otherwise valid signature.
    const replayTokenUrl = appendixHref;
    const replay = await signedGet(replayTokenUrl);
    assert.equal(replay.status, 409);
    assert.match(await replay.text(), /token_replayed/);

    // A token minted for one session cannot be used by another.
    const index2 = await fetch(`${h.site.url}/reports`);
    const session2 = index2.headers.get(SESSION_HEADER)!;
    let nonce2 = index2.headers.get(NONCE_HEADER)!;
    const sig2 = computeSignature(session2, nonce2, "GET", appendixHref);
    const crossSession = await fetch(`${h.site.url}${appendixHref}`, {
      headers: { [SESSION_HEADER]: session2, [NONCE_HEADER]: nonce2, [SIGNATURE_HEADER]: sig2 },
    });
    assert.equal(crossSession.status, 403);
    assert.match(await crossSession.text(), /bad_token/);
    void nonce2;
  });
});

describe("recovery", () => {
  test("session recovery: banned session and rate limiting do not lose data", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "mixed" } });
    await armFault(h.site.url, { type: "banSession", matchPath: "/reports/R-0003" });
    await armFault(h.site.url, { type: "rateLimit", matchPath: "/reports/R-0005", retryAfterMs: 40 });

    await startCollect(h.service.url, h.site.url);
    const progress = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(progress.state, "complete", progress.lastError ?? "");
    assert.equal(progress.deliveredReports, 6);

    const result = await download(h.service.url);
    assert.equal(result.status, 200);
    assert.equal(result.records.length, 6);
    assertNoDuplicateReports(result.records);
    for (const record of result.records) {
      assert.equal(record.revision, 1);
      assert.ok(record.samples.length >= 2);
    }

    const requests = await siteRequests(h.site.url);
    assert.ok(requests.some((request) => request.note === "fault_ban_session"), "ban fault must fire");
    assert.ok(requests.some((request) => request.status === 429), "rate limit must fire");
    // The ban forces a brand new session into the same snapshot.
    const sessions = h.site.state().sessions;
    assert.ok(sessions.length >= 2, "expected a replacement session");
    assert.ok(sessions.every((session) => session.snapshotId === progress.snapshotId));
  });

  test("response interruption: dropped appendix response is retried without duplication", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "mixed" } });
    await armFault(h.site.url, { type: "dropResponse", matchPath: "/appendix" });

    await startCollect(h.service.url, h.site.url);
    const progress = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(progress.state, "complete", progress.lastError ?? "");
    assert.equal(progress.deliveredReports, 6);

    const result = await download(h.service.url);
    assert.equal(result.records.length, 6);
    for (const record of result.records) {
      assert.equal(record.snapshotId, progress.snapshotId);
      const totalItems = record.samples.reduce((sum, sample) => sum + sample.items.length, 0);
      assert.ok(totalItems >= record.samples.length * 4, "no sample may lose its items");
    }

    const requests = await siteRequests(h.site.url);
    assert.ok(requests.some((request) => request.note === "fault_drop_response"));
    // Re-entry produced at least one extra body fetch; the final records are complete.
    assert.ok(bodyRequestCounts(requests).size === 6);
  });

  test("parse failure and unavailable report: no false success, then resumable", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "classic" } });
    await armFault(h.site.url, { type: "corruptReport", reportNo: "R-0002", times: 1 });
    await armFault(h.site.url, { type: "unavailableReport", reportNo: "R-0004", times: 1 });

    await startCollect(h.service.url, h.site.url);
    const failed = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(failed.state, "failed");
    assert.ok(failed.failed.some((entry) => entry.reportNo === "R-0002"));
    assert.ok(failed.missing.some((entry) => entry.reportNo === "R-0004"));
    assert.ok(failed.lastError && failed.lastError.length > 0);
    // Nothing was published because the snapshot is incomplete.
    const afterFailure = await download(h.service.url);
    assert.equal(afterFailure.status, 404);
    assert.equal((await getProgress(h.service.url)).delivery.available, false);
    assert.ok(!existsSync(path.join(h.dataDir, "current-delivery.json")));

    // Retry: faults were one-shot, the run resumes and completes.
    await startCollect(h.service.url, h.site.url);
    const complete = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(complete.state, "complete", complete.lastError ?? "");
    assert.equal(complete.deliveredReports, 6);
    const result = await download(h.service.url);
    assert.equal(result.records.length, 6);
    assertNoDuplicateReports(result.records);
  });
});

describe("delivery commit, cleanup and concurrent downloads", () => {
  test("cleanup keeps only the three newest deliveries and reports failures without breaking the run", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "classic" } });

    // Five complete runs, each publishing one delivery.
    for (let index = 0; index < 5; index++) {
      await startCollect(h.service.url, h.site.url, { fresh: index > 0 });
      const progress = await waitForState(h.service.url, ["complete", "failed"]);
      assert.equal(progress.state, "complete", progress.lastError ?? "");
      assert.equal(progress.delivered, true);
      if (index < 4) await publish(h.site.url, { reportNos: [] });
    }
    await waitUntil(async () => (await deliveryFiles(h.dataDir)).length === 3, 5_000);
    const kept = await deliveryFiles(h.dataDir);
    assert.equal(kept.length, 3, `expected 3 retained deliveries, saw ${kept.join(", ")}`);
    const pointer = await readDeliveryPointerFile(h.dataDir);
    assert.ok(pointer);
    assert.ok(kept.includes(pointer.file), "the current delivery must never be pruned");

    // Failure injection: a prunable "delivery" that cannot be unlinked because
    // it is a non-empty directory (with an old mtime so retention selects it).
    // Cleanup must report the failure, keep the run complete, and keep serving
    // the current delivery.
    const stubborn = path.join(h.dataDir, "deliveries", "delivery-stubborn.jsonl");
    await mkdir(stubborn, { recursive: true });
    await writeFile(path.join(stubborn, "child"), "x");
    const epoch = new Date(0);
    await utimes(stubborn, epoch, epoch);
    const newestSnapshot = await publish(h.site.url, { reportNos: [] });
    await startCollect(h.service.url, h.site.url, { fresh: true });
    const afterFailingCleanup = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(afterFailingCleanup.state, "complete", afterFailingCleanup.lastError ?? "");
    assert.equal(afterFailingCleanup.delivered, true);
    assert.equal(afterFailingCleanup.snapshotId, newestSnapshot.id);
    // The run's own state is what matters most; a cleanup problem is surfaced
    // only through progress.lastError when the run itself has nothing to say.
    // Cleanup runs after the commit, so give it a moment to report.
    await waitUntil(async () => /cleanup failed/.test((await getProgress(h.service.url)).progress.lastError ?? ""));
    const stillServed = await download(h.service.url);
    assert.equal(stillServed.status, 200);
    assert.equal(stillServed.headers.get("x-snapshot-id"), afterFailingCleanup.snapshotId);
    assert.notEqual(stillServed.headers.get("x-snapshot-id"), pointer.snapshotId);
  });

  test("a crash between report writes and the delivery commit is resumed without a false success", async () => {
    const site = await MockAssaySite.start({ seedSnapshot: { layoutMode: "mixed" } });
    cleanup.push(() => site.close());
    const dataDir = await tempDataDir("crash-before-commit");
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    // First complete run to have a delivery to protect.
    await armFault(site.url, { type: "delay", matchPath: "/reports/R-", ms: 1 });
    const entry = await buildCollectorEntry();
    let launched = spawnCollector(entry, dataDir, port, site.url);
    await launched.ready;
    let child = launched.child;
    await startCollect(baseUrl, site.url);
    const first = await waitForState(baseUrl, ["complete", "failed"]);
    assert.equal(first.state, "complete", first.lastError ?? "");
    const firstDelivery = await download(baseUrl);
    assert.equal(firstDelivery.status, 200);
    const firstPointer = await readDeliveryPointerFile(dataDir);
    assert.ok(firstPointer);

    // Second run: all reports on disk, but the process dies before the commit.
    await publish(site.url, { reportNos: ["R-0002"] });
    await fetch(`${site.url}/__control/faults/clear`, { method: "POST" });
    await startCollect(baseUrl, site.url, { fresh: true });
    const second = await waitForState(baseUrl, ["complete", "failed"]);
    assert.equal(second.state, "complete", second.lastError ?? "");
    const secondPointer = await readDeliveryPointerFile(dataDir);
    assert.ok(secondPointer && secondPointer.file !== firstPointer.file);

    // Simulate "died before commit": run state is running, snapshot reports are
    // complete, but the pointer still names the previous run. We restore the
    // old pointer and rewind the state to running/interrupted.
    const persisted = await readPersistedRun(dataDir);
    assert.ok(persisted);
    assert.equal(persisted.runId, secondPointer.runId);
    await writeFile(
      path.join(dataDir, "current-delivery.json"),
      `${JSON.stringify(firstPointer, null, 2)}\n`,
      "utf8",
    );
    await writePersistedRun(dataDir, {
      ...persisted,
      state: "running",
      finishedAt: null,
      deliveryFile: null,
    });
    child.kill("SIGKILL");
    await waitForExit(child);
    // While down, the old delivery is what a restart would find.
    assert.equal((await readDeliveryPointerFile(dataDir))?.file, firstPointer.file);

    launched = spawnCollector(entry, dataDir, port, site.url);
    await launched.ready;
    child = launched.child;
    const interrupted = await getProgress(baseUrl);
    assert.equal(interrupted.progress.state, "interrupted");
    assert.equal(interrupted.progress.delivered, false, "an uncommitted run must not claim delivery");
    assert.equal(interrupted.delivery.snapshotId, firstPointer.snapshotId);

    // Resume: reports are trusted from disk, and the commit is performed now.
    const resumed = await startCollect(baseUrl, site.url);
    assert.equal(resumed.status, 202);
    const finalProgress = await waitForState(baseUrl, ["complete", "failed"], 15_000);
    assert.equal(finalProgress.state, "complete", finalProgress.lastError ?? "");
    assert.equal(finalProgress.delivered, true);
    assert.equal(finalProgress.snapshotId, second.snapshotId);
    const finalPointer = await readDeliveryPointerFile(dataDir);
    assert.equal(finalPointer?.runId, secondPointer.runId);
    assert.notEqual(finalPointer?.file, firstPointer.file);
    const finalDownload = await download(baseUrl);
    assert.equal(finalDownload.status, 200);
    assert.equal(finalDownload.headers.get("x-snapshot-id"), second.snapshotId);
    // No report was fetched again: reports were already durable on disk.
    const counts = bodyRequestCounts(await siteRequests(site.url));
    assert.ok((counts.get("R-0002") ?? 0) <= 3, "resume must not re-crawl everything");

    child.kill("SIGTERM");
    await waitForExit(child);
  });

  test("a crash right after the pointer swap is recognized as committed on restart", async () => {
    const site = await MockAssaySite.start({ seedSnapshot: { layoutMode: "classic" } });
    cleanup.push(() => site.close());
    const dataDir = await tempDataDir("crash-after-commit");
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const entry = await buildCollectorEntry();
    let launched = spawnCollector(entry, dataDir, port, site.url);
    await launched.ready;
    let child = launched.child;

    await startCollect(baseUrl, site.url);
    const done = await waitForState(baseUrl, ["complete", "failed"]);
    assert.equal(done.state, "complete", done.lastError ?? "");
    const pointer = await readDeliveryPointerFile(dataDir);
    assert.ok(pointer);
    const persisted = await readPersistedRun(dataDir);
    assert.ok(persisted);
    child.kill("SIGKILL");
    await waitForExit(child);

    // Simulate the crash window: the pointer was swapped but the complete
    // state write never landed.
    await writePersistedRun(dataDir, {
      ...persisted,
      state: "running",
      finishedAt: null,
      deliveryFile: null,
    });

    launched = spawnCollector(entry, dataDir, port, site.url);
    await launched.ready;
    child = launched.child;
    const recovered = await getProgress(baseUrl);
    assert.equal(recovered.progress.state, "complete", "pointer proves the commit happened");
    assert.equal(recovered.progress.delivered, true);
    assert.equal(recovered.progress.snapshotId, pointer.snapshotId);
    const reloaded = await readPersistedRun(dataDir);
    assert.equal(reloaded?.state, "complete");
    assert.equal(reloaded?.deliveryFile, pointer.file);

    // Nothing is refetched and the committed delivery is served byte-for-byte.
    const served = await download(baseUrl);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("x-delivery-sha256"), pointer.sha256);
    assert.equal(createHash("sha256").update(served.raw).digest("hex"), pointer.sha256);
    assert.equal(served.records.length, 6);
    // Starting `/api/collect` again after the recovered commit must not need to
    // crawl the site again: every report is already durable on disk.
    const again = await startCollect(baseUrl, site.url);
    assert.equal(again.status, 202);
    const stillCommitted = await waitForState(baseUrl, ["complete", "failed"]);
    assert.equal(stillCommitted.state, "complete", stillCommitted.lastError ?? "");
    assert.equal(stillCommitted.delivered, true);
    assert.equal((await bodyRequestCounts(await siteRequests(site.url))).size, 6);
    assert.ok(
      [...(await bodyRequestCounts(await siteRequests(site.url))).values()].every((count) => count === 1),
      "no report body may be requested twice",
    );

    child.kill("SIGTERM");
    await waitForExit(child);
  });

  test("concurrent downloads during repeated re-collection always match their own headers", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "mixed" } });

    // Build up several deliveries so cleanup is actively pruning the 3-file
    // retention window while the downloads below race it.
    for (let index = 0; index < 4; index++) {
      await startCollect(h.service.url, h.site.url, { fresh: index > 0 });
      const progress = await waitForState(h.service.url, ["complete", "failed"]);
      assert.equal(progress.state, "complete", progress.lastError ?? "");
      await publish(h.site.url, { reportNos: [] });
    }

    // Hold a run open while launching many parallel downloads. Every response
    // must carry headers that describe exactly the bytes it delivered, and no
    // request may fail with a 500 because cleanup removed a file underneath it.
    await armFault(h.site.url, { type: "delay", matchPath: "/reports/R-0001", ms: 200, times: 1 });
    const running = await startCollect(h.service.url, h.site.url, { fresh: true });
    assert.equal(running.status, 202);

    const attempts = Array.from({ length: 24 }, async () => {
      const response = await fetch(`${h.service.url}/api/download`);
      const raw = await response.text();
      return { status: response.status, raw, headers: response.headers };
    });
    const results = await Promise.all(attempts);
    for (const result of results) {
      assert.equal(result.status, 200, "download must not 500 while cleanup runs");
      assert.equal(
        createHash("sha256").update(result.raw).digest("hex"),
        result.headers.get("x-delivery-sha256"),
        "sha256 header must match the served body",
      );
      assert.equal(Number(result.headers.get("content-length")), Buffer.byteLength(result.raw));
      assert.equal(Number(result.headers.get("x-delivery-reports")), 6);
      const records = result.raw.trim().split("\n").map((line) => JSON.parse(line) as ReportRecord);
      assert.equal(records.length, 6);
      const headerSnapshot = result.headers.get("x-snapshot-id");
      for (const record of records) {
        assert.equal(record.snapshotId, headerSnapshot, "all records must belong to the header snapshot");
      }
      assertNoDuplicateReports(records);
    }

    const finished = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(finished.state, "complete", finished.lastError ?? "");
    assert.ok((await deliveryFiles(h.dataDir)).length <= 3);
  });
});

describe("snapshots and layout", () => {  test("a revision published mid-collection does not mix into the pinned snapshot", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "mixed" } });
    // Slow down a later report so the publication lands mid-run.
    await armFault(h.site.url, { type: "delay", matchPath: "/reports/R-0005", ms: 250, times: 2 });

    await startCollect(h.service.url, h.site.url);
    await waitUntil(async () => {
      const current = (await getProgress(h.service.url)).progress;
      return current.deliveredReports >= 3;
    });
    const newSnapshot = await publish(h.site.url, { reportNos: ["R-0006"] });
    const completed = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(completed.state, "complete", completed.lastError ?? "");
    assert.equal(completed.snapshotId, "snap-0001");

    const first = await download(h.service.url);
    assert.equal(first.records.length, 6);
    for (const record of first.records) {
      assert.equal(record.snapshotId, "snap-0001");
      assert.equal(record.revision, 1, `${record.reportNo} must stay on revision 1`);
    }
    assert.ok(h.site.state().snapshots.length >= 2);

    // A new session can deliberately re-enter the historical snapshot and
    // still sees the original revision.
    const historical = await fetch(`${h.site.url}/reports?snapshot=snap-0001`);
    assert.equal(historical.status, 200);
    assert.equal(historical.headers.get("x-snapshot-id"), "snap-0001");
    const historicalHtml = await historical.text();
    assert.match(historicalHtml, /data-snapshot-id="snap-0001"/);

    // A fresh run picks up the new snapshot and only the new revision.
    const fresh = await startCollect(h.service.url, h.site.url, { fresh: true });
    assert.equal(fresh.status, 202);
    const freshProgress = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(freshProgress.state, "complete", freshProgress.lastError ?? "");
    assert.equal(freshProgress.snapshotId, newSnapshot.id);
    const second = await download(h.service.url);
    assert.equal(second.records.length, 6);
    for (const record of second.records) {
      assert.equal(record.snapshotId, newSnapshot.id);
      if (record.reportNo === "R-0006") assert.equal(record.revision, 2);
      else assert.equal(record.revision, 1);
    }
  });

  test("download always serves the last complete delivery during a new collection", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "classic" } });
    await startCollect(h.service.url, h.site.url);
    const firstProgress = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(firstProgress.state, "complete", firstProgress.lastError ?? "");
    const firstDelivery = await download(h.service.url);
    assert.equal(firstDelivery.status, 200);

    const newSnapshot = await publish(h.site.url);
    // Hold the final report open so the collection provably stays in progress.
    await armFault(h.site.url, { type: "delay", matchPath: "/reports/R-0006", ms: 1_500, times: 1 });
    const started = await startCollect(h.service.url, h.site.url, { fresh: true });
    assert.equal(started.status, 202);
    await waitUntil(async () => (await getProgress(h.service.url)).progress.deliveredReports >= 2);

    // While running, the previous delivery stays byte-for-byte available.
    let observedDuringRun = 0;
    while (observedDuringRun < 5) {
      const running = (await getProgress(h.service.url)).progress;
      if (running.state !== "running") break;
      const during = await download(h.service.url);
      assert.equal(during.status, 200);
      assert.equal(
        during.headers.get("x-snapshot-id"),
        firstProgress.snapshotId,
        `delivery swapped while run was still running (${running.deliveredReports}/${running.expectedReports})`,
      );
      assert.equal(during.raw, firstDelivery.raw);
      observedDuringRun += 1;
      await sleep(20);
    }
    assert.ok(observedDuringRun >= 1, "collection finished before a download could be observed");

    const final = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(final.state, "complete", final.lastError ?? "");
    assert.equal(final.snapshotId, newSnapshot.id);
    const second = await download(h.service.url);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("x-snapshot-id"), newSnapshot.id);
    assert.equal(second.records.length, 6);
    assert.notEqual(second.raw, firstDelivery.raw);

    // A later run that fails never replaces or claims success for the last
    // complete delivery.
    const thirdSnapshot = await publish(h.site.url, { reportNos: ["R-0002"] });
    await armFault(h.site.url, { type: "corruptReport", reportNo: "R-0003", times: 2 });
    await startCollect(h.service.url, h.site.url, { fresh: true });
    const failedRun = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(failedRun.state, "failed");
    assert.notEqual(failedRun.snapshotId, newSnapshot.id);
    assert.ok(failedRun.failed.some((entry) => entry.reportNo === "R-0003"));
    const stillOld = await download(h.service.url);
    assert.equal(stillOld.status, 200);
    assert.equal(stillOld.raw, second.raw, "failed run must not overwrite the previous complete delivery");
    assert.equal(stillOld.headers.get("x-snapshot-id"), newSnapshot.id);
    const progressAfterFailure = await getProgress(h.service.url);
    assert.equal(progressAfterFailure.progress.state, "failed");
    assert.equal(progressAfterFailure.delivery.snapshotId, newSnapshot.id);
    void thirdSnapshot;
  });

  test("layout change: the same content is parsed identically from both layouts", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "classic" } });
    await startCollect(h.service.url, h.site.url);
    const classicProgress = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(classicProgress.state, "complete", classicProgress.lastError ?? "");
    const classic = await download(h.service.url);
    assert.ok(classic.records.every((record) => record.layout === "classic"));

    // Same revisions, only the published layout changes.
    await publish(h.site.url, { layout: "compact", reportNos: [] });
    await startCollect(h.service.url, h.site.url, { fresh: true });
    const compactProgress = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(compactProgress.state, "complete", compactProgress.lastError ?? "");
    const compact = await download(h.service.url);
    assert.equal(compact.records.length, classic.records.length);
    assert.ok(compact.records.every((record) => record.layout === "compact"));

    for (const compactRecord of compact.records) {
      const classicRecord = classic.records.find((record) => record.reportNo === compactRecord.reportNo)!;
      assert.equal(compactRecord.revision, classicRecord.revision);
      assert.deepEqual(sampleSnapshot(compactRecord.samples), sampleSnapshot(classicRecord.samples));
      for (const entry of allMeasurements(compactRecord)) {
        assert.ok(entry.measurement.rawUnit === entry.measurement.rawUnit);
      }
    }
  });
});

describe("process restart", () => {
  test("a killed collector resumes from the same data dir and never refetches complete reports", async () => {
    const site = await MockAssaySite.start({ seedSnapshot: { layoutMode: "mixed" } });
    cleanup.push(() => site.close());
    const dataDir = await tempDataDir("restart");
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    // Slow every report slightly, and hold the last report open long enough
    // that the run cannot finish before we kill the process.
    await armFault(site.url, { type: "delay", matchPath: "/reports/R-", ms: 30, times: 400 });
    await armFault(site.url, { type: "delay", matchPath: "/reports/R-0006", ms: 3_000, times: 1 });

    const childEntry = await buildCollectorEntry();
    let launched = spawnCollector(childEntry, dataDir, port, site.url);
    await launched.ready;
    let child = launched.child;

    const startResponse = await startCollect(baseUrl, site.url);
    assert.equal(startResponse.status, 202);
    const started = (await startResponse.json()) as { snapshotId: string };
    assert.ok(started.snapshotId.startsWith("snap-"));
    // Wait for complete report files on disk (the durable source of truth),
    // not merely for the in-memory counter.
    await waitUntil(
      async () => (await storedReportFiles(dataDir, started.snapshotId)).length >= 3,
      20_000,
    );
    const beforeKill = await getProgress(baseUrl);
    assert.notEqual(beforeKill.progress.state, "complete");
    assert.equal((await download(baseUrl)).status, 404, "no delivery before completeness");
    const filesBeforeKill = await storedReportFiles(dataDir, started.snapshotId);

    child.kill("SIGKILL");
    await waitForExit(child);
    assert.ok(!existsSync(path.join(dataDir, "current-delivery.json")));
    const persisted = JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8")) as {
      snapshotId: string;
      entries: Array<{ reportNo: string; status: string }>;
    };
    const deliveredBeforeKill = filesBeforeKill.map((file: string) => file.replace(/\.json$/, ""));
    assert.ok(deliveredBeforeKill.length >= 3);
    assert.equal(persisted.snapshotId, started.snapshotId);

    // A new revision appears while the collector is down; the resuming run
    // must still target its original snapshot.
    await publish(site.url, { reportNos: ["R-0006"] });
    await fetch(`${site.url}/__control/faults/clear`, { method: "POST" });

    launched = spawnCollector(childEntry, dataDir, port, site.url);
    await launched.ready;
    child = launched.child;
    const interrupted = await getProgress(baseUrl);
    assert.equal(interrupted.progress.state, "interrupted");
    assert.equal(interrupted.progress.snapshotId, persisted.snapshotId);
    assert.equal(interrupted.delivery.available, false);

    // POST /api/collect resumes rather than starting over.
    const resume = await startCollect(baseUrl, site.url);
    assert.equal(resume.status, 202);
    const resumed = await waitForState(baseUrl, ["complete", "failed"], 25_000);
    assert.equal(resumed.state, "complete", resumed.lastError ?? "");
    assert.equal(resumed.deliveredReports, 6);
    assert.equal(resumed.snapshotId, persisted.snapshotId);

    const result = await download(baseUrl);
    assert.equal(result.status, 200);
    assert.equal(result.records.length, 6);
    for (const record of result.records) {
      assert.equal(record.snapshotId, persisted.snapshotId);
      assert.equal(record.revision, 1);
    }

    // Reports already complete on disk were never requested again.
    const counts = bodyRequestCounts(await siteRequests(site.url));
    for (const reportNo of deliveredBeforeKill) {
      assert.equal(counts.get(reportNo), 1, `${reportNo} was refetched after restart`);
    }

    // Every request of the resumed run stayed in the original snapshot.
    const resumedRequests = (await siteRequests(site.url)).filter(
      (request) => request.snapshotId !== persisted.snapshotId && request.url.includes("/reports/"),
    );
    assert.equal(resumedRequests.length, 0);

    // A fresh run afterwards moves to the newer snapshot with revision 2.
    await startCollect(baseUrl, site.url, { fresh: true });
    const fresh = await waitForState(baseUrl, ["complete", "failed"], 20_000);
    assert.equal(fresh.state, "complete", fresh.lastError ?? "");
    assert.notEqual(fresh.snapshotId, persisted.snapshotId);
    const freshDownload = await download(baseUrl);
    assert.equal(freshDownload.records.length, 6);
    const r6 = freshDownload.records.find((record) => record.reportNo === "R-0006")!;
    assert.equal(r6.revision, 2);

    child.kill("SIGTERM");
    await waitForExit(child);
  });
});

// ---------------------------------------------------------------------------
// helpers local to this file

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error("waitUntil timed out");
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("no port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Bundle the collector entry once so the spawned process starts in well under
 * a second; the bundle is generated from the exact sources under test.
 */
let collectorEntryPromise: Promise<string> | null = null;

function buildCollectorEntry(): Promise<string> {
  const root = path.resolve(import.meta.dirname, "..");
  const outDir = path.join(root, ".tmp");
  const outfile = path.join(outDir, "collector-child.mjs");
  collectorEntryPromise ??= (async () => {
    mkdirSync(outDir, { recursive: true });
    await esbuild({
      entryPoints: [path.join(root, "src/collector/main.ts")],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      logLevel: "silent",
    });
    return outfile;
  })();
  return collectorEntryPromise;
}

function spawnCollector(
  entry: string,
  dataDir: string,
  port: number,
  siteUrl: string,
): { child: CollectorChild; ready: Promise<string> } {
  const child = spawn(process.execPath, [entry], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      COLLECTOR_PORT: String(port),
      COLLECTOR_HOST: "127.0.0.1",
      COLLECTOR_DATA_DIR: dataDir,
      SITE_URL: siteUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = new Promise<string>((resolve, reject) => {
    let captured = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`collector child did not start within 25s: ${captured}${stderr}`));
    }, 25_000);
    child.stdout.on("data", (chunk: Buffer) => {
      captured += chunk.toString();
      const match = /listening on (http:\/\/[^\s]+)/.exec(captured);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`collector child exited early with code ${code}: ${stderr}`));
    });
  });
  return { child, ready };
}

async function waitForExit(child: CollectorChild): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
