/**
 * Deterministic content defects for tests. Unlike transport faults (bans,
 * dropped connections, corrupt HTML), these change the *semantic* content of
 * a report so that the rendered body and appendices disagree with the
 * directory manifest, while the pages themselves remain internally
 * consistent and parseable. The manifest always reflects the intact seed.
 *
 * Determinism rules:
 *  - applying a defect is a pure function of the (report, defect) pair, so
 *    the body and every appendix page render identical content without any
 *    cross-page state;
 *  - a defect only consumes its render budget when its target actually
 *    exists on the rendered page (e.g. a defect on an appendix-only sample is
 *    not spent by the body render);
 *  - once the budget reaches zero the defect goes dormant and later renders
 *    (including a collector resume) return to intact content.
 */

import type { ReportSeed, SampleSeed } from "./content.js";
import type { MeasurementKind } from "../shared/types.js";

export type ContentDefectType =
  | "omitSample"
  | "omitItem"
  | "duplicateItem"
  | "limitWithoutValue";

export interface ContentDefect {
  type: ContentDefectType;
  reportNo: string;
  /** How many report renders the defect applies to (default 1). */
  times: number;
  sampleId?: string;
  itemCode?: string;
  /** For duplicateItem: the item code that occupies the target slot. */
  sourceItemCode?: string;
}

/**
 * Apply the armed content defects to one *page-worth* of samples (the body
 * or a single appendix page). A defect only fires — and only spends its
 * render budget — when its target sample is actually present on that page,
 * so a defect aimed at an appendix sample stays armed through the body
 * render. Because the application is deterministic, every page renders the
 * same content whether or not it is ever retried.
 */
export function applyContentDefects(
  intact: ReportSeed,
  pageSamples: SampleSeed[],
  defects: ContentDefect[],
): SampleSeed[] {
  const page = new Set(pageSamples.map((sample) => sample.sampleId));
  // Work on deep-copied page samples; pages not touched by a defect stay
  // referentially identical to the intact seed.
  const working = new Map<string, SampleSeed>();
  const ensureSample = (sampleId: string): SampleSeed => {
    let sample = working.get(sampleId);
    if (!sample) {
      const original = pageSamples.find((candidate) => candidate.sampleId === sampleId)!;
      sample = { ...original, items: original.items.map((item) => ({ ...item })) };
      working.set(sampleId, sample);
    }
    return sample;
  };

  for (const defect of defects) {
    if (defect.reportNo !== intact.reportNo || defect.times <= 0) continue;

    if (defect.type === "omitSample") {
      const target = defect.sampleId
        ? pageSamples.find((sample) => sample.sampleId === defect.sampleId)
        : pageSamples[pageSamples.length - 1];
      if (!target || !page.has(target.sampleId)) continue;
      page.delete(target.sampleId);
      defect.times -= 1;
      continue;
    }

    const sample = defect.sampleId
      ? pageSamples.find((candidate) => candidate.sampleId === defect.sampleId)
      : pageSamples[pageSamples.length - 1];
    if (!sample || !page.has(sample.sampleId)) continue;
    const item = defect.itemCode
      ? sample.items.find((candidate) => candidate.code === defect.itemCode)
      : sample.items[sample.items.length - 1];
    if (!item) continue;
    const liveSample = ensureSample(sample.sampleId);

    if (defect.type === "omitItem") {
      if (!liveSample.items.some((candidate) => candidate.code === item.code)) continue;
      liveSample.items = liveSample.items.filter((candidate) => candidate.code !== item.code);
      defect.times -= 1;
      continue;
    }

    if (defect.type === "duplicateItem") {
      // A duplicate row/column occupies the declared item's slot, so the
      // declared code disappears and another code shows up twice.
      const source =
        liveSample.items.find((candidate) => candidate.code === defect.sourceItemCode) ??
        liveSample.items.find((candidate) => candidate.code !== item.code);
      if (!source) continue;
      const index = liveSample.items.findIndex((candidate) => candidate.code === item.code);
      if (index < 0) continue;
      liveSample.items[index] = { ...source };
      defect.times -= 1;
      continue;
    }

    if (defect.type === "limitWithoutValue") {
      const index = liveSample.items.findIndex((candidate) => candidate.code === item.code);
      if (index < 0) continue;
      // Below-detection-limit cell whose detection limit carries no numeric
      // value at all (a unit is still published).
      const liveItem = liveSample.items[index]!;
      liveSample.items[index] = {
        code: liveItem.code,
        name: liveItem.name,
        kind: "below_detection_limit" as MeasurementKind,
        value: null,
        unit: liveItem.unit ?? "mg/kg",
        limit: null,
      };
      defect.times -= 1;
    }
  }

  return pageSamples
    .filter((sample) => page.has(sample.sampleId))
    .map((sample) => working.get(sample.sampleId) ?? sample);
}
