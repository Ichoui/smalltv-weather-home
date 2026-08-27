import { contentHashFor, normalizeJokeText, type JokeCandidate } from "../../domain/daily-joke.js";
import { fetchJsonWithRetries } from "./http.js";

const REQUESTED_EXCLUSIONS = [
  "star+wars", "monsieur+et+madame", "melon+et+meleche", "toto", "lada",
  "devinettes", "chfyhfyf", "carambar", "amour", "histoires+droles",
] as const;

type BlablaguesCatalog = { blagues?: Record<string, unknown> };
type BlablaguesItem = {
  data?: {
    id?: unknown;
    id_rubrique?: unknown;
    id_categorie?: unknown;
    categorie?: unknown;
    link?: unknown;
    content?: { text_head?: unknown; text?: unknown; text_hidden?: unknown };
  };
};

function isExcludedCategory(categoryId: string): boolean {
  return REQUESTED_EXCLUSIONS.includes(categoryId as (typeof REQUESTED_EXCLUSIONS)[number]);
}

export async function fetchBlablaguesExcludedCategories(): Promise<string[]> {
  const response = await fetchJsonWithRetries(new URL("https://api.blablagues.net/?list_cat"), {
    headers: { "User-Agent": "home-assistant-daily-joke/1.0" },
  }) as BlablaguesCatalog;
  const available = new Set(Object.keys(response.blagues ?? {}));
  return REQUESTED_EXCLUSIONS.filter((category) => available.has(category));
}

export async function fetchBlablaguesJoke(): Promise<JokeCandidate | null> {
  const excludedCategories = await fetchBlablaguesExcludedCategories();
  const url = new URL("https://api.blablagues.net/");
  url.searchParams.set("rub", "blagues");
  url.searchParams.set("adu", "1");
  url.searchParams.set("cat_ex", excludedCategories.join(","));
  const response = await fetchJsonWithRetries(url, {
    headers: { "User-Agent": "home-assistant-daily-joke/1.0" },
  });
  const item = Array.isArray(response) ? response[0] as BlablaguesItem : response as BlablaguesItem;
  const data = item?.data;
  const content = data?.content;
  if (data?.id_rubrique !== "blagues" || typeof data.id_categorie !== "string" || isExcludedCategory(data.id_categorie)) return null;
  if (typeof data.categorie !== "string") return null;

  const lines = [content?.text_head, content?.text, content?.text_hidden]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  const text = lines.join("\n");
  if (!text) return null;
  const normalizedText = normalizeJokeText(text);
  const sourceId = typeof data.id === "string" || typeof data.id === "number"
    ? String(data.id)
    : `content:${contentHashFor(normalizedText)}`;
  return {
    source: "blablagues",
    sourceId,
    text,
    category: data.categorie,
    attribution: "Source : Blablagues.net",
    sourceUrl: typeof data.link === "string" ? data.link : null,
  };
}
