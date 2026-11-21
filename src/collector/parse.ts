/** Content-driven parser for both mock-site report layouts. */

import * as cheerio from "cheerio/slim";
import type { Cheerio, CheerioAPI } from "cheerio/slim";
import type { AnyNode } from "domhandler";
import type { ContentUnit, Layout, Measurement, ReportRecord, Sample } from "../shared/types.js";
import { belowDetectionLimit, measurementFromValue, missingMeasurement } from "../shared/units.js";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

export interface ParsedPage {
  reportNo: string;
  revision: number;
  snapshotId: string;
  layout: Layout;
  title: string;
  publishedAt: string;
  pageKind: "body" | "appendix";
  declaredSampleCount: number | null;
  samples: Sample[];
  /** Page URL supplied by the caller, propagated to each sample. */
  sourceUrl: string;
  /** Absolute-or-relative URLs discovered in page content. */
  appendixLinks: string[];
  nextLink: string | null;
  /** Body-only: a re-entry token link to the first unconfirmed appendix page. */
  resumeLink: string | null;
}

const MISSING_TOKENS = new Set(["", "—", "–", "-", "/", "n/a", "na", "缺测", "未测", "…", "...", "null"]);
const BDL_EXACT = new Set(["nd", "n.d.", "bdl"]);
const BDL_PREFIXES = ["<", "＜", "未检出", "低于检出限"];

function isBelowDetectionLimit(text: string): boolean {
  const lower = text.toLowerCase();
  return BDL_PREFIXES.some((prefix) => lower.startsWith(prefix)) || BDL_EXACT.has(lower);
}

