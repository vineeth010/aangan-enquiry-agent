/**
 * Google Calendar adapter (replaces Cal.com). Uses a service account that the designer has shared
 * their calendar with ("Make changes to events"). Documented endpoints: OAuth2 JWT bearer flow,
 * freeBusy.query, events.insert/get.
 *
 * Idempotency: events are inserted with a deterministic client-chosen event id derived from the call
 * id, so a retry returns 409 (already exists) instead of creating a second event.
 * Limitation: a service account cannot invite attendees without domain-wide delegation, so the
 * event lives on the designer's calendar and the caller is emailed separately via Resend.
 * Working hours are fixed at IST (no DST in India).
 */
import { createHash, createSign } from "node:crypto";

const API = "https://www.googleapis.com/calendar/v3";
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const WORK_START_HOUR = Number(process.env.CONSULT_START_HOUR ?? 10);
const WORK_END_HOUR = Number(process.env.CONSULT_END_HOUR ?? 19);

export type Booking = { uid: string; start: string };

let cached: { token: string; exp: number } | null = null;

function credentials(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
  const j = JSON.parse(raw);
  if (!j.client_email || !j.private_key) throw new Error("Service account JSON missing client_email/private_key");
  return { client_email: j.client_email, private_key: String(j.private_key).replace(/\\n/g, "\n") };
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const { client_email, private_key } = credentials();
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64u(JSON.stringify({
    iss: client_email, scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(private_key).toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${sig}` }),
  });
  if (!res.ok) throw new Error(`Google token HTTP ${res.status}`);
  const j: any = await res.json();
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function gfetch(path: string, init: RequestInit = {}) {
  const token = await accessToken();
  return fetch(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
}

/** Deterministic id: 64 hex chars, valid for Google's base32hex event-id alphabet (0-9, a-v). */
export const eventIdFor = (callId: string) => createHash("sha256").update(`aangan:${callId}`).digest("hex");

export async function getExistingEvent(calendarId: string, eventId: string): Promise<Booking | null> {
  const res = await gfetch(`/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Google Calendar get HTTP ${res.status}`);
  const e: any = await res.json();
  if (e.status === "cancelled") return null;
  return { uid: e.id, start: e.start?.dateTime ?? e.start?.date };
}

/** First free 1-hour slot in the next 14 days, Mon-Sat, within working hours (IST). */
/** Caller's stated preference; slots outside it are skipped. Callers fall back to no preference if nothing fits. */
export type SlotPreference = { date?: string | null; hourFrom?: number | null; hourTo?: number | null };

export async function firstAvailableSlot(calendarId: string, pref?: SlotPreference): Promise<string | null> {
  const from = Date.now() + 24 * 3600 * 1000;
  const to = from + 14 * 24 * 3600 * 1000;
  const res = await gfetch("/freeBusy", {
    method: "POST",
    body: JSON.stringify({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: [{ id: calendarId }] }),
  });
  if (!res.ok) throw new Error(`Google freeBusy HTTP ${res.status}`);
  const j: any = await res.json();
  const cal = j?.calendars?.[calendarId];
  if (cal?.errors?.length) throw new Error(`Calendar not accessible: ${cal.errors[0].reason ?? "unknown"} (share it with the service account)`);
  const busy: [number, number][] = (cal?.busy ?? []).map((b: any) => [Date.parse(b.start), Date.parse(b.end)]);

  const istDay0 = Math.floor((from + IST_OFFSET_MS) / 86_400_000) * 86_400_000; // IST midnight (as UTC-shifted ms)
  for (let d = 0; d < 15; d++) {
    const dayStart = istDay0 + d * 86_400_000;
    if (new Date(dayStart).getUTCDay() === 0) continue; // Sunday
    if (pref?.date && /^\d{4}-\d{2}-\d{2}$/.test(pref.date) && dayStart < Date.parse(pref.date + "T00:00:00Z")) continue;
    for (let h = WORK_START_HOUR; h < WORK_END_HOUR; h++) {
      if (pref?.hourFrom != null && h < pref.hourFrom) continue;
      if (pref?.hourTo != null && h + 1 > pref.hourTo) continue;
      const start = dayStart + h * 3_600_000 - IST_OFFSET_MS;
      const end = start + 3_600_000;
      if (start < from || end > to) continue;
      if (!busy.some(([bs, be]) => start < be && end > bs)) return new Date(start).toISOString();
    }
  }
  return null;
}

export async function createConsultationEvent(p: {
  calendarId: string; eventId: string; start: string; summary: string; description: string;
}): Promise<Booking> {
  const end = new Date(Date.parse(p.start) + 3_600_000).toISOString();
  const tz = process.env.CALENDAR_TIMEZONE || "Asia/Kolkata";
  const res = await gfetch(`/calendars/${encodeURIComponent(p.calendarId)}/events`, {
    method: "POST",
    body: JSON.stringify({
      id: p.eventId, summary: p.summary, description: p.description,
      start: { dateTime: p.start, timeZone: tz }, end: { dateTime: end, timeZone: tz },
    }),
  });
  if (res.status === 409) {
    const existing = await getExistingEvent(p.calendarId, p.eventId);
    if (existing) return existing;
    throw new Error("Google Calendar event id conflict (event may have been deleted)");
  }
  if (!res.ok) throw new Error(`Google Calendar insert HTTP ${res.status}`);
  const e: any = await res.json();
  return { uid: e.id, start: e.start?.dateTime ?? p.start };
}
