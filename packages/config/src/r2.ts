import { AwsClient } from "aws4fetch";

/** Minimal R2 (S3 API) client: put / get / list / delete. Credentials from R2_* env vars. */
export interface R2Object { key: string; size: number; lastModified: Date }

export function r2() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) throw new Error("R2 needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET");
  const aws = new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
  const base = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}`;
  const url = (key: string) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;

  return {
    bucket: R2_BUCKET,
    async put(key: string, body: Uint8Array | string, contentType = "application/octet-stream") {
      const res = await aws.fetch(url(key), { method: "PUT", body: body as BodyInit, headers: { "content-type": contentType } });
      if (!res.ok) throw new Error(`R2 put ${key} -> HTTP ${res.status}`);
    },
    async get(key: string): Promise<Uint8Array | null> {
      const res = await aws.fetch(url(key));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 get ${key} -> HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async del(key: string) {
      const res = await aws.fetch(url(key), { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`R2 delete ${key} -> HTTP ${res.status}`);
    },
    /** All objects under a prefix (follows pagination). */
    async list(prefix = ""): Promise<R2Object[]> {
      const out: R2Object[] = [];
      let token: string | null = null;
      do {
        const q = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "1000" });
        if (token) q.set("continuation-token", token);
        const res = await aws.fetch(`${base}?${q}`);
        if (!res.ok) throw new Error(`R2 list ${prefix} -> HTTP ${res.status}`);
        const xml = await res.text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const c = m[1]!;
          const key = c.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? "";
          out.push({ key: key.replace(/&amp;/g, "&"), size: Number(c.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0), lastModified: new Date(c.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] ?? 0) });
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? null : null;
      } while (token);
      return out;
    },
  };
}
