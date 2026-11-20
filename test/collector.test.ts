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
  armContentDefect,
  armFault,
  assertNoDuplicateReports,
  bodyRequestCounts,
  download,
  fetchManifest,
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

describe("declaration verification", () => {
  test("declared samples and per-sample items are satisfied in both layouts; explicit missing stays valid", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "mixed" } });
    const manifest = await fetchManifest(h.site.url);
    assert.equal(manifest.reports.length, 6);

    await startCollect(h.service.url, h.site.url);
    const progress = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(progress.state, "complete", progress.lastError ?? "");

    const result = await download(h.service.url);
    assert.equal(result.records.length, 6);

    // Every record matches its manifest declaration sample-for-sample and
    // item-for-item; item sets are allowed to differ between samples.
    for (const record of result.records) {
      const declaration = manifest.reports.find((entry) => entry.reportNo === record.reportNo)!;
      assert.equal(declaration.revision, record.revision);
      assert.equal(record.samples.length, declaration.samples.length);
      for (const declaredSample of declaration.samples) {
        const sample = record.samples.find((candidate) => candidate.sampleId === declaredSample.sampleId);
        assert.ok(sample, `${record.reportNo} must contain declared sample ${declaredSample.sampleId}`);
        const codes = sample!.items.map((item) => item.code).sort();
        assert.deepEqual(
          codes,
          declaredSample.items.map((item) => item.code).sort(),
          `${record.reportNo}/${sample!.sampleId} item set must match the manifest`,
        );
        const unique = new Set(sample!.items.map((item) => item.code));
        assert.equal(unique.size, sample!.items.length, "no duplicate detection items");
      }
    }

    // At least one report genuinely has differing per-sample item sets.
    const varied = manifest.reports.some((report) => {
      const sets = report.samples.map((sample) => sample.items.map((item) => item.code).sort().join(","));
      return new Set(sets).size > 1;
    });
    assert.ok(varied, "manifest should include reports whose samples differ in detection items");

    // Explicitly marked missing ("—") is a valid result, not a discrepancy.
    const missing = result.records.flatMap(allMeasurements).filter((entry) => entry.measurement.kind === "missing");
    assert.ok(missing.length >= 1);
    assert.deepEqual(progress.failed, []);
  });

  test("the same manifest verifies under classic and compact layout switches", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "classic" } });
    const classicManifest = await fetchManifest(h.site.url);
    await startCollect(h.service.url, h.site.url);
    const classicProgress = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(classicProgress.state, "complete", classicProgress.lastError ?? "");
    const classic = await download(h.service.url);

    await publish(h.site.url, { layout: "compact", reportNos: [] });
    const compactManifest = await fetchManifest(h.site.url);
    // Layout only changes presentation; the declaration itself is unchanged.
    assert.deepEqual(compactManifest.reports, classicManifest.reports);
    await startCollect(h.service.url, h.site.url, { fresh: true });
    const compactProgress = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(compactProgress.state, "complete", compactProgress.lastError ?? "");
    const compact = await download(h.service.url);

    for (const compactRecord of compact.records) {
      const classicRecord = classic.records.find((record) => record.reportNo === compactRecord.reportNo)!;
      assert.deepEqual(sampleSnapshot(compactRecord.samples), sampleSnapshot(classicRecord.samples));
      const declaration = compactManifest.reports.find(
        (entry) => entry.reportNo === compactRecord.reportNo,
      )!;
      for (const sample of compactRecord.samples) {
        const declared = declaration.samples.find((entry) => entry.sampleId === sample.sampleId)!;
        assert.deepEqual(
          sample.items.map((item) => item.code).sort(),
          declared.items.map((item) => item.code).sort(),
        );
      }
    }
  });
});

