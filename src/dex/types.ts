import type { ClarityValue, PostCondition, PostConditionMode } from "@stacks/transactions";

/**
 * A venue-agnostic execution interface.
 *
 * Execution is deliberately not tied to one DEX. Any single venue can lose
 * liquidity, ship a breaking SDK, or have a security issue disclosed against it,
 * and the correct response is to route elsewhere on a config change rather than
 * to rewrite the product. Adapters are therefore the unit of integration, and
 * the router picks between them on price.
 */

export interface DexQuote {
  venue: string;
  from: string;
  to: string;
  /** base units of `from` */
  amountIn: bigint;
  /** base units of `to` */
  expectedOut: bigint;
  feeBps: number;
  /**
   * True when the figure is derived from market mid-price rather than an
   * on-chain quote function. Indicative quotes are safe to show and to size a
   * minimum-received floor from; they are never the guarantee. The guarantee is
   * always the min-received argument plus Deny-mode post-conditions.
   */
  indicative: boolean;
}

export interface SwapPayload {
  contractAddress: string;
  contractName: string;
  functionName: string;
  functionArgs: ClarityValue[];
  postConditions: PostCondition[];
  postConditionMode: PostConditionMode;
}

export interface DexAdapter {
  readonly name: string;
  /** Whether this venue can trade the pair at all. */
  supports(from: string, to: string): boolean;
  quote(from: string, to: string, amountIn: bigint): Promise<DexQuote>;
  buildSwap(input: {
    from: string;
    to: string;
    amountIn: bigint;
    /** hard floor in base units of `to`; the chain enforces it */
    minOut: bigint;
    sender: string;
  }): Promise<SwapPayload>;
}
