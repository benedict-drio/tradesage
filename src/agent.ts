import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { ASSETS, MODEL } from "./config.js";
import { getCapsUsage, getQuote, proposeTrade, valuePortfolio } from "./engine.js";
import { getOnchainBalances, getPrices } from "./market.js";
import { describeRule, validateRule } from "./rules.js";
import { formatBase, toBase } from "./units.js";
import {
  newId,
  proposalStore,
  strategyStore,
  tradeStore,
  type Strategy,
  type StrategyRule,
} from "./store.js";

const ASSET = z.enum(["STX", "sBTC", "sUSD"]);

const SYSTEM_PROMPT = `You are TradeSage, a non-custodial AI trading copilot for the Stacks (Bitcoin L2) ecosystem.

You manage a paper-trading portfolio of STX, sBTC, and sUSD on behalf of a user. Your job:
- Monitor market conditions and the user's saved strategies.
- Explain market context in plain language.
- When a strategy's conditions are met (or the user asks for a trade), call propose_trade.

Execution model (session-scoped pre-approval):
- The user sets spend caps (per-trade USD and daily USD). Trades within those caps auto-execute the moment you propose them; check get_caps to know the current limits and today's remaining allowance.
- Trades beyond the caps queue as pending proposals that the user approves or rejects from the CLI. Always tell the user whether a proposal auto-executed or awaits their approval.

Division of labour — important:
- You compile strategies from natural language into structured rules (save_strategy). That is the one place your judgement enters the system.
- You do NOT evaluate strategies on a schedule. Monitoring cycles run deterministically in code, without any model call, so they keep working whether or not an AI provider is configured. Never tell the user a strategy will be checked "by you"; it is checked by the rule you compiled.

Rules:
- Always check the portfolio and current prices before proposing a trade.
- Never propose more than the portfolio holds; keep single proposals under 25% of total portfolio value unless the user explicitly asks for more.
- Give a concrete rationale on every proposal (price move, drift from target allocation, strategy rule triggered).
- If nothing warrants action, say so plainly — do not manufacture trades.
- Amounts are in the FROM asset's units (e.g. amount 100 with from=STX means sell 100 STX).`;

