import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { minimumReceived, routeBestQuote } from "../src/dex/index.js";
import type { DexAdapter, DexQuote } from "../src/dex/types.js";

/**
 * Routing is the layer that makes a single venue's failure survivable, so these
 * tests exercise the failure paths as hard as the happy one. Adapters are
 * injected, so nothing here touches the network.
 */

function fakeAdapter(
  name: string,
  out: bigint | Error,
  opts: { pairs?: Array<[string, string]>; feeBps?: number } = {},
): DexAdapter {
  const pairs = opts.pairs ?? [["STX", "sBTC"]];
  return {
    name,
    supports: (from, to) => pairs.some(([f, t]) => f === from && t === to),
    async quote(from, to, amountIn): Promise<DexQuote> {
      if (out instanceof Error) throw out;
      return {
        venue: name,
        from,
        to,
        amountIn,
        expectedOut: out,
        feeBps: opts.feeBps ?? 30,
        indicative: false,
      };
    },
    async buildSwap() {
      throw new Error("not used in these tests");
    },
  };
}

const AMOUNT = 100_000_000n;

describe("routeBestQuote", () => {
  it("picks the venue offering the most output", async () => {
    const r = await routeBestQuote("STX", "sBTC", AMOUNT, [
      fakeAdapter("worse", 1000n),
      fakeAdapter("better", 1200n),
    ]);
    assert.equal(r.best.venue, "better");
    assert.equal(r.best.expectedOut, 1200n);
  });

  it("is not influenced by registry order", async () => {
    const forward = await routeBestQuote("STX", "sBTC", AMOUNT, [
      fakeAdapter("a", 900n),
      fakeAdapter("b", 1100n),
    ]);
    const reversed = await routeBestQuote("STX", "sBTC", AMOUNT, [
      fakeAdapter("b", 1100n),
      fakeAdapter("a", 900n),
    ]);
    assert.equal(forward.best.venue, reversed.best.venue, "same prices must pick the same venue");
  });

  it("returns every quote considered, best first, so a decision is auditable", async () => {
    const r = await routeBestQuote("STX", "sBTC", AMOUNT, [
      fakeAdapter("mid", 1000n),
      fakeAdapter("high", 1500n),
      fakeAdapter("low", 500n),
    ]);
    assert.deepEqual(
      r.considered.map((q) => q.venue),
      ["high", "mid", "low"],
    );
  });

  it("degrades instead of failing when one venue is down", async () => {
    // The property that matters: a broken SDK or a dead API costs pricing
    // quality, not the ability to trade.
    const r = await routeBestQuote("STX", "sBTC", AMOUNT, [
      fakeAdapter("down", new Error("host returned 404")),
      fakeAdapter("up", 1000n),
    ]);
    assert.equal(r.best.venue, "up");
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].venue, "down");
    assert.match(r.failed[0].reason, /404/);
  });

  it("throws only when every venue fails, and names each reason", async () => {
    await assert.rejects(
      routeBestQuote("STX", "sBTC", AMOUNT, [
        fakeAdapter("one", new Error("timeout")),
        fakeAdapter("two", new Error("bad gateway")),
      ]),
      (e: Error) => /timeout/.test(e.message) && /bad gateway/.test(e.message),
    );
  });

  it("throws when no venue trades the pair at all", async () => {
    await assert.rejects(
      routeBestQuote("sUSD", "sBTC", AMOUNT, [fakeAdapter("stx-only", 1000n)]),
      /No configured venue trades sUSD\/sBTC/,
    );
  });

  it("ignores venues that do not support the pair rather than calling them", async () => {
    let called = false;
    const shouldNotBeCalled: DexAdapter = {
      name: "other-pair",
      supports: () => false,
      async quote() {
        called = true;
        throw new Error("should never run");
      },
      async buildSwap() {
        throw new Error("unused");
      },
    };
    const r = await routeBestQuote("STX", "sBTC", AMOUNT, [
      shouldNotBeCalled,
      fakeAdapter("ok", 1000n),
    ]);
    assert.equal(called, false, "unsupported venues must not be quoted");
    assert.equal(r.best.venue, "ok");
  });
});

describe("minimumReceived", () => {
  const quote = (out: bigint): DexQuote => ({
    venue: "t",
    from: "STX",
    to: "sBTC",
    amountIn: AMOUNT,
    expectedOut: out,
    feeBps: 15,
    indicative: false,
  });

  it("applies the slippage floor", () => {
    assert.equal(minimumReceived(quote(10_000n), 100), 9_900n); // 1%
    assert.equal(minimumReceived(quote(10_000n), 50), 9_950n); // 0.5%
  });

  it("never exceeds the quote", () => {
    for (const out of [1n, 661n, 10_000n, 123_456_789n]) {
      assert.ok(minimumReceived(quote(out), 100) <= out, `floor above quote for ${out}`);
    }
  });

  it("returns the quote itself at zero slippage", () => {
    assert.equal(minimumReceived(quote(661n), 0), 661n);
  });

  it("stays integral — a floor must be representable on-chain", () => {
    const m = minimumReceived(quote(661n), 100);
    assert.equal(typeof m, "bigint");
    assert.equal(m, 654n); // 661 * 9900 / 10000, truncated
  });
});
