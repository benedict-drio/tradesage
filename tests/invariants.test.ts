import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatBase, fromBase, toBase, usdToBase } from "../src/units.js";
import { minimumReceived } from "../src/dex/index.js";
import { evaluateStrategies, validateRule } from "../src/rules.js";
import { parseStrategy } from "../src/parse.js";
import type { DexQuote } from "../src/dex/types.js";
import type { PortfolioView } from "../src/engine.js";
import type { Strategy, StrategyRule } from "../src/store.js";
import type { AssetPrice } from "../src/market.js";

/**
 * Property-based and fuzz tests.
 *
 * The example-based suite checks that chosen inputs behave. These check that
 * properties hold across generated ones — which is where the three money-losing
 * defects found so far actually lived, none of which a hand-written example
 * would have caught.
 *
 * The generator is seeded, so a failure is reproducible rather than a story
 * about a run that once went wrong.
 */

const SEED = 0x5eed1234;
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ASSETS = ["STX", "sBTC", "sUSD"] as const;
const DECIMALS: Record<string, number> = { STX: 6, sBTC: 8, sUSD: 6 };
const PRICES: Record<string, AssetPrice> = {
  STX: { symbol: "STX", usd: 0.2913, change24hPct: -2.4 },
  sBTC: { symbol: "sBTC", usd: 78_412.55, change24hPct: 1.1 },
  sUSD: { symbol: "sUSD", usd: 1, change24hPct: 0 },
};
const RUNS = 300;

describe("invariant: money is always representable on-chain", () => {
  it("no conversion ever produces more precision than the asset has", () => {
    const rand = rng(SEED);
    for (let i = 0; i < RUNS; i++) {
      const asset = ASSETS[Math.floor(rand() * ASSETS.length)];
      const usd = rand() * 100_000;
      const price = PRICES[asset].usd * (0.5 + rand());
      const base = usdToBase(usd, asset, price);
      const frac = formatBase(base, asset).split(".")[1] ?? "";
      assert.ok(
        frac.length <= DECIMALS[asset],
        `${asset} produced ${frac.length} decimals from usd=${usd} price=${price}`,
      );
      assert.equal(typeof base, "bigint");
      assert.ok(base >= 0n, `negative base units from usd=${usd}`);
    }
  });

  it("base units survive a round trip through human units", () => {
    const rand = rng(SEED ^ 0xa1);
    for (let i = 0; i < RUNS; i++) {
      const asset = ASSETS[Math.floor(rand() * ASSETS.length)];
      // realistic magnitudes; f64 cannot round-trip arbitrarily large integers
      const base = BigInt(Math.floor(rand() * 1e12));
      assert.equal(toBase(fromBase(base, asset), asset), base, `${asset} lost ${base}`);
    }
  });
});

describe("invariant: a slippage floor is never above its quote", () => {
  it("holds for any output and any slippage", () => {
    const rand = rng(SEED ^ 0xb2);
    for (let i = 0; i < RUNS; i++) {
      const out = BigInt(1 + Math.floor(rand() * 1e10));
      const slippageBps = Math.floor(rand() * 10_001);
      const q: DexQuote = {
        venue: "t",
        from: "STX",
        to: "sBTC",
        amountIn: 1n,
        expectedOut: out,
        feeBps: 15,
        indicative: false,
      };
      const floor = minimumReceived(q, slippageBps);
      assert.ok(floor <= out, `floor ${floor} above quote ${out} at ${slippageBps}bps`);
      assert.ok(floor >= 0n, `negative floor at ${slippageBps}bps`);
    }
  });
});

// ---------------------------------------------------------------- strategies

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

function strategy(rule: StrategyRule): Strategy {
  return {
    id: "s",
    name: "s",
    description: "s",
    createdAt: new Date(0).toISOString(),
    active: true,
    rule,
    lastFiredAt: null,
  };
}

describe("invariant: rebalancing terminates and stays inside its mandate", () => {
  it("always converges, and never touches an untargeted asset", () => {
    const rand = rng(SEED ^ 0xc3);
    for (let i = 0; i < 120; i++) {
      const wStx = 0.1 + rand() * 0.8;
      const rule: StrategyRule = {
        kind: "rebalance",
        targets: { STX: Number(wStx.toFixed(4)), sBTC: Number((1 - wStx).toFixed(4)) },
        driftPct: 1 + rand() * 15,
      };
      // sum may drift a hair from 1 through rounding; skip inputs the engine
      // would legitimately reject rather than asserting on invalid rules
      const sum = rule.targets.STX + rule.targets.sBTC;
      if (Math.abs(sum - 1) > 0.001) continue;

      let balances: Record<string, number> = {
        STX: 100 + rand() * 20_000,
        sBTC: rand() * 0.5,
        sUSD: rand() * 5_000, // deliberately untargeted
      };
      const untargetedAtStart = balances.sUSD;

      let fired = 0;
      for (let cycle = 0; cycle < 40; cycle++) {
        const res = evaluateStrategies([strategy(rule)], portfolio(balances), PRICES);
        if (res.triggered.length === 0) break;
        fired++;
        const t = res.triggered[0];
        assert.notEqual(t.from, "sUSD", "untargeted asset was sold");
        assert.notEqual(t.to, "sUSD", "untargeted asset was bought");
        const amount = fromBase(t.amount, t.from);
        assert.ok(amount <= balances[t.from] + 1e-9, `proposed ${amount} of ${balances[t.from]}`);
        const usd = amount * PRICES[t.from].usd;
        balances = {
          ...balances,
          [t.from]: balances[t.from] - amount,
          [t.to]: balances[t.to] + usd / PRICES[t.to].usd,
        };
      }
      assert.ok(fired < 40, `did not converge: still firing after 40 cycles (w=${wStx})`);
      assert.equal(balances.sUSD, untargetedAtStart, "untargeted balance changed");
    }
  });
});

