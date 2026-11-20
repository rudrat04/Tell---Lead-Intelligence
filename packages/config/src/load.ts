import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { AwsClient } from "aws4fetch";
import { PackSchema, PACK_FILES, type Pack } from "./schema.js";

/** Where the pack comes from: a local folder, or a private R2 prefix (production; keeps a business's pack out of the public repo). */
export type PackSource = { kind: "dir"; dir: string } | { kind: "r2"; prefix: string };

export class PackError extends Error {}

async function readDir(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of PACK_FILES) {
    try { out[f] = await readFile(join(dir, `${f}.yaml`), "utf8"); } catch { /* missing file -> schema reports it */ }
  }
  return out;
}

function r2Client() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) throw new PackError("R2 pack needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET");
  const aws = new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
  const base = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}`;
  return { aws, base };
}

const objectUrl = (base: string, prefix: string, f: string) => `${base}/${prefix.replace(/^\/+|\/+$/g, "")}/${f}.yaml`;

async function readR2(prefix: string): Promise<Record<string, string>> {
  const { aws, base } = r2Client();
  const out: Record<string, string> = {};
  await Promise.all(PACK_FILES.map(async (f) => {
    // network blips ("fetch failed") and 5xx are retried; a 404 means the optional file isn't there
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await aws.fetch(objectUrl(base, prefix, f));
        if (res.ok) { out[f] = await res.text(); return; }
        if (res.status === 404) return;
        if (res.status < 500 || attempt >= 3) throw new PackError(`R2 ${f}.yaml -> HTTP ${res.status}`);
      } catch (e) {
        if (e instanceof PackError || attempt >= 3) throw e;
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }));
  return out;
}

/** Upload a local pack folder to a private R2 prefix (`pnpm pack:push`). */
export async function pushPackToR2(dir: string, prefix: string): Promise<string[]> {
  const files = await readDir(dir);
  const { aws, base } = r2Client();
  for (const [f, body] of Object.entries(files)) {
    const res = await aws.fetch(objectUrl(base, prefix, f), { method: "PUT", body, headers: { "content-type": "application/yaml" } });
    if (!res.ok) throw new PackError(`upload ${f}.yaml -> HTTP ${res.status}`);
  }
  return Object.keys(files);
}

export function parsePack(files: Record<string, string>): Pack {
  const raw: Record<string, unknown> = {};
  for (const [f, text] of Object.entries(files)) {
    try { raw[f === "pack" ? "meta" : f] = parse(text); } catch (e) { throw new PackError(`${f}.yaml is not valid YAML: ${(e as Error).message}`); }
  }
  // buyers.yaml (`buyers: [...]`): who to reach, kept apart from the ICP (which companies); stored as icp.personas
  if (raw.buyers != null) {
    const list = (raw.buyers as { buyers?: unknown }).buyers;
    const icp = (raw.icp ?? {}) as Record<string, unknown>;
    if (!Array.isArray(list)) throw new PackError("buyers.yaml must hold a `buyers:` list");
    if (Array.isArray(icp.personas) && icp.personas.length) throw new PackError("buyers are set twice: in buyers.yaml and icp.yaml personas (keep buyers.yaml)");
    raw.icp = { ...icp, personas: list };
    delete raw.buyers;
  }
  // industries.yaml (`industries: { segment: {...} }`): one place per industry, expanded into the ICP fields
  if (raw.industries != null) {
    const list = (raw.industries as { industries?: unknown }).industries;
    if (!list || typeof list !== "object" || Array.isArray(list)) throw new PackError("industries.yaml must hold an `industries:` map (segment name -> industry)");
    raw.icp = expandIndustries((raw.icp ?? {}) as Record<string, any>, list as Record<string, any>);
    delete raw.industries;
  }
  const r = PackSchema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new PackError(`config pack is invalid:\n${issues}`);
  }
  return r.data;
}

/** TELL_PACK_R2_PREFIX (production) > TELL_PACK_DIR > packs/example-gtm (development). */
export function packSourceFromEnv(cwd = process.cwd()): PackSource {
  if (process.env.TELL_PACK_R2_PREFIX) return { kind: "r2", prefix: process.env.TELL_PACK_R2_PREFIX };
  return { kind: "dir", dir: resolve(cwd, process.env.TELL_PACK_DIR ?? "packs/example-gtm") };
}

export async function loadPack(src: PackSource = packSourceFromEnv()): Promise<Pack> {
  return parsePack(src.kind === "dir" ? await readDir(src.dir) : await readR2(src.prefix));
}

export async function loadPackFromDir(dir: string): Promise<Pack> {
  return loadPack({ kind: "dir", dir });
}

/**
 * Expand industries.yaml into the ICP fields scoring reads. A segment defined in both files is an error (one place per
 * industry), so nothing is silently merged. Exported for tests.
 */
export function expandIndustries(icp: Record<string, any>, industries: Record<string, any>): Record<string, any> {
  const hf = { ...(icp.hard_filters ?? {}) };
  const map: Record<string, string> = { ...(icp.segment_map ?? {}) };
  const desc: Record<string, string> = { ...(icp.segment_descriptions ?? {}) };
  const overrides: Record<string, unknown> = { ...(hf.segment_overrides ?? {}) };
  const soft = { ...(icp.soft_fit ?? {}) };
  const fitBy: Record<string, number> = { ...(soft.segment ?? {}) };
  const any = new Set<string>(hf.industries_any ?? []);
  for (const [seg, ind] of Object.entries(industries)) {
    if (!ind || typeof ind !== "object") throw new PackError(`industries.yaml: "${seg}" must be a map`);
    const clash = [desc[seg] != null && "segment_descriptions", overrides[seg] != null && "segment_overrides", fitBy[seg] != null && "soft_fit.segment",
      Object.values(map).includes(seg) && "segment_map"].filter(Boolean);
    if (clash.length) throw new PackError(`industry "${seg}" is defined in both industries.yaml and icp.yaml (${clash.join(", ")}): keep it in industries.yaml`);
    if (ind.description) desc[seg] = ind.description;
    if (!ind.excluded) {
      for (const label of [ind.label, ...(ind.aliases ?? [])].filter(Boolean)) { map[label] = seg; any.add(label); }
      if (ind.regions || ind.team_size) overrides[seg] = { ...(ind.team_size ? { team_size: ind.team_size } : {}), ...(ind.regions ? { regions_any: ind.regions } : {}) };
      if (ind.fit != null) fitBy[seg] = ind.fit;
    }
  }
  return { ...icp, industries, segment_map: map, segment_descriptions: desc, soft_fit: { ...soft, segment: fitBy },
    hard_filters: { ...hf, industries_any: [...any], segment_overrides: overrides } };
}
