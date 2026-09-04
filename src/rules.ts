import type { AssetPrice } from "./market.js";
import type { PortfolioView } from "./engine.js";
import type { Strategy, StrategyRule } from "./store.js";
import { formatBase, fromBase, toBase, usdToBase } from "./units.js";

/**
 * Deterministic strategy evaluation.
 *
 * This module contains no model calls and no network calls. Given prices, a
 * portfolio, and the compiled rules, the same inputs always produce the same
 * decisions — which is what makes the safety properties auditable and lets
 * monitoring run without any AI provider configured.
 */

export interface TriggeredAction {
  strategyId: string;
  strategyName: string;
  from: string;
  to: string;
  /** base units of `from` — never a float, so it is always representable on-chain */
  amount: bigint;
  reason: string;
}

export interface SkippedStrategy {
  strategyId: string;
  strategyName: string;
  reason: string;
}

export interface EvaluationResult {
  triggered: TriggeredAction[];
  skipped: SkippedStrategy[];
}

function hoursSince(iso: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

function evaluateDca(
  rule: Extract<StrategyRule, { kind: "dca" }>,
  strategy: Strategy,
  portfolio: PortfolioView,
): TriggeredAction | SkippedStrategy {
  const elapsed = hoursSince(strategy.lastFiredAt);
  if (elapsed < rule.everyHours) {
    const due = round(rule.everyHours - elapsed, 1);
    return {
      strategyId: strategy.id,
      strategyName: strategy.name,
      reason: `not due for another ${due}h`,
    };
  }
  const available = portfolio.balances[rule.from]?.base ?? 0n;
  const wanted = toBase(rule.amount, rule.from);
  if (available < wanted) {
    return {
      strategyId: strategy.id,
      strategyName: strategy.name,
      reason: `insufficient ${rule.from} (have ${formatBase(available, rule.from)}, need ${rule.amount})`,
    };
  }
  return {
    strategyId: strategy.id,
    strategyName: strategy.name,
    from: rule.from,
    to: rule.to,
    amount: wanted,
    reason:
      strategy.lastFiredAt === null
        ? `first DCA run: ${rule.amount} ${rule.from} -> ${rule.to}`
        : `DCA interval of ${rule.everyHours}h elapsed (${round(elapsed, 1)}h since last run)`,
  };
}

function evaluateRebalance(
  rule: Extract<StrategyRule, { kind: "rebalance" }>,
  strategy: Strategy,
  portfolio: PortfolioView,
  prices: Record<string, AssetPrice>,
): TriggeredAction | SkippedStrategy {
  const skip = (reason: string): SkippedStrategy => ({
    strategyId: strategy.id,
    strategyName: strategy.name,
    reason,
  });

  // Weights are measured across the TARGETED assets only, never the whole
  // portfolio. Measuring against the whole portfolio makes targets that sum to
  // 1 unreachable whenever the user also holds an untargeted asset, so the rule
  // fires on every cycle forever and bleeds fees. Normalising to the targeted
  // subset is both the correct reading of "keep my STX/sBTC split at 60/40" and
  // what makes the loop terminate.
  const assets = Object.keys(rule.targets);
  const subsetUsd = assets.reduce((sum, a) => sum + (portfolio.balances[a]?.usdValue ?? 0), 0);
  if (subsetUsd <= 0) return skip("none of the targeted assets are held");

  const drifts = assets.map((asset) => {
    const usd = portfolio.balances[asset]?.usdValue ?? 0;
    const weight = usd / subsetUsd;
    return { asset, target: rule.targets[asset], weight, driftPct: (weight - rule.targets[asset]) * 100 };
  });

  const worst = drifts.reduce((a, b) => (Math.abs(b.driftPct) > Math.abs(a.driftPct) ? b : a));
  if (Math.abs(worst.driftPct) < rule.driftPct) {
    return skip(
      `max drift ${round(Math.abs(worst.driftPct), 2)}pp is under the ${rule.driftPct}pp threshold`,
    );
  }

  // Most overweight asset sells into the most underweight one.
  const over = drifts.reduce((a, b) => (b.driftPct > a.driftPct ? b : a));
  const under = drifts.reduce((a, b) => (b.driftPct < a.driftPct ? b : a));
  if (over.asset === under.asset) return skip("no offsetting pair");
  if (over.driftPct <= 0) return skip("no overweight asset to sell");

  // Move the full excess: with subset-normalised weights this lands both legs
  // on target in one trade, so the rule stops firing instead of grinding.
  const excessUsd = (over.weight - over.target) * subsetUsd;
  const price = prices[over.asset]?.usd ?? 0;
  if (!Number.isFinite(price) || price <= 0) return skip(`no price for ${over.asset}`);
  if (!Number.isFinite(excessUsd) || excessUsd <= 0) return skip("nothing to rebalance");

  const available = portfolio.balances[over.asset]?.base ?? 0n;
  const wanted = usdToBase(excessUsd, over.asset, price);
  const amount = wanted < available ? wanted : available;
  if (amount <= 0n) return skip("computed trade size is not positive");

  return {
    strategyId: strategy.id,
    strategyName: strategy.name,
    from: over.asset,
    to: under.asset,
    amount,
    reason:
      `${over.asset} is ${round(over.weight * 100, 1)}% of the targeted set vs ${round(over.target * 100, 1)}% target ` +
      `(+${round(over.driftPct, 2)}pp, over the ${rule.driftPct}pp threshold); ` +
      `${under.asset} is underweight at ${round(under.weight * 100, 1)}%`,
  };
}

function evaluateThreshold(
  rule: Extract<StrategyRule, { kind: "threshold" }>,
  strategy: Strategy,
  portfolio: PortfolioView,
  prices: Record<string, AssetPrice>,
): TriggeredAction | SkippedStrategy {
  const elapsed = hoursSince(strategy.lastFiredAt);
  if (elapsed < rule.cooldownHours) {
    return {
      strategyId: strategy.id,
      strategyName: strategy.name,
      reason: `cooling down (${round(rule.cooldownHours - elapsed, 1)}h remaining)`,
    };
  }
  const change = prices[rule.asset]?.change24hPct;
  if (change === null || change === undefined) {
    return {
      strategyId: strategy.id,
      strategyName: strategy.name,
      reason: `no 24h change data for ${rule.asset}`,
    };
  }
  const met = rule.direction === "drop" ? change <= -rule.changePct : change >= rule.changePct;
  if (!met) {
    return {
      strategyId: strategy.id,
      strategyName: strategy.name,
      reason: `${rule.asset} 24h change ${round(change, 2)}% has not ${rule.direction === "drop" ? "fallen to" : "risen to"} ${rule.direction === "drop" ? "-" : "+"}${rule.changePct}%`,
    };
  }
  const available = portfolio.balances[rule.from]?.base ?? 0n;
  const wanted = toBase(rule.amount, rule.from);
  if (available < wanted) {
    return {
      strategyId: strategy.id,
      strategyName: strategy.name,
      reason: `condition met but insufficient ${rule.from} (have ${formatBase(available, rule.from)})`,
    };
  }
  return {
    strategyId: strategy.id,
    strategyName: strategy.name,
    from: rule.from,
    to: rule.to,
    amount: wanted,
    reason: `${rule.asset} moved ${round(change, 2)}% in 24h, crossing the ${rule.direction === "drop" ? "-" : "+"}${rule.changePct}% trigger`,
  };
}

function isTriggered(x: TriggeredAction | SkippedStrategy): x is TriggeredAction {
  return "from" in x;
}

export function evaluateStrategies(
  strategies: Strategy[],
  portfolio: PortfolioView,
  prices: Record<string, AssetPrice>,
): EvaluationResult {
  const triggered: TriggeredAction[] = [];
  const skipped: SkippedStrategy[] = [];

  for (const strategy of strategies) {
    if (!strategy.active) continue;
    if (!strategy.rule) {
      skipped.push({
        strategyId: strategy.id,
        strategyName: strategy.name,
        reason: "no compiled rule — re-save this strategy to compile it",
      });
      continue;
    }

    let outcome: TriggeredAction | SkippedStrategy;
    switch (strategy.rule.kind) {
      case "dca":
        outcome = evaluateDca(strategy.rule, strategy, portfolio);
        break;
      case "rebalance":
        outcome = evaluateRebalance(strategy.rule, strategy, portfolio, prices);
        break;
      case "threshold":
        outcome = evaluateThreshold(strategy.rule, strategy, portfolio, prices);
        break;
    }

    if (isTriggered(outcome)) triggered.push(outcome);
    else skipped.push(outcome);
  }

  return { triggered, skipped };
}

/**
 * Validate a compiled rule before it is stored. Called from every creation path
 * (CLI and agent), so an unknown asset or a nonsensical weight set fails loudly
 * at save time rather than silently never firing.
 */
export function validateRule(rule: StrategyRule, knownAssets: string[]): void {
  const check = (asset: string, field: string) => {
    if (!knownAssets.includes(asset)) {
      throw new Error(
        `Unknown asset "${asset}" in ${field}. Supported: ${knownAssets.join(", ")}`,
      );
    }
  };
  const positive = (n: number, field: string) => {
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${field} must be a positive number`);
  };

  switch (rule.kind) {
    case "dca":
      check(rule.from, "from");
      check(rule.to, "to");
      if (rule.from === rule.to) throw new Error("from and to must differ");
      positive(rule.amount, "amount");
      positive(rule.everyHours, "everyHours");
      break;

    case "rebalance": {
      const entries = Object.entries(rule.targets);
      if (entries.length < 2) throw new Error("rebalance needs at least two target assets");
      for (const [asset, weight] of entries) {
        check(asset, "targets");
        if (!Number.isFinite(weight) || weight <= 0 || weight >= 1) {
          throw new Error(`target weight for ${asset} must be between 0 and 1 (got ${weight})`);
        }
      }
      const sum = entries.reduce((s, [, w]) => s + w, 0);
      if (Math.abs(sum - 1) > 0.001) {
        throw new Error(`target weights must sum to 1 (got ${round(sum, 4)})`);
      }
      positive(rule.driftPct, "driftPct");
      if (rule.driftPct >= 100) throw new Error("driftPct must be below 100");
      break;
    }

    case "threshold":
      check(rule.asset, "asset");
      check(rule.from, "from");
      check(rule.to, "to");
      if (rule.from === rule.to) throw new Error("from and to must differ");
      positive(rule.changePct, "changePct");
      positive(rule.amount, "amount");
      positive(rule.cooldownHours, "cooldownHours");
      break;
  }
}

/** Human-readable one-liner for a compiled rule (used by the CLI, no model needed). */
export function describeRule(rule: StrategyRule): string {
  switch (rule.kind) {
    case "dca":
      return `DCA ${rule.amount} ${rule.from} -> ${rule.to} every ${rule.everyHours}h`;
    case "rebalance": {
      const t = Object.entries(rule.targets)
        .map(([a, w]) => `${Math.round(w * 100)}% ${a}`)
        .join(" / ");
      return `Rebalance to ${t} when drift exceeds ${rule.driftPct}pp`;
    }
    case "threshold":
      return `If ${rule.asset} ${rule.direction}s ${rule.changePct}% in 24h, swap ${rule.amount} ${rule.from} -> ${rule.to} (cooldown ${rule.cooldownHours}h)`;
  }
}
