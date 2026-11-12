import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

export * from "./schema.js";
export { eq, inArray, and, desc, sql } from "drizzle-orm";

export function getDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  return drizzle(neon(url));
}
