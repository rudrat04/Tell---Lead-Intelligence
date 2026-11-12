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

const toRegex = (p: string) => {
  const m = p.match(/^\(\?([a-z]+)\)(.*)$/s); // YAML patterns use inline flags like (?i)
  return m ? new RegExp(m[2]!, m[1]) : new RegExp(p);
};

export interface Gate1Rules {
  never: RegExp[];
  /** at least one must match; empty = no requirement */
  required: RegExp[];
}

export function loadGate1Rules(path: string): Gate1Rules {
  const cfg = parse(readFileSync(path, "utf8")) as { never_patterns?: string[]; required_any?: string[] };
  return { never: (cfg.never_patterns ?? []).map(toRegex), required: (cfg.required_any ?? []).map(toRegex) };
}

export function loadNeverPatterns(path: string): RegExp[] {
  return loadGate1Rules(path).never;
}

export function gate1(text: string, never: RegExp[], required: RegExp[] = []): Gate1Result {
  const injectionFlag = detectInjection(text);
  const hit = never.find((r) => r.test(text));
  if (hit) return { pass: false, reason: `never-pattern: ${hit.source}`, injectionFlag };
  if (text.trim().length < 20) return { pass: false, reason: "too short", injectionFlag };
  if (required.length && !required.some((r) => r.test(text))) return { pass: false, reason: "no GTM keyword", injectionFlag };
  return { pass: true, reason: injectionFlag ? "passed, injection flagged -> uncertain queue" : "passed", injectionFlag };
}
