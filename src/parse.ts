import { ASSETS } from "./config.js";
import type { StrategyRule } from "./store.js";

/**
 * Deterministic plain-English strategy parsing — no model, no API key, no network.
 *
 * Strategies come in three shapes, and the phrasings people actually use for
 * them are narrow enough to parse with a grammar. That makes the language model
 * an optional convenience for unusual phrasing rather than a dependency: this
 * parser handles the common cases offline and for free, and anything it cannot
 * read fails with a message naming the missing piece so the user can supply it
 * directly.
 *
 * Every parse is checked by `validateRule` before it is stored, and any value
 * the parser had to assume is reported in `defaults` so it is visible to the
 * user rather than silently applied to their money.
 */

export type ParseResult =
  | { ok: true; rule: StrategyRule; name: string; defaults: string[] }
  | { ok: false; reason: string; hint: string };

const SYMBOLS = Object.keys(ASSETS);
const ASSET_ALT = SYMBOLS.join("|");
const canonical = new Map(SYMBOLS.map((s) => [s.toLowerCase(), s]));

function asset(raw: string): string {
  return canonical.get(raw.toLowerCase()) ?? raw;
}

function fail(reason: string, hint: string): ParseResult {
  return { ok: false, reason, hint };
}

/** "weekly", "every 3 days", "each week" -> hours */
function parseInterval(text: string): number | null {
  const named: Array<[RegExp, number]> = [
    [/\bhourly\b|\ban?\s+hour\b|\bper\s+hour\b|\bevery\s+hour\b/i, 1],
    [/\bdaily\b|\ba\s+day\b|\bper\s+day\b|\bevery\s+day\b|\beach\s+day\b/i, 24],
    [/\bweekly\b|\ba\s+week\b|\bper\s+week\b|\bevery\s+week\b|\beach\s+week\b/i, 168],
    [/\bfortnightly\b|\bbi-?weekly\b/i, 336],
    [/\bmonthly\b|\ba\s+month\b|\bper\s+month\b|\bevery\s+month\b|\beach\s+month\b/i, 720],
  ];
  for (const [re, hours] of named) if (re.test(text)) return hours;

  const numeric = text.match(/\bevery\s+(\d+(?:\.\d+)?)\s*(hour|day|week|month)s?\b/i);
  if (numeric) {
    const n = Number(numeric[1]);
    const unit = numeric[2].toLowerCase();
    const mult = unit === "hour" ? 1 : unit === "day" ? 24 : unit === "week" ? 168 : 720;
    return n * mult;
  }
  return null;
}

