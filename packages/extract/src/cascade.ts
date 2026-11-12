import { extractPost, type LlmClient, type PostExtraction, type ExtractorConfig } from "./post.js";
import { verifyPost } from "./verifier.js";

export interface GateDeps {
  llm: LlmClient;
  /** Gate 1 (free rules), injected from @tell/intel to keep packages decoupled */
  gate1: (text: string) => { pass: boolean; reason: string; injectionFlag: boolean };
  /** Gate 2 (exemplar similarity). Optional until embeddings land. */
  gate2?: (text: string) => Promise<{ pass: boolean; reason: string }>;
  /** business-specific prompt parts (pack extractor.yaml) */
  extractor: ExtractorConfig;
  /** Gate 3 strengths below this are not signals (pack signals.min_post_strength) */
  minStrength?: number;
}

/** Default minimum Gate 3 strength (1 = unrelated, 2 = barely related). */
export const MIN_SIGNAL_STRENGTH = 3;

export type CascadeResult =
  | { status: "confirmed"; extraction: PostExtraction; log: string[] }
  | { status: "rejected"; gate: number; reason: string; log: string[] }
  | { status: "uncertain"; gate: number; reason: string; log: string[] };

/** Cheapest gate first; every decision is logged with its reason. */
export async function runCascade(deps: GateDeps, text: string): Promise<CascadeResult> {
  const log: string[] = [];
  const g1 = deps.gate1(text);
  log.push(`gate1: ${g1.reason}`);
  if (!g1.pass) return { status: "rejected", gate: 1, reason: g1.reason, log };
  if (g1.injectionFlag) return { status: "uncertain", gate: 1, reason: "instruction-like text aimed at AI", log };

  if (deps.gate2) {
    const g2 = await deps.gate2(text);
    log.push(`gate2: ${g2.reason}`);
    if (!g2.pass) return { status: "rejected", gate: 2, reason: g2.reason, log };
  }

  const g3 = await extractPost(deps.llm, text, deps.extractor);
  if (!g3.ok) {
    log.push(`gate3: ${g3.reason}${g3.detail ? ` (${g3.detail})` : ""}`);
    return g3.reason === "ungrounded"
      ? { status: "rejected", gate: 3, reason: "quote not found in source", log }
      : { status: "uncertain", gate: 3, reason: g3.reason, log };
  }
  log.push(`gate3: ${g3.extraction.ask_type} strength ${g3.extraction.strength}`);
  // Weak or self-promotional extractions are not signals: reject here and skip the Gate 4 call.
  if (g3.extraction.strength < (deps.minStrength ?? MIN_SIGNAL_STRENGTH) || g3.extraction.self_promotion || g3.extraction.author_role === "vendor") {
    return { status: "rejected", gate: 3, reason: g3.extraction.self_promotion || g3.extraction.author_role === "vendor" ? "self-promotion / vendor" : "no need (low strength)", log };
  }

  const g4 = await verifyPost(deps.llm, text, g3.extraction, deps.extractor.need_description);
  log.push(`gate4: ${g4.decision}`);
  if (g4.decision === "uncertain") return { status: "uncertain", gate: 4, reason: g4.reason, log };
  if (g4.decision === "reject") return { status: "rejected", gate: 4, reason: g4.verdict.reason, log };
  return { status: "confirmed", extraction: g3.extraction, log };
}
