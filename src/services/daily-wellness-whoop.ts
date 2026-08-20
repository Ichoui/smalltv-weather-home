import { getFirestore } from "firebase-admin/firestore";
import {
  currentDateInTimeZone,
  type DailyWellnessAccountResponse,
  type WellnessAccountId,
  type WellnessStatus,
  WELLNESS_ACCOUNTS,
} from "./daily-wellness.js";
import { getWhoopAccessToken, WhoopAccountNotConnectedError } from "./whoop-oauth.js";
import {
  fetchWhoopRecovery,
  fetchWhoopSleeps,
  type WhoopApiError,
  type WhoopOAuthCredentials,
  type WhoopRecovery,
  type WhoopSleep,
} from "../whoop/client.js";
import type { IntervalsWellness } from "../intervals/client.js";

type WhoopCacheDocument = {
  accountId: WellnessAccountId;
  date: string;
  status: WellnessStatus;
  wellness?: IntervalsWellness;
  sourceUpdatedAt?: string | null;
  fetchedAt?: string;
  expiresAt?: string;
  generation: number;
  invalidatedAt?: string;
};

type WhoopWellnessResult =
  | { kind: "available"; wellness: IntervalsWellness; sourceUpdatedAt: string | null }
  | { kind: "pending" }
  | { kind: "missing" }
  | { kind: "error" };

const CACHE_COLLECTION = "wellnessWhoopCache";
const CACHE_TTL_MS: Record<Exclude<WellnessStatus, "invalidated">, number> = {
  available: 60 * 60 * 1_000,
  pending: 5 * 60 * 1_000,
  missing: 5 * 60 * 1_000,
  error: 2 * 60 * 1_000,
};

function cacheDocumentId(date: string, accountId: WellnessAccountId): string {
  return `${date}__${accountId}`;
}

function isWellnessStatus(value: unknown): value is WellnessStatus {
  return value === "available" || value === "pending" || value === "missing" || value === "error" || value === "invalidated";
}

function parseCache(value: unknown): WhoopCacheDocument | null {
  if (typeof value !== "object" || value === null) return null;
  const cache = value as Partial<WhoopCacheDocument>;
  if ((cache.accountId !== "me" && cache.accountId !== "partner") || typeof cache.date !== "string" || !isWellnessStatus(cache.status)) return null;
  return {
    accountId: cache.accountId,
    date: cache.date,
    status: cache.status,
    wellness: cache.wellness,
    sourceUpdatedAt: cache.sourceUpdatedAt ?? null,
    fetchedAt: cache.fetchedAt,
    expiresAt: cache.expiresAt,
    generation: typeof cache.generation === "number" ? cache.generation : 0,
    invalidatedAt: cache.invalidatedAt,
  };
}

function isCacheValid(cache: WhoopCacheDocument | null, now: Date): boolean {
  return cache !== null && cache.status !== "invalidated" && typeof cache.expiresAt === "string" && Date.parse(cache.expiresAt) > now.getTime();
}

function asResponse(cache: WhoopCacheDocument | null, hit: boolean, stale: boolean): DailyWellnessAccountResponse {
  if (!cache) {
    return {
      status: "error",
      cache: { hit, stale, fetchedAt: null, expiresAt: null },
      sourceUpdatedAt: null,
      wellness: null,
    };
  }
  return {
    status: cache.status,
    cache: { hit, stale, fetchedAt: cache.fetchedAt ?? null, expiresAt: cache.expiresAt ?? null },
    sourceUpdatedAt: cache.sourceUpdatedAt ?? null,
    wellness: cache.status === "available" && cache.wellness ? cache.wellness : null,
  };
}

function nextExpiry(status: Exclude<WellnessStatus, "invalidated">, now: Date): string {
  return new Date(now.getTime() + CACHE_TTL_MS[status]).toISOString();
}

function dateOfTimestamp(value: string, timeZone: string): string | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? currentDateInTimeZone(date, timeZone) : null;
}

function selectMainSleep(sleeps: WhoopSleep[], date: string, timeZone: string): WhoopSleep | null {
  return sleeps.find((sleep) => !sleep.nap && dateOfTimestamp(sleep.end, timeZone) === date) ?? null;
}

function latestUpdatedAt(sleep: WhoopSleep, recovery: WhoopRecovery): string | null {
  const dates = [sleep.updated_at, recovery.updated_at]
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
  if (dates.length === 0) return null;
  return dates.reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest);
}

function sleepSeconds(sleep: WhoopSleep): number | null {
  const stages = sleep.score?.stage_summary;
  const values = [
    stages?.total_light_sleep_time_milli,
    stages?.total_slow_wave_sleep_time_milli,
    stages?.total_rem_sleep_time_milli,
  ];
  return values.every((value) => typeof value === "number")
    ? values.reduce((total, value) => total + value, 0) / 1_000
    : null;
}

function mapWhoopWellness(date: string, sleep: WhoopSleep, recovery: WhoopRecovery): { wellness: IntervalsWellness; sourceUpdatedAt: string | null } {
  const sourceUpdatedAt = latestUpdatedAt(sleep, recovery);
  return {
    sourceUpdatedAt,
    wellness: {
      id: date,
      updated: sourceUpdatedAt,
      sleepSecs: sleepSeconds(sleep),
      sleepScore: sleep.score?.sleep_performance_percentage ?? null,
      restingHR: recovery.score?.resting_heart_rate ?? null,
      hrv: recovery.score?.hrv_rmssd_milli ?? null,
      readiness: recovery.score?.recovery_score ?? null,
      respiration: sleep.score?.respiratory_rate ?? null,
      spO2: recovery.score?.spo2_percentage ?? null,
    },
  };
}

