import {
  ASSETS,
  BASE_SLIPPAGE_BPS,
  IMPACT_BPS_PER_10K_USD,
  STARTING_BALANCES,
  SWAP_FEE_BPS,
} from "./config.js";
import { getPrices, type AssetPrice } from "./market.js";
import { evaluateStrategies, type SkippedStrategy } from "./rules.js";
import {
  applyRate,
  formatBase,
  fromBase,
  parseBase,
  serializeBase,
  toBase,
  usdValueOf,
} from "./units.js";
import {
  capsStore,
  newId,
  portfolioStore,
  proposalStore,
  strategyStore,
  tradeStore,
  withLock,
  type Caps,
  type Portfolio,
  type Proposal,
  type Trade,
} from "./store.js";

export interface Quote {
  from: string;
  to: string;
  /** base units of `from` */
  amountIn: bigint;
  price: number; // units of `to` per unit of `from`, after fee + slippage
  /** base units of `to` */
  expectedOut: bigint;
  feeBps: number;
  slippageBps: number;
  notionalUsd: number;
}

export function assertAsset(symbol: string): void {
  if (!ASSETS[symbol]) {
    throw new Error(`Unknown asset "${symbol}". Supported: ${Object.keys(ASSETS).join(", ")}`);
  }
}

/** `amountIn` is base units of `from`. */
export async function getQuote(from: string, to: string, amountIn: bigint): Promise<Quote> {
  assertAsset(from);
  assertAsset(to);
  if (from === to) throw new Error("from and to must differ");
  if (amountIn <= 0n) throw new Error("amount must be positive");

  const prices = await getPrices();
  const notionalUsd = usdValueOf(amountIn, from, prices[from].usd);
  const slippageBps = BASE_SLIPPAGE_BPS + (notionalUsd / 10_000) * IMPACT_BPS_PER_10K_USD;
  const midPrice = prices[from].usd / prices[to].usd;
  const effectivePrice = midPrice * (1 - (SWAP_FEE_BPS + slippageBps) / 10_000);

  return {
    from,
    to,
    amountIn,
    price: effectivePrice,
    // Quantised to what `to` can actually represent on-chain.
    expectedOut: applyRate(amountIn, effectivePrice, from, to),
    feeBps: SWAP_FEE_BPS,
    slippageBps: Math.round(slippageBps),
    notionalUsd,
  };
}

export async function initPortfolio(reset = false): Promise<Portfolio> {
  const existing = portfolioStore.load();
  if (existing && !reset) return existing;

  const prices = await getPrices();
  let initialValueUsd = 0;
  const balances: Record<string, string> = {};
  for (const [symbol, amount] of Object.entries(STARTING_BALANCES)) {
    const base = toBase(amount, symbol);
    balances[symbol] = serializeBase(base);
    initialValueUsd += usdValueOf(base, symbol, prices[symbol].usd);
  }
  const portfolio: Portfolio = {
    createdAt: new Date().toISOString(),
    initialValueUsd,
    balances,
  };
  portfolioStore.save(portfolio);
  return portfolio;
}

export interface PortfolioView {
  balances: Record<string, { amount: number; base: bigint; usdValue: number }>;
  totalUsd: number;
  initialUsd: number;
  pnlUsd: number;
  pnlPct: number;
}

export async function valuePortfolio(): Promise<PortfolioView> {
  const portfolio = portfolioStore.load();
  if (!portfolio) throw new Error('No portfolio yet — run "tradesage init" first.');
  const prices = await getPrices();

  const balances: PortfolioView["balances"] = {};
  let totalUsd = 0;
  for (const [symbol, raw] of Object.entries(portfolio.balances)) {
    const base = parseBase(raw);
    const usdValue = usdValueOf(base, symbol, prices[symbol].usd);
    balances[symbol] = { amount: fromBase(base, symbol), base, usdValue };
    totalUsd += usdValue;
  }
  const pnlUsd = totalUsd - portfolio.initialValueUsd;
  return {
    balances,
    totalUsd,
    initialUsd: portfolio.initialValueUsd,
    pnlUsd,
    pnlPct: (pnlUsd / portfolio.initialValueUsd) * 100,
  };
}

