import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTools } from "../src/agent.js";

/**
 * The `chat` path is the only code path that talks to the model, so it is the
 * only one not exercised by the rest of the suite. These tests cover the part
 * that can be checked without credentials: that every tool definition is
 * structurally valid before it is ever sent. A malformed schema — most likely a
 * dangling `$ref` from the discriminated union in save_strategy — is rejected by
 * the API with a 400 and would break `chat` on its first real invocation.
 */

const tools = buildTools() as Array<{
  name: string;
  description?: string;
  input_schema?: Record<string, any>;
  inputSchema?: Record<string, any>;
}>;

const schemaOf = (t: (typeof tools)[number]) => t.input_schema ?? t.inputSchema ?? {};

describe("agent tool definitions", () => {
  it("defines the full toolset", () => {
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "get_caps",
      "get_market",
      "get_onchain_balances",
      "get_portfolio",
      "get_quote",
      "list_recent_activity",
      "list_strategies",
      "propose_trade",
      "save_strategy",
    ]);
  });

  it("gives every tool a name, a description, and an object schema", () => {
    for (const t of tools) {
      assert.ok(t.name, "tool is missing a name");
      assert.ok(t.description && t.description.length > 20, `${t.name} needs a real description`);
      assert.equal(schemaOf(t).type, "object", `${t.name} schema must be an object`);
    }
  });

  it("has no dangling $ref anywhere in any tool schema", () => {
    for (const t of tools) {
      const schema = schemaOf(t);
      const json = JSON.stringify(schema);
      const refs = [...json.matchAll(/"\$ref":\s*"#\/\$defs\/([^"]+)"/g)].map((m) => m[1]);
      const defs = schema.$defs ? Object.keys(schema.$defs) : [];
      const dangling = refs.filter((r) => !defs.includes(r));
      assert.deepEqual(dangling, [], `${t.name} has unresolved $refs: ${dangling.join(", ")}`);
    }
  });

  it("compiles the strategy rule as a three-branch union", () => {
    const save = tools.find((t) => t.name === "save_strategy")!;
    const rule = schemaOf(save).properties?.rule;
    assert.ok(rule, "save_strategy must accept a rule");
    const branches = rule.oneOf ?? rule.anyOf ?? [];
    assert.equal(branches.length, 3, "expected dca | rebalance | threshold");
  });

  it("serializes to JSON without throwing", () => {
    // bigint or a cyclic value anywhere in a schema would fail here rather than
    // at request time.
    assert.doesNotThrow(() => JSON.stringify(tools));
  });
});
