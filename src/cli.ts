#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";

// Load .env if present. The README tells users to create one, so it has to be
// read — otherwise a key placed there is silently ignored. Variables already
// set in the shell win, matching how --env-file behaves.
if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // Malformed or unreadable .env should not stop a keyless command working.
  }
}

import { explainTick, runAgent } from "./agent.js";
import {
  approveProposal,
  getCapsUsage,
  initPortfolio,
  rejectProposal,
  runTick,
  setCaps,
  valuePortfolio,
} from "./engine.js";
import { executeLiveSwap, getLiveQuote } from "./live.js";
import { resolveSigner } from "./wallet.js";
import { getPrices } from "./market.js";
import { ASSETS } from "./config.js";
import { describeRule, validateRule } from "./rules.js";
import { parseStrategy } from "./parse.js";
import { formatBase, parseBase } from "./units.js";
import {
  newId,
  proposalStore,
  strategyStore,
  tradeStore,
  type Strategy,
  type StrategyRule,
} from "./store.js";

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function requireApiKey(): void {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error(
      'This command talks to the TradeSage agent and needs Claude API credentials.\nSet ANTHROPIC_API_KEY (or run "ant auth login") and try again.',
    );
    process.exit(1);
  }
}

async function printStatus(): Promise<void> {
  const view = await valuePortfolio();
  console.log("\nPortfolio");
  console.log("---------");
  for (const [symbol, row] of Object.entries(view.balances)) {
    console.log(`${symbol.padEnd(5)} ${formatBase(row.base, symbol).padEnd(16)} ${usd(row.usdValue)}`);
  }
  console.log(`\nTotal: ${usd(view.totalUsd)}  (started at ${usd(view.initialUsd)})`);
  const sign = view.pnlUsd >= 0 ? "+" : "";
  console.log(`P&L:   ${sign}${usd(view.pnlUsd)} (${sign}${view.pnlPct.toFixed(2)}%)\n`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "init": {
      const portfolio = await initPortfolio(rest.includes("--reset"));
      console.log(`Paper portfolio ready (created ${portfolio.createdAt}).`);
      await printStatus();
      break;
    }
    case "status":
      await printStatus();
      break;
    case "market": {
      const prices = await getPrices();
      console.log("\nMarket");
      console.log("------");
      for (const p of Object.values(prices)) {
        const change =
          p.change24hPct === null ? "" : `  (${p.change24hPct >= 0 ? "+" : ""}${p.change24hPct.toFixed(2)}% 24h)`;
        console.log(`${p.symbol.padEnd(5)} ${usd(p.usd)}${change}`);
      }
      console.log();
      break;
    }
    case "chat": {
      requireApiKey();
      const message = rest.join(" ").trim();
      if (!message) {
        console.error('Usage: tradesage chat "your message"');
        process.exit(1);
      }
      console.log(await runAgent(message));
      break;
    }
    case "tick": {
      // Deterministic: no API key, no model call.
      const result = await runTick();
      console.log(`\nMonitoring cycle — ${result.evaluatedAt}`);
      console.log("-".repeat(52));

      if (result.acted.length === 0 && result.skipped.length === 0) {
        console.log('No strategies saved yet. Add one with "tradesage strategy add ..."');
      }
      for (const a of result.acted) {
        const p = a.proposal;
        const state =
          p.status === "executed"
            ? "EXECUTED (within caps)"
            : "PENDING — needs your approval";
        console.log(`\n▸ ${a.strategyName}: ${state}`);
        console.log(`  ${formatBase(parseBase(p.amount), p.from)} ${p.from} -> ~${formatBase(parseBase(p.quote.expectedOut), p.to)} ${p.to}`);
        console.log(`  ${a.reason}`);
        if (p.status === "pending") console.log(`  approve with: tradesage approve ${p.id}`);
      }
      for (const s of result.skipped) {
        console.log(`\n· ${s.strategyName}: no action — ${s.reason}`);
      }
      for (const e of result.errors) {
        console.log(`\n! ${e.strategyName}: ${e.message}`);
      }

      console.log(
        `\nPortfolio: ${usd(result.portfolio.totalUsd)}  ` +
          `(${result.portfolio.pnlUsd >= 0 ? "+" : ""}${usd(result.portfolio.pnlUsd)}, ` +
          `${result.portfolio.pnlPct >= 0 ? "+" : ""}${result.portfolio.pnlPct.toFixed(2)}%)\n`,
      );

      if (rest.includes("--explain")) {
        if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
          console.log("(--explain needs an API key; the cycle above ran without one.)");
        } else {
          console.log(await explainTick(result));
        }
      }
      break;
    }
    case "strategy": {
      // Keyless structured entry — the same rules the agent compiles, typed by hand.
      const [sub, ...args] = rest;
      if (sub !== "add") {
        throw new Error(
          [
            "Usage:",
            "  tradesage strategy add dca <from> <to> <amount> <everyHours>",
            "  tradesage strategy add rebalance <ASSET:weight,...> <driftPct>",
            "  tradesage strategy add threshold <asset> <drop|rise> <changePct> <from> <to> <amount> <cooldownHours>",
            "",
            'Example: tradesage strategy add rebalance "STX:0.6,sBTC:0.4" 5',
          ].join("\n"),
        );
      }
      const [kind] = args;
      let rule: StrategyRule;
      let name: string;
      if (kind === "dca") {
        const [from, to, amount, everyHours] = args.slice(1);
        rule = {
          kind: "dca",
          from,
          to,
          amount: Number(amount),
          everyHours: Number(everyHours),
        };
        name = `DCA ${from}->${to}`;
      } else if (kind === "rebalance") {
        const [targetsRaw, driftPct] = args.slice(1);
        const targets: Record<string, number> = {};
        for (const part of targetsRaw.split(",")) {
          const [asset, weight] = part.split(":");
          targets[asset.trim()] = Number(weight);
        }
        rule = { kind: "rebalance", targets, driftPct: Number(driftPct) };
        name = `Rebalance ${Object.keys(targets).join("/")}`;
      } else if (kind === "threshold") {
        const [asset, direction, changePct, from, to, amount, cooldownHours] = args.slice(1);
        rule = {
          kind: "threshold",
          asset,
          direction: direction as "drop" | "rise",
          changePct: Number(changePct),
          from,
          to,
          amount: Number(amount),
          cooldownHours: Number(cooldownHours ?? 24),
        };
        name = `${asset} ${direction} ${changePct}%`;
      } else {
        throw new Error(`Unknown strategy kind "${kind}" (dca | rebalance | threshold)`);
      }

      validateRule(rule, Object.keys(ASSETS));
      const strategies = strategyStore.load();
      const strategy: Strategy = {
        id: newId("strat"),
        name,
        description: describeRule(rule),
        createdAt: new Date().toISOString(),
        active: true,
        rule,
        lastFiredAt: null,
      };
      strategies.push(strategy);
      strategyStore.save(strategies);
      console.log(`Saved ${strategy.id}: ${describeRule(rule)}`);
      break;
    }
    case "add": {
      // Plain English, no model, no API key, no network.
      const sentence = rest.join(" ").trim();
      if (!sentence) {
        throw new Error(
          [
            'Usage: tradesage add "<strategy in plain English>"',
            "",
            'Examples:',
            '  tradesage add "DCA 200 STX into sBTC weekly"',
            '  tradesage add "rebalance to 60/40 STX/sBTC when drift exceeds 5%"',
            '  tradesage add "if STX drops 10% in a day, move 200 sUSD into STX"',
          ].join("\n"),
        );
      }
      const parsed = parseStrategy(sentence);
      if (!parsed.ok) {
        console.error(`Could not read that strategy: ${parsed.reason}.`);
        console.error(parsed.hint);
        console.error('\nOr enter it directly with "tradesage strategy add ...".');
        process.exit(1);
      }
      validateRule(parsed.rule, Object.keys(ASSETS));
      const list = strategyStore.load();
      const saved: Strategy = {
        id: newId("strat"),
        name: parsed.name,
        description: describeRule(parsed.rule),
        createdAt: new Date().toISOString(),
        active: true,
        rule: parsed.rule,
        lastFiredAt: null,
      };
      list.push(saved);
      strategyStore.save(list);
      console.log(`Saved ${saved.id}`);
      console.log(`  ${describeRule(parsed.rule)}`);
      for (const d of parsed.defaults) console.log(`  assumed: ${d}`);
      break;
    }
    case "strategies": {
      const strategies = strategyStore.load();
      if (strategies.length === 0) {
        console.log('No strategies yet. Add one with: tradesage chat "DCA 200 STX into sBTC weekly"');
        break;
      }
      for (const s of strategies) {
        const compiled = s.rule ? describeRule(s.rule) : "NOT COMPILED — re-save to compile";
        const last = s.lastFiredAt ? `last fired ${s.lastFiredAt}` : "never fired";
        console.log(`${s.id}  [${s.active ? "active" : "off"}] ${s.name}`);
        console.log(`    rule: ${compiled}`);
        console.log(`    ${last}`);
      }
      break;
    }
    case "proposals": {
      const pending = proposalStore.load().filter((p) => p.status === "pending");
      if (pending.length === 0) {
        console.log("No pending proposals.");
        break;
      }
      for (const p of pending) {
        console.log(
          `${p.id}  ${formatBase(parseBase(p.amount), p.from)} ${p.from} -> ~${formatBase(parseBase(p.quote.expectedOut), p.to)} ${p.to}` +
            `  (fee ${p.quote.feeBps}bps, slip ~${p.quote.slippageBps}bps)\n    ${p.rationale}`,
        );
      }
      console.log('\nApprove with: tradesage approve <id>   Reject with: tradesage reject <id>');
      break;
    }
    case "approve": {
      const id = rest[0];
      if (!id) throw new Error("Usage: tradesage approve <proposal-id>");
      const trade = await approveProposal(id);
      console.log(
        `Executed: ${formatBase(parseBase(trade.amountIn), trade.from)} ${trade.from} -> ${formatBase(parseBase(trade.amountOut), trade.to)} ${trade.to}`,
      );
      await printStatus();
      break;
    }
    case "reject": {
      const id = rest[0];
      if (!id) throw new Error("Usage: tradesage reject <proposal-id>");
      rejectProposal(id);
      console.log(`Rejected ${id}.`);
      break;
    }
    case "caps": {
      const sub = rest[0];
      if (sub === "on" || sub === "off") {
        setCaps({ enabled: sub === "on" });
      } else if (sub === "set") {
        const perTrade = Number(rest[1]);
        const daily = Number(rest[2]);
        if (!perTrade || !daily) {
          throw new Error("Usage: tradesage caps set <perTradeUsd> <dailyUsd>");
        }
        setCaps({ perTradeUsd: perTrade, dailyUsd: daily });
      } else if (sub) {
        throw new Error("Usage: tradesage caps [on|off|set <perTradeUsd> <dailyUsd>]");
      }
      const usage = getCapsUsage();
      console.log(`\nSession caps: ${usage.caps.enabled ? "ENABLED" : "disabled"}`);
      console.log(`  Per trade:  ${usd(usage.caps.perTradeUsd)}`);
      console.log(`  Daily:      ${usd(usage.caps.dailyUsd)}`);
      console.log(`  Spent today:     ${usd(usage.spentTodayUsd)}`);
      console.log(`  Remaining today: ${usd(usage.remainingTodayUsd)}\n`);
      if (usage.caps.enabled) {
        console.log("Trades within these caps auto-execute; larger trades queue for approval.");
      } else {
        console.log('Every trade queues for manual approval. Enable with: tradesage caps on');
      }
      break;
    }
    case "live-quote": {
      const [from, to, amountStr] = rest;
      const amount = Number(amountStr);
      if (!from || !to || !amount) {
        throw new Error("Usage: tradesage live-quote <from> <to> <amount>  (e.g. live-quote STX sBTC 100)");
      }
      const quote = await getLiveQuote(from, to, amount);
      console.log(`\nLive quote (Velar, mainnet)`);
      console.log(`  ${quote.amountIn} ${quote.from} -> ${quote.amountOut} ${quote.to}`);
      console.log(`  Route: ${quote.route.join(" -> ")}\n`);
      break;
    }
    case "live-execute": {
      const [from, to, amountStr] = rest.filter((a) => !a.startsWith("--"));
      const amount = Number(amountStr);
      const broadcast = rest.includes("--broadcast");
      if (!from || !to || !amount) {
        throw new Error(
          "Usage: tradesage live-execute <from> <to> <amount> [--broadcast]\nWithout --broadcast this is a dry run: it builds and signs the real swap transaction but does not send it.",
        );
      }
      // Accepts a hex private key or a seed phrase; derivation is local and the
      // credential never leaves this machine.
      const signer = await resolveSigner(process.env.STACKS_PRIVATE_KEY);
      const senderKey = signer.privateKey;
      console.log(`\nWallet ${signer.address} (from ${signer.source})`);
      if (broadcast) {
        // Irreversible and spends real funds: build and show it first, then
        // require an explicit typed confirmation.
        const preview = await executeLiveSwap({
          from,
          to,
          amountIn: amount,
          senderKey,
          broadcast: false,
        });
        const quote = await getLiveQuote(from, to, amount, preview.senderAddress);
        console.log("\nAbout to send a REAL mainnet transaction");
        console.log(`  From wallet: ${preview.senderAddress}`);
        console.log(`  Balance:     ${preview.stxBalance} STX`);
        console.log(`  Swapping:    ${amount} ${from} -> ~${quote.amountOut} ${to}`);
        console.log(`  Network fee: ${preview.feeStx} STX`);
        console.log(`  Contract:    ${preview.contract}::${preview.functionName}`);
        if (preview.shortfall) {
          console.error(`\nCannot proceed: ${preview.shortfall}`);
          process.exit(1);
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question('\nType "send" to broadcast, anything else to cancel: ');
        rl.close();
        if (answer.trim().toLowerCase() !== "send") {
          console.log("Cancelled. Nothing was sent.");
          break;
        }
      }
      const result = await executeLiveSwap({ from, to, amountIn: amount, senderKey, broadcast });
      console.log(`\n${broadcast ? "Broadcast" : "Dry run (signed, not sent)"}`);
      console.log(`  Sender:   ${result.senderAddress}`);
      console.log(`  Contract: ${result.contract}::${result.functionName}`);
      console.log(`  Txid:     ${result.txid}`);
      console.log(`  Post-conditions (Deny mode — chain aborts if violated):`);
      console.log(
        JSON.stringify(result.postConditions, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
      );
      if (broadcast) {
        console.log(`\n  Track: https://explorer.hiro.so/txid/0x${result.txid}?chain=mainnet\n`);
      }
      break;
    }
    case "trades": {
      const trades = tradeStore.load();
      if (trades.length === 0) {
        console.log("No trades executed yet.");
        break;
      }
      for (const t of trades) {
        console.log(
          `${t.executedAt}  ${formatBase(parseBase(t.amountIn), t.from)} ${t.from} -> ${formatBase(parseBase(t.amountOut), t.to)} ${t.to}`,
        );
      }
      break;
    }
    default:
      console.log(`TradeSage — non-custodial AI trading copilot for Stacks (paper-trading prototype)

Usage: tradesage <command>

  init [--reset]      Create the paper portfolio (5,000 STX / 0.05 sBTC / 1,000 sUSD)
  status              Portfolio balances, total value, P&L
  market              Current STX / sBTC / sUSD prices
  tick [--explain]    Run one monitoring cycle (deterministic; NO API key needed)
  strategy add ...    Add a strategy as a structured rule (no API key needed)
  strategies          List saved strategies and their compiled rules

  chat "<message>"    Talk to the agent — describe a strategy in plain English and
                      it compiles to a rule; ask for analysis (needs API key)
  caps                Show session spend caps; "caps on|off", "caps set <perTrade> <daily>"
  proposals           List trade proposals awaiting your approval
  approve <id>        Approve a proposal (executes the paper trade)
  reject <id>         Reject a proposal
  trades              Executed trade history

  live-quote <from> <to> <amt>              Real Velar (mainnet) quote, e.g. STX sBTC 100
  live-execute <from> <to> <amt> [--broadcast]
                      Build + sign the real post-conditioned swap (dry run unless --broadcast;
                      needs STACKS_PRIVATE_KEY)

Trades inside your session caps auto-execute; everything else waits for your sign-off.
Monitoring, caps, and execution run without any AI provider — only natural-language
strategy capture ("chat") uses the model.`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
