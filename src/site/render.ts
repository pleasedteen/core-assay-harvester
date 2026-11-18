/** HTML rendering for the two supported mock-site layouts. */

import type { ContentUnit, MeasurementKind } from "../shared/types.js";
import type { ReportSeed, SampleSeed, ItemSeed } from "./content.js";
import { REPORT_NOS } from "./content.js";

export const BODY_SAMPLE_CAPACITY = 2;
export const APPENDIX_SAMPLE_CAPACITY = 1;

export function splitPages(report: ReportSeed): SampleSeed[][] {
  const pages: SampleSeed[][] = [report.samples.slice(0, BODY_SAMPLE_CAPACITY)];
  for (let i = BODY_SAMPLE_CAPACITY; i < report.samples.length; i += APPENDIX_SAMPLE_CAPACITY) {
    pages.push(report.samples.slice(i, i + APPENDIX_SAMPLE_CAPACITY));
  }
  return pages;
}

export function appendixPageCount(report: ReportSeed): number {
  return Math.max(0, Math.ceil((report.samples.length - BODY_SAMPLE_CAPACITY) / APPENDIX_SAMPLE_CAPACITY));
}

function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function metaTags(report: ReportSeed, snapshotId: string, page: string): string {
  return [
    `<meta charset="utf-8">`,
    `<meta name="x-snapshot-id" content="${esc(snapshotId)}">`,
    `<meta name="x-report-no" content="${esc(report.reportNo)}">`,
    `<meta name="x-revision" content="${report.revision}">`,
    `<meta name="x-layout" content="${report.layout}">`,
    `<meta name="x-sample-count" content="${report.samples.length}">`,
    `<meta name="x-page" content="${esc(page)}">`,
  ].join("\n");
}

const SITE_HEADER = `<header class="site">
  <div class="brand">华东地质化验中心 · 岩芯化验报告库</div>
  <nav><a href="/reports">报告目录</a></nav>
</header>`;

