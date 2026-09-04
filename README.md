# TradeSage

**A non-custodial portfolio manager for sBTC and STX holders.** Describe a strategy in plain English — "DCA into sBTC weekly", "rebalance to 60/40 STX/sBTC when drift exceeds 5%" — and TradeSage monitors the market, evaluates your rules, and trades within limits you set. It runs entirely on deterministic code: no API key, no model, no AI account. Small trades inside your **session caps** execute automatically; anything larger waits for your explicit approval. Live execution is a real Velar swap whose post-conditions make the chain itself reject any fill worse than quoted.

Built for the Stacks Endowment RFP **"Trading Bots powered by AI"** — automated trading bots that execute trades on DEXs, optimizing for market-making and portfolio management. TradeSage takes the user-facing side of that RFP: portfolio management for regular Stacks holders, not protocol-side liquidity.

## Why this design

- **Non-custodial by construction.** The agent's only write path is `propose_trade`. Live execution is a separate step the agent cannot invoke: the user signs with their own key, and Clarity **post-conditions in Deny mode** cap exactly what the transaction may move — the chain aborts anything worse than the quote.
- **Session-scoped pre-approval instead of babysitting.** Approving every trade by hand isn't automation. Users set caps (per-trade USD, daily USD); the agent trades freely inside them and queues anything larger for review. Real automation, verifiable limits — the same trust thesis the Endowment funded in AgentPay, applied to trading.
- **No AI dependency at all.** `tradesage add "DCA 200 STX into sBTC weekly"` parses plain English with a deterministic grammar — no model, no API key, no network. Monitoring, caps, evaluation, and execution are likewise plain code. A language model is an *optional* extra for unusual phrasing and conversational analysis; the product is complete without one.
- **Paper-first.** Strategies run risk-free against live prices with a realistic fee + slippage model before any real sats move.

## How it works

```text
              ┌─────────────────────────────────────────────┐
              │            TradeSage agent (Claude)          │
              │  get_market · get_portfolio · get_quote ·    │
              │  get_caps · propose_trade · save_strategy ·  │
              │  list_recent_activity · get_onchain_balances │
              └───────┬────────────────────────┬────────────┘
                      │ reads                  │ propose_trade only
         ┌────────────┴───────────┐    ┌───────┴───────────────────┐
         │  Market data           │    │  Caps check                │
         │  CoinGecko prices      │    │  within caps → auto-exec   │
         │  Hiro API balances     │    │  beyond caps → pending     │
         │  Velar live quotes     │    │  (user approves/rejects)   │
         └────────────────────────┘    └───────┬───────────────────┘
                                               │ execute
                              ┌────────────────┴────────────────┐
                              │ Paper engine     │ Live (Velar)  │
                              │ fee+slip fill,   │ user-signed   │
                              │ P&L tracking     │ swap w/ Deny  │
                              │                  │ post-conds    │
                              └─────────────────────────────────┘
```