describe("invariant: no rule ever proposes more than is held", () => {
  it("holds across generated portfolios for every rule kind", () => {
    const rand = rng(SEED ^ 0xd4);
    for (let i = 0; i < RUNS; i++) {
      const balances: Record<string, number> = {
        STX: rand() * 5_000,
        sBTC: rand() * 0.2,
        sUSD: rand() * 2_000,
      };
      const rules: StrategyRule[] = [
        { kind: "dca", from: "STX", to: "sBTC", amount: rand() * 6_000, everyHours: 1 },
        {
          kind: "threshold",
          asset: "STX",
          direction: "drop",
          changePct: 0.1,
          from: "sUSD",
          to: "STX",
          amount: rand() * 3_000,
          cooldownHours: 1,
        },
      ];
      for (const rule of rules) {
        const res = evaluateStrategies([strategy(rule)], portfolio(balances), PRICES);
        for (const t of res.triggered) {
          assert.ok(
            t.amount <= toBase(balances[t.from], t.from),
            `${t.amount} exceeds held ${balances[t.from]} ${t.from}`,
          );
          assert.ok(t.amount > 0n, "non-positive amount proposed");
        }
      }
    }
  });
});

// ---------------------------------------------------------------- parser fuzz

describe("fuzz: the parser survives untrusted input", () => {
  const WORDS = [
    "dca","rebalance","if","when","STX","sBTC","sUSD","drops","rises","weekly","daily",
    "every","into","to","%","5","0.4","60/40","drift","exceeds","move","buy","swap",
    "","(",")","{","}","[","]","\\","'","\"","--","..","1e999","NaN","-5","999999999999",
    "\u0000","\ud83d\ude00","<script>","' OR 1=1","%s","../../etc/passwd",
  ];

  it("never throws, whatever it is given", () => {
    const rand = rng(SEED ^ 0xe5);
    for (let i = 0; i < 1500; i++) {
      const n = Math.floor(rand() * 12);
      const text = Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(" ");
      assert.doesNotThrow(() => parseStrategy(text), `threw on: ${JSON.stringify(text)}`);
    }
  });

  it("every rule it accepts is one the engine also accepts", () => {
    // Mutation fuzzing rather than pure noise: random word salad never forms a
    // valid strategy (measured: 0 valid parses in 1500), so it exercises only
    // the rejection path. Corrupting known-good strategies reaches both.
    const SEEDS = [
      "DCA 200 STX into sBTC weekly",
      "DCA 50 STX into sUSD every 3 days",
      "rebalance to 60/40 STX/sBTC when drift exceeds 5%",
      "rebalance to 70% STX and 30% sBTC",
      "if STX drops 10% in a day, move 200 sUSD into STX",
      "when sBTC rises 8%, sell 0.01 sBTC into sUSD",
    ];
    const rand = rng(SEED ^ 0xf6);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];

    let accepted = 0;
    for (let i = 0; i < 2000; i++) {
      let words = pick(SEEDS).split(" ");
      const mutations = 1 + Math.floor(rand() * 3);
      for (let m = 0; m < mutations; m++) {
        const at = Math.floor(rand() * words.length);
        switch (Math.floor(rand() * 6)) {
          case 0: words.splice(at, 1); break;                       // drop a word
          case 1: words.splice(at, 0, words[at] ?? ""); break;      // duplicate one
          case 2: words[at] = pick(WORDS); break;                   // replace with noise
          case 3: words[at] = String(Math.floor(rand() * 1e6)); break; // change a number
          case 4: words = [...words].reverse(); break;              // reorder
          case 5: words.push(pick(WORDS)); break;                   // append noise
        }
      }
      const text = words.join(" ");
      const res = parseStrategy(text);
      if (!res.ok) continue;
      accepted++;
      assert.doesNotThrow(
        () => validateRule(res.rule, [...ASSETS]),
        `parser accepted a rule the engine rejects, from: ${JSON.stringify(text)}`,
      );
    }
    assert.ok(accepted > 50, `corpus reached the success path only ${accepted} times`);
  });

  it("always explains a rejection instead of failing silently", () => {
    const rand = rng(SEED ^ 0x17);
    for (let i = 0; i < 400; i++) {
      const n = Math.floor(rand() * 12);
      const text = Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(" ");
      const res = parseStrategy(text);
      if (res.ok) continue;
      assert.ok(res.reason.length > 5, `empty reason for: ${JSON.stringify(text)}`);
      assert.ok(res.hint.length > 5, `empty hint for: ${JSON.stringify(text)}`);
    }
  });
});
