import assert from "node:assert/strict";
import test from "node:test";
import {
  contentHashFor,
  fallbackDailyJokeState,
  normalizeJokeText,
  toStoredJoke,
} from "../lib/domain/daily-joke.js";
import { fetchBlaguesApiJoke } from "../lib/providers/jokes/blagues-api.js";
import { fetchBlablaguesJoke } from "../lib/providers/jokes/blablagues.js";

test("normalisation de texte et hash sont déterministes", () => {
  const normalized = normalizeJokeText("  C’est\u00a0une  vanne…\r\n  \u00abOui\u00bb  ");
  assert.equal(normalized, "C'est une vanne…\n\"Oui\"");
  assert.equal(contentHashFor(normalized), contentHashFor("C'est une vanne…\n\"Oui\""));
  assert.notEqual(toStoredJoke({
    source: "blagues-api", sourceId: "1", text: "x".repeat(200), category: "global", attribution: null, sourceUrl: null,
  }), null);
  assert.equal(toStoredJoke({
    source: "blagues-api", sourceId: "1", text: "x".repeat(201), category: "global", attribution: null, sourceUrl: null,
  }), null);
});

test("Blagues-API exclut uniquement dev et conserve son identifiant", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: new URL(url), init };
    return new Response(JSON.stringify({ id: 42, type: "dark", joke: "Question ?", answer: "Réponse." }));
  };
  try {
    const joke = await fetchBlaguesApiJoke("secret-token");
    assert.equal(request.url.searchParams.get("disallow"), "dev");
    assert.equal(request.init.headers.Authorization, "Bearer secret-token");
    assert.deepEqual(joke, {
      source: "blagues-api", sourceId: "42", text: "Question ?\nRéponse.", category: "dark", attribution: null,
      sourceUrl: "https://www.blagues-api.fr/api/id/42",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Blablagues utilise adu=1, les slugs officiels, et refuse une catégorie exclue", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(url);
    requests.push(requestUrl);
    if (requestUrl.searchParams.has("list_cat")) {
      return new Response(JSON.stringify({ blagues: { "star+wars": {}, "ta+mere": {}, "histoires+droles": {}, belges: {} } }));
    }
    return new Response(JSON.stringify([{
      data: {
        id: "abc", id_rubrique: "blagues", id_categorie: "belges", categorie: "Belges", link: "https://example.test/joke",
        content: { text_head: "Une question", text: "", text_hidden: "Une réponse" },
      },
    }]));
  };
  try {
    const joke = await fetchBlablaguesJoke();
    assert.equal(requests[1].searchParams.get("rub"), "blagues");
    assert.equal(requests[1].searchParams.get("adu"), "1");
    assert.equal(requests[1].searchParams.get("cat_ex"), "star+wars,ta+mere,histoires+droles");
    assert.equal(joke.attribution, "Source : Blablagues.net");
    assert.equal(joke.text, "Une question\nUne réponse");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Blablagues rejette défensivement une histoire retournée malgré les exclusions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(url);
    if (requestUrl.searchParams.has("list_cat")) {
      return new Response(JSON.stringify({ blagues: { "histoires+droles": {} } }));
    }
    return new Response(JSON.stringify([{
      data: {
        id: "story", id_rubrique: "blagues", id_categorie: "histoires+droles", categorie: "Histoires drôles",
        content: { text_head: "Une longue histoire", text: "", text_hidden: "La fin" },
      },
    }]));
  };
  try {
    assert.equal(await fetchBlablaguesJoke(), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("état de secours sans texte humoristique", () => {
  assert.deepEqual(fallbackDailyJokeState("2026-08-25", "Aucune source"), {
    date: "2026-08-25",
    text: "La vanne du jour est indisponible. Réessayez plus tard.",
    contentHash: null,
    source: null,
    sourceId: null,
    category: null,
    attribution: null,
    sourceUrl: null,
    selectedAt: null,
    status: "error",
    errorMessage: "Aucune source",
  });
});
