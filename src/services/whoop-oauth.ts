import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { randomBytes, randomUUID } from "node:crypto";
import type { WellnessAccountId } from "./daily-wellness.js";
import {
  createWhoopAuthorizationUrl,
  exchangeWhoopAuthorizationCode,
  refreshWhoopToken,
  type WhoopOAuthCredentials,
} from "../whoop/client.js";

type WhoopAccountDocument = {
  accountId: WellnessAccountId;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  connectedAt: string;
  updatedAt: string;
  tokenVersion: number;
  refreshLeaseId?: string;
  refreshLeaseExpiresAt?: string;
};

const ACCOUNTS_COLLECTION = "whoopAccounts";
const STATES_COLLECTION = "whoopOAuthStates";
const EXPIRY_MARGIN_MS = 60_000;
const LEASE_MS = 30_000;
const LEASE_WAIT_ATTEMPTS = 5;
const LEASE_WAIT_MS = 250;

export class WhoopAccountNotConnectedError extends Error {}

function parseAccount(value: unknown): WhoopAccountDocument | null {
  if (typeof value !== "object" || value === null) return null;
  const document = value as Partial<WhoopAccountDocument>;
  if (
    (document.accountId !== "me" && document.accountId !== "partner") ||
    typeof document.accessToken !== "string" ||
    typeof document.refreshToken !== "string" ||
    typeof document.expiresAt !== "string" ||
    typeof document.connectedAt !== "string" ||
    typeof document.updatedAt !== "string"
  ) return null;
  return {
    accountId: document.accountId,
    accessToken: document.accessToken,
    refreshToken: document.refreshToken,
    expiresAt: document.expiresAt,
    connectedAt: document.connectedAt,
    updatedAt: document.updatedAt,
    tokenVersion: typeof document.tokenVersion === "number" ? document.tokenVersion : 0,
    refreshLeaseId: document.refreshLeaseId,
    refreshLeaseExpiresAt: document.refreshLeaseExpiresAt,
  };
}

function isFresh(document: WhoopAccountDocument, now = Date.now()): boolean {
  const expiry = Date.parse(document.expiresAt);
  return Number.isFinite(expiry) && expiry > now + EXPIRY_MARGIN_MS;
}

function isLeaseActive(document: WhoopAccountDocument, now = Date.now()): boolean {
  return typeof document.refreshLeaseExpiresAt === "string" && Date.parse(document.refreshLeaseExpiresAt) > now;
}

function accountReference(accountId: WellnessAccountId) {
  return getFirestore().collection(ACCOUNTS_COLLECTION).doc(accountId);
}

function waitForLease(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, LEASE_WAIT_MS));
}

export async function createWhoopAuthorization(
  accountId: WellnessAccountId,
  clientId: string,
  redirectUri: string,
): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  const now = new Date();
  await getFirestore().collection(STATES_COLLECTION).doc(state).set({
    accountId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
  });
  return createWhoopAuthorizationUrl(clientId, redirectUri, state);
}

async function consumeWhoopState(state: string): Promise<WellnessAccountId | null> {
  const reference = getFirestore().collection(STATES_COLLECTION).doc(state);
  return getFirestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() as { accountId?: unknown; expiresAt?: unknown } | undefined;
    transaction.delete(reference);
    if (
      !data ||
      (data.accountId !== "me" && data.accountId !== "partner") ||
      typeof data.expiresAt !== "string" ||
      Date.parse(data.expiresAt) <= Date.now()
    ) return null;
    return data.accountId;
  });
}

export async function completeWhoopAuthorization(
  code: string,
  state: string,
  credentials: WhoopOAuthCredentials,
): Promise<WellnessAccountId | null> {
  const accountId = await consumeWhoopState(state);
  if (!accountId) return null;

  const tokens = await exchangeWhoopAuthorizationCode(code, credentials);
  const reference = accountReference(accountId);
  await getFirestore().runTransaction(async (transaction) => {
    const current = (await transaction.get(reference)).data();
    const account = parseAccount(current);
    const now = new Date().toISOString();
    transaction.set(reference, {
      accountId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      connectedAt: account?.connectedAt ?? now,
      updatedAt: now,
      tokenVersion: (account?.tokenVersion ?? 0) + 1,
      refreshLeaseId: FieldValue.delete(),
      refreshLeaseExpiresAt: FieldValue.delete(),
    }, { merge: true });
  });
  return accountId;
}

type AcquireResult =
  | { kind: "fresh"; accessToken: string }
  | { kind: "busy" }
  | { kind: "acquired"; leaseId: string; refreshToken: string; tokenVersion: number };

async function acquireRefreshLease(
  accountId: WellnessAccountId,
  forceRefreshForToken?: string,
): Promise<AcquireResult> {
  const reference = accountReference(accountId);
  return getFirestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const account = snapshot.exists ? parseAccount(snapshot.data()) : null;
    if (!account) throw new WhoopAccountNotConnectedError();
    if (isFresh(account) && (!forceRefreshForToken || account.accessToken !== forceRefreshForToken)) {
      return { kind: "fresh", accessToken: account.accessToken };
    }
    if (isLeaseActive(account)) return { kind: "busy" };

    const leaseId = randomUUID();
    transaction.update(reference, {
      refreshLeaseId: leaseId,
      refreshLeaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
    });
    return { kind: "acquired", leaseId, refreshToken: account.refreshToken, tokenVersion: account.tokenVersion };
  });
}

async function releaseLease(accountId: WellnessAccountId, leaseId: string): Promise<void> {
  const reference = accountReference(accountId);
  await getFirestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const account = snapshot.exists ? parseAccount(snapshot.data()) : null;
    if (account?.refreshLeaseId === leaseId) {
      transaction.update(reference, {
        refreshLeaseId: FieldValue.delete(),
        refreshLeaseExpiresAt: FieldValue.delete(),
      });
    }
  });
}

async function commitRefresh(
  accountId: WellnessAccountId,
  leaseId: string,
  tokenVersion: number,
  tokens: Awaited<ReturnType<typeof refreshWhoopToken>>,
): Promise<boolean> {
  const reference = accountReference(accountId);
  return getFirestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const account = snapshot.exists ? parseAccount(snapshot.data()) : null;
    if (!account || account.refreshLeaseId !== leaseId || account.tokenVersion !== tokenVersion) return false;
    transaction.update(reference, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      updatedAt: new Date().toISOString(),
      tokenVersion: tokenVersion + 1,
      refreshLeaseId: FieldValue.delete(),
      refreshLeaseExpiresAt: FieldValue.delete(),
    });
    return true;
  });
}

export async function getWhoopAccessToken(
  accountId: WellnessAccountId,
  credentials: WhoopOAuthCredentials,
  forceRefreshForToken?: string,
): Promise<string> {
  for (let attempt = 0; attempt < LEASE_WAIT_ATTEMPTS; attempt += 1) {
    const acquisition = await acquireRefreshLease(accountId, forceRefreshForToken);
    if (acquisition.kind === "fresh") return acquisition.accessToken;
    if (acquisition.kind === "busy") {
      await waitForLease();
      continue;
    }

    try {
      const tokens = await refreshWhoopToken(acquisition.refreshToken, credentials);
      if (await commitRefresh(accountId, acquisition.leaseId, acquisition.tokenVersion, tokens)) return tokens.accessToken;
    } catch (error) {
      await releaseLease(accountId, acquisition.leaseId);
      throw error;
    }
  }
  throw new Error("WHOOP token refresh is busy");
}
