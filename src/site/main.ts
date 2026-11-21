/** CLI entry point for the mock assay site. */

import { MockAssaySite } from "./server.js";

const port = Number(process.env.SITE_PORT ?? 4100);
const host = process.env.SITE_HOST ?? "127.0.0.1";
const layoutMode = (process.env.SITE_LAYOUT ?? "mixed") as "mixed" | "classic" | "compact";
const longReportSamples = process.env.SITE_LONG_REPORT_SAMPLES
  ? Number(process.env.SITE_LONG_REPORT_SAMPLES)
  : undefined;

const site = await MockAssaySite.start({
  port,
  host,
  seedSnapshot: { layoutMode },
  longReportSamples,
});
console.log(`[site] listening on ${site.url}`);
console.log(`[site] directory: ${site.url}/reports`);
console.log(`[site] current snapshot: ${site.state().currentSnapshot}`);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void site.close().then(() => process.exit(0));
  });
}