Everything is an existing dependency: the [Claude API](https://platform.claude.com) (tool-use agent loop), the [Velar SDK](https://docs.velar.co) (real DEX quotes, swap construction, post-conditions), the [Hiro Stacks API](https://www.hiro.so/stacks-api) (on-chain data), [@stacks/transactions](https://github.com/hirosystems/stacks.js) (signing), and CoinGecko (USD prices). No custom infrastructure.

## Quickstart

```bash
npm install                 # no API key needed for anything below

npm run dev init            # create the paper portfolio
npm run dev market          # live STX / sBTC prices
npm run dev status          # balances + P&L

# add strategies in plain English — no API key, no model, no network
npm run dev add "DCA 200 STX into sBTC weekly"
npm run dev add "rebalance to 60/40 STX/sBTC when drift exceeds 5%"
npm run dev add "if STX drops 10% in a day, move 200 sUSD into STX"

# or enter the rule directly
npm run dev strategy add rebalance "STX:0.6,sBTC:0.4" 5
npm run dev strategies      # see the compiled rules

npm run dev tick            # one monitoring cycle — deterministic, no API key

# note: pass flags after `--`, or npm swallows them:
#   npm run dev -- init --reset
#   npm run dev -- tick --explain

# session caps — the automation dial
npm run dev caps set 250 750   # $250 per trade, $750 per day
npm run dev caps on            # trades inside caps now auto-execute
npm run dev proposals          # anything larger waits here
npm run dev approve <id>

# live path (real Velar, mainnet)
npm run dev live-quote STX sBTC 100
STACKS_PRIVATE_KEY=... npm run dev live-execute STX sBTC 25                 # dry run: builds + signs
STACKS_PRIVATE_KEY=... npm run dev -- live-execute STX sBTC 25 --broadcast  # sends it
```

### Does this need an API key? No.

Every command above runs with no Anthropic credentials whatsoever — including `add`, which reads plain English, and `tick`, the loop that actually executes strategies.

| | Model call? | Needs a key? |
| --- | --- | --- |
| `add` — plain English → rule | **Never** (deterministic grammar) | **No** |
| `strategy add` — rule entered directly | Never | No |
| Every monitoring cycle, forever | Never | No |
| Evaluating rules, enforcing caps, executing | Never | No |
| `chat` — conversational analysis | Yes | Yes, optional |

Only `chat` calls a model, and nothing depends on it. It exists for phrasing the grammar cannot read and for open-ended questions; remove it and the product is unchanged.

If you do enable it, the key is the **operator's**, never a user's — it would live on your server, and a TradeSage user needs a Stacks wallet and nothing else.

The consequence is that inference is a bounded one-off cost rather than a per-user running cost. A hundred users with three strategies each is ~300 lifetime model calls. Had evaluation stayed in the model — as it did in the first version of this codebase — the same hundred users on hourly monitoring would be ~216,000 calls a month, and the economics would not survive it.

Measured on the actual prompt and tool schemas (~2,040 input + ~300 output tokens per compilation), on the default model:

| Strategies compiled | Cost, lifetime |
| --- | --- |
| 300 (≈100 users) | **$1.06** |
| 5,000 (≈1,600 users) | **$17.71** |

**And you may never pay it.** The deterministic parser covers the common phrasings for all three strategy kinds, so the model is only reached for input it cannot read. Set `TRADESAGE_MODEL` to override the default, or simply never set a key.

## What's real vs simulated

| Component | Status |
| --- | --- |
| STX / BTC prices, 24h change | **Real** (CoinGecko, 60s cache) |
| On-chain wallet lookups | **Real** (Hiro API, read-only) |
| Plain-English → rule (`add`) | **Real and deterministic** — grammar-based, no model, no key, no network |
| Conversational analysis (`chat`) | **Real** (Claude tool-use loop) — optional, nothing depends on it |
| Strategy evaluation, proposals, caps, monitoring cycle | **Real and deterministic** — no model call, runs with no API key |
| DEX quotes (`live-quote`) | **Real** (Velar STX/sBTC pool, mainnet) |
| Swap transaction + post-conditions (`live-execute`) | **Settled on mainnet.** [`0x85e1a2ff4fda368a…`](https://explorer.hiro.so/txid/0x85e1a2ff4fda368a6bcebbb72f5d0c1fa086e7315df37d67a725a226a806a9a9?chain=mainnet) — 5 STX → 1668 sats sBTC, Deny mode, all 3 post-conditions enforced by the chain. |
| Paper trade fills | **Simulated** — 30bps fee + size-dependent slippage against live mid-price |
| In-wallet signing (browser) | **Milestone 2** — @stacks/connect approval page |

Example of what the chain enforces on a live 25 STX → sBTC swap (Deny mode — any transfer outside these bounds aborts the transaction):

```json
[
  { "type": "stx-postcondition", "address": "<you>",        "condition": "eq",  "amount": "25000000" },
  { "type": "ft-postcondition",  "address": "<velar pool>", "condition": "gte", "amount": "6375",
    "asset": "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token" }
]
```

## Tests

```bash
npm test        # rule evaluator, cap arithmetic, concurrency (no network, no API key)
npm run typecheck
```

Two of these are regression tests for money-losing bugs found during development: a rebalance rule whose target was unreachable while an untargeted asset was held (it re-traded every cycle, bleeding fees), and concurrent monitoring cycles double-executing the same strategy. Both are fixed; the tests keep them fixed.

Balances and trade amounts are held as **integer base units** (microSTX, satoshis), never floats, so they cannot drift and are always representable on-chain — `tests/units.test.ts` asserts this.

**A live swap has settled on mainnet** — [`0x85e1a2ff4fda368a…`](https://explorer.hiro.so/txid/0x85e1a2ff4fda368a6bcebbb72f5d0c1fa086e7315df37d67a725a226a806a9a9?chain=mainnet), 5 STX → 1668 sats sBTC, `post_condition_mode: deny` with all three conditions enforced by the chain. The non-custodial guarantee is demonstrated, not merely described.

**Known limitations, stated plainly:** there is no devnet/fork harness exercising the swap against real contract state, and execution routes through a single venue.

## Roadmap

- **M1 (done, this repo):** paper-trading agent — strategies, monitoring cycles, session caps with auto-execution, proposal queue, simulated fills, P&L — plus the live execution skeleton: real Velar quotes and signed, post-conditioned swap transactions.
- **M2:** productionize live execution — browser-wallet signing via @stacks/connect, caps enforced on the live path, scheduled monitoring (cron ticks), multi-DEX routing (Bitflow aggregator).
- **M3:** web dashboard (strategy cards, approval inbox, activity feed), Telegram/Discord approvals, strategy performance analytics.

## Stack

TypeScript · Node 20+ · [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk) (beta tool runner, `claude-opus-4-8`) · zod · [@velarprotocol/velar-sdk](https://www.npmjs.com/package/@velarprotocol/velar-sdk) · [@stacks/transactions](https://www.npmjs.com/package/@stacks/transactions) · Hiro Stacks API · CoinGecko

## License

MIT
