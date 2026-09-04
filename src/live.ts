import { VelarSDK, type SwapResponse } from "@velarprotocol/velar-sdk";
import { getOnchainBalances } from "./market.js";
import {
  broadcastTransaction,
  makeContractCall,
  privateKeyToAddress,
  PostConditionMode,
} from "@stacks/transactions";

/**
 * Live execution path (M2 skeleton): real quotes and swap transactions on the
 * Velar DEX (mainnet), with the post-conditions Velar derives from the quote —
 * user sends exactly amount-in, pool must send at least min-out, Deny mode.
 *
 * The agent never touches this module. Execution is triggered by the human via
 * `tradesage live-execute`, and signing uses a key the user supplies locally
 * (STACKS_PRIVATE_KEY) or, in the web flow, their browser wallet.
 */

/** TradeSage asset -> Velar token contract principal */
const VELAR_TOKENS: Record<string, string> = {
  STX: "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx",
  sBTC: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
};

const DEFAULT_SLIPPAGE = 0.01; // 1%
// Read-only default principal for quoting when the user hasn't configured a key
const QUOTE_ACCOUNT = "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR";

function velarToken(symbol: string): string {
  const token = VELAR_TOKENS[symbol];
  if (!token) {
    throw new Error(
      `Live execution currently supports ${Object.keys(VELAR_TOKENS).join(", ")} (got ${symbol})`,
    );
  }
  return token;
}

export interface LiveQuote {
  from: string;
  to: string;
  amountIn: number;
  amountOut: number;
  route: string[];
  dex: "velar";
}

export async function getLiveQuote(
  from: string,
  to: string,
  amountIn: number,
  account: string = QUOTE_ACCOUNT,
): Promise<LiveQuote> {
  const sdk = new VelarSDK();
  const swap = await sdk.getSwapInstance({
    account,
    inToken: velarToken(from),
    outToken: velarToken(to),
  });
  const computed = await swap.getComputedAmount({ amount: amountIn, slippage: DEFAULT_SLIPPAGE });
  if (computed.valid === false) {
    throw new Error(`Velar could not quote ${from}->${to}: ${computed.errorMessage}`);
  }
  return {
    from,
    to,
    amountIn,
    amountOut: Number(computed.value),
    route: computed.route ?? [],
    dex: "velar",
  };
}

export async function buildLiveSwap(
  from: string,
  to: string,
  amountIn: number,
  account: string,
): Promise<SwapResponse> {
  const sdk = new VelarSDK();
  const swap = await sdk.getSwapInstance({
    account,
    inToken: velarToken(from),
    outToken: velarToken(to),
  });
  return swap.swap({ amount: amountIn, slippage: DEFAULT_SLIPPAGE });
}

export interface LiveExecutionResult {
  txid: string;
  broadcast: boolean;
  contract: string;
  functionName: string;
  postConditions: unknown[];
  senderAddress: string;
  feeStx: number;
  stxBalance: number;
  /** null when the wallet can cover the swap; a reason when it cannot */
  shortfall: string | null;
}

/**
 * Build (and optionally broadcast) the real swap transaction.
 * Post-conditions come from the Velar quote and run in Deny mode, so the chain
 * itself aborts the transaction if the fill would be worse than quoted.
 */
export async function executeLiveSwap(input: {
  from: string;
  to: string;
  amountIn: number;
  senderKey: string;
  broadcast: boolean;
}): Promise<LiveExecutionResult> {
  const senderAddress = privateKeyToAddress(input.senderKey, "mainnet");
  const payload = await buildLiveSwap(input.from, input.to, input.amountIn, senderAddress);

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

  // Preflight against real balances before spending anything. Without this the
  // first live attempt fails inside the node with a rejection reason rather
  // than telling the caller plainly that the wallet is short.
  const feeMicro = transaction.auth.spendingCondition?.fee ?? 0n;
  const feeStx = Number(feeMicro) / 1e6;
  const { stx: stxBalance } = await getOnchainBalances(senderAddress);
  const stxNeeded = feeStx + (input.from === "STX" ? input.amountIn : 0);
  const shortfall =
    stxBalance < stxNeeded
      ? `wallet holds ${stxBalance} STX but this needs ${stxNeeded.toFixed(6)} STX ` +
        `(${input.from === "STX" ? `${input.amountIn} to swap + ` : ""}${feeStx.toFixed(6)} fee)`
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
    contract: `${payload.contractAddress}.${payload.contractName}`,
    functionName: payload.functionName,
    postConditions: payload.postConditions,
    senderAddress,
    feeStx,
    stxBalance,
    shortfall,
  };
}
