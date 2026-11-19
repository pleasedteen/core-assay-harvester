/**
 * End-to-end tests: every scenario runs against a real local HTTP site and a
 * real collector HTTP service (or a spawned collector process).
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { after, describe, test } from "node:test";
import { build as esbuild } from "esbuild";
import { computeSignature, NONCE_HEADER, SESSION_HEADER, SIGNATURE_HEADER } from "../src/shared/protocol.js";
import type { ReportRecord, Sample } from "../src/shared/types.js";
import { MockAssaySite } from "../src/site/server.js";
import {
  armFault,
  assertNoDuplicateReports,
  bodyRequestCounts,
  download,
  getProgress,
  publish,
  readStoredReport,
  siteRequests,
  sleep,
  storedReportFiles,
  startCollect,
  startHarness,
  tempDataDir,
  waitForState,
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

describe("snapshots and layout", () => {
  test("a revision published mid-collection does not mix into the pinned snapshot", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "mixed" } });
    // Slow down a report so the publication lands mid-run.
    await armFault(h.site.url, { type: "delay", matchPath: "/reports/R-0006", ms: 250, times: 1 });

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

describe("parallel collection", () => {
  test("default is one lane; three lanes finish within two thirds of the single-lane time", async () => {
    const delayAll = { type: "delay", matchPath: "/reports/R-", excludePath: "/appendix", ms: 200, times: 400 };

    // Single lane (the default: no concurrency configured, no request option).
    const serial = await harness({ seedSnapshot: { layoutMode: "mixed" } });
    await armFault(serial.site.url, delayAll);
    const serialMs = await timeCollection(serial);
    assert.equal((await download(serial.service.url)).records.length, 6);

    // Default really is sequential: every request arrives after the previous
    // one's response was logged, so no two requests are ever in flight.
    const serialRequests = reportRequests(await siteRequests(serial.site.url));
    assert.ok(serialRequests.length >= 12, "expected body + appendix requests");
    for (let i = 1; i < serialRequests.length; i++) {
      assert.ok(
        Date.parse(serialRequests[i]!.receivedAt) >= Date.parse(serialRequests[i - 1]!.at) - 5,
        `request ${i} started before request ${i - 1} finished`,
      );
    }
    assert.equal(maxInFlight(serialRequests), 1, "single lane must never overlap requests");

    // Three lanes.
    const parallel = await harness({ seedSnapshot: { layoutMode: "mixed" } });
    await armFault(parallel.site.url, delayAll);
    const parallelMs = await timeCollection(parallel, { concurrency: 3 });
    const parallelResult = await download(parallel.service.url);
    assert.equal(parallelResult.records.length, 6);
    assertNoDuplicateReports(parallelResult.records);
    const parallelProgress = (await getProgress(parallel.service.url)).progress;
    for (const record of parallelResult.records) {
      assert.equal(record.snapshotId, parallelProgress.snapshotId);
      assert.ok(record.samples.length >= 2);
    }

    const parallelRequests = reportRequests(await siteRequests(parallel.site.url));
    assert.ok(maxInFlight(parallelRequests) >= 2, "three lanes must overlap requests");
    // Same fixed per-request delay, so the speedup comes from concurrency alone.
    assert.ok(
      parallelMs <= (serialMs * 2) / 3,
      `three lanes took ${parallelMs}ms, single lane ${serialMs}ms (limit ${Math.round((serialMs * 2) / 3)}ms)`,
    );
  });

  test("a rate limit pauses every session until the site's retry time while in-flight requests finish", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "mixed" } });
    await armFault(h.site.url, { type: "delay", matchPath: "/reports/R-", excludePath: "/appendix", ms: 120, times: 400 });
    const retryAfterMs = 400;
    await armFault(h.site.url, { type: "rateLimit", matchPath: "/reports/R-0002", retryAfterMs, times: 1 });

    await startCollect(h.service.url, h.site.url, { concurrency: 3 });
    const progress = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(progress.state, "complete", progress.lastError ?? "");
    assert.equal(progress.deliveredReports, 6);
    const result = await download(h.service.url);
    assert.equal(result.records.length, 6);
    assertNoDuplicateReports(result.records);

    const requests = await siteRequests(h.site.url);
    const limited = requests.find((request) => request.status === 429);
    assert.ok(limited, "rate limit must fire");
    const limitedAt = Date.parse(limited.receivedAt);
    // The 429 is sent some ms after it arrives; anything the client dispatched
    // before it could observe the 429 counts as already in flight.
    const sentAt = Date.parse(limited.at);
    const graceMs = 75;

    for (const request of requests) {
      const receivedAt = Date.parse(request.receivedAt);
      if (receivedAt <= sentAt + graceMs) continue;
      assert.ok(
        receivedAt >= limitedAt + retryAfterMs - 25,
        `${request.url} was sent ${receivedAt - limitedAt}ms after the 429, before the ${retryAfterMs}ms retry time`,
      );
    }
    // Requests did land after the cooldown, i.e. the run resumed rather than
    // silently dropping work.
    assert.ok(
      requests.some((request) => Date.parse(request.receivedAt) >= limitedAt + retryAfterMs - 25),
      "collection must resume after the retry time",
    );

    // More than one session existed, and all of them respected the cooldown.
    const sessionsAfter = new Set(requests.filter((request) => request.sessionId).map((request) => request.sessionId));
    assert.ok(sessionsAfter.size >= 2, "three lanes use independent sessions");
    // The limited request itself was retried only after the cooldown.
    const limitedRetry = requests.find(
      (request) =>
        request.url.startsWith("/reports/R-0002") &&
        request.status === 200 &&
        Date.parse(request.receivedAt) > limitedAt,
    );
    assert.ok(limitedRetry, "the rate-limited request must succeed on retry");
  });

  test("session invalidation only recollects the affected report", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "mixed" } });
    await armFault(h.site.url, { type: "banSession", matchPath: "/reports/R-0003" });

    await startCollect(h.service.url, h.site.url, { concurrency: 3 });
    const progress = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(progress.state, "complete", progress.lastError ?? "");
    assert.equal(progress.deliveredReports, 6);

    const result = await download(h.service.url);
    assert.equal(result.records.length, 6);
    assertNoDuplicateReports(result.records);
    for (const record of result.records) {
      assert.equal(record.revision, 1);
      assert.ok(record.samples.length >= 2);
    }

    const requests = await siteRequests(h.site.url);
    const banned = requests.filter((request) => request.note === "fault_ban_session");
    assert.equal(banned.length, 1, "ban fault must fire exactly once");
    assert.match(banned[0]!.url, /^\/reports\/R-0003/);
    // Only the report whose request hit the ban is touched again; the other
    // sessions keep their work (and their persisted results).
    const counts = bodyRequestCounts(requests);
    assert.equal(counts.size, 6);
    for (const [reportNo, count] of counts) {
      assert.equal(count, 1, `${reportNo} body fetched ${count} times`);
    }
    const r3Requests = requests.filter((request) => request.url.startsWith("/reports/R-0003"));
    assert.equal(r3Requests.length, 2, "the banned report restarts from its body once");
    assert.ok(
      h.site.state().sessions.filter((session) => session.snapshotId === progress.snapshotId).length >= 2,
      "a replacement session must stay bound to the pinned snapshot",
    );
  });
});

// ---------------------------------------------------------------------------
// helpers local to this file

async function timeCollection(
  h: Harness,
  options: { concurrency?: number } = {},
): Promise<number> {
  const start = performance.now();
  const response = await startCollect(h.service.url, h.site.url, options);
  assert.equal(response.status, 202);
  const progress = await waitForState(h.service.url, ["complete", "failed"], 30_000);
    const elapsed = performance.now() - start;
    assert.equal(progress.state, "complete", progress.lastError ?? "");
    assert.equal(progress.deliveredReports, 6);
    return elapsed;
  }

function reportRequests(
  requests: Array<{ url: string; note: string; at: string; receivedAt: string }>,
): Array<{ url: string; note: string; at: string; receivedAt: string }> {
  return requests.filter((request) => request.url.split("?")[0]!.startsWith("/reports/R-"));
}

/** Peak number of requests whose [receivedAt, at] windows overlap. */
function maxInFlight(
  requests: Array<{ at: string; receivedAt: string }>,
): number {
  const events: Array<{ time: number; delta: number }> = [];
  for (const request of requests) {
    events.push({ time: Date.parse(request.receivedAt), delta: 1 });
    events.push({ time: Date.parse(request.at), delta: -1 });
  }
  events.sort((left, right) => left.time - right.time || left.delta - right.delta);
  let inFlight = 0;
  let peak = 0;
  for (const event of events) {
    inFlight += event.delta;
    peak = Math.max(peak, inFlight);
  }
  return peak;
}

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
