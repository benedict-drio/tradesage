import {
  broadcastTransaction,
  makeContractCall,
  PostConditionMode,
  privateKeyToAddress,
} from "@stacks/transactions";
import { getOnchainBalances } from "./market.js";
import { formatBase, fromBase } from "./units.js";
import { adapterByName, minimumReceived, routeBestQuote, type DexQuote } from "./dex/index.js";

/**
 * Live execution: quote across every configured venue, take the best, and sign a
 * swap whose Deny-mode post-conditions bound exactly what the transaction may
 * move.
 *
 * The agent cannot reach this module. Execution is human-triggered, and the
 * signing key is read from the environment and never leaves the machine.
 */

const DEFAULT_SLIPPAGE_BPS = 100; // 1%

export interface LiveQuote {
  from: string;
  to: string;
  amountIn: bigint;
  amountOut: bigint;
  venue: string;
  indicative: boolean;
  feeBps: number;
  /** every venue that answered, best first */
  considered: Array<{ venue: string; out: bigint; feeBps: number }>;
  failed: Array<{ venue: string; reason: string }>;
}

export async function getLiveQuote(
  from: string,
  to: string,
  amountIn: bigint,
): Promise<LiveQuote> {
  const { best, considered, failed } = await routeBestQuote(from, to, amountIn);
  return {
    from,
    to,
    amountIn,
    amountOut: best.expectedOut,
    venue: best.venue,
    indicative: best.indicative,
    feeBps: best.feeBps,
    considered: considered.map((q) => ({ venue: q.venue, out: q.expectedOut, feeBps: q.feeBps })),
    failed,
  };
}

export interface LiveExecutionResult {
  txid: string;
  broadcast: boolean;
  venue: string;
  contract: string;
  functionName: string;
  postConditions: unknown[];
  senderAddress: string;
  amountIn: bigint;
  expectedOut: bigint;
  minOut: bigint;
  feeStx: number;
  stxBalance: number;
  /** null when the wallet can cover the swap; a reason when it cannot */
  shortfall: string | null;
}

export async function executeLiveSwap(input: {
  from: string;
  to: string;
  amountIn: bigint;
  senderKey: string;
  broadcast: boolean;
  /** pin a venue instead of routing on price */
  venue?: string;
  slippageBps?: number;
}): Promise<LiveExecutionResult> {
  const senderAddress = privateKeyToAddress(input.senderKey, "mainnet");
  const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  let quote: DexQuote;
  if (input.venue) {
    quote = await adapterByName(input.venue).quote(input.from, input.to, input.amountIn);
  } else {
    quote = (await routeBestQuote(input.from, input.to, input.amountIn)).best;
  }

  // The chain-enforced floor. Everything above is advisory; this is the promise.
  const minOut = minimumReceived(quote, slippageBps);

  const payload = await adapterByName(quote.venue).buildSwap({
    from: input.from,
    to: input.to,
    amountIn: input.amountIn,
    minOut,
    sender: senderAddress,
  });

  const transaction = await makeContractCall({
    contractAddress: payload.contractAddress,
    contractName: payload.contractName,
    functionName: payload.functionName,
    functionArgs: payload.functionArgs,
    postConditions: payload.postConditions,
    postConditionMode: PostConditionMode.Deny,
    senderKey: input.senderKey,
    network: "mainnet",
  });

  // Preflight against real balances. Without this the first live attempt fails
  // inside the node with a rejection reason rather than saying plainly that the
  // wallet is short.
  const feeMicro = transaction.auth.spendingCondition?.fee ?? 0n;
  const feeStx = Number(feeMicro) / 1e6;
  const { stx: stxBalance } = await getOnchainBalances(senderAddress);
  const stxNeeded = feeStx + (input.from === "STX" ? fromBase(input.amountIn, "STX") : 0);
  const shortfall =
    stxBalance < stxNeeded
      ? `wallet holds ${stxBalance} STX but this needs ${stxNeeded.toFixed(6)} STX ` +
        `(${input.from === "STX" ? `${formatBase(input.amountIn, "STX")} to swap + ` : ""}${feeStx.toFixed(6)} fee)`
      : null;

  let broadcast = false;
  if (input.broadcast) {
    if (shortfall) throw new Error(`Cannot broadcast: ${shortfall}`);
    const result = await broadcastTransaction({ transaction, network: "mainnet" });
    // A rejected broadcast returns `{ reason, reason_data }`, never `{ error }`.
    // Checking for "error" would treat every rejection as a success and report a
    // txid that was never accepted into the mempool.
    if (!("txid" in result)) {
      const reason = (result as { reason?: string }).reason ?? "unknown";
      const detail =
        (result as { reason_data?: { message?: string } }).reason_data?.message ??
        JSON.stringify(result);
      throw new Error(`Broadcast rejected by the node (${reason}): ${detail}`);
    }
    broadcast = true;
  }

  return {
    txid: transaction.txid(),
    broadcast,
    venue: quote.venue,
    contract: `${payload.contractAddress}.${payload.contractName}`,
    functionName: payload.functionName,
    postConditions: payload.postConditions,
    senderAddress,
    amountIn: input.amountIn,
    expectedOut: quote.expectedOut,
    minOut,
    feeStx,
    stxBalance,
    shortfall,
  };
}