export interface CapsUsage {
  caps: Caps;
  spentTodayUsd: number;
  remainingTodayUsd: number;
}

export function getCapsUsage(): CapsUsage {
  const caps = capsStore.load();
  const today = new Date().toISOString().slice(0, 10);
  const spentTodayUsd = tradeStore
    .load()
    .filter((t) => t.executedAt.slice(0, 10) === today)
    .reduce((sum, t) => sum + t.notionalUsd, 0);
  return {
    caps,
    spentTodayUsd,
    remainingTodayUsd: Math.max(0, caps.dailyUsd - spentTodayUsd),
  };
}

export function setCaps(update: Partial<Caps>): Caps {
  const caps = { ...capsStore.load(), ...update };
  if (caps.perTradeUsd <= 0 || caps.dailyUsd <= 0) {
    throw new Error("Caps must be positive USD amounts");
  }
  capsStore.save(caps);
  return caps;
}

function withinCaps(notionalUsd: number): boolean {
  const { caps, remainingTodayUsd } = getCapsUsage();
  return caps.enabled && notionalUsd <= caps.perTradeUsd && notionalUsd <= remainingTodayUsd;
}

export async function createProposal(input: {
  from: string;
  to: string;
  /** base units of `from` */
  amount: bigint;
  rationale: string;
  strategyId?: string | null;
}): Promise<Proposal> {
  assertAsset(input.from);
  assertAsset(input.to);
  const portfolio = portfolioStore.load();
  if (!portfolio) throw new Error('No portfolio yet — run "tradesage init" first.');
  const available = parseBase(portfolio.balances[input.from] ?? "0");
  if (input.amount > available) {
    throw new Error(
      `Insufficient ${input.from}: proposal needs ${formatBase(input.amount, input.from)}, ` +
        `portfolio holds ${formatBase(available, input.from)}`,
    );
  }

  const quote = await getQuote(input.from, input.to, input.amount);
  const proposal: Proposal = {
    id: newId("prop"),
    createdAt: new Date().toISOString(),
    status: "pending",
    from: input.from,
    to: input.to,
    amount: serializeBase(input.amount),
    rationale: input.rationale,
    strategyId: input.strategyId ?? null,
    quote: {
      price: quote.price,
      expectedOut: serializeBase(quote.expectedOut),
      feeBps: quote.feeBps,
      slippageBps: quote.slippageBps,
      notionalUsd: quote.notionalUsd,
    },
  };
  const proposals = proposalStore.load();
  proposals.push(proposal);
  proposalStore.save(proposals);

  // Session-scoped pre-approval: small trades inside the user's caps execute
  // immediately; the manual approve step is only for trades beyond the caps.
  if (withinCaps(quote.notionalUsd)) {
    await executeProposal(proposal.id, { auto: true });
    return proposalStore.load().find((p) => p.id === proposal.id)!;
  }
  return proposal;
}

async function executeProposal(id: string, opts: { auto: boolean }): Promise<Trade> {
  const proposals = proposalStore.load();
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal) throw new Error(`No proposal ${id}`);
  if (proposal.status !== "pending") throw new Error(`Proposal ${id} is ${proposal.status}`);

  const portfolio = portfolioStore.load();
  if (!portfolio) throw new Error("No portfolio");
  const available = parseBase(portfolio.balances[proposal.from] ?? "0");
  const amountIn = parseBase(proposal.amount);
  if (amountIn > available) {
    throw new Error(`Insufficient ${proposal.from} at execution time`);
  }

  // Re-quote at execution so fills use current prices, not stale proposal prices
  const quote = await getQuote(proposal.from, proposal.to, amountIn);
  const prices = await getPrices();

  // Exact integer arithmetic: balances cannot drift, and every amount stays
  // representable on-chain.
  const heldTo = parseBase(portfolio.balances[proposal.to] ?? "0");
  portfolio.balances[proposal.from] = serializeBase(available - amountIn);
  portfolio.balances[proposal.to] = serializeBase(heldTo + quote.expectedOut);
  portfolioStore.save(portfolio);

  proposal.status = "executed";
  proposal.autoExecuted = opts.auto;
  proposalStore.save(proposals);

  const trade: Trade = {
    id: newId("trade"),
    executedAt: new Date().toISOString(),
    proposalId: proposal.id,
    from: proposal.from,
    to: proposal.to,
    amountIn: proposal.amount,
    amountOut: serializeBase(quote.expectedOut),
    priceUsdIn: prices[proposal.from].usd,
    priceUsdOut: prices[proposal.to].usd,
    notionalUsd: quote.notionalUsd,
  };
  const trades = tradeStore.load();
  trades.push(trade);
  tradeStore.save(trades);
  return trade;
}

