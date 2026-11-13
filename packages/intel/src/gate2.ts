import { createHash } from "node:crypto";

/**
 * Gate 2 (plan 7): how close a new post is to examples you've marked good (pos) or bad (neg).
 *
 * The vector is a deterministic hashed bag of words and word pairs (384 dims, the `exemplars.embedding` size), not a
 * neural embedding: no model download in every 30-minute run, same result in CI. It catches near-duplicates of known
 * noise and known good asks; a real embedding model can replace `featurize` later without changing the rest.
 *
 * Shadow mode (default): the similarity is logged and nothing is dropped. Enforcing needs `mode: enforce` in the pack
 * AND at least `min_exemplars` on each side.
 */

export const GATE2_DIMS = 384;
const STOP = new Set("a an the and or but if of to in on at for with from by as is are was were be been it this that these those i we you they he she my our your their me us them do does did have has had not no so just very can will would could should about into than then there here what which who how when where why all any some more most".split(" "));

const bucket = (s: string) => createHash("md5").update(s).digest().readUInt32LE(0);

/** L2-normalised hashed features of a text (words + adjacent word pairs, sublinear term frequency). */
export function featurize(text: string): number[] {
  const words = text.toLowerCase().normalize("NFKD").replace(/https?:\/\/\S+/g, " ").replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  const tf = new Map<string, number>();
  for (let i = 0; i < words.length; i++) {
    tf.set(words[i]!, (tf.get(words[i]!) ?? 0) + 1);
    if (i + 1 < words.length) { const bg = `${words[i]} ${words[i + 1]}`; tf.set(bg, (tf.get(bg) ?? 0) + 1); }
  }
  const v = new Array<number>(GATE2_DIMS).fill(0);
  for (const [t, n] of tf) {
    const h = bucket(t);
    v[h % GATE2_DIMS]! += (h & 0x80000000 ? -1 : 1) * (1 + Math.log(n)); // signed hashing reduces collisions' bias
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

export interface Exemplar { vec: number[]; label: "pos" | "neg" }
export interface Gate2Config { mode: "shadow" | "enforce"; min_exemplars: number; drop_margin: number; drop_min_similarity: number }
export interface Gate2Result { pass: boolean; reason: string; pos: number; neg: number; enforced: boolean }

/**
 * Drop only when the post is clearly closer to a bad example than to any good one (by drop_margin) and close enough
 * to that bad example to be the same kind of post (drop_min_similarity). Everything else passes on to Gate 3.
 */
export function gate2Decide(text: string, bank: Exemplar[], cfg: Gate2Config): Gate2Result {
  const v = featurize(text);
  const best = (label: "pos" | "neg") => bank.filter((e) => e.label === label).reduce((m, e) => Math.max(m, cosine(v, e.vec)), 0);
  const pos = Math.round(best("pos") * 1000) / 1000, neg = Math.round(best("neg") * 1000) / 1000;
  const nPos = bank.filter((e) => e.label === "pos").length, nNeg = bank.length - nPos;
  const enforced = cfg.mode === "enforce" && nPos >= cfg.min_exemplars && nNeg >= cfg.min_exemplars;
  const looksBad = neg >= cfg.drop_min_similarity && neg - pos >= cfg.drop_margin;
  const tag = `pos ${pos} neg ${neg}, bank ${nPos}+/${nNeg}-`;
  if (!enforced) return { pass: true, reason: `shadow (${looksBad ? "would drop" : "would keep"}): ${tag}`, pos, neg, enforced };
  return looksBad ? { pass: false, reason: `close to a bad example: ${tag}`, pos, neg, enforced } : { pass: true, reason: `kept: ${tag}`, pos, neg, enforced };
}