export function buildTools() {
  return [
    betaZodTool({
      name: "get_market",
      description:
        "Get current USD prices and 24h change for STX, sBTC (tracks BTC), and sUSD (stable). Call this before reasoning about any trade.",
      inputSchema: z.object({}),
      run: async () => JSON.stringify(await getPrices()),
    }),
    betaZodTool({
      name: "get_portfolio",
      description:
        "Get the paper portfolio: balance per asset, USD value per asset, total value, and P&L since inception.",
      inputSchema: z.object({}),
      run: async () => JSON.stringify(await valuePortfolio()),
    }),
    betaZodTool({
      name: "get_quote",
      description:
        "Get a swap quote (effective price, expected output, fee and slippage in bps) for converting one asset into another. Use before proposing a trade.",
      inputSchema: z.object({
        from: z.enum(["STX", "sBTC", "sUSD"]).describe("Asset to sell"),
        to: z.enum(["STX", "sBTC", "sUSD"]).describe("Asset to buy"),
        amount: z.number().positive().describe("Amount of the FROM asset to swap"),
      }),
      run: async ({ from, to, amount }) => {
        const q = await getQuote(from, to, toBase(amount, from));
        return JSON.stringify({
          ...q,
          amountIn: formatBase(q.amountIn, from),
          expectedOut: formatBase(q.expectedOut, to),
        });
      },
    }),
    betaZodTool({
      name: "get_caps",
      description:
        "Get the user's session spend caps (per-trade USD, daily USD, enabled flag) and how much of today's allowance is already spent. Check before proposing so you can tell the user whether a trade will auto-execute.",
      inputSchema: z.object({}),
      run: async () => JSON.stringify(getCapsUsage()),
    }),
    betaZodTool({
      name: "propose_trade",
      description:
        "Create a trade proposal. If its USD notional fits within the user's session caps it executes immediately (status 'executed', autoExecuted true); otherwise it queues for human approval (status 'pending'). Returns the proposal with its id, status, and quote.",
      inputSchema: z.object({
        from: z.enum(["STX", "sBTC", "sUSD"]),
        to: z.enum(["STX", "sBTC", "sUSD"]),
        amount: z.number().positive().describe("Amount of the FROM asset to sell"),
        rationale: z
          .string()
          .describe("Concrete reason for the trade, referencing prices, drift, or a strategy rule"),
        strategy_id: z.string().nullable().describe("Strategy that triggered this, or null"),
      }),
      run: async ({ from, to, amount, rationale, strategy_id }) =>
        JSON.stringify(
          await proposeTrade({ from, to, amount, rationale, strategyId: strategy_id }),
        ),
    }),
    betaZodTool({
      name: "list_strategies",
      description: "List the user's saved trading strategies.",
      inputSchema: z.object({}),
      run: async () => JSON.stringify(strategyStore.load()),
    }),
    betaZodTool({
      name: "save_strategy",
      description:
        "Compile the user's natural-language strategy into a structured rule and save it. This is the ONLY point at which a model interprets the strategy — every later monitoring cycle evaluates the saved rule with deterministic code. Choose the rule kind that fits and fill every field precisely; if the user's description is ambiguous about an amount, interval, or threshold, ask them before saving rather than guessing.",
      inputSchema: z.object({
        name: z.string().describe("Short strategy name"),
        description: z.string().describe("The user's intent, restated in one clear sentence"),
        rule: z
          .discriminatedUnion("kind", [
            z.object({
              kind: z.literal("dca"),
              from: ASSET,
              to: ASSET,
              amount: z.number().positive().describe("Amount of the FROM asset per interval"),
              everyHours: z.number().positive().describe("Interval in hours (weekly = 168)"),
            }),
            z.object({
              kind: z.literal("rebalance"),
              targets: z
                .record(z.string(), z.number())
                .describe('Target weights as fractions summing to 1, e.g. {"STX":0.6,"sBTC":0.4}'),
              driftPct: z
                .number()
                .positive()
                .describe("Trigger when any weight drifts this many percentage points"),
            }),
            z.object({
              kind: z.literal("threshold"),
              asset: ASSET.describe("Asset whose 24h move is watched"),
              direction: z.enum(["drop", "rise"]),
              changePct: z.number().positive().describe("Absolute 24h move, in percent"),
              from: ASSET,
              to: ASSET,
              amount: z.number().positive(),
              cooldownHours: z
                .number()
                .positive()
                .describe("Minimum hours between firings; default 24 unless the user says otherwise"),
            }),
          ])
          .describe("The machine-evaluatable form of the strategy"),
      }),
      run: async ({ name, description, rule }) => {
        validateRule(rule as StrategyRule, Object.keys(ASSETS));
        const strategies = strategyStore.load();
        const strategy: Strategy = {
          id: newId("strat"),
          name,
          description,
          createdAt: new Date().toISOString(),
          active: true,
          rule: rule as StrategyRule,
          lastFiredAt: null,
        };
        strategies.push(strategy);
        strategyStore.save(strategies);
        return JSON.stringify({
          ...strategy,
          compiledAs: describeRule(strategy.rule!),
          note: "Saved. Monitoring cycles now evaluate this rule deterministically, with no model call.",
        });
      },
    }),
    betaZodTool({
      name: "list_recent_activity",
      description: "List pending/recent proposals and executed trades.",
      inputSchema: z.object({}),
      run: async () =>
        JSON.stringify({
          proposals: proposalStore.load().slice(-10),
          trades: tradeStore.load().slice(-10),
        }),
    }),
    betaZodTool({
      name: "get_onchain_balances",
      description:
        "Read-only lookup of a real Stacks wallet's STX and token balances via the Hiro API. Use when the user shares a mainnet address (SP...).",
      inputSchema: z.object({
        address: z.string().describe("Stacks mainnet principal, e.g. SP2C2Y..."),
      }),
      run: async ({ address }) => JSON.stringify(await getOnchainBalances(address)),
    }),
  ];
}

export async function runAgent(userMessage: string): Promise<string> {
  const client = new Anthropic();
  const finalMessage = await client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    tools: buildTools(),
    messages: [{ role: "user", content: userMessage }],
  });

  return finalMessage.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Optional narration of an already-completed monitoring cycle.
 *
 * The cycle itself ran deterministically before this is called; nothing here
 * decides anything. If no API key is configured the CLI prints the plain-text
 * report instead and the product behaves identically.
 */
export async function explainTick(result: unknown): Promise<string> {
  const client = new Anthropic();
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system:
      "You are TradeSage. You are given the JSON result of a monitoring cycle that has ALREADY run and already acted. Summarize it for the user in at most six sentences: market context, portfolio value and P&L, what fired and why, what is awaiting approval. Do not propose new trades and do not second-guess the rules — they are deterministic and already applied.",
    messages: [{ role: "user", content: JSON.stringify(result) }],
  });
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
