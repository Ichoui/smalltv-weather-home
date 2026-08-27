import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import {
  fallbackDailyJokeState,
  toStoredJoke,
  type DailyJokeState,
  type JokeCandidate,
  type JokeSource,
  type StoredJoke,
} from "../domain/daily-joke.js";
import { fetchBlaguesApiJoke } from "../providers/jokes/blagues-api.js";
import { fetchBlablaguesJoke } from "../providers/jokes/blablagues.js";

const CONTENT_COLLECTION = "jokeContent";
const SOURCE_ID_COLLECTION = "jokeSourceIds";
const DAILY_COLLECTION = "dailyJokes";
const STATE_DOCUMENT = "jokeState/current";
const MAX_CANDIDATES_PER_SOURCE = 10;

type SourceFetcher = () => Promise<JokeCandidate | null>;
type StoreResult = "stored" | "already-selected" | "duplicate";

function sourceIdentityId(source: JokeSource, sourceId: string): string {
  // Firestore document IDs cannot contain a slash, while source IDs may come from providers.
  return Buffer.from(`${source}:${sourceId}`, "utf8").toString("base64url");
}

function readState(value: unknown): DailyJokeState | null {
  if (typeof value !== "object" || value === null) return null;
  const state = value as Partial<DailyJokeState>;
  if (typeof state.date !== "string" || typeof state.text !== "string") return null;
  if (state.status !== "ok" && state.status !== "stale" && state.status !== "error") return null;
  return {
    date: state.date,
    text: state.text,
    contentHash: typeof state.contentHash === "string" ? state.contentHash : null,
    source: state.source === "blagues-api" || state.source === "blablagues" ? state.source : null,
    sourceId: typeof state.sourceId === "string" ? state.sourceId : null,
    category: typeof state.category === "string" ? state.category : null,
    attribution: typeof state.attribution === "string" ? state.attribution : null,
    sourceUrl: typeof state.sourceUrl === "string" ? state.sourceUrl : null,
    selectedAt: typeof state.selectedAt === "string" ? state.selectedAt : null,
    status: state.status,
    ...(typeof state.errorMessage === "string" ? { errorMessage: state.errorMessage } : {}),
  };
}

function stateFromStoredJoke(date: string, joke: StoredJoke, selectedAt: string): DailyJokeState {
  return {
    date,
    text: joke.text,
    contentHash: joke.contentHash,
    source: joke.source,
    sourceId: joke.sourceId,
    category: joke.category,
    attribution: joke.attribution,
    sourceUrl: joke.sourceUrl,
    selectedAt,
    status: "ok",
  };
}

async function existingDailyJoke(date: string): Promise<DailyJokeState | null> {
  const snapshot = await getFirestore().collection(DAILY_COLLECTION).doc(date).get();
  const state = snapshot.exists ? readState(snapshot.data()) : null;
  return state?.status === "ok" ? state : null;
}

async function storeJokeForDate(date: string, joke: StoredJoke): Promise<StoreResult> {
  const firestore = getFirestore();
  const dailyReference = firestore.collection(DAILY_COLLECTION).doc(date);
  const contentReference = firestore.collection(CONTENT_COLLECTION).doc(joke.contentHash);
  const sourceReference = firestore.collection(SOURCE_ID_COLLECTION).doc(sourceIdentityId(joke.source, joke.sourceId));
  const stateReference = firestore.doc(STATE_DOCUMENT);
  const selectedAt = new Date().toISOString();
  const state = stateFromStoredJoke(date, joke, selectedAt);

  return firestore.runTransaction(async (transaction) => {
    const [dailySnapshot, contentSnapshot, sourceSnapshot, currentSnapshot] = await Promise.all([
      transaction.get(dailyReference),
      transaction.get(contentReference),
      transaction.get(sourceReference),
      transaction.get(stateReference),
    ]);
    // The current state is read in the same transaction as the canonical registries.
    // It is overwritten atomically below only after all duplicate checks have passed.
    void currentSnapshot;
    const daily = dailySnapshot.exists ? readState(dailySnapshot.data()) : null;
    if (daily?.status === "ok") return "already-selected";
    if (contentSnapshot.exists || sourceSnapshot.exists) return "duplicate";

    transaction.create(contentReference, {
      text: joke.text,
      normalizedText: joke.normalizedText,
      contentHash: joke.contentHash,
      source: joke.source,
      sourceId: joke.sourceId,
      category: joke.category,
      attribution: joke.attribution,
      sourceUrl: joke.sourceUrl,
      firstSeenAt: selectedAt,
      servedAt: selectedAt,
      servedDate: date,
    });
    transaction.create(sourceReference, {
      source: joke.source,
      sourceId: joke.sourceId,
      contentHash: joke.contentHash,
      servedAt: selectedAt,
      servedDate: date,
    });
    transaction.create(dailyReference, state);
    transaction.set(stateReference, state);
    return "stored";
  });
}