async function withWhoopToken<T>(
  accountId: WellnessAccountId,
  credentials: WhoopOAuthCredentials,
  operation: (accessToken: string) => Promise<T>,
): Promise<T> {
  const accessToken = await getWhoopAccessToken(accountId, credentials);
  try {
    return await operation(accessToken);
  } catch (error) {
    if ((error as WhoopApiError).kind !== "unauthorized") throw error;
    return operation(await getWhoopAccessToken(accountId, credentials, accessToken));
  }
}

async function fetchWhoopWellness(
  accountId: WellnessAccountId,
  date: string,
  timeZone: string,
  credentials: WhoopOAuthCredentials,
): Promise<WhoopWellnessResult> {
  try {
    const sleeps = await withWhoopToken(accountId, credentials, fetchWhoopSleeps);
    const sleep = selectMainSleep(sleeps, date, timeZone);
    if (!sleep || sleep.score_state === "UNSCORABLE") return { kind: "missing" };
    if (sleep.score_state !== "SCORED" || !sleep.score) return { kind: "pending" };

    const recovery = await withWhoopToken(accountId, credentials, (accessToken) => fetchWhoopRecovery(accessToken, sleep.cycle_id));
    if (!recovery || recovery.score_state === "PENDING_SCORE") return { kind: "pending" };
    if (recovery.score_state === "UNSCORABLE") return { kind: "missing" };
    if (recovery.score_state !== "SCORED" || !recovery.score) return { kind: "pending" };

    return { kind: "available", ...mapWhoopWellness(date, sleep, recovery) };
  } catch (error) {
    if (error instanceof WhoopAccountNotConnectedError) return { kind: "error" };
    return { kind: "error" };
  }
}

function documentFromResult(
  result: WhoopWellnessResult,
  accountId: WellnessAccountId,
  date: string,
  generation: number,
  now: Date,
  staleCache: WhoopCacheDocument | null,
): { document: WhoopCacheDocument; stale: boolean } {
  if (result.kind === "available") {
    return {
      document: {
        accountId, date, status: "available", wellness: result.wellness, sourceUpdatedAt: result.sourceUpdatedAt,
        fetchedAt: now.toISOString(), expiresAt: nextExpiry("available", now), generation,
      },
      stale: false,
    };
  }
  if (result.kind === "pending" || result.kind === "missing") {
    return {
      document: {
        accountId, date, status: result.kind, sourceUpdatedAt: null,
        fetchedAt: now.toISOString(), expiresAt: nextExpiry(result.kind, now), generation,
      },
      stale: false,
    };
  }
  if (staleCache?.status === "available" && staleCache.wellness) {
    return {
      document: { ...staleCache, expiresAt: nextExpiry("error", now), generation },
      stale: true,
    };
  }
  return {
    document: {
      accountId, date, status: "error", sourceUpdatedAt: null,
      fetchedAt: now.toISOString(), expiresAt: nextExpiry("error", now), generation,
    },
    stale: false,
  };
}

async function loadCache(date: string, accountId: WellnessAccountId): Promise<WhoopCacheDocument | null> {
  const snapshot = await getFirestore().collection(CACHE_COLLECTION).doc(cacheDocumentId(date, accountId)).get();
  return snapshot.exists ? parseCache(snapshot.data()) : null;
}

async function refreshAccount(
  accountId: WellnessAccountId,
  date: string,
  timeZone: string,
  credentials: WhoopOAuthCredentials,
): Promise<DailyWellnessAccountResponse> {
  let cache = await loadCache(date, accountId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (isCacheValid(cache, new Date())) return asResponse(cache, true, false);
    const expectedGeneration = cache?.generation ?? 0;
    const result = await fetchWhoopWellness(accountId, date, timeZone, credentials);
    const next = documentFromResult(result, accountId, date, expectedGeneration, new Date(), cache);
    const reference = getFirestore().collection(CACHE_COLLECTION).doc(cacheDocumentId(date, accountId));
    const wrote = await getFirestore().runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const current = snapshot.exists ? parseCache(snapshot.data()) : null;
      if ((current?.generation ?? 0) !== expectedGeneration) return false;
      transaction.set(reference, next.document);
      return true;
    });
    if (wrote) return asResponse(next.document, false, next.stale);
    cache = await loadCache(date, accountId);
  }
  return asResponse(cache, false, false);
}

export async function getDailyWellnessWhoop(
  date: string,
  timeZone: string,
  credentials: WhoopOAuthCredentials,
): Promise<Record<WellnessAccountId, DailyWellnessAccountResponse>> {
  const results = await Promise.all(WELLNESS_ACCOUNTS.map(async (accountId) => [
    accountId,
    await refreshAccount(accountId, date, timeZone, credentials),
  ] as const));
  return Object.fromEntries(results) as Record<WellnessAccountId, DailyWellnessAccountResponse>;
}

export async function resetDailyWellnessWhoop(date: string, accountId: WellnessAccountId): Promise<void> {
  const reference = getFirestore().collection(CACHE_COLLECTION).doc(cacheDocumentId(date, accountId));
  await getFirestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const current = snapshot.exists ? parseCache(snapshot.data()) : null;
    transaction.set(reference, {
      accountId,
      date,
      status: "invalidated",
      generation: (current?.generation ?? 0) + 1,
      invalidatedAt: new Date().toISOString(),
    });
  });
}
