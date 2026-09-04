import { ASSETS } from "./config.js";

/**
 * Asset amounts as integer base units.
 *
 * Money must not be held in f64. Repeated float arithmetic drifts (a balance
 * ends up as 4936.8159897951045 STX), and a float amount can express a quantity
 * that is not representable on-chain — STX has 6 decimals, sBTC has 8, so
 * anything finer is a value no transaction can actually move.
 *
 * Every balance and trade amount is therefore a bigint count of base units
 * (microSTX, satoshis). Floats are permitted only for USD valuations and the
 * fee/slippage model, and any float that becomes an amount is quantised through
 * `usdToBase` / `toBase` before it can touch a balance.
 */

export function decimalsOf(asset: string): number {
  const config = ASSETS[asset];
  if (!config) {
    throw new Error(`Unknown asset "${asset}". Supported: ${Object.keys(ASSETS).join(", ")}`);
  }
  return config.decimals;
}

function scale(asset: string): bigint {
  return 10n ** BigInt(decimalsOf(asset));
}

/** Human amount -> base units, truncating anything finer than the asset supports. */
export function toBase(amount: number, asset: string): bigint {
  if (!Number.isFinite(amount)) throw new Error(`amount is not finite: ${amount}`);
  if (amount < 0) throw new Error(`amount is negative: ${amount}`);
  const decimals = decimalsOf(asset);
  // Format through a fixed-decimal string rather than multiplying by a power of
  // ten, which would reintroduce binary rounding error at the boundary.
  const [whole, frac = ""] = amount.toFixed(decimals).split(".");
  return BigInt(whole) * scale(asset) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Base units -> human amount. Display and USD maths only; never store this. */
export function fromBase(base: bigint, asset: string): number {
  return Number(base) / Number(scale(asset));
}

/** JSON-safe persistence: bigint has no JSON representation. */
export function serializeBase(base: bigint): string {
  return base.toString();
}

export function parseBase(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`base units must be integral: ${value}`);
    return BigInt(value);
  }
  return BigInt(value);
}

export function usdValueOf(base: bigint, asset: string, priceUsd: number): number {
  return fromBase(base, asset) * priceUsd;
}

/** USD -> base units of `asset`, truncated to what the chain can represent. */
export function usdToBase(usd: number, asset: string, priceUsd: number): bigint {
  if (!Number.isFinite(usd) || !Number.isFinite(priceUsd) || priceUsd <= 0) return 0n;
  if (usd <= 0) return 0n;
  return toBase(usd / priceUsd, asset);
}

/** Fixed-point display, trailing zeros trimmed. */
export function formatBase(base: bigint, asset: string): string {
  const decimals = decimalsOf(asset);
  const s = scale(asset);
  const negative = base < 0n;
  const abs = negative ? -base : base;
  const whole = abs / s;
  const frac = (abs % s).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * Apply a float ratio to a base-unit amount, returning base units.
 * Used by the paper fill model: the ratio may be fractional, the result may not.
 */
export function applyRate(base: bigint, rate: number, fromAsset: string, toAsset: string): bigint {
  if (!Number.isFinite(rate) || rate <= 0) return 0n;
  return toBase(fromBase(base, fromAsset) * rate, toAsset);
}
