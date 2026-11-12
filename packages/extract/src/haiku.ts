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

  async complete({ system, user }: { system: string; user: string }): Promise<string> {
    if (this.spentUsd >= this.opts.capUsd) throw new Error("Haiku spend cap reached");
    const res = await this.client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 1024,
      // Short structured classification: thinking adds cost and can eat the max_tokens budget.
      thinking: { type: "disabled" },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    });
    this.spentUsd += costUsd(res.usage);
    if (res.stop_reason === "refusal") return ""; // treated as invalid output -> uncertain queue
    const block = res.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text : "";
  }
}
