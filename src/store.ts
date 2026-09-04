import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";

export function readJson<T>(file: string, fallback: T): T {
  const path = join(DATA_DIR, file);
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true });
  // Write-then-rename so a crash mid-write can never leave a torn JSON file
  // that would be unparseable on the next read.
  const target = join(DATA_DIR, file);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, target);
}

const LOCK_PATH = () => join(DATA_DIR, ".lock");
const LOCK_STALE_MS = 30_000;

/**
 * Cross-process mutual exclusion around read-modify-write cycles.
 *
 * Without this, two monitoring cycles running concurrently (exactly what a
 * scheduler produces) both pass their `lastFiredAt` check before either writes,
 * and the same strategy executes twice — a double spend of the user's funds.
 * `wx` makes lock creation atomic; a lock older than LOCK_STALE_MS is treated
 * as abandoned by a crashed process and broken.
 */
export async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync(DATA_DIR, { recursive: true });
  const path = LOCK_PATH();
  const deadline = Date.now() + LOCK_STALE_MS;

  for (;;) {
    try {
      closeSync(openSync(path, "wx"));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let age = 0;
      try {
        age = Date.now() - statSync(path).mtimeMs;
      } catch {
        continue; // lock vanished between the failed create and the stat; retry
      }
      if (age > LOCK_STALE_MS) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          "Timed out waiting for the TradeSage state lock. Another cycle may still be running; " +
            `if nothing is running, remove ${path}.`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}

export interface Portfolio {
  createdAt: string;
  initialValueUsd: number;
  /** Base units per asset, as decimal strings — never floats. See units.ts. */
  balances: Record<string, string>;
}

/**
 * A strategy's machine-evaluatable form. Natural language is compiled into one
 * of these ONCE, at save time; every monitoring cycle afterwards evaluates the
 * rule with plain deterministic code and no model call.
 */
export type StrategyRule =
  | {
      kind: "dca";
      from: string;
      to: string;
      /** amount of `from` to convert each interval */
      amount: number;
      everyHours: number;
    }
  | {
      kind: "rebalance";
      /** target portfolio weights by asset, e.g. { STX: 0.6, sBTC: 0.4 } */
      targets: Record<string, number>;
      /** trigger when any asset's weight drifts this many percentage points */
      driftPct: number;
    }
  | {
      kind: "threshold";
      asset: string;
      direction: "drop" | "rise";
      /** absolute 24h move, in percent, that triggers the rule */
      changePct: number;
      from: string;
      to: string;
      amount: number;
      /** minimum hours between firings */
      cooldownHours: number;
    };

export interface Strategy {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  active: boolean;
  /** null only for legacy strategies saved before rule compilation existed */
  rule: StrategyRule | null;
  lastFiredAt: string | null;
}

export interface Proposal {
  id: string;
  createdAt: string;
  status: "pending" | "approved" | "rejected" | "executed";
  /** true when executed automatically under the user's pre-approved session caps */
  autoExecuted?: boolean;
  from: string;
  to: string;
  /** base units of `from`, as a decimal string */
  amount: string;
  rationale: string;
  strategyId: string | null;
  quote: {
    price: number;
    /** base units of `to`, as a decimal string */
    expectedOut: string;
    feeBps: number;
    slippageBps: number;
    notionalUsd: number;
  };
}

export interface Trade {
  id: string;
  executedAt: string;
  proposalId: string;
  from: string;
  to: string;
  /** base units, as decimal strings */
  amountIn: string;
  amountOut: string;
  priceUsdIn: number;
  priceUsdOut: number;
  notionalUsd: number;
}

/**
 * Session-scoped pre-approval: trades whose notional fits inside these caps
 * execute without a manual approve step. Everything else queues as pending.
 */
export interface Caps {
  enabled: boolean;
  perTradeUsd: number;
  dailyUsd: number;
}

export const DEFAULT_CAPS: Caps = {
  enabled: false,
  perTradeUsd: 250,
  dailyUsd: 750,
};

export const portfolioStore = {
  load: () => readJson<Portfolio | null>("portfolio.json", null),
  save: (p: Portfolio) => writeJson("portfolio.json", p),
};

export const strategyStore = {
  load: () => readJson<Strategy[]>("strategies.json", []),
  save: (s: Strategy[]) => writeJson("strategies.json", s),
};

export const proposalStore = {
  load: () => readJson<Proposal[]>("proposals.json", []),
  save: (p: Proposal[]) => writeJson("proposals.json", p),
};

export const tradeStore = {
  load: () => readJson<Trade[]>("trades.json", []),
  save: (t: Trade[]) => writeJson("trades.json", t),
};

export const capsStore = {
  load: () => readJson<Caps>("caps.json", DEFAULT_CAPS),
  save: (c: Caps) => writeJson("caps.json", c),
};

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
