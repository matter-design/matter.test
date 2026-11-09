import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod/v4";

/** Model for extraction and planning. */
export const AGENT_MODEL = process.env.AGENT_MODEL || "claude-opus-5-5";

/** US$ per million tokens, for the agent-spend figure. Cache writes cost 1.25x input; reads 0.05x. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number };

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };

export function priceUsage(model: string, u: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): Usage {
  const p = PRICES[model] ?? PRICES["claude-opus-5-5"]!;
  const inputTokens = u.input_tokens ?? 0;
  const outputTokens = u.output_tokens ?? 0;
  const cacheReadTokens = u.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
  const costUsd = (inputTokens * p.input + cacheWriteTokens * p.input * 1.25 + cacheReadTokens * p.cacheRead + outputTokens * p.output) / 1e6;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

export type StructuredRequest<S extends z.ZodTypeAny> = {
  schema: S;
  system: string;
  user: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
};

export type StructuredResult<T> = { data: T; usage: Usage; model: string };

/** The one model call the pipeline makes. Injected so tests can run the pipeline without the API. */
export type StructuredModel = <S extends z.ZodTypeAny>(req: StructuredRequest<S>) => Promise<StructuredResult<z.infer<S>>>;

export class AgentError extends Error {
  constructor(
    message: string,
    readonly usage: Usage = NO_USAGE,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

/**
 * Claude with structured output. Streams (plans can run to tens of thousands of tokens), caches the system prompt,
 * and opts into server-side fallbacks so a classifier refusal is retried on Anthropic's recommended model.
 */
export function claudeModel(client = new Anthropic({ maxRetries: 3 }), model = AGENT_MODEL): StructuredModel {
  return async ({ schema, system, user, effort = "high", maxTokens = 64000 }) => {
    const stream = client.beta.messages.stream({
      model,
      max_tokens: maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort, format: zodOutputFormat(schema) },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    });
    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await stream.finalMessage();
    } catch (e) {
      throw explain(e);
    }
    const usage = priceUsage(msg.model, msg.usage);
    if (msg.stop_reason === "refusal") throw new AgentError("Claude declined to process this source.", usage);
    if (msg.stop_reason === "max_tokens") throw new AgentError("Claude's answer was cut off (too long). Try splitting the source.", usage);
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AgentError("Claude's answer wasn't valid JSON.", usage);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new AgentError(`Claude's answer didn't match the expected shape: ${parsed.error.issues[0]?.message}`, usage);
    return { data: parsed.data, usage, model: msg.model };
  };
}

const hasCredentials = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);

/** Turn API failures into messages the Sources list can show. */
function explain(e: unknown): Error {
  if (e instanceof Anthropic.AuthenticationError) return new AgentError("The worker's Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env and restart the worker.");
  if (e instanceof Anthropic.PermissionDeniedError) return new AgentError(`This API key can't use ${AGENT_MODEL}. Check the key's workspace and model access.`);
  if (e instanceof Anthropic.RateLimitError) return new AgentError("Anthropic's rate limit was hit. Try again in a minute.");
  if (e instanceof Anthropic.APIConnectionError) return new AgentError("Couldn't reach the Anthropic API. Check the worker's network connection and try again.");
  if (e instanceof Anthropic.APIError) return new AgentError(`The Anthropic API returned an error (${e.status ?? "no status"}): ${e.message}`);
  if (!hasCredentials()) return new AgentError("Claude isn't set up on the worker: put ANTHROPIC_API_KEY in .env and restart the worker.");
  return e instanceof Error ? e : new Error(String(e));
}
