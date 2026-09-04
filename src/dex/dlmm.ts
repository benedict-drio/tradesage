import {
  contractPrincipalCV,
  cvToJSON,
  hexToCV,
  PostConditionMode,
  uintCV,
} from "@stacks/transactions";
import { fromBase } from "../units.js";
import type { DexAdapter, DexQuote, SwapPayload } from "./types.js";

/**
 * Bitflow DLMM — called directly, with no SDK and no API dependency.
 *
 * The published `@bitflowlabs/core-sdk` defaults to an API host that returns 404
 * on every path, so the SDK cannot initialise. Going straight to the contracts
 * avoids that entirely and removes a third-party service from the critical path:
 * the only external calls left are a Stacks node and a price feed.
 *
 * Contract addresses and the argument shape below were read from settled mainnet
 * swaps rather than from documentation, so they reflect what the router actually
 * accepts.
 *
 * Known issue, stated rather than discovered later: an open report against
 * `dlmm-core-v-1-1` describes an authorization bypass via `tx-sender` spoofing
 * (BitflowFinance/bitflow-dlmm#6). It affects privileged admin functions and
 * requires an admin to call into an attacker-controlled contract; ordinary swap
 * entry points are not the vector. It does not change what a user's transaction
 * can move here, because that is bounded by Deny-mode post-conditions — but it is
 * a reason to keep execution venue-agnostic rather than to depend on one DEX.
 */

const ROUTER_ADDRESS = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const ROUTER_NAME = "dlmm-swap-router-v-1-1";
const CORE_ADDRESS = "SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA";
const CORE_NAME = "dlmm-core-v-1-1";
const HIRO = "https://api.hiro.so";

/**
 * Bin prices are y base units per x base unit, scaled by 1e8. Verified against a
 * settled swap: the pool reported 33236 while the observed fill was 3.3403e-4
 * sats per microSTX, i.e. the same number at this scale.
 */
const PRICE_SCALE = 100_000_000n;

