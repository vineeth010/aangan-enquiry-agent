import { createHmac } from "node:crypto";
import { safeEqual } from "@/lib/auth";

/**
 * ASSUMPTION (UNVERIFIED): Vaani signs the raw request body with HMAC-SHA256
 * using a shared secret, sent as hex (optionally prefixed "sha256=") in a
 * header. Header name is configurable via VAANI_SIGNATURE_HEADER.
 * Replace this single file if Vaani documents a different scheme.
 * Fails closed: no secret configured => every request is rejected.
 */
export function verifyVaaniSignature(rawBody: string, headers: Headers): boolean {
  const secret = process.env.VAANI_WEBHOOK_SECRET;
  if (!secret) return false;
  const headerName = (process.env.VAANI_SIGNATURE_HEADER || "x-webhook-signature").toLowerCase();
  const provided = headers.get(headerName);
  if (!provided) return false;
  const given = provided.replace(/^sha256=/i, "").trim().toLowerCase();
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(given, expected);
}

export function signForTests(rawBody: string, secret: string) {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}