function shell(title: string, bodyClass: string, head: string, content: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
${head}
<title>${esc(title)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;color:#1b1b1b}
table{border-collapse:collapse;margin:1rem 0}
th,td{border:1px solid #bbb;padding:.35rem .6rem;text-align:left}
th{background:#eee}
.bdl,.missing{color:#666}
</style>
</head>
<body class="${bodyClass}">
${SITE_HEADER}
<main>
${content}
</main>
<footer class="site-footer"><p>本页面由本地模拟站点生成，数据仅供演示。</p></footer>
</body>
</html>`;
}

export function renderIndex(
  snapshotId: string,
  revisions: Record<string, number>,
): string {
  const rows = REPORT_NOS.map((reportNo) => {
    const revision = revisions[reportNo] ?? 1;
    return `<tr>
      <td><a href="/reports/${reportNo}" data-role="report" data-report-no="${reportNo}">${reportNo}</a></td>
      <td>${reportNo} 岩芯化验报告</td>
      <td class="revision">${revision}</td>
      <td>2026-03-${String(10 + REPORT_NOS.indexOf(reportNo)).padStart(2, "0")}T08:30:00Z</td>
    </tr>`;
  }).join("\n");
  const content = `<h1>报告目录</h1>
<p class="snapshot" data-snapshot-id="${esc(snapshotId)}">当前快照：${esc(snapshotId)}</p>
<table class="directory">
  <thead><tr><th>报告编号</th><th>标题</th><th>修订</th><th>发布日期</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;
  return shell(
    "报告目录",
    "layout-directory",
    `<meta charset="utf-8"><meta name="x-snapshot-id" content="${esc(snapshotId)}"><meta name="x-page" content="index">`,
    content,
  );
}

function unitLabel(unit: ContentUnit): string {
  return unit === "pct" ? "%" : "mg/kg";
}

function classicResultCell(item: ItemSeed): string {
  const kind: MeasurementKind = item.kind;
  if (kind === "value") {
    return `<td class="result value" data-item="${esc(item.code)}" data-unit="${esc(item.unit!)}">${esc(item.value!)}</td>`;
  }
  if (kind === "below_detection_limit") {
    return `<td class="result bdl" data-item="${esc(item.code)}" data-unit="${esc(item.unit!)}">&lt; ${esc(item.limit!)}</td>`;
  }
  return `<td class="result missing" data-item="${esc(item.code)}">—</td>`;
}

function classicTable(report: ReportSeed, samples: SampleSeed[], part: number): string {
  const headers = report.samples[0]!.items
    .map((item) => `<th>${esc(item.code)} / ${esc(item.name)} (${unitLabel(item.unit ?? "mg/kg")})</th>`)
    .join("");
  const rows = samples
    .map((sample) => `<tr data-sample-id="${esc(sample.sampleId)}">
      <td class="sid">${esc(sample.sampleId)}</td>
      <td class="depth">${esc(sample.fromM)}–${esc(sample.toM)} m</td>
      <td class="lith">${esc(sample.lithology)}</td>
      ${sample.items.map(classicResultCell).join("\n      ")}
    </tr>`)
    .join("\n");
  return `<table class="assay classic" data-part="${part}">
  <thead><tr><th>样本号</th><th>深度 (m)</th><th>岩性</th>${headers}</tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

function compactResultCell(item: ItemSeed): string {
  const text =
    item.kind === "value"
      ? `${item.value!} ${unitLabel(item.unit!)}`
      : item.kind === "below_detection_limit"
        ? `< ${item.limit!} ${unitLabel(item.unit!)}`
        : "—";
  const cls = item.kind === "below_detection_limit" ? "bdl" : item.kind === "missing" ? "missing" : "value";
  const unitAttr = item.kind === "missing" ? "" : ` data-unit="${esc(item.unit!)}"`;
  return `<td class="res ${cls}"${unitAttr}>${esc(text)}</td>`;
}

function compactTable(samples: SampleSeed[], part: number): string {
  const rows: string[] = [];
  for (const sample of samples) {
    sample.items.forEach((item, index) => {
      const head = index === 0;
      rows.push(`<tr class="${head ? "head-row" : "cont-row"}"${head ? ` data-sample-id="${esc(sample.sampleId)}"` : ""}>
      <td class="sid">${head ? esc(sample.sampleId) : ""}</td>
      <td class="depth">${head ? `${esc(sample.fromM)}–${esc(sample.toM)} m` : ""}</td>
      <td class="lith">${head ? esc(sample.lithology) : ""}</td>
      <td class="item"><span class="code">${esc(item.code)}</span><span class="name">${esc(item.name)}</span></td>
      ${compactResultCell(item)}
    </tr>`);
    });
  }
  return `<table class="assay compact" data-part="${part}">
  <thead><tr><th>样本号</th><th>深度 (m)</th><th>岩性</th><th>检测项</th><th>结果</th></tr></thead>
  <tbody>
${rows.join("\n")}
  </tbody>
</table>`;
}

function reportHeader(report: ReportSeed): string {
  if (report.layout === "classic") {
    return `<h1 class="report-title">${esc(report.title)}</h1>
<dl class="report-meta">
  <dt>报告编号</dt><dd data-field="reportNo">${esc(report.reportNo)}</dd>
  <dt>修订</dt><dd data-field="revision">${report.revision}</dd>
  <dt>发布日期</dt><dd data-field="publishedAt">${esc(report.publishedAt)}</dd>
</dl>`;
  }
  return `<h1 class="report-title">${esc(report.title)}</h1>
<p class="report-meta compact-meta">
  <span>编号 <b data-field="reportNo">${esc(report.reportNo)}</b></span>
  <span>修订 <b data-field="revision">${report.revision}</b></span>
  <span>发布日期 <b data-field="publishedAt">${esc(report.publishedAt)}</b></span>
</p>`;
}

export function renderBodyPage(
  report: ReportSeed,
  snapshotId: string,
  samples: SampleSeed[],
  appendixHref: string | null,
): string {
  const table = report.layout === "classic" ? classicTable(report, samples, 1) : compactTable(samples, 1);
  let links = "";
  if (appendixHref) {
    links =
      report.layout === "classic"
        ? `<div class="appendix-links"><h2>附表</h2><ul><li><a class="appendix" href="${esc(appendixHref)}">附表 1：续样本检测结果</a></li></ul></div>`
        : `<nav class="subdocs"><a data-role="appendix" href="${esc(appendixHref)}">附表 1：续样本检测结果</a></nav>`;
  }
  const content = `${reportHeader(report)}
<p class="lead">本报告共 ${report.samples.length} 个岩芯样本，结果按检测项列出。低于检出限以“&lt; 检出限”表示，缺测以“—”表示。</p>
${table}
${links}`;
  return shell(report.title, `layout-${report.layout}`, metaTags(report, snapshotId, "body"), content);
}

export function renderAppendixPage(
  report: ReportSeed,
  snapshotId: string,
  page: number,
  samples: SampleSeed[],
  nextHref: string | null,
): string {
  const part = page;
  const table = report.layout === "classic" ? classicTable(report, samples, part) : compactTable(samples, part);
  let pager = "";
  if (nextHref) {
    pager =
      report.layout === "classic"
        ? `<div class="pager"><a class="next-page" rel="next" href="${esc(nextHref)}">下一附表 →</a></div>`
        : `<nav class="subdocs"><a data-role="next" href="${esc(nextHref)}">下一附表 →</a></nav>`;
  }
  const content = `<h1>${esc(report.reportNo)} 附表 ${part}</h1>
<p class="appendix-meta">报告编号 ${esc(report.reportNo)} · 修订 ${report.revision} · 附表第 ${part} 页</p>
${table}
${pager}`;
  return shell(
    `${report.reportNo} 附表 ${part}`,
    `layout-${report.layout}`,
    metaTags(report, snapshotId, `appendix-${part}`),
    content,
  );
}

export function renderErrorPage(title: string, message: string): string {
  return shell(title, "layout-error", `<meta charset="utf-8">`, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`);
}