describe("content defects vs declarations", () => {
  async function defectTarget(
    siteUrl: string,
    reportNo: string,
    predicate: (itemCode: string) => boolean = () => true,
  ): Promise<{ sampleId: string; itemCode: string }> {
    const manifest = await fetchManifest(siteUrl);
    const report = manifest.reports.find((entry) => entry.reportNo === reportNo)!;
    for (const sample of [...report.samples].reverse()) {
      const item = [...sample.items].reverse().find((candidate) => predicate(candidate.code));
      if (item) return { sampleId: sample.sampleId, itemCode: item.code };
    }
    throw new Error(`no defect target found in ${reportNo}`);
  }

  test("missing sample row: progress names the missing sample and the run fails", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "mixed" } });
    const manifest = await fetchManifest(h.site.url);
    const targetReport = "R-0006"; // five samples, spans three appendix pages
    const report = manifest.reports.find((entry) => entry.reportNo === targetReport)!;
    const missingSample = report.samples[report.samples.length - 1]!;
    await armContentDefect(h.site.url, {
      type: "omitSample",
      reportNo: targetReport,
      sampleId: missingSample.sampleId,
    });

    await startCollect(h.service.url, h.site.url);
    const failed = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(failed.state, "failed");
    const entry = failed.failed.find((item) => item.reportNo === targetReport)!;
    assert.ok(entry, "the defective report must appear in failed[]");
    const discrepancy = entry.discrepancies!.find((issue) => issue.type === "sample_missing")!;
    assert.ok(discrepancy);
    assert.equal(discrepancy.sampleId, missingSample.sampleId);
    // The items lost with the sample are named too.
    assert.ok(
      entry.discrepancies!.some(
        (issue) => issue.type === "item_missing" && issue.sampleId === missingSample.sampleId,
      ),
    );
    assert.equal((await download(h.service.url)).status, 404, "no delivery while the snapshot is incomplete");

    // Once the one-shot defect is consumed, a resume re-fetches and passes.
    await startCollect(h.service.url, h.site.url);
    const complete = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(complete.state, "complete", complete.lastError ?? "");
    const result = await download(h.service.url);
    assert.equal(result.records.length, 6);
  });

  test("missing detection column on an appendix page: progress names sample and item", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "mixed" } });
    // R-0006 has appendix samples; pick an item of its last (appendix-only) sample.
    const target = await defectTarget(h.site.url, "R-0006");
    await armContentDefect(h.site.url, { type: "omitItem", reportNo: "R-0006", ...target });

    await startCollect(h.service.url, h.site.url);
    const failed = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(failed.state, "failed");
    const entry = failed.failed.find((item) => item.reportNo === "R-0006")!;
    const discrepancy = entry.discrepancies!.find((issue) => issue.type === "item_missing")!;
    assert.ok(discrepancy, JSON.stringify(entry));
    assert.equal(discrepancy.sampleId, target.sampleId);
    assert.equal(discrepancy.itemCode, target.itemCode);
    assert.match(entry.reason, new RegExp(`${target.sampleId}`));
  });

  test("duplicate item substitution in compact layout is detected with both codes named", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "compact" } });
    const target = await defectTarget(h.site.url, "R-0002", (code) => code !== "Au");
    const manifest = await fetchManifest(h.site.url);
    const report = manifest.reports.find((entry) => entry.reportNo === "R-0002")!;
    const sample = report.samples.find((entry) => entry.sampleId === target.sampleId)!;
    const source = sample.items.find((item) => item.code !== target.itemCode)!;

    await armContentDefect(h.site.url, {
      type: "duplicateItem",
      reportNo: "R-0002",
      sampleId: target.sampleId,
      itemCode: target.itemCode,
      sourceItemCode: source.code,
    });

    await startCollect(h.service.url, h.site.url);
    const failed = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(failed.state, "failed");
    const entry = failed.failed.find((item) => item.reportNo === "R-0002")!;
    const duplicated = entry.discrepancies!.find(
      (issue) => issue.type === "item_duplicated" && issue.itemCode === source.code,
    );
    assert.ok(duplicated, JSON.stringify(entry.discrepancies));
    assert.equal(duplicated.sampleId, target.sampleId);
    const missing = entry.discrepancies!.find(
      (issue) => issue.type === "item_missing" && issue.itemCode === target.itemCode,
    );
    assert.ok(missing, "the substituted declared item must be reported missing");
  });

  test("detection limit without a numeric value names the sample and item; explicit 缺测 still valid", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "mixed" } });
    // A below-detection-limit-capable value item on R-0004.
    const target = await defectTarget(h.site.url, "R-0004", (code) => code === "Au" || code === "Ag");
    await armContentDefect(h.site.url, { type: "limitWithoutValue", reportNo: "R-0004", ...target });

    await startCollect(h.service.url, h.site.url);
    const failed = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(failed.state, "failed");
    const entry = failed.failed.find((item) => item.reportNo === "R-0004")!;
    const discrepancy = entry.discrepancies!.find((issue) => issue.type === "limit_without_value")!;
    assert.ok(discrepancy, JSON.stringify(entry));
    assert.equal(discrepancy.sampleId, target.sampleId);
    assert.equal(discrepancy.itemCode, target.itemCode);

    // Meanwhile, an explicitly marked missing measurement ("—") in the same
    // snapshot is never turned into a discrepancy.
    const others = entry.discrepancies!.filter((issue) => issue.type !== "limit_without_value");
    assert.ok(
      !others.some((issue) => issue.detail.includes("缺测")),
      "explicit missing measurements must stay valid",
    );

    // The defect is one-shot; resume clears the failure and delivers.
    await startCollect(h.service.url, h.site.url);
    const complete = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(complete.state, "complete", complete.lastError ?? "");
  });
});

