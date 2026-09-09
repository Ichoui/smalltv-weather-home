import type { JokeCandidate } from "../../domain/daily-joke.js";
import { fetchJsonWithRetries } from "./http.js";

type BlaguesApiResponse = {
  id?: unknown;
  type?: unknown;
  joke?: unknown;
  answer?: unknown;
};

export async function fetchBlaguesApiJoke(token: string): Promise<JokeCandidate | null> {
  const url = new URL("https://www.blagues-api.fr/api/random");
  url.searchParams.append("disallow", "dev");
  const response = await fetchJsonWithRetries(url, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "home-assistant-daily-joke/1.0" },
  }) as BlaguesApiResponse;

  if (typeof response.id !== "number" && typeof response.id !== "string") return null;
  if (typeof response.type !== "string" || response.type === "dev" || typeof response.joke !== "string") return null;
  const answer = typeof response.answer === "string" && response.answer.trim() ? response.answer : null;
  const sourceId = String(response.id);
  return {
    source: "blagues-api",
    sourceId,
    text: answer === null ? response.joke : `${response.joke}\n${answer}`,
    setup: answer === null ? null : response.joke,
    punchline: answer,
    category: response.type,
    attribution: null,
    sourceUrl: `https://www.blagues-api.fr/api/id/${encodeURIComponent(sourceId)}`,
  };
}
