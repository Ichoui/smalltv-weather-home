import { createHash } from "node:crypto";

export const JOKE_SOURCES = ["blagues-api", "blablagues"] as const;
export type JokeSource = (typeof JOKE_SOURCES)[number];
export type DailyJokeStatus = "ok" | "stale" | "error";

export type JokeCandidate = {
  source: JokeSource;
  sourceId: string;
  text: string;
  category: string;
  attribution: string | null;
  sourceUrl: string | null;
};

export type StoredJoke = JokeCandidate & {
  normalizedText: string;
  contentHash: string;
};

export type DailyJokeState = {
  date: string;
  text: string;
  contentHash: string | null;
  source: JokeSource | null;
  sourceId: string | null;
  category: string | null;
  attribution: string | null;
  sourceUrl: string | null;
  selectedAt: string | null;
  status: DailyJokeStatus;
  errorMessage?: string;
};

const QUOTE_MAP: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201B": "'",
  "\u2032": "'",
  "\u201C": "\"",
  "\u201D": "\"",
  "\u201E": "\"",
  "\u00AB": "\"",
  "\u00BB": "\"",
};

/** Returns a stable comparison representation while keeping question/answer line breaks. */
export function normalizeJokeText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/[\u2018\u2019\u201B\u2032\u201C\u201D\u201E\u00AB\u00BB]/g, (character) => QUOTE_MAP[character] ?? character)
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function contentHashFor(normalizedText: string): string {
  return createHash("sha256").update(normalizedText, "utf8").digest("hex");
}

export function toStoredJoke(candidate: JokeCandidate): StoredJoke | null {
  const normalizedText = normalizeJokeText(candidate.text);
  if (!normalizedText || Array.from(normalizedText).length > 200) return null;
  const sourceId = candidate.sourceId.trim();
  const category = candidate.category.trim();
  if (!sourceId || !category) return null;

  return {
    ...candidate,
    sourceId,
    category,
    text: normalizedText,
    normalizedText,
    contentHash: contentHashFor(normalizedText),
  };
}

export function fallbackDailyJokeState(date: string, errorMessage: string): DailyJokeState {
  return {
    date,
    text: "La vanne du jour est indisponible. Réessayez plus tard.",
    contentHash: null,
    source: null,
    sourceId: null,
    category: null,
    attribution: null,
    sourceUrl: null,
    selectedAt: null,
    status: "error",
    errorMessage,
  };
}
