import { parse } from "yaml";
import { readFileSync } from "node:fs";

/** Gate 1: free rules. Never-patterns from signals.yaml + prompt-injection flagging. */

export interface Gate1Result {
  pass: boolean;
  reason: string;
  /** instruction-like text aimed at an AI; item goes to the uncertain queue, not dropped */
  injectionFlag: boolean;
}

const INJECTION = [
  /ignore (all |your |the )?(previous |prior |above )?(instructions|rules)/i,
  /disregard (all |your |the )?(previous |prior )?(instructions|rules)/i,
  /(rate|score|classify|mark) (this|it) (as )?(10\/10|5\/5|a 5|strength 5|genuine|high intent)/i,
  /you are (now )?(an? )?(ai|assistant|language model)/i,
  /system prompt/i,
  /as an ai/i,
];

export function detectInjection(text: string): boolean {
  return INJECTION.some((r) => r.test(text));
}

export function loadNeverPatterns(path: string): RegExp[] {
  const cfg = parse(readFileSync(path, "utf8")) as { never_patterns?: string[] };
  return (cfg.never_patterns ?? []).map((p) => {
    const m = p.match(/^\(\?([a-z]+)\)(.*)$/s); // YAML patterns use inline flags like (?i)
    return m ? new RegExp(m[2]!, m[1]) : new RegExp(p);
  });
}

export function gate1(text: string, never: RegExp[]): Gate1Result {
  const injectionFlag = detectInjection(text);
  const hit = never.find((r) => r.test(text));
  if (hit) return { pass: false, reason: `never-pattern: ${hit.source}`, injectionFlag };
  if (text.trim().length < 20) return { pass: false, reason: "too short", injectionFlag };
  return { pass: true, reason: injectionFlag ? "passed, injection flagged -> uncertain queue" : "passed", injectionFlag };
}
