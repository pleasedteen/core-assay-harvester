/**
 * Verify a parsed report against the site's directory-level declaration.
 *
 * The declaration names every sample and the detection items each sample
 * must carry; item sets may differ between samples of the same report.
 * Explicitly marked missing measurements ("—") are still valid — only
 * structural defects and unquantifiable detection limits are discrepancies.
 */

import type {
  DeclarationDiscrepancy,
  ReportDeclaration,
  ReportRecord,
} from "../shared/types.js";

function discrepancy(
  type: DeclarationDiscrepancy["type"],
  reportNo: string,
  sampleId: string | null,
  itemCode: string | null,
  detail: string,
): DeclarationDiscrepancy {
  return { type, reportNo, sampleId, itemCode, detail };
}

export function verifyAgainstDeclaration(
  record: Pick<ReportRecord, "reportNo" | "snapshotId" | "revision" | "samples">,
  declaration: ReportDeclaration,
): DeclarationDiscrepancy[] {
  const issues: DeclarationDiscrepancy[] = [];
  const reportNo = record.reportNo;

  const parsedById = new Map(record.samples.map((sample) => [sample.sampleId, sample]));

  // --- samples: missing rows and unexpected samples ------------------------
  for (const declaredSample of declaration.samples) {
    if (!parsedById.has(declaredSample.sampleId)) {
      issues.push(
        discrepancy(
          "sample_missing",
          reportNo,
          declaredSample.sampleId,
          null,
          `Sample ${declaredSample.sampleId} declared by the site is absent from the report content`,
        ),
      );
    }
  }
  for (const sample of record.samples) {
    if (!declaration.samples.some((declared) => declared.sampleId === sample.sampleId)) {
      issues.push(
        discrepancy(
          "sample_unexpected",
          reportNo,
          sample.sampleId,
          null,
          `Sample ${sample.sampleId} appears in the report but is not declared in the snapshot manifest`,
        ),
      );
    }
  }

  // --- per-sample detection items ------------------------------------------
  for (const declaredSample of declaration.samples) {
    const sample = parsedById.get(declaredSample.sampleId);
    if (!sample) {
      // Already reported as sample_missing; name every declared item too so
      // progress states exactly which detection items were lost with it.
      for (const item of declaredSample.items) {
        issues.push(
          discrepancy(
            "item_missing",
            reportNo,
            declaredSample.sampleId,
            item.code,
            `Item ${item.code} cannot be found because sample ${declaredSample.sampleId} is missing`,
          ),
        );
      }
      continue;
    }

    const seenCodes = new Map<string, number>();
    for (const item of sample.items) {
      seenCodes.set(item.code, (seenCodes.get(item.code) ?? 0) + 1);
    }

    for (const declaredItem of declaredSample.items) {
      const occurrences = seenCodes.get(declaredItem.code) ?? 0;
      if (occurrences === 0) {
        issues.push(
          discrepancy(
            "item_missing",
            reportNo,
            sample.sampleId,
            declaredItem.code,
            `Sample ${sample.sampleId} is missing declared detection item ${declaredItem.code}`,
          ),
        );
      } else if (occurrences > 1) {
        issues.push(
          discrepancy(
            "item_duplicated",
            reportNo,
            sample.sampleId,
            declaredItem.code,
            `Sample ${sample.sampleId} lists item ${declaredItem.code} ${occurrences} times (duplicate row/column)`,
          ),
        );
      }
    }

    for (const item of sample.items) {
      if (!declaredSample.items.some((declared) => declared.code === item.code)) {
        issues.push(
          discrepancy(
            "extra_item",
            reportNo,
            sample.sampleId,
            item.code,
            `Sample ${sample.sampleId} contains undeclared item ${item.code}`,
          ),
        );
      }
      // A below-detection-limit result must publish a numeric detection
      // limit; a unit alone is not quantifiable. Explicitly missing
      // measurements ("—") stay valid and are never flagged here.
      if (
        item.measurement.kind === "below_detection_limit" &&
        (item.measurement.detectionLimitRaw === null ||
          item.measurement.detectionLimitMgPerKg === null)
      ) {
        issues.push(
          discrepancy(
            "limit_without_value",
            reportNo,
            sample.sampleId,
            item.code,
            `Sample ${sample.sampleId} / ${item.code} is below detection limit but the detection limit has no numeric value`,
          ),
        );
      }
    }
  }

  return issues;
}

/** Turn discrepancies into a single human-readable failure reason. */
export function describeDiscrepancies(issues: DeclarationDiscrepancy[]): string {
  return issues
    .map((issue) => {
      const location = [issue.sampleId, issue.itemCode].filter(Boolean).join(" / ");
      return `${issue.type}${location ? ` ${location}` : ""}: ${issue.detail}`;
    })
    .join("; ");
}
