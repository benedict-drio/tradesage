import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyRate, formatBase, fromBase, parseBase, toBase, usdToBase } from "../src/units.js";

describe("base units", () => {
  it("uses each asset's on-chain precision", () => {
    assert.equal(toBase(1, "STX"), 1_000_000n); // 6 decimals
    assert.equal(toBase(1, "sBTC"), 100_000_000n); // 8 decimals
    assert.equal(toBase(1, "sUSD"), 1_000_000n);
  });

  it("round-trips exactly", () => {
    for (const [amount, asset] of [
      [5000, "STX"],
      [0.05, "sBTC"],
      [1234.567891, "STX"],
      [0.00000001, "sBTC"],
    ] as const) {
      assert.equal(fromBase(toBase(amount, asset), asset), amount);
    }
  });

  it("truncates below the asset's precision instead of inventing dust", () => {
    // STX cannot express 1e-9; the excess must be dropped, not rounded up into
    // an amount no transaction could move.
    assert.equal(toBase(1.0000001234, "STX"), 1_000_000n);
  });

  it("rejects negative and non-finite amounts", () => {
    assert.throws(() => toBase(-1, "STX"), /negative/);
    assert.throws(() => toBase(Number.NaN, "STX"), /not finite/);
    assert.throws(() => toBase(Number.POSITIVE_INFINITY, "STX"), /not finite/);
  });

  it("rejects unknown assets", () => {
    assert.throws(() => toBase(1, "DOGE"), /Unknown asset/);
  });
});

describe("balance arithmetic is exact", () => {
  it("does not drift across many round-trips", () => {
    // Regression: with f64 balances, 100 round-trips left STX at
    // 4936.8159897951045 — 13 decimals on a 6-decimal asset. Integer base units
    // make the same sequence exact and reversible.
    let stx = toBase(5000, "STX");
    const out = toBase(1, "STX");
    for (let i = 0; i < 1000; i++) {
      stx = stx - out;
      stx = stx + out;
    }
    assert.equal(stx, toBase(5000, "STX"));
    assert.equal(formatBase(stx, "STX"), "5000");
  });

  it("keeps every balance representable on-chain", () => {
    let stx = toBase(5000, "STX");
    for (let i = 0; i < 100; i++) {
      stx -= usdToBase(1.37, "STX", 0.2913);
      stx += usdToBase(0.41, "STX", 0.2913);
    }
    // An integer count of base units is representable by construction; assert
    // the formatted value never exceeds the asset's decimal places.
    const frac = formatBase(stx, "STX").split(".")[1] ?? "";
    assert.ok(frac.length <= 6, `STX formatted with ${frac.length} decimals`);
    assert.equal(typeof stx, "bigint");
  });
});

describe("conversions", () => {
  it("usdToBase quantises to the target asset", () => {
    const base = usdToBase(100, "sBTC", 76_000);
    assert.equal(typeof base, "bigint");
    assert.ok(base > 0n);
    const frac = formatBase(base, "sBTC").split(".")[1] ?? "";
    assert.ok(frac.length <= 8);
  });

  it("usdToBase returns zero rather than NaN on bad input", () => {
    assert.equal(usdToBase(100, "STX", 0), 0n);
    assert.equal(usdToBase(Number.NaN, "STX", 1), 0n);
    assert.equal(usdToBase(-5, "STX", 1), 0n);
  });

  it("applyRate produces representable output", () => {
    const out = applyRate(toBase(25, "STX"), 0.0000038, "STX", "sBTC");
    assert.equal(typeof out, "bigint");
    const frac = formatBase(out, "sBTC").split(".")[1] ?? "";
    assert.ok(frac.length <= 8);
  });

  it("parseBase accepts the persisted string form", () => {
    assert.equal(parseBase("1000000"), 1_000_000n);
    assert.equal(parseBase(1_000_000), 1_000_000n);
    assert.throws(() => parseBase(1.5), /integral/);
  });
});

describe("formatBase", () => {
  it("trims trailing zeros without losing precision", () => {
    assert.equal(formatBase(1_000_000n, "STX"), "1");
    assert.equal(formatBase(1_500_000n, "STX"), "1.5");
    assert.equal(formatBase(1n, "sBTC"), "0.00000001");
    assert.equal(formatBase(0n, "STX"), "0");
  });
});
