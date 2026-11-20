/** Deterministic synthetic assay-report content. */

import type { ContentUnit, Layout, MeasurementKind } from "../shared/types.js";

export interface ItemSeed {
  code: string;
  name: string;
  kind: MeasurementKind;
  /** Decimal string for kind === "value". */
  value: string | null;
  /** Unit for value / detection-limit entries. */
  unit: ContentUnit | null;
  /** Detection limit decimal string for kind === "below_detection_limit". */
  limit: string | null;
}

export interface SampleSeed {
  sampleId: string;
  fromM: string;
  toM: string;
  lithology: string;
  items: ItemSeed[];
}

export interface ReportSeed {
  reportNo: string;
  revision: number;
  title: string;
  layout: Layout;
  publishedAt: string;
  samples: SampleSeed[];
}

export const REPORT_NOS = ["R-0001", "R-0002", "R-0003", "R-0004", "R-0005", "R-0006"] as const;

const LITHOLOGIES = ["砂岩", "粉砂岩", "泥岩", "灰岩", "花岗岩", "砾岩"];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function baseLayout(reportIndex: number): Layout {
  return reportIndex % 2 === 0 ? "classic" : "compact";
}

function buildItems(
  reportNo: string,
  revision: number,
  sampleIndex: number,
  sampleCount: number,
  rng: () => number,
): ItemSeed[] {
  const reportIndex = REPORT_NOS.indexOf(reportNo as (typeof REPORT_NOS)[number]);
  const value = (min: number, max: number, digits: number): string =>
    (min + rng() * (max - min)).toFixed(digits);

  const items: ItemSeed[] = [
    {
      code: "Au",
      name: "金",
      kind: "value",
      value: value(0.45, 3.2, 2),
      unit: "pct",
      limit: null,
    },
    {
      code: "Ag",
      name: "银",
      kind: "value",
      value: value(4, 95, 1),
      unit: "mg/kg",
      limit: null,
    },
    {
      code: "Cu",
      name: "铜",
      kind: "value",
      value: value(0.012, 0.92, 3),
      unit: "pct",
      limit: null,
    },
    {
      code: "Pb",
      name: "铅",
      kind: "value",
      value: value(8, 160, 0),
      unit: "mg/kg",
      limit: null,
    },
  ];

  // One below-detection-limit result and one missing result per report, with
  // the affected sample/item determined deterministically by revision.
  const bdlSample = (reportIndex + revision) % sampleCount;
  if (sampleIndex === bdlSample) {
    if ((reportIndex + revision) % 2 === 0) {
      items[0] = { code: "Au", name: "金", kind: "below_detection_limit", value: null, unit: "pct", limit: "0.01" };
    } else {
      items[1] = { code: "Ag", name: "银", kind: "below_detection_limit", value: null, unit: "mg/kg", limit: "0.5" };
    }
  }

  const missingSample = (reportIndex + revision + 1) % sampleCount;
  if (sampleIndex === missingSample) {
    items[3] = { code: "Pb", name: "铅", kind: "missing", value: null, unit: null, limit: null };
  }

  // Detection-item sets are allowed to differ between samples of one report:
  // roughly half the samples additionally carry a Zn (锌) result. The
  // directory manifest declares exactly which samples include it.
  const zincRoll = rng();
  if ((reportIndex + sampleIndex) % 2 === 0) {
    items.push({
      code: "Zn",
      name: "锌",
      kind: "value",
      value: (15 + zincRoll * 220).toFixed(1),
      unit: "mg/kg",
      limit: null,
    });
  }

  return items;
}

export function buildReport(reportNo: string, revision: number): ReportSeed {
  const reportIndex = REPORT_NOS.indexOf(reportNo as (typeof REPORT_NOS)[number]);
  if (reportIndex < 0) throw new Error(`Unknown report ${reportNo}`);
  const rng = mulberry32(hashString(`${reportNo}@${revision}`));
  // 2 samples => body only (no appendix); 5 samples => three appendix pages.
  const sampleCount = [4, 3, 2, 4, 3, 5][reportIndex]!;
  const samples: SampleSeed[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const from = 3 + i * 1.6 + rng() * 0.4;
    const to = from + 0.8 + rng() * 0.6;
    samples.push({
      sampleId: `S-${reportNo}-${String(i + 1).padStart(2, "0")}`,
      fromM: from.toFixed(1),
      toM: to.toFixed(1),
      lithology: LITHOLOGIES[(reportIndex + i) % LITHOLOGIES.length]!,
      items: buildItems(reportNo, revision, i, sampleCount, rng),
    });
  }

  const layout = baseLayout(reportIndex);
  return {
    reportNo,
    revision,
    title: `${reportNo} 岩芯化验报告（第 ${revision} 修订）`,
    layout: revision === 1 ? layout : layout === "classic" ? "compact" : "classic",
    publishedAt: `2026-${revision === 1 ? "03" : "05"}-${String(10 + reportIndex).padStart(2, "0")}T08:30:00Z`,
    samples,
  };
}

/**
 * The authoritative declaration published in the directory manifest: which
 * samples exist and which detection items each of them must carry.
 */
export function reportDeclaration(report: ReportSeed): import("../shared/types.js").ReportDeclaration {
  return {
    reportNo: report.reportNo,
    revision: report.revision,
    samples: report.samples.map((sample) => ({
      sampleId: sample.sampleId,
      items: sample.items.map((item) => ({ code: item.code, name: item.name })),
    })),
  };
}