function normalizeSpace(text: string): string {
  return text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeUnit(text: string | null | undefined): ContentUnit | null {
  if (!text) return null;
  const cleaned = normalizeSpace(text)
    .replace(/[()（）]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "");
  if (["%", "％", "pct", "percent", "百分比", "wt%"].includes(cleaned)) return "pct";
  if (
    [
      "mg/kg",
      "mg·kg-1",
      "mg·kg−1",
      "mg·kg⁻¹",
      "mg.kg-1",
      "mgkg-1",
      "ppm",
      "毫克/千克",
      "mg/kg干重",
    ].includes(cleaned)
  ) {
    return "mg/kg";
  }
  return null;
}

/** Split "Au / 金 (%)" or "Au 金 (%)" into code, name, unit. */
export function parseItemHeader(text: string): { code: string; name: string; unit: ContentUnit | null } {
  const cleaned = normalizeSpace(text);
  const unitMatch = /[（(]\s*([^()（）]+?)\s*[)）]\s*$/.exec(cleaned);
  const unit = unitMatch ? normalizeUnit(unitMatch[1]) : null;
  const withoutUnit = unitMatch ? cleaned.slice(0, unitMatch.index) : cleaned;
  const pieces = withoutUnit.split(/\s*[/／]\s*/);
  if (pieces.length >= 2) {
    return { code: pieces[0]!.trim(), name: pieces.slice(1).join(" / ").trim(), unit };
  }
  // Fallback: "Au 金"
  const spaced = /^([A-Za-z][A-Za-z0-9_-]*)\s+(.+)$/.exec(withoutUnit);
  if (spaced) return { code: spaced[1]!, name: spaced[2]!.trim(), unit };
  // Fallback: trailing unit without parentheses, e.g. "Au %"
  const trailing = /^(\S+)\s+(%|mg\/kg)$/i.exec(withoutUnit);
  if (trailing) return { code: trailing[1]!, name: trailing[1]!, unit: normalizeUnit(trailing[2]!) };
  return { code: withoutUnit.trim(), name: withoutUnit.trim(), unit };
}

function parseMeasurement(rawText: string, contextUnit: ContentUnit | null): Measurement {
  const text = normalizeSpace(rawText);
  const lower = text.toLowerCase();

  let unit = contextUnit;
  let valuePart = text;

  // A unit may be appended to the cell text in compact layouts.
  const suffix = /^(.*?)\s*[（(]?([%％]|mg\s*[\/·]\s*kg(?:-1|−1|⁻¹)?|mg\/kg|ppm)[)）]?$/i.exec(text);
  if (suffix) {
    const suffixUnit = normalizeUnit(suffix[2]!);
    if (suffixUnit) {
      if (unit && unit !== suffixUnit) {
        throw new ParseError(`Unit mismatch in cell "${text}": header says ${unit}, cell says ${suffixUnit}`);
      }
      unit = suffixUnit;
      valuePart = suffix[1]!.trim();
    }
  }

  // `rawText` records the published representation without a trailing unit:
  // the unit itself is preserved in rawUnit/detectionLimitUnit, which keeps
  // records from the two layouts directly comparable.
  if (isBelowDetectionLimit(valuePart)) {
    const limitMatch = /(-?\d+(?:\.\d+)?)/.exec(valuePart);
    if (!limitMatch) {
      if (!unit) throw new ParseError(`Below-detection-limit cell "${text}" has no unit`);
      return belowDetectionLimit("0", unit, valuePart);
    }
    if (!unit) {
      throw new ParseError(`Below-detection-limit cell "${text}" has no detectable unit`);
    }
    return belowDetectionLimit(limitMatch[1]!, unit, valuePart);
  }

  if (MISSING_TOKENS.has(lower) || MISSING_TOKENS.has(valuePart.toLowerCase())) {
    return missingMeasurement(valuePart);
  }

  const numeric = /^-?\d+(?:\.\d+)?$/.exec(valuePart.replace(/[,\s]/g, ""));
  if (!numeric) throw new ParseError(`Unrecognized result cell "${text}"`);
  if (!unit) throw new ParseError(`Result cell "${text}" has no detectable unit`);
  if (valuePart.startsWith("-")) throw new ParseError(`Negative content in cell "${text}"`);
  return measurementFromValue(numeric[0]!, unit, valuePart);
}

function parseDepth(text: string): { fromM: string | null; toM: string | null } {
  const cleaned = normalizeSpace(text).replace(/\s*m$/i, "");
  const match = /^(-?\d+(?:\.\d+)?)\s*[–—\-~～至]\s*(-?\d+(?:\.\d+)?)$/.exec(cleaned);
  if (!match) return { fromM: null, toM: null };
  return { fromM: match[1]!, toM: match[2]! };
}

function tableLayout(_$: CheerioAPI, table: Cheerio<AnyNode>): Layout | null {
  const declared = table.attr("class") ?? "";
  if (/\bclassic\b/.test(declared)) return "classic";
  if (/\bcompact\b/.test(declared)) return "compact";
  if (table.find("td.item").length > 0 || table.find("td .code").length > 0) return "compact";
  if (table.find("tr[data-sample-id]").length > 0) return "classic";
  return null;
}

function parseClassicTable($: CheerioAPI, table: Cheerio<AnyNode>): Sample[] {
  const headers = table
    .find("thead tr th")
    .toArray()
    .map((cell) => normalizeSpace($(cell).text()));
  const sampleColumns = headers.findIndex((header) => header.includes("样本"));
  const depthColumn = headers.findIndex((header) => header.includes("深度"));
  const lithColumn = headers.findIndex((header) => header.includes("岩性"));

  // Item columns are everything after the lithology column that is not a
  // sample/depth/lithology column.
  const itemHeaders = headers
    .map((header, index) => ({ header, index }))
    .filter(({ index }) => index !== sampleColumns && index !== depthColumn && index !== lithColumn)
    .map(({ header, index }) => ({ ...parseItemHeader(header), index }));

  const samples: Sample[] = [];
  table.find("tbody tr").each((_rowIndex, row) => {
    const cells = $(row).find("td").toArray();
    if (cells.length === 0) return;
    const sampleId =
      $(row).attr("data-sample-id") ??
      $(cells[sampleColumns >= 0 ? sampleColumns : 0]!).text().trim();
    if (!sampleId) throw new ParseError("Classic row without sample id");
    const depth = parseDepth($(cells[depthColumn >= 0 ? depthColumn : 1]!).text());
    const lithology = lithColumn >= 0 ? normalizeSpace($(cells[lithColumn]!).text()) || null : null;

    const items = itemHeaders.map((item) => {
      const cell = $(cells[item.index]!);
      const cellUnit = normalizeUnit(cell.attr("data-unit"));
      const unit = cellUnit && item.unit && cellUnit !== item.unit
        ? (() => { throw new ParseError(`Unit conflict for ${item.code}: header ${item.unit}, cell ${cellUnit}`); })()
        : (cellUnit ?? item.unit);
      return {
        code: item.code,
        name: item.name,
        measurement: parseMeasurement(cell.text(), unit),
      };
    });
    if (items.length === 0) throw new ParseError(`Sample ${sampleId} has no result columns`);
    samples.push({ sampleId, ...depth, lithology, sourceUrl: "", items });
  });
  return samples;
}

function parseCompactTable($: CheerioAPI, table: Cheerio<AnyNode>): Sample[] {
  const samples: Sample[] = [];
  let current: Sample | null = null;

  table.find("tbody tr").each((_rowIndex, row) => {
    const tr = $(row);
    const cells = tr.find("td").toArray();
    if (cells.length < 4) return;
    const headId = tr.attr("data-sample-id");
    const sidText = normalizeSpace($(cells[0]!).text());
    const rowSampleId = headId ?? sidText;

    // A compact row either opens a sample (broader rowspan-like head row) or
    // continues the most recent one.
    if (rowSampleId) {
      current = {
        sampleId: rowSampleId,
        ...parseDepth($(cells[1]!).text()),
        lithology: normalizeSpace($(cells[2]!).text()) || null,
        sourceUrl: "",
        items: [],
      };
      samples.push(current);
    }
    if (!current) {
      throw new ParseError("Compact row appears before any sample row");
    }

    const itemCell = tr.find("td.item").first();
    const code = normalizeSpace(itemCell.find(".code").text()) || normalizeSpace(itemCell.text());
    const name = normalizeSpace(itemCell.find(".name").text()) || code;
    const resultCell = tr.find("td.res, td.result").last();
    if (!code) throw new ParseError("Compact row without item code");
    if (resultCell.length === 0) throw new ParseError(`Compact row for ${code} has no result cell`);
    const unit = normalizeUnit(resultCell.attr("data-unit"));
    const measurement = parseMeasurement(resultCell.text(), unit);
    current!.items.push({ code, name, measurement });
  });

  for (const sample of samples) {
    if (sample.items.length === 0) throw new ParseError(`Sample ${sample.sampleId} has no items`);
  }
  return samples;
}

function findTables($: CheerioAPI): Cheerio<AnyNode>[] {
  return $("table.assay")
    .toArray()
    .map((table) => $(table).first());
}

function discoverLinks($: CheerioAPI, pageKind: "body" | "appendix"): {
  appendixLinks: string[];
  nextLink: string | null;
  resumeLink: string | null;
} {
  const appendixLinks: string[] = [];
  const seen = new Set<string>();

  // A body page may carry a re-entry link for a replacement session. It is
  // discovered from page content like every other paging entry, but kept
  // separate so normal pagination never jumps through it.
  let resumeLink: string | null = null;

  $("a").each((_index, anchor) => {
    const href = $(anchor).attr("href");
    if (!href) return;
    const role = $(anchor).attr("data-role") ?? "";
    const isResume = role === "appendix-resume" || $(anchor).hasClass("appendix-resume-link");
    if (isResume) {
      if (!resumeLink) resumeLink = href;
      return;
    }
    const isAppendixLink =
      /\/appendix\//.test(href) ||
      role === "appendix" ||
      role === "next" ||
      $(anchor).hasClass("appendix") ||
      $(anchor).hasClass("next-page") ||
      $(anchor).attr("rel") === "next";
    if (!isAppendixLink) return;
    if (seen.has(href)) return;
    seen.add(href);
    appendixLinks.push(href);
  });

  let nextLink: string | null = null;
  if (pageKind === "body") {
    const firstAppendix = appendixLinks.find((href) => /\/appendix\/1(?:[?#]|$)/.test(href));
    nextLink = appendixLinks[0] ?? null;
    if (firstAppendix) nextLink = firstAppendix;
  } else {
    const explicit = $("a.next-page, a[rel=next], a[data-role=next]").first().attr("href");
    nextLink = explicit ?? appendixLinks.find((href) => !/\/appendix\/1(?:[?#]|$)/.test(href)) ?? null;
  }
  return { appendixLinks, nextLink, resumeLink };
}

export interface ParseContext {
  /** Snapshot the collector is pinned to; used when the page omits its own marker. */
  expectedSnapshotId?: string;
  /** URL of the page being parsed, recorded as each sample's provenance. */
  sourceUrl?: string;
}

export function parsePage(html: string, context: ParseContext = {}): ParsedPage {
  const $ = cheerio.load(html);
  const bodyClass = $("body").attr("class") ?? "";
  const layoutHint = $('meta[name="x-layout"]').attr("content");
  const title = normalizeSpace($("h1.report-title").text()) || normalizeSpace($("h1").first().text());

  const headingText = normalizeSpace($("h1").first().text());
  const reportNo =
    $('meta[name="x-report-no"]').attr("content") ||
    normalizeSpace($('[data-field="reportNo"]').first().text()) ||
    /^([A-Za-z][A-Za-z0-9._-]*)\s*(?:岩芯化验报告|附表)?/.exec(headingText)?.[1] ||
    "";
  if (!reportNo) throw new ParseError("Report number not found in page");

  const revisionText =
    $('meta[name="x-revision"]').attr("content") ||
    normalizeSpace($('[data-field="revision"]').first().text()) ||
    /第\s*(\d+)\s*修订/.exec(headingText)?.[1] ||
    /修订\s*[:：]?\s*(\d+)/.exec(normalizeSpace($("main p").first().text()))?.[1] ||
    /修订\s*[·:：]?\s*(\d+)/.exec(normalizeSpace($(".appendix-meta").text()))?.[1] ||
    "";
  const revision = Number(revisionText);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new ParseError(`Invalid revision "${revisionText}" for ${reportNo}`);
  }

  const snapshotId =
    $('meta[name="x-snapshot-id"]').attr("content") ||
    $(".snapshot").attr("data-snapshot-id") ||
    context.expectedSnapshotId ||
    "";
  if (!snapshotId) throw new ParseError(`Snapshot id missing for ${reportNo}`);

  const pageName = $('meta[name="x-page"]').attr("content") ?? "";
  const pageKind: "body" | "appendix" = pageName.startsWith("appendix") || /附表\s*\d+/.test(title)
    ? "appendix"
    : "body";

  const declaredSampleCountText = $('meta[name="x-sample-count"]').attr("content");
  const declaredSampleCount = declaredSampleCountText ? Number(declaredSampleCountText) : null;

  const tables = findTables($);
  if (tables.length === 0) {
    const message = normalizeSpace($("main p").last().text()) || "No assay table found";
    throw new ParseError(`Page for ${reportNo} is not a valid report (${message})`);
  }
  if (tables.length > 1) throw new ParseError(`Unexpected ${tables.length} assay tables for ${reportNo}`);

  const table = tables[0]!;
  const layout =
    tableLayout($, table) ??
    (layoutHint === "classic" || layoutHint === "compact"
      ? layoutHint
      : bodyClass.includes("layout-compact")
        ? "compact"
        : "classic");

  const parsedSamples = layout === "compact" ? parseCompactTable($, table) : parseClassicTable($, table);
  if (parsedSamples.length === 0) throw new ParseError(`Page for ${reportNo} contains no samples`);
  const sourceUrl = context.sourceUrl ?? "";
  const samples = parsedSamples.map((sample) => ({ ...sample, sourceUrl }));

  const publishedAt =
    normalizeSpace($('[data-field="publishedAt"]').first().text()) || new Date(0).toISOString();

  const { appendixLinks, nextLink, resumeLink } = discoverLinks($, pageKind);
  return {
    reportNo,
    revision,
    snapshotId,
    layout,
    title: title || `${reportNo} 岩芯化验报告`,
    publishedAt,
    pageKind,
    declaredSampleCount: Number.isFinite(declaredSampleCount) ? declaredSampleCount : null,
    samples,
    sourceUrl,
    appendixLinks,
    nextLink,
    resumeLink: pageKind === "body" ? resumeLink : null,
  };
}

export interface PagePart {
  url: string;
  html: string;
}

/** Merge body + appendix pages into one validated report record. */
export function mergeReportParts(
  parts: PagePart[],
  options: { expectedSnapshotId: string; expectedRevision: number },
): { record: Omit<ReportRecord, "collectedAt">; layout: Layout } {
  if (parts.length === 0) throw new ParseError("No pages supplied");
  const parsed = parts.map((part) => {
    try {
      return parsePage(part.html, {
        expectedSnapshotId: options.expectedSnapshotId,
        sourceUrl: part.url,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ParseError(`${part.url}: ${reason}`);
    }
  });
  const first = parsed[0]!;
  if (first.pageKind !== "body") throw new ParseError("First page is not the report body");

  for (const page of parsed) {
    if (page.reportNo !== first.reportNo) {
      throw new ParseError(`Appendix ${page.reportNo} does not belong to report ${first.reportNo}`);
    }
    if (page.revision !== first.revision) {
      throw new ParseError(
        `Revision mismatch in ${first.reportNo}: body rev ${first.revision}, page rev ${page.revision}`,
      );
    }
    if (page.snapshotId !== first.snapshotId) {
      throw new ParseError(
        `Snapshot mismatch in ${first.reportNo}: body ${first.snapshotId}, page ${page.snapshotId}`,
      );
    }
  }
  if (first.snapshotId !== options.expectedSnapshotId) {
    throw new ParseError(
      `Snapshot ${first.snapshotId} does not match the run snapshot ${options.expectedSnapshotId}`,
    );
  }
  if (first.revision !== options.expectedRevision) {
    throw new ParseError(
      `Revision ${first.revision} does not match the directory revision ${options.expectedRevision}`,
    );
  }

  const byId = new Map<string, Sample>();
  const order: string[] = [];
  for (const page of parsed) {
    for (const sample of page.samples) {
      const existing = byId.get(sample.sampleId);
      if (!existing) {
        byId.set(sample.sampleId, sample);
        order.push(sample.sampleId);
        continue;
      }
      if (existing.fromM !== sample.fromM || existing.toM !== sample.toM) {
        throw new ParseError(`Sample ${sample.sampleId} appears on two pages with different depths`);
      }
      for (const item of sample.items) {
        const prior = existing.items.find((candidate) => candidate.code === item.code);
        if (!prior) {
          existing.items.push(item);
        } else if (prior.measurement.kind !== item.measurement.kind || prior.measurement.rawText !== item.measurement.rawText) {
          throw new ParseError(
            `Sample ${sample.sampleId} / ${item.code} has conflicting values across pages`,
          );
        }
      }
    }
  }

  const samples = order.map((id) => byId.get(id)!);
  if (first.declaredSampleCount !== null && samples.length !== first.declaredSampleCount) {
    throw new ParseError(
      `Expected ${first.declaredSampleCount} samples for ${first.reportNo}, parsed ${samples.length}`,
    );
  }

  return {
    layout: first.layout,
    record: {
      reportNo: first.reportNo,
      revision: first.revision,
      snapshotId: first.snapshotId,
      layout: first.layout,
      title: first.title,
      publishedAt: first.publishedAt,
      source: {
        bodyUrl: parts[0]!.url,
        appendixUrls: parts.slice(1).map((part) => part.url),
      },
      samples,
    },
  };
}
