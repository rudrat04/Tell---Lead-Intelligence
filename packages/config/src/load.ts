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
    const res = await aws.fetch(objectUrl(base, prefix, f));
    if (res.ok) out[f] = await res.text();
    else if (res.status !== 404) throw new PackError(`R2 ${f}.yaml -> HTTP ${res.status}`);
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
