export interface AssetConfig {
  symbol: string;
  name: string;
  decimals: number;
  /** CoinGecko id used to price the asset; null for stables pegged to $1 */
  coingeckoId: string | null;
  /** Mainnet contract for reference in proposals and the eventual live executor */
  contract: string | null;
}

export const ASSETS: Record<string, AssetConfig> = {
  STX: {
    symbol: "STX",
    name: "Stacks",
    decimals: 6,
    coingeckoId: "blockstack",
    contract: null, // native asset
  },
  sBTC: {
    symbol: "sBTC",
    name: "sBTC (Bitcoin on Stacks)",
    decimals: 8,
    coingeckoId: "bitcoin",
    contract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
  },
  sUSD: {
    symbol: "sUSD",
    name: "Stable USD (aeUSDC-equivalent cash leg)",
    decimals: 6,
    coingeckoId: null,
    contract: null,
  },
};

export const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price";
export const HIRO_API_URL = "https://api.hiro.so";

/** Paper-trading fill model */
export const SWAP_FEE_BPS = 30; // 0.30% pool fee, in line with Stacks DEX pools
export const BASE_SLIPPAGE_BPS = 20; // baseline price impact for small orders
export const IMPACT_BPS_PER_10K_USD = 15; // additional impact per $10k notional

export const DATA_DIR = new URL("../data/", import.meta.url).pathname;

export const STARTING_BALANCES: Record<string, number> = {
  STX: 5_000,
  sBTC: 0.05,
  sUSD: 1_000,
};

/**
 * Model used for strategy compilation and optional narration — the only two
 * places a model is called at all.
 *
 * Defaults to Haiku deliberately. The task is bounded structured extraction:
 * read one sentence, pick one of three rule shapes, fill its fields. Output is
 * then checked by `validateRule` and shown to the user before anything is
 * saved, so a wrong compilation is caught rather than acted on. That makes the
 * cheapest capable model the correct default rather than a compromise — roughly
 * $0.0035 per strategy compiled, or about $18 for five thousand of them.
 *
 * Override with TRADESAGE_MODEL if you want a stronger model for conversational
 * analysis; nothing in the money path depends on this choice.
 */
export const MODEL = process.env.TRADESAGE_MODEL ?? "claude-haiku-4-5";
