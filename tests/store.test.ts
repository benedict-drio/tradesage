import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readJson, withLock, writeJson } from "../src/store.js";

describe("withLock", () => {
  it("serializes concurrent read-modify-write cycles", async () => {
    // Regression: two monitoring cycles running concurrently both passed their
    // lastFiredAt check before either wrote, executing the same strategy twice.
    writeJson("lock-probe.json", { n: 0 });

    const increment = async () => {
      await withLock(async () => {
        const state = readJson<{ n: number }>("lock-probe.json", { n: 0 });
        // Yield mid-cycle: without the lock the interleaving loses updates.
        await new Promise((r) => setTimeout(r, 5));
        writeJson("lock-probe.json", { n: state.n + 1 });
      });
    };

    await Promise.all([increment(), increment(), increment(), increment(), increment()]);

    const final = readJson<{ n: number }>("lock-probe.json", { n: -1 });
    assert.equal(final.n, 5, "every increment must be preserved");
  });

  it("releases the lock when the body throws", async () => {
    await assert.rejects(
      withLock(async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    // If the lock leaked, this would time out instead of resolving.
    const ok = await withLock(async () => "acquired");
    assert.equal(ok, "acquired");
  });
});

describe("writeJson", () => {
  it("round-trips and never leaves a partial file", () => {
    const value = { a: 1, nested: { b: [1, 2, 3] } };
    writeJson("roundtrip-probe.json", value);
    assert.deepEqual(readJson("roundtrip-probe.json", null), value);
  });

  it("returns the fallback for a missing file", () => {
    assert.deepEqual(readJson("definitely-missing.json", { fallback: true }), { fallback: true });
  });
});
