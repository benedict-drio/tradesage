import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateStrategies, validateRule, describeRule } from "../src/rules.js";
import type { Strategy, StrategyRule } from "../src/store.js";
import type { PortfolioView } from "../src/engine.js";
import type { AssetPrice } from "../src/market.js";
import { fromBase, toBase } from "../src/units.js";

const ASSETS = ["STX", "sBTC", "sUSD"];

const PRICES: Record<string, AssetPrice> = {
  STX: { symbol: "STX", usd: 0.29, change24hPct: 5 },
  sBTC: { symbol: "sBTC", usd: 76_000, change24hPct: 1 },
  sUSD: { symbol: "sUSD", usd: 1, change24hPct: 0 },
};

function portfolio(balances: Record<string, number>): PortfolioView {
  const out: PortfolioView["balances"] = {};
  let totalUsd = 0;
  for (const [asset, amount] of Object.entries(balances)) {
    const base = toBase(amount, asset);
    const usdValue = amount * PRICES[asset].usd;
    out[asset] = { amount, base, usdValue };
    totalUsd += usdValue;
  }
  return { balances: out, totalUsd, initialUsd: totalUsd, pnlUsd: 0, pnlPct: 0 };
}

function strategy(rule: StrategyRule, lastFiredAt: string | null = null): Strategy {
  return {
    id: "strat_test",
    name: "test",
    description: "test",
    createdAt: new Date(0).toISOString(),
    active: true,
    rule,
    lastFiredAt,
  };
}

/** Apply a triggered action to a balance map, ignoring fees, as a swap would. */
function applySwap(
  balances: Record<string, number>,
  action: { from: string; to: string; amount: bigint },
): Record<string, number> {
  const amount = fromBase(action.amount, action.from);
  const usd = amount * PRICES[action.from].usd;
  return {
    ...balances,
    [action.from]: balances[action.from] - amount,
    [action.to]: balances[action.to] + usd / PRICES[action.to].usd,
  };
}

describe("rebalance", () => {
  const rule: StrategyRule = {
    kind: "rebalance",
    targets: { STX: 0.6, sBTC: 0.4 },
    driftPct: 5,
  };

  it("terminates instead of firing forever when the portfolio holds an untargeted asset", () => {
    // Regression: weights were measured against the whole portfolio, so 60/40
    // was unreachable while sUSD was held and the rule re-fired every cycle,
    // bleeding fees indefinitely.
    let balances: Record<string, number> = { STX: 5000, sBTC: 0.05, sUSD: 1000 };
    let fired = 0;

    for (let cycle = 0; cycle < 25; cycle++) {
      const res = evaluateStrategies([strategy(rule)], portfolio(balances), PRICES);
      if (res.triggered.length === 0) break;
      fired++;
      balances = applySwap(balances, res.triggered[0]);
    }

    assert.ok(fired > 0, "expected at least one rebalancing trade");
    assert.ok(fired <= 3, `rebalance should settle within a few trades, fired ${fired} times`);

    const final = evaluateStrategies([strategy(rule)], portfolio(balances), PRICES);
    assert.equal(final.triggered.length, 0, "rebalance must stop once inside the threshold");
    assert.ok(balances.sUSD === 1000, "untargeted sUSD must not be traded");
  });

  it("measures weights across targeted assets only", () => {
    // STX/sBTC already exactly 60/40 between themselves; a large untargeted
    // sUSD position must not make the rule fire.
    const stxUsd = 6000;
    const balances = {
      STX: stxUsd / PRICES.STX.usd,
      sBTC: 4000 / PRICES.sBTC.usd,
      sUSD: 50_000,
    };
    const res = evaluateStrategies([strategy(rule)], portfolio(balances), PRICES);
    assert.equal(res.triggered.length, 0, res.skipped[0]?.reason);
  });

  it("fires when the targeted split genuinely drifts", () => {
    const balances = { STX: 1000 / PRICES.STX.usd, sBTC: 9000 / PRICES.sBTC.usd, sUSD: 0 };
    const res = evaluateStrategies([strategy(rule)], portfolio(balances), PRICES);
    assert.equal(res.triggered.length, 1);
    assert.equal(res.triggered[0].from, "sBTC", "overweight leg should be sold");
    assert.equal(res.triggered[0].to, "STX");
  });

  it("never proposes more than is held", () => {
    const balances: Record<string, number> = { STX: 0, sBTC: 0.05, sUSD: 0 };
    const res = evaluateStrategies([strategy(rule)], portfolio(balances), PRICES);
    for (const t of res.triggered) {
      assert.ok(t.amount <= toBase(balances[t.from], t.from), `${t.amount} exceeds held`);
      assert.ok(t.amount > 0n, `bad amount ${t.amount}`);
    }
  });
});

