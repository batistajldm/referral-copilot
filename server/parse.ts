// Natural-language query parsing via a Databricks Foundation Model.
//
// Track 3 ("dialysis near Jaipur", "emergency surgery near Patna") is a plain-
// English request. We use a served LLM ONLY as a front-door parser: it turns
// free text into the structured {need, city, state} our deterministic,
// evidence-ranked SQL already understands. The evidence/confidence/citation
// pipeline is untouched — the model never ranks or invents facilities.

import { z } from 'zod';

// Minimal structural type for the serving handle we need (avoids coupling to
// the full generic AppKit type, which depends on the plugin array).
type ServingResult = { ok?: boolean; status?: number; message?: string; data?: unknown };
type AppKit = {
  serving: (alias?: string) => { invoke: (body: Record<string, unknown>) => Promise<unknown> };
};

export type ParsedQuery = { need: string; city: string; state: string };

// The serving endpoint is only callable when its name is injected (prod: the
// `serving-default` app resource; local: DATABRICKS_SERVING_ENDPOINT_NAME in
// .env). When absent, NL parsing is disabled and the form still works.
export function nlParseEnabled(): boolean {
  return Boolean(process.env.DATABRICKS_SERVING_ENDPOINT_NAME);
}

const SYSTEM_PROMPT = `You extract structured search parameters for a healthcare facility finder in India.
Given the user's free-text request, respond with ONLY a compact JSON object (no prose, no markdown) with exactly these keys:
- "need": the care need or medical specialty as a short lowercase term (e.g. "dialysis", "maternity", "oncology", "emergency", "trauma", "icu", "surgery"). Empty string if none is stated.
- "city": the city or town the user wants to be NEAR. Empty string if none is stated.
- "state": an Indian state or region ONLY if explicitly named by the user. Empty string otherwise.
Examples:
"dialysis near Jaipur" -> {"need":"dialysis","city":"Jaipur","state":""}
"emergency surgery near Patna" -> {"need":"emergency","city":"Patna","state":"Bihar"}
"maternity care in Kerala" -> {"need":"maternity","city":"","state":"Kerala"}`;

const ParsedSchema = z.object({
  need: z.string().default(''),
  city: z.string().default(''),
  state: z.string().default(''),
});

/** Pull the first JSON object out of a model response (handles ```json fences). */
function extractJson(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : content;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('No JSON object in model response');
  return JSON.parse(candidate.slice(start, end + 1));
}

/** Parse a free-text request into structured search params. */
export async function parseQuery(appkit: AppKit, text: string): Promise<ParsedQuery> {
  const raw = await appkit.serving('default').invoke({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
    max_tokens: 200,
    temperature: 0,
  });

  // The serving handle returns an ExecutionResult ({ ok, data }); be defensive
  // in case a future version returns the response payload directly.
  const result = raw as ServingResult;
  if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
    throw new Error(result.message || 'Serving endpoint error');
  }
  const payload = (result && typeof result === 'object' && 'data' in result ? result.data : raw) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload?.choices?.[0]?.message?.content ?? '';
  if (!content.trim()) throw new Error('Empty model response');

  const parsed = ParsedSchema.parse(extractJson(content));
  return {
    need: parsed.need.trim(),
    city: parsed.city.trim(),
    state: parsed.state.trim(),
  };
}
