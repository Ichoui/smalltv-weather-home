export async function fetchJsonWithRetries(
  url: URL,
  init: RequestInit,
  attempts = 3,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`Joke provider request failed (${response.status}) for ${url.origin}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Joke provider request failed");
}
