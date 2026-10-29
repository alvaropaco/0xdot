import { z } from "zod";

/** Attribution is restricted to OpenRouter inference endpoints, never compatible/custom hosts. */
export function openRouterInferenceFetch(fetcher: typeof fetch, userId?: string): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.origin !== "https://openrouter.ai" ||
      !["/api/v1/chat/completions", "/api/v1/responses"].includes(url.pathname)
    )
      return fetcher(input, init);
    const headers = new Headers(
      init?.headers !== undefined
        ? init.headers
        : input instanceof Request
          ? input.headers
          : undefined,
    );
    headers.set("HTTP-Referer", "https://rakazo.com");
    headers.set("X-OpenRouter-Title", "Rakazo");
    const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    if (typeof body !== "string") throw new Error("OpenRouter inference requires a JSON body");
    const payload = JSON.parse(body);
    if (userId) payload.user = userId;
    return fetcher(input, { ...init, headers, body: JSON.stringify(payload) });
  };
}

const tokens = z.number().int().nonnegative().nullable().optional();
const generationSchema = z.object({
  data: z.object({
    id: z.string(),
    total_cost: z.number().finite().nonnegative().nullable(),
    native_tokens_prompt: tokens,
    native_tokens_completion: tokens,
    native_tokens_cached: tokens,
    native_tokens_reasoning: tokens,
  }),
});