async function markSelectionFailure(date: string, errorMessage: string): Promise<DailyJokeState> {
  const firestore = getFirestore();
  const dailyReference = firestore.collection(DAILY_COLLECTION).doc(date);
  const stateReference = firestore.doc(STATE_DOCUMENT);
  return firestore.runTransaction(async (transaction) => {
    const [dailySnapshot, currentSnapshot] = await Promise.all([
      transaction.get(dailyReference),
      transaction.get(stateReference),
    ]);
    const daily = dailySnapshot.exists ? readState(dailySnapshot.data()) : null;
    if (daily?.status === "ok") return daily;

    const current = currentSnapshot.exists ? readState(currentSnapshot.data()) : null;
    const next = current?.source && current.text
      ? { ...current, status: "stale" as const, errorMessage }
      : fallbackDailyJokeState(date, errorMessage);
    transaction.set(stateReference, next);
    return next;
  });
}

function fetcherFor(source: JokeSource, blaguesApiToken: string): SourceFetcher {
  return source === "blagues-api"
    ? () => fetchBlaguesApiJoke(blaguesApiToken)
    : fetchBlablaguesJoke;
}

function sourceOrder(random: () => number): [JokeSource, JokeSource] {
  return random() < 0.5 ? ["blagues-api", "blablagues"] : ["blablagues", "blagues-api"];
}

export async function selectDailyJoke(
  date: string,
  blaguesApiToken: string,
  random: () => number = Math.random,
): Promise<DailyJokeState> {
  const existing = await existingDailyJoke(date);
  if (existing) {
    logger.info("Daily joke already selected", { date });
    return existing;
  }

  for (const source of sourceOrder(random)) {
    const fetchCandidate = fetcherFor(source, blaguesApiToken);
    for (let attempt = 1; attempt <= MAX_CANDIDATES_PER_SOURCE; attempt += 1) {
      let candidate: JokeCandidate | null;
      try {
        candidate = await fetchCandidate();
      } catch {
        logger.warn("Daily joke source request failed", { date, source, attempt });
        break;
      }
      const joke = candidate ? toStoredJoke(candidate) : null;
      if (!joke) {
        logger.warn("Daily joke candidate rejected", { date, source, attempt });
        continue;
      }

      const stored = await storeJokeForDate(date, joke);
      if (stored === "stored") {
        logger.info("Daily joke selected", { date, source, category: joke.category });
        return getDailyJokeState(date);
      }
      if (stored === "already-selected") {
        const selected = await existingDailyJoke(date);
        if (selected) return selected;
      }
      logger.info("Daily joke duplicate rejected", { date, source, attempt, reason: stored });
    }
    logger.warn("Daily joke source exhausted; trying fallback", { date, source });
  }

  logger.error("No new daily joke available", { date });
  return markSelectionFailure(date, "Aucune vanne inédite n'est disponible pour le moment.");
}

export async function getDailyJokeState(date: string): Promise<DailyJokeState> {
  const snapshot = await getFirestore().doc(STATE_DOCUMENT).get();
  return snapshot.exists
    ? readState(snapshot.data()) ?? fallbackDailyJokeState(date, "État de vanne invalide.")
    : fallbackDailyJokeState(date, "Aucune vanne n'a encore été sélectionnée.");
}
