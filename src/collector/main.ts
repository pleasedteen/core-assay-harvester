/** CLI entry point for the collector service. */

import path from "node:path";
import { Collector } from "./runner.js";
import { startCollectorService } from "./server.js";

const host = process.env.COLLECTOR_HOST ?? "127.0.0.1";
const port = Number(process.env.COLLECTOR_PORT ?? 4200);
const dataDir = path.resolve(process.env.COLLECTOR_DATA_DIR ?? "data/collector");

const collector = new Collector({
  dataDir,
  siteUrl: process.env.SITE_URL ?? "http://127.0.0.1:4100",
  concurrency: Number(process.env.COLLECTOR_CONCURRENCY ?? 1),
});
const service = await startCollectorService({ collector, host, port, dataDir });

console.log(`[collector] listening on ${service.url}`);
console.log(`[collector] data dir: ${dataDir}`);
console.log(`[collector] POST ${service.url}/api/collect  {"siteUrl":"http://127.0.0.1:4100"}`);
console.log(`[collector] GET  ${service.url}/api/progress`);
console.log(`[collector] GET  ${service.url}/api/download`);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Persist the running flag as interrupted before exiting so a restart
    // resumes instead of starting over.
    void service.close().then(() => process.exit(0));
  });
}
