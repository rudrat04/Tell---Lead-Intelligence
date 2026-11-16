import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient } from "./post.js";

export const HAIKU_MODEL = "claude-haiku-5-5";

/** USD per million tokens for claude-haiku-5-5 (prompts up to 100K tokens). Cache write ~1.25x input, cache read ~0.1x input. */
export const HAIKU_PRICE = { inPerM: 0.1, outPerM: 0.5, cacheWriteMult: 1.25, cacheReadMult: 0.1 };

export function costUsd(u: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}, p = HAIKU_PRICE): number {
  return (
    u.input_tokens * p.inPerM +
    (u.cache_creation_input_tokens ?? 0) * p.inPerM * p.cacheWriteMult +
    (u.cache_read_input_tokens ?? 0) * p.inPerM * p.cacheReadMult +
    u.output_tokens * p.outPerM
  ) / 1e6;
}

/**
 * Haiku client with prompt caching on the system prompt and a spend cap for this client's lifetime.
 * The cap passed in should be the *remaining* daily budget (see the scheduled runner, which persists daily spend).
 */
export class HaikuClient implements LlmClient {
  private client: Anthropic;
  private spentUsd = 0;

  constructor(private opts: { capUsd: number; apiKey?: string }) {
    this.client = new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY });
  }

  get spent() { return this.spentUsd; }

  async complete({ system, user, think = false }: { system: string; user: string; think?: boolean }): Promise<string> {
    if (this.spentUsd >= this.opts.capUsd) throw new Error("Haiku spend cap reached");
    const res = await this.client.messages.create({
      model: HAIKU_MODEL,
      // Classification: no thinking (disabled is accepted at effort high or below; Haiku 5.5's default is medium).
      // Writing (the opening email): adaptive thinking at medium effort, with room so thinking can't eat the answer.
      ...(think
        ? { max_tokens: 8000, thinking: { type: "adaptive" as const }, output_config: { effort: "medium" as const } }
        : { max_tokens: 1024, thinking: { type: "disabled" as const } }),
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    });
    this.spentUsd += costUsd(res.usage);
    if (res.stop_reason === "refusal") return ""; // treated as invalid output -> uncertain queue
    const block = res.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text : "";
  }
}

/** The writer (analyst: hypothesis, opener, email and LinkedIn drafts). Classification stays on Haiku. */
export const WRITER_MODEL = "claude-sonnet-5-5";
/** USD per million tokens for claude-sonnet-5-5. Cache reads are $0.10/M (0.05x input). */
export const WRITER_PRICE = { inPerM: 2, outPerM: 10, cacheWriteMult: 1.25, cacheReadMult: 0.05 };
export type WriterEffort = "low" | "medium";

/**
 * Sonnet client for writing: adaptive thinking at low or medium effort (Sonnet 5.5 defaults to high, so it is always set),
 * prompt caching on the system prompt, server-side refusal fallback ("default" routing), and a spend cap for this
 * client's lifetime (pass the *remaining* daily writer budget). The fallback model's tokens are costed at Sonnet rates.
 */
export class WriterClient implements LlmClient {
  private client: Anthropic;
  private spentUsd = 0;

  constructor(private opts: { capUsd: number; effort?: WriterEffort; apiKey?: string }) {
    this.client = new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY });
  }

  get spent() { return this.spentUsd; }

  async complete({ system, user }: { system: string; user: string; think?: boolean }): Promise<string> {
    if (this.spentUsd >= this.opts.capUsd) throw new Error("writer spend cap reached");
    const res = await this.client.beta.messages.create({
      model: WRITER_MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: this.opts.effort ?? "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    });
    this.spentUsd += costUsd(res.usage, WRITER_PRICE);
    if (res.stop_reason === "refusal") return ""; // the whole fallback chain declined: invalid output, code opener stands
    const block = res.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text : "";
  }
}

/** ANALYST_EFFORT env: low or medium (default medium); anything else falls back to medium. */
export const writerEffort = (v = process.env.ANALYST_EFFORT): WriterEffort => (v === "low" ? "low" : "medium");
