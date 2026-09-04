import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseStrategy } from "../src/parse.js";
import { validateRule } from "../src/rules.js";

const ASSETS = ["STX", "sBTC", "sUSD"];

/** Parse and assert success, checking the rule also survives validation. */
function ok(text: string) {
  const res = parseStrategy(text);
  assert.equal(res.ok, true, res.ok ? "" : `${res.reason} — ${res.hint}`);
  if (!res.ok) throw new Error("unreachable");
  validateRule(res.rule, ASSETS); // parser must never emit a rule the engine rejects
  return res;
}

describe("DCA phrasings", () => {
  const phrasings = [
    "DCA 200 STX into sBTC weekly",
    "dca 200 stx into sbtc weekly",
    "Dollar-cost average 200 STX into sBTC every week",
    "Buy 200 STX worth of sBTC weekly",
    "accumulate sBTC with 200 STX every 7 days",
    "invest 200 STX into sBTC every week",
  ];
  for (const text of phrasings) {
    it(`reads: ${text}`, () => {
      const res = ok(text);
      assert.equal(res.rule.kind, "dca");
      if (res.rule.kind !== "dca") return;
      assert.equal(res.rule.from, "STX");
      assert.equal(res.rule.to, "sBTC");
      assert.equal(res.rule.amount, 200);
      assert.equal(res.rule.everyHours, 168);
    });
  }

  it("handles other intervals", () => {
    const daily = ok("DCA 50 STX into sBTC daily");
    assert.equal(daily.rule.kind === "dca" && daily.rule.everyHours, 24);
    const every3 = ok("DCA 50 STX into sBTC every 3 days");
    assert.equal(every3.rule.kind === "dca" && every3.rule.everyHours, 72);
    const monthly = ok("DCA 50 STX into sBTC monthly");
    assert.equal(monthly.rule.kind === "dca" && monthly.rule.everyHours, 720);
  });

  it("names the missing piece instead of guessing", () => {
    const noInterval = parseStrategy("DCA 200 STX into sBTC");
    assert.equal(noInterval.ok, false);
    if (noInterval.ok) return;
    assert.match(noInterval.reason, /how often/);
    assert.match(noInterval.hint, /weekly/);
  });
});

describe("rebalance phrasings", () => {
  const phrasings = [
    "rebalance to 60% STX and 40% sBTC when drift exceeds 5%",
    "Rebalance to 60/40 STX/sBTC when drift exceeds 5%",
    "rebalance my allocation to 60% STX / 40% sBTC, drift 5pp",
    "keep the split at 60% STX and 40% sBTC, rebalance beyond 5%",
  ];
  for (const text of phrasings) {
    it(`reads: ${text}`, () => {
      const res = ok(text);
      assert.equal(res.rule.kind, "rebalance");
      if (res.rule.kind !== "rebalance") return;
      assert.equal(res.rule.targets.STX, 0.6);
      assert.equal(res.rule.targets.sBTC, 0.4);
      assert.equal(res.rule.driftPct, 5);
    });
  }

  it("reports an assumed drift threshold rather than hiding it", () => {
    const res = ok("rebalance to 60% STX and 40% sBTC");
    assert.equal(res.rule.kind === "rebalance" && res.rule.driftPct, 5);
    assert.equal(res.defaults.length, 1);
    assert.match(res.defaults[0], /drift threshold/);
  });

  it("rejects weights that do not total 100%", () => {
    const res = parseStrategy("rebalance to 60% STX and 60% sBTC when drift exceeds 5%");
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.reason, /not 100%/);
  });

  it("rejects a single-asset split", () => {
    const res = parseStrategy("rebalance to 100% STX");
    assert.equal(res.ok, false);
  });
});

describe("threshold phrasings", () => {
  it("reads a drop rule", () => {
    const res = ok("if STX drops 10% in a day, move 200 sUSD into STX");
    assert.equal(res.rule.kind, "threshold");
    if (res.rule.kind !== "threshold") return;
    assert.equal(res.rule.asset, "STX");
    assert.equal(res.rule.direction, "drop");
    assert.equal(res.rule.changePct, 10);
    assert.equal(res.rule.from, "sUSD");
    assert.equal(res.rule.to, "STX");
    assert.equal(res.rule.amount, 200);
  });

  it("reads a rise rule", () => {
    const res = ok("when sBTC rises 8%, sell 0.01 sBTC into sUSD");
    assert.equal(res.rule.kind === "threshold" && res.rule.direction, "rise");
    assert.equal(res.rule.kind === "threshold" && res.rule.asset, "sBTC");
  });

  it("defaults the cooldown and says so", () => {
    const res = ok("if STX drops 10%, move 200 sUSD into STX");
    assert.equal(res.rule.kind === "threshold" && res.rule.cooldownHours, 24);
    assert.ok(res.defaults.some((d) => /cooldown/.test(d)));
  });
});

describe("failure behaviour", () => {
  it("never returns a rule it cannot fully determine", () => {
    for (const text of ["", "do something clever", "make me money", "buy the dip"]) {
      const res = parseStrategy(text);
      assert.equal(res.ok, false, `should not have parsed: "${text}"`);
      if (res.ok) continue;
      assert.ok(res.reason.length > 10, "failure needs a real reason");
      assert.ok(res.hint.length > 10, "failure needs an actionable hint");
    }
  });

  it("rejects unknown assets rather than inventing one", () => {
    const res = parseStrategy("DCA 200 DOGE into sBTC weekly");
    assert.equal(res.ok, false);
  });

  it("every successful parse survives validateRule", () => {
    // The parser and the engine must not disagree about what a valid rule is.
    const corpus = [
      "DCA 200 STX into sBTC weekly",
      "DCA 1 STX into sUSD daily",
      "rebalance to 60/40 STX/sBTC when drift exceeds 5%",
      "rebalance to 50% STX and 50% sUSD",
      "if STX drops 10% in a day, move 200 sUSD into STX",
      "when sBTC rises 8%, sell 0.01 sBTC into sUSD",
    ];
    for (const text of corpus) {
      const res = parseStrategy(text);
      assert.equal(res.ok, true, `failed: ${text}`);
      if (!res.ok) continue;
      assert.doesNotThrow(() => validateRule(res.rule, ASSETS), `invalid rule from: ${text}`);
    }
  });
});