async function callRead(
  address: string,
  name: string,
  fn: string,
  args: string[] = [],
): Promise<ReturnType<typeof cvToJSON>> {
  const res = await fetch(`${HIRO}/v2/contracts/call-read/${address}/${name}/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sender: address, arguments: args }),
  });
  if (!res.ok) throw new Error(`read-only call ${fn} failed: HTTP ${res.status}`);
  const body = (await res.json()) as { okay: boolean; result?: string; cause?: string };
  if (!body.okay || !body.result) throw new Error(`read-only call ${fn} failed: ${body.cause}`);
  return cvToJSON(hexToCV(body.result));
}

const hexUint = (n: bigint | string) => "0x01" + BigInt(n).toString(16).padStart(32, "0");
const hexInt = (n: bigint | string) => "0x00" + BigInt(n).toString(16).padStart(32, "0");

/** Current price of the pool's active bin, read from chain. */
async function activeBinPrice(cfg: PoolConfig, xForY: boolean): Promise<bigint> {
  const [poolAddress, poolName] = cfg.pool;
  const state = await callRead(poolAddress, poolName, "get-pool-for-swap", [
    xForY ? "0x03" : "0x04",
  ]);
  // response -> optional/tuple; read the fields the price function needs
  const fields = (state as { value: { value: Record<string, { value: string }> } }).value.value;
  const initialPrice = fields["initial-price"].value;
  const binStep = fields["bin-step"].value;
  const activeBin = fields["active-bin-id"].value;

  const price = await callRead(CORE_ADDRESS, CORE_NAME, "get-bin-price", [
    hexUint(initialPrice),
    hexUint(binStep),
    hexInt(activeBin),
  ]);
  return BigInt((price as { value: { value: string } }).value.value);
}

interface PoolConfig {
  pool: [address: string, name: string];
  /** the pool's x side */
  x: { symbol: string; token: [string, string] };
  /** the pool's y side */
  y: { symbol: string; token: [string, string]; assetName: string };
  feeBps: number;
}

const POOLS: PoolConfig[] = [
  {
    pool: [ROUTER_ADDRESS, "dlmm-pool-stx-sbtc-v-2-bps-15"],
    x: { symbol: "STX", token: ["SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR", "token-stx-v-1-2"] },
    y: {
      symbol: "sBTC",
      token: ["SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4", "sbtc-token"],
      assetName: "sbtc-token",
    },
    feeBps: 15,
  },
];

function findPool(from: string, to: string): { cfg: PoolConfig; xForY: boolean } | null {
  for (const cfg of POOLS) {
    if (cfg.x.symbol === from && cfg.y.symbol === to) return { cfg, xForY: true };
    if (cfg.y.symbol === from && cfg.x.symbol === to) return { cfg, xForY: false };
  }
  return null;
}

export const dlmmAdapter: DexAdapter = {
  name: "bitflow-dlmm",

  supports(from, to) {
    return findPool(from, to) !== null;
  },

  async quote(from, to, amountIn): Promise<DexQuote> {
    const match = findPool(from, to);
    if (!match) throw new Error(`bitflow-dlmm does not have a ${from}/${to} pool`);

    // Priced from the pool's own active-bin price rather than from a market
    // feed, so the quote reflects this venue rather than an approximation of it.
    // A large trade walks into further bins and would fill slightly worse than
    // this; at the sizes this product places it is exact, and min-received plus
    // post-conditions bound the difference regardless.
    const price = await activeBinPrice(match.cfg, match.xForY);
    const feeNum = BigInt(10_000 - match.cfg.feeBps);
    // Single division: truncating the gross amount and again after the fee loses
    // a base unit on small trades, which is enough to flip a venue comparison.
    const expectedOut = match.xForY
      ? (amountIn * price * feeNum) / (PRICE_SCALE * 10_000n)
      : (amountIn * PRICE_SCALE * feeNum) / (price * 10_000n);

    return {
      venue: this.name,
      from,
      to,
      amountIn,
      expectedOut,
      feeBps: match.cfg.feeBps,
      indicative: false,
    };
  },

  async buildSwap({ from, to, amountIn, minOut, sender }): Promise<SwapPayload> {
    const match = findPool(from, to);
    if (!match) throw new Error(`bitflow-dlmm does not have a ${from}/${to} pool`);
    const { cfg, xForY } = match;
    const [poolAddress, poolName] = cfg.pool;

    // Observed on settled swaps: the trader sends the input asset to the pool
    // contract, and the pool sends the output back to the trader. Post-conditions
    // mirror exactly that, in Deny mode — send precisely amountIn, receive no
    // less than minOut, or the chain rejects the transaction.
    const poolPrincipal = `${poolAddress}.${poolName}`;
    const sbtcAsset = `${cfg.y.token[0]}.${cfg.y.token[1]}::${cfg.y.assetName}`;

    const postConditions = xForY
      ? [
          { type: "stx-postcondition", address: sender, condition: "eq", amount: amountIn.toString() },
          {
            type: "ft-postcondition",
            address: poolPrincipal,
            condition: "gte",
            amount: minOut.toString(),
            asset: sbtcAsset,
          },
        ]
      : [
          {
            type: "ft-postcondition",
            address: sender,
            condition: "eq",
            amount: amountIn.toString(),
            asset: sbtcAsset,
          },
          { type: "stx-postcondition", address: poolPrincipal, condition: "gte", amount: minOut.toString() },
        ];

    return {
      contractAddress: ROUTER_ADDRESS,
      contractName: ROUTER_NAME,
      functionName: xForY ? "swap-x-for-y-simple-multi" : "swap-y-for-x-simple-multi",
      functionArgs: [
        contractPrincipalCV(poolAddress, poolName),
        contractPrincipalCV(cfg.x.token[0], cfg.x.token[1]),
        contractPrincipalCV(cfg.y.token[0], cfg.y.token[1]),
        uintCV(amountIn),
        uintCV(minOut),
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      postConditions: postConditions as any,
      postConditionMode: PostConditionMode.Deny,
    };
  },
};

/** Pool reserves, read from chain — used to report venue depth. */
export async function dlmmPoolDepth(): Promise<{ pool: string; stx: number; sbtc: number }> {
  const cfg = POOLS[0];
  const principal = `${cfg.pool[0]}.${cfg.pool[1]}`;
  const res = await fetch(`https://api.hiro.so/extended/v1/address/${principal}/balances`);
  if (!res.ok) throw new Error(`Could not read DLMM pool balances: ${res.status}`);
  const body = (await res.json()) as {
    stx: { balance: string };
    fungible_tokens: Record<string, { balance: string }>;
  };
  const sbtcKey = Object.keys(body.fungible_tokens ?? {}).find((k) => k.includes("sbtc-token"));
  return {
    pool: principal,
    stx: Number(body.stx.balance) / 1e6,
    sbtc: sbtcKey ? fromBase(BigInt(body.fungible_tokens[sbtcKey].balance), "sBTC") : 0,
  };
}
