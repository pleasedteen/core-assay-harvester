/** Shared data contracts between the mock assay site, collector and tests. */

export type ContentUnit = "pct" | "mg/kg";
export type Layout = "classic" | "compact";

/** How a measurement is represented in the published report. */
export type MeasurementKind = "value" | "below_detection_limit" | "missing";

export interface Measurement {
  kind: MeasurementKind;
  /** The exact published representation, e.g. "1.24", "< 0.01", "—". */
  rawText: string;
  /** Only for kind === "value": the exact value exactly as published (decimal string). */
  rawValue: string | null;
  /** Only for kind === "value": the unit the publisher used. */
  rawUnit: ContentUnit | null;
  /** Canonical content in mg/kg. Only for kind === "value". */
  mgPerKg: number | null;
  /** Exact canonical content as a decimal string. Only for kind === "value". */
  mgPerKgExact: string | null;
  /** Detection limit as published, normalized to mg/kg, when stated. */
  detectionLimitMgPerKg: number | null;
  /** Exact detection limit as published (decimal string), when stated. */
  detectionLimitRaw: string | null;
  detectionLimitUnit: ContentUnit | null;
}

export interface AssayItem {
  code: string;
  name: string;
  measurement: Measurement;
}

export interface Sample {
  sampleId: string;
  /** Depth interval in metres, as published. */
  fromM: string | null;
  toM: string | null;
  lithology: string | null;
  /** Page this sample was published on (body or appendix), for provenance. */
  sourceUrl: string;
  items: AssayItem[];
}

export interface ReportRecord {
  reportNo: string;
  revision: number;
  /** Snapshot id assigned by the site, identical for every page of one crawl target. */
  snapshotId: string;
  layout: Layout;
  title: string;
  publishedAt: string;
  source: {
    /** URLs used to obtain the report body and all appendix pages. */
    bodyUrl: string;
    appendixUrls: string[];
  };
  samples: Sample[];
  /** ISO timestamp when the collector finished persisting the record. */
  collectedAt: string;
}

export interface ProgressSnapshot {
  runId: string | null;
  state: "idle" | "running" | "interrupted" | "failed" | "complete";
  snapshotId: string | null;
  siteUrl: string | null;
  indexUrl: string | null;
  expectedReports: number;
  deliveredReports: number;
  pending: string[];
  missing: Array<{ reportNo: string; reason: string }>;
  failed: Array<{ reportNo: string; reason: string }>;
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  resumedFrom: string | null;
}
