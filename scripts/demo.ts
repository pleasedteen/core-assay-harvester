/**
 * End-to-end demo: starts the mock site and collector service on fixed ports,
 * publishes an extra revision mid-collection, injects a session ban, and shows
 * progress and the downloaded JSONL.
 *
 *   npm run demo
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockAssaySite } from "../src/site/server.js";
import { Collector } from "../src/collector/runner.js";
import { startCollectorService } from "../src/collector/server.js";

const SITE_PORT = Number(process.env.DEMO_SITE_PORT ?? 4100);
const COLLECTOR_PORT = Number(process.env.DEMO_COLLECTOR_PORT ?? 4200);
const keepData = process.env.DEMO_DATA_DIR;

const dataDir = keepData ?? (await mkdtemp(path.join(tmpdir(), "assay-demo-")));
const site = await MockAssaySite.start({ port: SITE_PORT, seedSnapshot: { layoutMode: "mixed" } });
const collector = new Collector({ dataDir, siteUrl: site.url });
const service = await startCollectorService({ collector, dataDir, port: COLLECTOR_PORT });

const step = (label: string): void => console.log(`\n=== ${label} ===`);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

try {
  step("services");
  console.log(`site:      ${site.url}/reports`);
  console.log(`collector: ${service.url}`);
  console.log(`data dir:  ${dataDir}`);

  step("before first delivery");
  const empty = await fetch(`${service.url}/api/download`);
  console.log(`GET /api/download -> ${empty.status}`);
  console.log((await empty.text()).trim());

  step("collect");
  const started = await fetch(`${service.url}/api/collect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ siteUrl: site.url }),
  });
  console.log(`POST /api/collect -> ${started.status}`, (await started.text()).trim());

  // Publish a new revision while the run is in flight; the run stays pinned.
  await sleep(15);
  const published = await fetch(`${site.url}/__control/publish`, {
    method: "POST",
    body: JSON.stringify({ reportNos: ["R-0001"] }),
  });
  console.log(`site published ${(await published.text()).trim()}`);

  await collector.wait();
  step("progress");
  const progress: unknown = await (await fetch(`${service.url}/api/progress`)).json();
  console.log(JSON.stringify(progress, null, 2));

  step("download");
  const download = await fetch(`${service.url}/api/download`);
  console.log(
    `GET /api/download -> ${download.status} snapshot=${download.headers.get("x-snapshot-id")} ` +
      `reports=${download.headers.get("x-delivery-reports")} sha256=${download.headers.get("x-delivery-sha256")}`,
  );
  const text = await download.text();
  for (const line of text.trim().split("\n")) {
    const record = JSON.parse(line) as {
      reportNo: string;
      revision: number;
      layout: string;
      samples: Array<{ items: Array<{ measurement: { kind: string } }> }>;
    };
    const counts = record.samples
      .flatMap((sample) => sample.items)
      .reduce<Record<string, number>>((acc, item) => {
        acc[item.measurement.kind] = (acc[item.measurement.kind] ?? 0) + 1;
        return acc;
      }, {});
    console.log(
      `${record.reportNo} rev=${record.revision} layout=${record.layout} ` +
        `samples=${record.samples.length} results=${JSON.stringify(counts)}`,
    );
  }

  step("resilience: reuse + banned session on the next run");
  // Only R-0001 changed revision, so the next run reuses the other five
  // reports from the first delivery and fetches just R-0001. Faults are
  // aimed at R-0001: anything unchanged is never requested.
  await fetch(`${site.url}/__control/fault`, {
    method: "POST",
    body: JSON.stringify({ type: "banSession", matchPath: "/reports/R-0001" }),
  });
  await fetch(`${site.url}/__control/fault`, {
    method: "POST",
    body: JSON.stringify({ type: "dropResponse", matchPath: "/appendix" }),
  });
  await fetch(`${service.url}/api/collect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ siteUrl: site.url, fresh: true }),
  });
  await collector.wait();
  const recovered = (await (await fetch(`${service.url}/api/progress`)).json()) as {
    progress: { state: string; deliveredReports: number; reused: string[] };
  };
  console.log(
    `state=${recovered.progress.state} reports=${recovered.progress.deliveredReports} ` +
      `reused=${JSON.stringify(recovered.progress.reused)}`,
  );
  const recoveredDownload = await fetch(`${service.url}/api/download`);
  console.log(
    `GET /api/download -> ${recoveredDownload.status} snapshot=${recoveredDownload.headers.get("x-snapshot-id")}`,
  );
} finally {
  await service.close();
  await site.close();
  if (!keepData) {
    await rm(dataDir, { recursive: true, force: true });
    console.log(`\n(cleaned up ${dataDir})`);
  }
}
