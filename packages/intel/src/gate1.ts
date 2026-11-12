import { toRegex, type Pack } from "@tell/config";

/** Gate 1: free rules. Required keywords + never-patterns from the pack, plus prompt-injection flagging. */

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

export interface Gate1Rules {
  never: RegExp[];
  /** at least one must match; empty = no requirement */
  required: RegExp[];
}

/** Gate 1 rules from the pack's signals.gate1 section. */
export function gate1Rules(pack: Pick<Pack, "signals">): Gate1Rules {
  return { never: pack.signals.gate1.never.map(toRegex), required: pack.signals.gate1.required_any.map(toRegex) };
}

export function gate1(text: string, never: RegExp[], required: RegExp[] = []): Gate1Result {
  const injectionFlag = detectInjection(text);
  const hit = never.find((r) => r.test(text));
  if (hit) return { pass: false, reason: `never-pattern: ${hit.source}`, injectionFlag };
  if (text.trim().length < 20) return { pass: false, reason: "too short", injectionFlag };
  if (required.length && !required.some((r) => r.test(text))) return { pass: false, reason: "no required keyword", injectionFlag };
  return { pass: true, reason: injectionFlag ? "passed, injection flagged -> uncertain queue" : "passed", injectionFlag };
}
