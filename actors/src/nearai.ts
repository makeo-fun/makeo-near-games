// NEAR AI Cloud client: OpenAI-compatible chat completions at https://cloud-api.near.ai/v1, asking
// for JSON output from a TEE-attested model (NEAR_AI_MODEL; models with owned_by "nearai" in
// GET /v1/models run in NEAR's own TEEs). It keeps the exact request and response bytes, because the
// response signature (GET /v1/signature/{id}, checked in verify/nearai.ts) covers their sha256.
//
// Per NEAR's "Response Signatures" doc: build the body once and send those bytes; send the canonical
// model id with `x-no-aliasing: true` (an alias makes the gateway re-sign instead of the model);
// don't stream (the gateway re-signs streams); ask for an uncompressed body.
import type { Prompt } from "./types";

export const NEAR_AI_BASE = "https://cloud-api.near.ai/v1";
/** A model served from NEAR's own TEE with JSON mode (GET /v1/models, 2026-11-14). */
export const DEFAULT_MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";

export type Completion = { chat_id: string; json: unknown; text: string; request_body: string; response_body: string };
export interface Inference {
  readonly model: string;
  complete(prompt: Prompt): Promise<Completion>;
}

export type NearAiOptions = { apiKey: string; model?: string; timeoutMs?: number; maxTokens?: number; temperature?: number; fetch?: typeof fetch; base?: string };

export class NearAiClient implements Inference {
  readonly model: string;
  constructor(private readonly options: NearAiOptions) {
    this.model = options.model ?? DEFAULT_MODEL;
  }

  async complete(prompt: Prompt): Promise<Completion> {
    const request_body = JSON.stringify({
      model: this.model,
      messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }],
      response_format: { type: "json_object" },
      temperature: this.options.temperature ?? 0.7,
      max_tokens: this.options.maxTokens ?? 600,
      stream: false,
    });
    const response = await (this.options.fetch ?? fetch)(`${this.options.base ?? NEAR_AI_BASE}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json", accept: "application/json", "accept-encoding": "identity", "x-no-aliasing": "true" },
      body: request_body,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 25_000),
    });
    const raw = new Uint8Array(await response.arrayBuffer());
    const response_body = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response_body.slice(0, 200)}`);
    const body = JSON.parse(response_body) as { id?: string; choices?: Array<{ message?: { content?: string | null } }> };
    if (!body.id) throw new Error("completion has no id");
    const text = body.choices?.[0]?.message?.content ?? "";
    return { chat_id: body.id, json: extractJson(text), text, request_body, response_body };
  }
}

/** The first JSON object in a model's text (tolerates <think> blocks and code fences); null if none. */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "").trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const start = cleaned.indexOf("{");
  for (let end = cleaned.lastIndexOf("}"); start >= 0 && end > start; end = cleaned.lastIndexOf("}", end - 1)) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* shorter */ }
  }
  return null;
}

/** NEAR AI when NEAR_AI_API_KEY is set; null (scripted moves) otherwise. */
export function nearAiFromEnv(env: Record<string, string | undefined> = process.env): NearAiClient | null {
  if (!env.NEAR_AI_API_KEY) return null;
  return new NearAiClient({ apiKey: env.NEAR_AI_API_KEY, model: env.NEAR_AI_MODEL || DEFAULT_MODEL });
}

/**
 * A stand-in that answers from a script and shapes its bytes like NEAR AI's, for mock rooms and tests.
 * `answer` gets the prompt and returns the JSON the model would.
 */
export function scriptedInference(answer: (prompt: Prompt) => unknown, model = "scripted-local"): Inference {
  let n = 0;
  return {
    model,
    async complete(prompt) {
      const json = answer(prompt);
      const chat_id = `chatcmpl-local-${++n}`;
      const request_body = JSON.stringify({ model, messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }], response_format: { type: "json_object" } });
      const text = JSON.stringify(json);
      const response_body = JSON.stringify({ id: chat_id, object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
      return { chat_id, json, text, request_body, response_body };
    },
  };
}