describe("resume against an old cache directory", () => {
  test("an intact cache is verified from the directory manifest only and never refetched", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "mixed" } });
    await startCollect(h.service.url, h.site.url);
    const first = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(first.state, "complete", first.lastError ?? "");
    const firstDelivery = await download(h.service.url);
    assert.equal(firstDelivery.status, 200);

    const requestsBeforeResume = (await siteRequests(h.site.url)).length;

    // Resume the same data directory without any content change.
    await startCollect(h.service.url, h.site.url);
    const resumed = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(resumed.state, "complete", resumed.lastError ?? "");
    assert.equal(resumed.deliveredReports, 6);

    // Cache verification only reads the directory: no report body or appendix
    // page may have been requested during the resumed run — only index
    // (directory) entries should have been appended.
    const requestsAfterResume = await siteRequests(h.site.url);
    const newRequests = requestsAfterResume.slice(requestsBeforeResume);
    assert.ok(newRequests.length > 0, "the resumed run must at least re-enter the directory");
    assert.ok(
      newRequests.every((request) => request.note === "index"),
      `resume fetched report pages: ${JSON.stringify(newRequests.map((request) => request.note))}`,
    );
    const second = await download(h.service.url);
    assert.equal(second.raw, firstDelivery.raw);
  });

  test("a cache that no longer matches the manifest is re-collected from body and appendices", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "mixed" } });
    await startCollect(h.service.url, h.site.url);
    const first = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(first.state, "complete", first.lastError ?? "");
    const firstDelivery = await download(h.service.url);

    // Corrupt one cached report file on disk (simulating a stale/tampered
    // cache): drop a whole detection item from one sample.
    const storedPath = path.join(
      h.dataDir,
      "snapshots",
      first.snapshotId!,
      "reports",
      "R-0001.json",
    );
    const cached = JSON.parse(await readFile(storedPath, "utf8")) as ReportRecord;
    const victimSample = cached.samples[cached.samples.length - 1]!;
    const victimItem = victimSample.items[victimSample.items.length - 1]!;
    victimSample.items = victimSample.items.filter((item) => item.code !== victimItem.code);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(storedPath, `${JSON.stringify(cached)}\n`);

    const countsBeforeResume = bodyRequestCounts(await siteRequests(h.site.url));

    await startCollect(h.service.url, h.site.url);
    const resumed = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(resumed.state, "complete", resumed.lastError ?? "");

    // The corrupted report alone was re-fetched (body + its pages); the other
    // five intact reports were verified from the manifest and not requested.
    const countsAfterResume = bodyRequestCounts(await siteRequests(h.site.url));
    assert.equal(
      (countsAfterResume.get("R-0001") ?? 0) - (countsBeforeResume.get("R-0001") ?? 0),
      1,
      "the unverifiable cached report must be re-collected once",
    );
    for (const reportNo of ["R-0002", "R-0003", "R-0004", "R-0005", "R-0006"]) {
      assert.equal(
        (countsAfterResume.get(reportNo) ?? 0) - (countsBeforeResume.get(reportNo) ?? 0),
        0,
        `${reportNo} cache should have been trusted`,
      );
    }

    const repaired = await readStoredReport(h.dataDir, first.snapshotId!, "R-0001");
    const repairedSample = repaired.samples.find((sample) => sample.sampleId === victimSample.sampleId)!;
    assert.ok(
      repairedSample.items.some((item) => item.code === victimItem.code),
      "re-collected report restores the missing detection item",
    );
    const redelivery = await download(h.service.url);
    assert.equal(redelivery.records.length, 6);
    assert.notEqual(redelivery.raw, firstDelivery.raw);
  });

  test("a persistent content defect keeps the previous delivery until verification passes", async () => {
    const h = await harness({ seedSnapshot: { layoutMode: "classic" } });
    // Build a complete baseline delivery first.
    await startCollect(h.service.url, h.site.url);
    const baseline = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(baseline.state, "complete", baseline.lastError ?? "");
    const baselineDelivery = await download(h.service.url);
    assert.equal(baselineDelivery.status, 200);

    // Publish a new revision so a fresh run targets a snapshot whose reports
    // are not cached yet, then arm a persistent defect against one of them.
    const nextSnapshot = await publish(h.site.url, { reportNos: ["R-0005"] });
    const target = await (async () => {
      const manifest = await fetchManifest(h.site.url);
      const report = manifest.reports.find((entry) => entry.reportNo === "R-0005")!;
      const sample = report.samples[report.samples.length - 1]!;
      return { sampleId: sample.sampleId, itemCode: sample.items[sample.items.length - 1]!.code };
    })();
    await armContentDefect(h.site.url, { type: "omitItem", reportNo: "R-0005", times: 10, ...target });

    await startCollect(h.service.url, h.site.url, { fresh: true });
    const failedRun = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(failedRun.state, "failed");
    assert.equal(failedRun.snapshotId, nextSnapshot.id);
    const entry = failedRun.failed.find((item) => item.reportNo === "R-0005")!;
    assert.ok(entry.discrepancies!.some((issue) => issue.type === "item_missing"));
    assert.ok(entry.discrepancies!.some((issue) => issue.sampleId === target.sampleId));

    // The previous complete delivery stays available byte-for-byte.
    const duringFailure = await download(h.service.url);
    assert.equal(duringFailure.status, 200);
    assert.equal(duringFailure.raw, baselineDelivery.raw);

    // Clear the defect: the resume re-collects, verification passes and a new
    // delivery is published.
    await fetch(`${h.site.url}/__control/faults/clear`, { method: "POST" });
    await startCollect(h.service.url, h.site.url);
    const complete = await waitForState(h.service.url, ["complete", "failed"]);
    assert.equal(complete.state, "complete", complete.lastError ?? "");
    const finalDelivery = await download(h.service.url);
    assert.equal(finalDelivery.records.length, 6);
    assert.notEqual(finalDelivery.raw, baselineDelivery.raw);
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
