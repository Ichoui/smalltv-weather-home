export type WhoopOAuthCredentials = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type WhoopTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
};

export type WhoopSleep = {
  id: string;
  cycle_id: number;
  updated_at?: string;
  end: string;
  nap: boolean;
  score_state: "SCORED" | "PENDING_SCORE" | "UNSCORABLE" | string;
  score?: {
    stage_summary?: {
      total_light_sleep_time_milli?: number | null;
      total_slow_wave_sleep_time_milli?: number | null;
      total_rem_sleep_time_milli?: number | null;
    };
    sleep_performance_percentage?: number | null;
    respiratory_rate?: number | null;
  };
};

export type WhoopRecovery = {
  cycle_id: number;
  updated_at?: string;
  score_state: "SCORED" | "PENDING_SCORE" | "UNSCORABLE" | string;
  score?: {
    resting_heart_rate?: number | null;
    hrv_rmssd_milli?: number | null;
    recovery_score?: number | null;
    spo2_percentage?: number | null;
  };
};

export class WhoopApiError extends Error {
  constructor(readonly kind: "unauthorized" | "rate_limited" | "not_found" | "request") {
    super(kind);
  }
}

const WHOOP_ORIGIN = "https://api.prod.whoop.com";
const REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseSleep(value: unknown): WhoopSleep | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.cycle_id !== "number" || typeof value.end !== "string" || typeof value.nap !== "boolean" || typeof value.score_state !== "string") {
    return null;
  }
  const score = isRecord(value.score) ? value.score : undefined;
  const stages = score && isRecord(score.stage_summary) ? score.stage_summary : undefined;
  return {
    id: value.id,
    cycle_id: value.cycle_id,
    updated_at: stringOrUndefined(value.updated_at),
    end: value.end,
    nap: value.nap,
    score_state: value.score_state,
    score: score ? {
      stage_summary: stages ? {
        total_light_sleep_time_milli: numberOrNull(stages.total_light_sleep_time_milli),
        total_slow_wave_sleep_time_milli: numberOrNull(stages.total_slow_wave_sleep_time_milli),
        total_rem_sleep_time_milli: numberOrNull(stages.total_rem_sleep_time_milli),
      } : undefined,
      sleep_performance_percentage: numberOrNull(score.sleep_performance_percentage),
      respiratory_rate: numberOrNull(score.respiratory_rate),
    } : undefined,
  };
}

function parseRecovery(value: unknown): WhoopRecovery | null {
  if (!isRecord(value) || typeof value.cycle_id !== "number" || typeof value.score_state !== "string") return null;
  const score = isRecord(value.score) ? value.score : undefined;
  return {
    cycle_id: value.cycle_id,
    updated_at: stringOrUndefined(value.updated_at),
    score_state: value.score_state,
    score: score ? {
      resting_heart_rate: numberOrNull(score.resting_heart_rate),
      hrv_rmssd_milli: numberOrNull(score.hrv_rmssd_milli),
      recovery_score: numberOrNull(score.recovery_score),
      spo2_percentage: numberOrNull(score.spo2_percentage),
    } : undefined,
  };
}

async function requestJson(url: URL, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new WhoopApiError("request");
  }

  if (response.status === 401) throw new WhoopApiError("unauthorized");
  if (response.status === 404) throw new WhoopApiError("not_found");
  if (response.status === 429) throw new WhoopApiError("rate_limited");
  if (!response.ok) throw new WhoopApiError("request");

  try {
    return await response.json();
  } catch {
    throw new WhoopApiError("request");
  }
}

function parseTokenSet(value: unknown): WhoopTokenSet {
  if (!isRecord(value) || typeof value.access_token !== "string" || typeof value.refresh_token !== "string" || !Number.isFinite(value.expires_in)) {
    throw new WhoopApiError("request");
  }
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresAt: new Date(Date.now() + Number(value.expires_in) * 1_000).toISOString(),
  };
}

async function requestToken(body: URLSearchParams): Promise<WhoopTokenSet> {
  const value = await requestJson(new URL("/oauth/oauth2/token", WHOOP_ORIGIN), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  return parseTokenSet(value);
}

export async function exchangeWhoopAuthorizationCode(
  code: string,
  credentials: WhoopOAuthCredentials,
): Promise<WhoopTokenSet> {
  return requestToken(new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    redirect_uri: credentials.redirectUri,
  }));
}

export async function refreshWhoopToken(
  refreshToken: string,
  credentials: WhoopOAuthCredentials,
): Promise<WhoopTokenSet> {
  return requestToken(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    scope: "offline",
  }));
}

export async function fetchWhoopSleeps(accessToken: string): Promise<WhoopSleep[]> {
  const url = new URL("/developer/v2/activity/sleep", WHOOP_ORIGIN);
  url.searchParams.set("limit", "25");
  const body = await requestJson(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  if (!isRecord(body) || !Array.isArray(body.records)) throw new WhoopApiError("request");
  return body.records.map(parseSleep).filter((sleep): sleep is WhoopSleep => sleep !== null);
}

export async function fetchWhoopRecovery(accessToken: string, cycleId: number): Promise<WhoopRecovery | null> {
  try {
    const body = await requestJson(
      new URL(`/developer/v2/cycle/${encodeURIComponent(String(cycleId))}/recovery`, WHOOP_ORIGIN),
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
    );
    const recovery = parseRecovery(body);
    if (!recovery) throw new WhoopApiError("request");
    return recovery;
  } catch (error) {
    if (error instanceof WhoopApiError && error.kind === "not_found") return null;
    throw error;
  }
}

export function createWhoopAuthorizationUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL("/oauth/oauth2/auth", WHOOP_ORIGIN);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "read:sleep read:recovery offline");
  url.searchParams.set("state", state);
  return url.toString();
}
