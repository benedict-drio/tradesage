import { dlmmAdapter } from "./dlmm.js";
import { velarAdapter } from "./velar.js";
import type { DexAdapter, DexQuote } from "./types.js";

export type { DexAdapter, DexQuote, SwapPayload } from "./types.js";
export { dlmmPoolDepth } from "./dlmm.js";

/** Registry, in no particular order — selection is on price, not position. */
export const ADAPTERS: DexAdapter[] = [dlmmAdapter, velarAdapter];

export function adapterByName(name: string): DexAdapter {
  const found = ADAPTERS.find((a) => a.name === name);
  if (!found) {
    throw new Error(`Unknown venue "${name}". Available: ${ADAPTERS.map((a) => a.name).join(", ")}`);
  }
  return found;
}

export interface RoutingResult {
  best: DexQuote;
  /** every venue that answered, best first — kept so a routing decision is auditable */
  considered: DexQuote[];
  failed: Array<{ venue: string; reason: string }>;
}

/**
 * Quote the pair at every venue that supports it and return the best.
 *
 * Quotes are gathered concurrently and a failing venue is recorded rather than
 * allowed to fail the route, so one DEX being down degrades pricing instead of
 * stopping execution. That is the property that makes a single venue's outage,
 * SDK breakage, or disclosed vulnerability survivable.
 */
export async function routeBestQuote(
  from: string,
  to: string,
  amountIn: bigint,
): Promise<RoutingResult> {
  const eligible = ADAPTERS.filter((a) => a.supports(from, to));
  if (eligible.length === 0) {
    throw new Error(`No configured venue trades ${from}/${to}`);
  }

  const settled = await Promise.allSettled(eligible.map((a) => a.quote(from, to, amountIn)));

  const considered: DexQuote[] = [];
  const failed: RoutingResult["failed"] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") considered.push(r.value);
    else failed.push({ venue: eligible[i].name, reason: String(r.reason?.message ?? r.reason) });
  });

  if (considered.length === 0) {
    throw new Error(
      `Every venue failed to quote ${from}/${to}: ${failed.map((f) => `${f.venue} (${f.reason})`).join("; ")}`,
    );
  }

  considered.sort((a, b) => (b.expectedOut > a.expectedOut ? 1 : b.expectedOut < a.expectedOut ? -1 : 0));
  return { best: considered[0], considered, failed };
}

/** Slippage floor applied to a quote to produce the chain-enforced minimum. */
export function minimumReceived(quote: DexQuote, slippageBps: number): bigint {
  return (quote.expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}
