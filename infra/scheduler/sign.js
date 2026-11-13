/** hex HMAC-SHA256 of "<delivery id>|<label>", first 32 chars. Same as the digest's signer (packages/deliver/src/label-links.ts). */
export async function sign(secret, d, v) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${d}|${v}`)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
