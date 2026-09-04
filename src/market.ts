import { ASSETS, COINGECKO_URL, HIRO_API_URL } from "./config.js";

export interface AssetPrice {
  symbol: string;
  usd: number;
  change24hPct: number | null;
}

let priceCache: { at: number; prices: Record<string, AssetPrice> } | null = null;
const CACHE_MS = 60_000;

export async function getPrices(): Promise<Record<string, AssetPrice>> {
  if (priceCache && Date.now() - priceCache.at < CACHE_MS) return priceCache.prices;

  const ids = Object.values(ASSETS)
    .map((a) => a.coingeckoId)
    .filter((id): id is string => id !== null);

  const url = `${COINGECKO_URL}?ids=${ids.join(",")}&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko request failed: ${res.status}`);
  const body = (await res.json()) as Record<string, { usd: number; usd_24h_change?: number }>;

  const prices: Record<string, AssetPrice> = {};
  for (const asset of Object.values(ASSETS)) {
    if (asset.coingeckoId === null) {
      prices[asset.symbol] = { symbol: asset.symbol, usd: 1, change24hPct: 0 };
    } else {
      const row = body[asset.coingeckoId];
      if (!row) throw new Error(`No price returned for ${asset.symbol}`);
      prices[asset.symbol] = {
        symbol: asset.symbol,
        usd: row.usd,
        change24hPct: row.usd_24h_change ?? null,
      };
    }
  }
  priceCache = { at: Date.now(), prices };
  return prices;
}

export interface OnchainBalances {
  address: string;
  stx: number;
  fungibleTokens: Record<string, string>;
}

/** Read-only lookup of a real wallet via the Hiro API — no keys, no signing. */
export async function getOnchainBalances(address: string): Promise<OnchainBalances> {
  const res = await fetch(`${HIRO_API_URL}/extended/v1/address/${address}/balances`);
  if (!res.ok) throw new Error(`Hiro API request failed: ${res.status}`);
  const body = (await res.json()) as {
    stx: { balance: string };
    fungible_tokens: Record<string, { balance: string }>;
  };
  const tokens: Record<string, string> = {};
  for (const [id, v] of Object.entries(body.fungible_tokens ?? {})) {
    tokens[id] = v.balance;
  }
  return {
    address,
    stx: Number(body.stx.balance) / 1e6,
    fungibleTokens: tokens,
  };
}
