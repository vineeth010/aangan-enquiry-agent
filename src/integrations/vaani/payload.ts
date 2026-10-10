import { createHash } from "node:crypto";

/**
 * Integration boundary for Vaani webhooks. Nothing outside this folder knows Vaani's field names.
 *
 * VERIFIED against Vaani's own "Test Connectivity" delivery AND a real web test call (Oct 2026).
 * Real calls arrive as ONE flat event (no `events` list); the test ping wraps events in an `events` list. Both are handled.
 * Real-call data fields: call_id, room_name, agent_name, call_type ("webrtc_call"), phone_number ("web-user" for web calls),
 * call_started_at, call_ended_at, call_duration (seconds), end_reason, summary, entities, dispositions {"Enquiry Outcome": ...},
 * transcript (text lines like "[14:03:42] USER: ..."), recording_url, conversation_quality.
 * Test-ping details:
 *   headers: x-webhook-signature ("sha256=" + HMAC-SHA256 hex of the raw body), x-webhook-event
 *   body: { event, timestamp, events: [ { event: "call_postprocessing", call_id, timestamp,
 *           data: { room_name, call_id, call_duration, end_reason, summary, entities,
 *                   dispositions, recording_url, transcript: string } } ] }
 * Phone: data.phone_number (a placeholder like "web-user" on web test calls, so it is stored as null there).
 * NOT yet seen: a real PHONE call delivery (the number format in data.phone_number / from).
 */
export type NormalizedCall = {
  vaaniCallId: string;
  callIdSource: "payload" | "body_hash";
  callerPhone: string | null;
  startedAt: string | null;
  durationSeconds: number | null;
  transcript: string | null;
};

export const COMPLETED_CALL_EVENT = "call_postprocessing";

const PHONE_PATHS = ["phone_number", "caller_number", "from", "phone", "caller.phone", "entities.phone", "entities.phone_number"];
/** Web test calls report a placeholder such as "web-user" instead of a number. */
const realPhone = (v: string | null) => (v && !/^web/i.test(v) ? v : null);

function pick(obj: unknown, paths: readonly string[]): unknown {
  for (const p of paths) {
    let cur: any = obj;
    for (const k of p.split(".")) cur = cur == null ? undefined : cur[k];
    if (cur !== undefined && cur !== null && cur !== "") return cur;
  }
  return undefined;
}
const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : null);

export function flattenTranscript(t: unknown): string | null {
  if (typeof t === "string") return t.trim() || null;
  if (Array.isArray(t)) {
    const lines = t
      .map((m: any) => {
        const who = m?.role ?? m?.speaker ?? "speaker";
        const text = m?.text ?? m?.content ?? m?.message;
        return typeof text === "string" && text.trim() ? `${who}: ${text.trim()}` : null;
      })
      .filter(Boolean);
    return lines.length ? lines.join("\n") : null;
  }
  return null;
}

export type ParsedWebhook =
  | { kind: "test" }
  | { kind: "calls"; calls: { call: NormalizedCall; payload: unknown }[]; ignored: number }
  | { kind: "invalid" };

/** One delivery can batch several events; only completed-call (post-processing) events become calls. */
export function parseVaaniWebhook(raw: string, json: unknown): ParsedWebhook {
  const body = json as any;
  if (!body || typeof body !== "object") return { kind: "invalid" };
  if (body.event === "webhook_test") return { kind: "test" };
  // Test delivery wraps events in an `events` array; real deliveries may arrive as a single event object.
  const events: any[] = Array.isArray(body.events) ? body.events : body.event || body.data ? [body] : [];
  const calls: { call: NormalizedCall; payload: unknown }[] = [];
  let ignored = 0;
  const isCompleted = (name: unknown) => typeof name === "string" && name.toLowerCase().replace(/[^a-z]/g, "") === "callpostprocessing";
  for (const ev of events) {
    if (!isCompleted(ev?.event ?? ev?.type)) { ignored++; continue; }
    const id = str(ev.call_id ?? ev.data?.call_id);
    // VERIFIED on a real web call: the delivery timestamp is the END of post-processing; the true start is data.call_started_at.
    const started = str(ev.data?.call_started_at ?? ev.timestamp);
    const dur = Number(ev.data?.call_duration);
    calls.push({
      payload: ev,
      call: {
        // Missing id => dedupe on a hash of the event so redeliveries stay safe.
        vaaniCallId: id ?? `eventhash:${createHash("sha256").update(JSON.stringify(ev)).digest("hex")}`,
        callIdSource: id ? "payload" : "body_hash",
        callerPhone: realPhone(str(pick(ev.data, PHONE_PATHS) ?? ev.from)),
        startedAt: started && !Number.isNaN(Date.parse(started)) ? new Date(started).toISOString() : null,
        durationSeconds: Number.isFinite(dur) ? Math.round(dur) : null,
        transcript: flattenTranscript(ev.data?.transcript),
      },
    });
  }
  if (!calls.length && !events.length) return { kind: "invalid" };
  return { kind: "calls", calls, ignored };
}
