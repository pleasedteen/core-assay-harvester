import type { ContentUnit, Measurement } from "./types.js";

/** 1 % == 10 000 mg/kg. */
export const MG_PER_KG_PER_PERCENT = 10_000;

const DECIMAL = /^\d+(?:\.\d+)?$/;

/** Parse a published decimal without losing precision; null when malformed. */
export function parseDecimal(text: string): { coefficient: bigint; scale: number } | null {
  const trimmed = text.trim();
  if (!DECIMAL.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  return { coefficient: BigInt(`${whole}${frac}`), scale: frac.length };
}

/**
 * Convert an exact published decimal in the given unit to mg/kg.
 * Returns the number for the canonical field plus the exact scaled integer
 * so downstream consumers can verify no precision loss.
 */
export function toMgPerKg(rawValue: string, unit: ContentUnit): {
  mgPerKg: number;
  exact: { coefficient: bigint; scale: number };
} | null {
  const parsed = parseDecimal(rawValue);
  if (!parsed) return null;
  let { coefficient, scale } = parsed;
  if (unit === "pct") {
    coefficient *= BigInt(MG_PER_KG_PER_PERCENT);
  } else if (unit !== "mg/kg") {
    return null;
  }
  const asNumber = Number(coefficient) / 10 ** scale;
  if (!Number.isFinite(asNumber)) return null;
  return { mgPerKg: asNumber, exact: { coefficient, scale } };
}

/** Format an exact scaled integer as a decimal string, trimming trailing zeros. */
export function formatExact(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale) || "0";
  let frac = scale > 0 ? digits.slice(digits.length - scale) : "";
  frac = frac.replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

export function measurementFromValue(
  rawValue: string,
  rawUnit: ContentUnit,
  rawText = rawValue,
): Measurement {
  const converted = toMgPerKg(rawValue, rawUnit);
  if (!converted) throw new Error(`Invalid measurement value: ${rawValue} ${rawUnit}`);
  return {
    kind: "value",
    rawText,
    rawValue,
    rawUnit,
    mgPerKg: converted.mgPerKg,
    mgPerKgExact: formatExact(converted.exact.coefficient, converted.exact.scale),
    detectionLimitMgPerKg: null,
    detectionLimitRaw: null,
    detectionLimitUnit: null,
  };
}

export function belowDetectionLimit(
  limitRaw: string,
  limitUnit: ContentUnit,
  rawText = `< ${limitRaw}`,
): Measurement {
  const converted = toMgPerKg(limitRaw, limitUnit);
  if (!converted) throw new Error(`Invalid detection limit: ${limitRaw} ${limitUnit}`);
  return {
    kind: "below_detection_limit",
    rawText,
    rawValue: null,
    rawUnit: null,
    mgPerKg: null,
    mgPerKgExact: null,
    detectionLimitMgPerKg: converted.mgPerKg,
    detectionLimitRaw: limitRaw,
    detectionLimitUnit: limitUnit,
  };
}

export function missingMeasurement(rawText = "—"): Measurement {
  return {
    kind: "missing",
    rawText,
    rawValue: null,
    rawUnit: null,
    mgPerKg: null,
    mgPerKgExact: null,
    detectionLimitMgPerKg: null,
    detectionLimitRaw: null,
    detectionLimitUnit: null,
  };
}
