import { after } from "next/server";
import { verifyVaaniSignature } from "@/integrations/vaani/signature";
import { parseVaaniWebhook } from "@/integrations/vaani/payload";
import { ingestCall, processCall } from "@/core/pipeline";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Field names and types only, never values, so unfamiliar payloads can be diagnosed without logging caller data. */
function shapeOf(raw: string): string {
  try {
    const paths: string[] = [];
    const walk = (v: unknown, p: string, d: number) => {
      if (v && typeof v === "object" && d < 4) for (const [k, c] of Object.entries(v as object)) walk(c, p ? `${p}.${k}` : k, d + 1);
      else paths.push(`${p}:${Array.isArray(v) ? "array" : typeof v}`);
    };
    walk(JSON.parse(raw), "", 0);
    return paths.slice(0, 80).join(", ");
  } catch {
    return "non-JSON";
  }
}

export async function POST(req: Request) {
  const raw = await req.text(); // signature is over the exact raw bytes
  if (!verifyVaaniSignature(raw, req.headers)) {
    // Header names only (no values) to help diagnose a mismatched scheme.
    console.warn("[vaani-webhook] rejected signature; headers:", [...req.headers.keys()].filter((h) => !h.startsWith("x-vercel")).join(","));
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = parseVaaniWebhook(raw, json);
  if (parsed.kind === "test") return Response.json({ ok: true, test: true });
  if (parsed.kind === "invalid") {
    console.warn("[vaani-webhook] unrecognised payload shape:", shapeOf(raw));
    return Response.json({ error: "unrecognised payload" }, { status: 400 });
  }
  if (!parsed.calls.length) console.warn("[vaani-webhook] no completed-call event; shape:", shapeOf(raw));

  const results = [];
  for (const { call, payload } of parsed.calls) {
    const row = await ingestCall(JSON.stringify(payload), payload, call); // persisted before evaluation
    if (row.status === "received") {
      try {
        after(() => processCall(row.id)); // evaluate after responding so Vaani isn't kept waiting
      } catch {
        // No request scope (e.g. unit tests): the retry job picks up 'received' calls.
      }
    }
    results.push({ callId: row.id, duplicate: !row.inserted, status: row.status });
  }
  // 200 for duplicates too, so Vaani stops redelivering.
  return Response.json({ ok: true, ignoredEvents: parsed.ignored, results });
}
