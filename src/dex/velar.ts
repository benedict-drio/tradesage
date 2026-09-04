import { VelarSDK } from "@velarprotocol/velar-sdk";
import { PostConditionMode } from "@stacks/transactions";
import { fromBase, toBase } from "../units.js";
import type { DexAdapter, DexQuote, SwapPayload } from "./types.js";

/**
 * Velar — quoted and built through the Velar SDK, which supplies its own
 * post-conditions derived from the quote.
 *
 * Retained as the second venue so execution is never dependent on a single DEX.
 * Its STX/sBTC pool is materially thinner than the DLMM one, so the router will
 * usually prefer Bitflow; this is the fallback that makes that a choice rather
 * than a dependency.
 */

const TOKENS: Record<string, string> = {
  STX: "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx",
  sBTC: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
};

const DEFAULT_SLIPPAGE = 0.01;
const QUOTE_ACCOUNT = "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR";

export const velarAdapter: DexAdapter = {
  name: "velar",

  supports(from, to) {
    return Boolean(TOKENS[from] && TOKENS[to] && from !== to);
  },

  async quote(from, to, amountIn): Promise<DexQuote> {
    const sdk = new VelarSDK();
    const swap = await sdk.getSwapInstance({
      account: QUOTE_ACCOUNT,
      inToken: TOKENS[from],
      outToken: TOKENS[to],
    });
    const computed = await swap.getComputedAmount({
      amount: fromBase(amountIn, from),
      slippage: DEFAULT_SLIPPAGE,
    });
    if (computed.valid === false) {
      throw new Error(`Velar could not quote ${from}->${to}: ${computed.errorMessage}`);
    }
    return {
      venue: this.name,
      from,
      to,
      amountIn,
      expectedOut: toBase(Number(computed.value), to),
      feeBps: 30,
      indicative: false,
    };
  },

  async buildSwap({ from, to, amountIn, sender }): Promise<SwapPayload> {
    const sdk = new VelarSDK();
    const swap = await sdk.getSwapInstance({
      account: sender,
      inToken: TOKENS[from],
      outToken: TOKENS[to],
    });
    const payload = await swap.swap({
      amount: fromBase(amountIn, from),
      slippage: DEFAULT_SLIPPAGE,
    });
    return {
      contractAddress: payload.contractAddress,
      contractName: payload.contractName,
      functionName: payload.functionName,
      functionArgs: payload.functionArgs,
      postConditions: payload.postConditions,
      postConditionMode: PostConditionMode.Deny,
    };
  },
};