/** First "<number> <ASSET>" pair, e.g. "200 STX". */
function parseAmountAsset(text: string): { amount: number; symbol: string } | null {
  const m = text.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:of\\s+)?(${ASSET_ALT})\\b`, "i"));
  return m ? { amount: Number(m[1]), symbol: asset(m[2]) } : null;
}

function parseDca(text: string): ParseResult {
  const src = parseAmountAsset(text);
  if (!src) {
    return fail(
      "could not find an amount and asset to spend",
      `Say how much and of what, e.g. "DCA 200 STX into sBTC weekly". Assets: ${SYMBOLS.join(", ")}.`,
    );
  }
  // Destination is the first asset that is not the source. Prefer one introduced
  // by into/to/for/worth of, but fall back to any other asset mentioned — and in
  // both cases skip the source, so "Buy 200 STX worth of sBTC" does not read the
  // "STX" after "Buy" as the destination.
  const explicit = [
    ...text.matchAll(
      new RegExp(`(?:into|to|for|worth\\s+of|buying)\\s+(?:\\d+(?:\\.\\d+)?\\s*)?(${ASSET_ALT})\\b`, "gi"),
    ),
  ]
    .map((m) => asset(m[1]))
    .find((a) => a !== src.symbol);
  const anyOther = [...text.matchAll(new RegExp(`\\b(${ASSET_ALT})\\b`, "gi"))]
    .map((m) => asset(m[1]))
    .find((a) => a !== src.symbol);
  const to = explicit ?? anyOther;
  if (!to || to === src.symbol) {
    return fail(
      "could not find which asset to buy",
      `Name the destination, e.g. "DCA ${src.amount} ${src.symbol} into sBTC weekly".`,
    );
  }

  const everyHours = parseInterval(text);
  if (everyHours === null) {
    return fail(
      "could not find how often to buy",
      'Add an interval: "weekly", "daily", or "every 3 days".',
    );
  }

  return {
    ok: true,
    rule: { kind: "dca", from: src.symbol, to, amount: src.amount, everyHours },
    name: `DCA ${src.symbol}->${to}`,
    defaults: [],
  };
}

function parseRebalance(text: string): ParseResult {
  const pairs: Array<{ symbol: string; weight: number }> = [];

  // "60% STX", "60 STX"
  for (const m of text.matchAll(
    new RegExp(`(\\d+(?:\\.\\d+)?)\\s*%?\\s*(?:of\\s+)?(${ASSET_ALT})\\b`, "gi"),
  )) {
    pairs.push({ symbol: asset(m[2]), weight: Number(m[1]) });
  }
  // "STX 60%"
  if (pairs.length < 2) {
    for (const m of text.matchAll(new RegExp(`(${ASSET_ALT})\\s*(?:at|to)?\\s*(\\d+(?:\\.\\d+)?)\\s*%`, "gi"))) {
      pairs.push({ symbol: asset(m[1]), weight: Number(m[2]) });
    }
  }
  // "60/40 STX/sBTC" — the slash form is authoritative when present, because the
  // pair regex above misreads it (the "40" in "60/40" sits next to "STX").
  const nums = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  const syms = text.match(new RegExp(`(${ASSET_ALT})\\s*\\/\\s*(${ASSET_ALT})`, "i"));
  if (nums && syms) {
    pairs.length = 0;
    pairs.push({ symbol: asset(syms[1]), weight: Number(nums[1]) });
    pairs.push({ symbol: asset(syms[2]), weight: Number(nums[2]) });
  }

  const unique = new Map<string, number>();
  for (const p of pairs) if (!unique.has(p.symbol)) unique.set(p.symbol, p.weight);
  if (unique.size < 2) {
    return fail(
      "could not find at least two target weights",
      'Give the split, e.g. "rebalance to 60% STX and 40% sBTC when drift exceeds 5%".',
    );
  }

  const sum = [...unique.values()].reduce((a, b) => a + b, 0);
  const divisor = sum > 1.5 ? 100 : 1;
  const targets: Record<string, number> = {};
  for (const [symbol, weight] of unique) targets[symbol] = weight / divisor;
  const normalised = Object.values(targets).reduce((a, b) => a + b, 0);
  if (Math.abs(normalised - 1) > 0.001) {
    return fail(
      `target weights add up to ${Math.round(normalised * 100)}%, not 100%`,
      "Adjust the split so the weights total 100%.",
    );
  }

  const defaults: string[] = [];
  const drift =
    text.match(/drift[^\d]{0,24}(\d+(?:\.\d+)?)/i)?.[1] ??
    text.match(/(\d+(?:\.\d+)?)\s*(?:pp|%|percentage[- ]points?)[^.]{0,24}drift/i)?.[1] ??
    text.match(/(?:exceeds?|more than|over|beyond|off by)\s*(\d+(?:\.\d+)?)\s*%?/i)?.[1];
  let driftPct = drift ? Number(drift) : 5;
  if (!drift) defaults.push("drift threshold of 5 percentage points (not stated)");

  return {
    ok: true,
    rule: { kind: "rebalance", targets, driftPct },
    name: `Rebalance ${Object.keys(targets).join("/")}`,
    defaults,
  };
}

function parseThreshold(text: string): ParseResult {
  const dropWords = /\b(drops?|falls?|fell|dips?|declines?|crashes?|loses?|down)\b/i;
  const riseWords = /\b(rises?|gains?|jumps?|climbs?|pumps?|rallies|up)\b/i;
  const isDrop = dropWords.test(text);
  const direction: "drop" | "rise" = isDrop ? "drop" : "rise";

  const watched = text.match(
    new RegExp(`(?:if|when|should)\\s+(${ASSET_ALT})\\b`, "i"),
  )?.[1];
  if (!watched) {
    return fail(
      "could not find which asset to watch",
      'Name it after "if" or "when", e.g. "if STX drops 10% in a day, buy 200 STX with sUSD".',
    );
  }

  const changeMatch =
    text.match(new RegExp(`${direction === "drop" ? dropWords.source : riseWords.source}[^\\d]{0,16}(\\d+(?:\\.\\d+)?)\\s*%`, "i")) ??
    text.match(/\b(\d+(?:\.\d+)?)\s*%/);
  if (!changeMatch) {
    return fail(
      "could not find the percentage move that should trigger it",
      'Include the move, e.g. "if STX drops 10% in a day...".',
    );
  }
  const changePct = Number(changeMatch[changeMatch.length - 1]);

  // The action clause: "buy/move/swap <amount> <ASSET> into <ASSET>"
  const actionText = text.slice(text.search(/\b(buy|move|swap|rotate|convert|sell|put)\b/i));
  const spend = parseAmountAsset(actionText || text);
  if (!spend) {
    return fail(
      "could not find how much to trade when it triggers",
      'Say what to do, e.g. "...then move 200 sUSD into STX".',
    );
  }
  const destRaw = actionText.match(new RegExp(`(?:into|to|for)\\s+(${ASSET_ALT})\\b`, "i"))?.[1];
  const to = destRaw
    ? asset(destRaw)
    : SYMBOLS.find((s) => s !== spend.symbol && new RegExp(`\\b${s}\\b`, "i").test(actionText));
  if (!to || to === spend.symbol) {
    return fail(
      "could not find which asset to buy when it triggers",
      `Name the destination, e.g. "...move ${spend.amount} ${spend.symbol} into ${watched.toUpperCase() === spend.symbol.toUpperCase() ? "sBTC" : asset(watched)}".`,
    );
  }

  const defaults: string[] = [];
  const cooldown = parseInterval(text.replace(/\bin\s+a\s+day\b/i, ""));
  const cooldownHours = cooldown ?? 24;
  if (cooldown === null) defaults.push("cooldown of 24 hours between firings (not stated)");

  return {
    ok: true,
    rule: {
      kind: "threshold",
      asset: asset(watched),
      direction,
      changePct,
      from: spend.symbol,
      to,
      amount: spend.amount,
      cooldownHours,
    },
    name: `${asset(watched)} ${direction} ${changePct}%`,
    defaults,
  };
}

/**
 * Parse one sentence into a strategy rule. Returns an actionable failure rather
 * than guessing when the sentence is ambiguous — guessing here would silently
 * change what happens to someone's money.
 */
export function parseStrategy(text: string): ParseResult {
  const t = text.trim();
  if (!t) return fail("empty input", 'Describe a strategy, e.g. "DCA 200 STX into sBTC weekly".');

  // Rebalance is checked first: "rebalance ... when drift exceeds 5%" contains
  // both a "when" and a percentage, so a threshold-first order misroutes it.
  if (/\bre-?balance\b|\ballocation\b|\bsplit\b/i.test(t)) return parseRebalance(t);
  if (/\b(if|when|should)\b/i.test(t) && /\d+\s*%/.test(t)) return parseThreshold(t);
  if (/\bdca\b|\bdollar[- ]cost\b|\baccumulate\b|\bbuy\b|\binvest\b|\bevery\b|\bweekly\b|\bdaily\b|\bmonthly\b/i.test(t))
    return parseDca(t);

  return fail(
    "could not tell which kind of strategy this is",
    'Start with "DCA...", "Rebalance...", or "If <asset> drops N%...".',
  );
}
