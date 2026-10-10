import { createHash, timingSafeEqual } from "node:crypto";
import { query } from "./db";

export function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Check a bearer token against a configured env secret. Unset secret = deny. */
export function checkEnvToken(req: Request, envName: string): boolean {
  const expected = process.env[envName];
  const got = bearer(req);
  return !!expected && !!got && safeEqual(got, expected);
}

export async function designerFromRequest(req: Request) {
  const token = bearer(req);
  if (!token) return null;
  const rows = await query<{ id: string; name: string }>(
    "SELECT id, name FROM designers WHERE access_token_hash = $1 AND active",
    [sha256(token)],
  );
  return rows[0] ?? null;
}
