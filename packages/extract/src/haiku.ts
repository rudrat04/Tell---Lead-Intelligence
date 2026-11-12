import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient } from "./post.js";

export const HAIKU_MODEL = "claude-haiku-5-5";

/** Haiku client with prompt caching on the system prompt and a hard daily spend cap. */
export class HaikuClient implements LlmClient {
  private client: Anthropic;
  private spentUsd = 0;

  constructor(private opts: { dailyCapUsd: number; apiKey?: string; inPerM?: number; outPerM?: number }) {
    this.client = new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY });
  }

  get spent() { return this.spentUsd; }

  async complete({ system, user }: { system: string; user: string }): Promise<string> {
    if (this.spentUsd >= this.opts.dailyCapUsd) throw new Error("Haiku daily spend cap reached");
    const res = await this.client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 600,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    });
    // Per-million-token prices are configurable; defaults are placeholders to verify against current pricing.
    const inP = this.opts.inPerM ?? 1, outP = this.opts.outPerM ?? 5;
    this.spentUsd += (res.usage.input_tokens * inP + res.usage.output_tokens * outP) / 1e6;
    const block = res.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text : "";
  }
}