describe("dca", () => {
  const rule: StrategyRule = { kind: "dca", from: "STX", to: "sBTC", amount: 300, everyHours: 168 };
  const held = { STX: 5000, sBTC: 0.05, sUSD: 1000 };

  it("fires on first run", () => {
    const res = evaluateStrategies([strategy(rule)], portfolio(held), PRICES);
    assert.equal(res.triggered.length, 1);
    assert.equal(res.triggered[0].amount, toBase(300, "STX"));
  });

  it("does not fire before the interval elapses", () => {
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const res = evaluateStrategies([strategy(rule, oneHourAgo)], portfolio(held), PRICES);
    assert.equal(res.triggered.length, 0);
    assert.match(res.skipped[0].reason, /not due/);
  });

  it("fires again once the interval has elapsed", () => {
    const longAgo = new Date(Date.now() - 200 * 3_600_000).toISOString();
    const res = evaluateStrategies([strategy(rule, longAgo)], portfolio(held), PRICES);
    assert.equal(res.triggered.length, 1);
  });

  it("skips when the balance is insufficient", () => {
    const res = evaluateStrategies([strategy(rule)], portfolio({ ...held, STX: 10 }), PRICES);
    assert.equal(res.triggered.length, 0);
    assert.match(res.skipped[0].reason, /insufficient/i);
  });
});

describe("threshold", () => {
  const rule: StrategyRule = {
    kind: "threshold",
    asset: "STX",
    direction: "drop",
    changePct: 3,
    from: "sUSD",
    to: "STX",
    amount: 200,
    cooldownHours: 24,
  };
  const held = { STX: 5000, sBTC: 0.05, sUSD: 1000 };

  it("does not fire when the asset moved the other way", () => {
    const res = evaluateStrategies([strategy(rule)], portfolio(held), PRICES);
    assert.equal(res.triggered.length, 0);
  });

  it("fires on a qualifying drop", () => {
    const dropped = { ...PRICES, STX: { ...PRICES.STX, change24hPct: -7 } };
    const res = evaluateStrategies([strategy(rule)], portfolio(held), dropped);
    assert.equal(res.triggered.length, 1);
  });

  it("respects the cooldown", () => {
    const dropped = { ...PRICES, STX: { ...PRICES.STX, change24hPct: -7 } };
    const recent = new Date(Date.now() - 3_600_000).toISOString();
    const res = evaluateStrategies([strategy(rule, recent)], portfolio(held), dropped);
    assert.equal(res.triggered.length, 0);
    assert.match(res.skipped[0].reason, /cooling down/);
  });
});

describe("validateRule", () => {
  it("rejects unknown assets", () => {
    assert.throws(
      () =>
        validateRule(
          { kind: "dca", from: "DOGE", to: "sBTC", amount: 10, everyHours: 1 },
          ASSETS,
        ),
      /Unknown asset "DOGE"/,
    );
  });

  it("rejects target weights that do not sum to 1", () => {
    assert.throws(
      () => validateRule({ kind: "rebalance", targets: { STX: 0.6, sBTC: 0.9 }, driftPct: 5 }, ASSETS),
      /sum to 1/,
    );
  });

  it("rejects identical from/to", () => {
    assert.throws(
      () => validateRule({ kind: "dca", from: "STX", to: "STX", amount: 1, everyHours: 1 }, ASSETS),
      /must differ/,
    );
  });

  it("rejects non-positive amounts", () => {
    assert.throws(
      () => validateRule({ kind: "dca", from: "STX", to: "sBTC", amount: 0, everyHours: 1 }, ASSETS),
      /positive/,
    );
  });

  it("accepts a well-formed rule", () => {
    validateRule({ kind: "rebalance", targets: { STX: 0.6, sBTC: 0.4 }, driftPct: 5 }, ASSETS);
  });
});

describe("describeRule", () => {
  it("renders each kind without throwing", () => {
    assert.match(
      describeRule({ kind: "dca", from: "STX", to: "sBTC", amount: 300, everyHours: 168 }),
      /DCA 300 STX/,
    );
    assert.match(
      describeRule({ kind: "rebalance", targets: { STX: 0.6, sBTC: 0.4 }, driftPct: 5 }),
      /60% STX/,
    );
  });
});

describe("uncompiled strategies", () => {
  it("are skipped with an actionable reason rather than crashing", () => {
    const legacy = { ...strategy({ kind: "dca", from: "STX", to: "sBTC", amount: 1, everyHours: 1 }), rule: null };
    const res = evaluateStrategies([legacy], portfolio({ STX: 100, sBTC: 0, sUSD: 0 }), PRICES);
    assert.equal(res.triggered.length, 0);
    assert.match(res.skipped[0].reason, /no compiled rule/);
  });
});