/** Manual approval path for proposals beyond the session caps. */
export async function approveProposal(id: string): Promise<Trade> {
  return withLock(() => executeProposal(id, { auto: false }));
}

/**
 * Locked entry point for callers outside a monitoring cycle (the agent's
 * propose_trade tool). `createProposal` itself stays unlocked because the cycle
 * already holds the lock when it calls it — the lock is not reentrant.
 */
export async function proposeTrade(input: {
  from: string;
  to: string;
  /** human-readable amount of `from`; quantised to base units on the way in */
  amount: number;
  rationale: string;
  strategyId?: string | null;
}): Promise<Proposal> {
  assertAsset(input.from);
  return withLock(() =>
    createProposal({ ...input, amount: toBase(input.amount, input.from) }),
  );
}

export interface TickResult {
  evaluatedAt: string;
  portfolio: PortfolioView;
  prices: Record<string, AssetPrice>;
  acted: Array<{ proposal: Proposal; reason: string; strategyName: string }>;
  skipped: SkippedStrategy[];
  errors: Array<{ strategyName: string; message: string }>;
}

/**
 * One monitoring cycle, start to finish, with **no model call**.
 *
 * Rules were compiled from natural language once at save time; this evaluates
 * them deterministically, opens proposals for whatever triggered, and lets the
 * caps decide which of those execute immediately. Runs with no AI provider
 * configured.
 */
export async function runTick(): Promise<TickResult> {
  // Whole cycle under the lock: evaluation reads balances and lastFiredAt, then
  // writes proposals, trades, and lastFiredAt. Two cycles interleaving there
  // execute the same strategy twice.
  return withLock(runTickLocked);
}

async function runTickLocked(): Promise<TickResult> {
  const portfolio = await valuePortfolio();
  const prices = await getPrices();
  const strategies = strategyStore.load();
  const { triggered, skipped } = evaluateStrategies(strategies, portfolio, prices);

  const acted: TickResult["acted"] = [];
  const errors: TickResult["errors"] = [];

  // A strategy with a proposal still awaiting approval must not queue another —
  // otherwise an un-approved rebalance re-proposes on every cycle and floods
  // the approval queue with near-identical entries.
  const awaitingApproval = new Set(
    proposalStore
      .load()
      .filter((p) => p.status === "pending" && p.strategyId !== null)
      .map((p) => p.strategyId as string),
  );

  for (const action of triggered) {
    if (awaitingApproval.has(action.strategyId)) {
      skipped.push({
        strategyId: action.strategyId,
        strategyName: action.strategyName,
        reason: "an earlier proposal from this strategy is still awaiting your approval",
      });
      continue;
    }
    try {
      const proposal = await createProposal({
        from: action.from,
        to: action.to,
        amount: action.amount,
        rationale: action.reason,
        strategyId: action.strategyId,
      });
      acted.push({ proposal, reason: action.reason, strategyName: action.strategyName });

      // Only stamp lastFiredAt once the proposal exists, so a failed cycle retries.
      const list = strategyStore.load();
      const target = list.find((s) => s.id === action.strategyId);
      if (target) {
        target.lastFiredAt = new Date().toISOString();
        strategyStore.save(list);
      }
    } catch (err) {
      errors.push({
        strategyName: action.strategyName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    evaluatedAt: new Date().toISOString(),
    portfolio: await valuePortfolio(),
    prices,
    acted,
    skipped,
    errors,
  };
}

export function rejectProposal(id: string): Proposal {
  const proposals = proposalStore.load();
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal) throw new Error(`No proposal ${id}`);
  if (proposal.status !== "pending") throw new Error(`Proposal ${id} is ${proposal.status}`);
  proposal.status = "rejected";
  proposalStore.save(proposals);
  return proposal;
}
