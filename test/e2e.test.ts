import { test, before } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { query } from "../src/lib/db";
import { migrate } from "../scripts/migrate";
import { sha256 } from "../src/lib/auth";
import { signForTests } from "../src/integrations/vaani/signature";
import { POST as webhook } from "../src/app/api/webhooks/vaani/call-completed/route";
import { GET as designerGet } from "../src/app/api/designer/enquiries/route";
import { GET as metricsGet } from "../src/app/api/metrics/route";
import { processCall, retryPending } from "../src/core/pipeline";
import { eventIdFor } from "../src/integrations/gcal";
import { FIXTURES } from "./fixtures";

process.env.DATABASE_URL = "pglite:memory";
process.env.VAANI_WEBHOOK_SECRET = "whsec";
process.env.VAANI_SIGNATURE_HEADER = "x-webhook-signature";
process.env.GEMINI_API_KEY = "x";
process.env.RESEND_API_KEY = "x";
process.env.EMAIL_FROM = "t@example.com";
process.env.EMAIL_TEST_MODE = "false"; // redirect behaviour is covered separately in rules.test.ts
process.env.FOUNDER_TOKEN = "founder-token";
process.env.HUBSPOT_TOKEN = "hs";
process.env.HUBSPOT_COMPANY_ID = "42";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: "sa@proj.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});

// --- fake external world -------------------------------------------------
let lastPrompt = "";
const calls = { gemini: 0, inserts: 0, emails: [] as { to: string; subject: string; text: string }[], aggregates: 0, notes: [] as string[] };
const events = new Map<string, any>(); // calendarId/eventId -> event
let calFailTimes = 0;
const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

const crit = (v: string, ev: string[] = []) => ({ verdict: v, rationale: `why ${v}`, evidence: ev });
function geminiFor(prompt: string) {
  const t = prompt.split("<transcript>")[1];
  if (t.includes("COMPLAINT"))
    return { call_type: "existing_client_issue", summary: "Existing client unhappy about a delayed reply", project_summary: null, caller_name: "Sheetal", caller_email: null, handoff_note: "n",
      criteria: { real_project: crit("unclear"), service_area: crit("pass", ["Viman Nagar"]), timeline: crit("unclear"), budget: crit("unclear"), decision_maker: crit("unclear") } };
  if (t.includes("Nashik"))
    return { call_type: "new_enquiry", summary: "Suresh Patil (suresh@x.com, +91 98765 43210) asked about a Nashik home office", project_summary: "home office", caller_name: "Suresh Patil", caller_email: "suresh@x.com", handoff_note: "n",
      criteria: { real_project: crit("pass"), service_area: crit("fail", ["I'm in Nashik"]), timeline: crit("unclear"), budget: crit("pass"), decision_maker: crit("pass") } };
  return { call_type: "new_enquiry", summary: "Priya 3BHK", project_summary: "3BHK Kothrud full redesign", caller_name: "Priya", caller_email: "priya@example.com",
    handoff_note: "Referred by Shruti.",
    details: { space_type: "residential", locality: "Kothrud", size_sqft: 1400, timeline: "By March", lead_source: "Referral: Shruti Joshi", is_rented: false, preferred_time: "weekday evenings after 5", preferred_date: null, preferred_hour_from: 17, preferred_hour_to: 19 },
    criteria: { real_project: crit("pass", ["redo the whole thing"]), service_area: crit("pass", ["3BHK in Kothrud"]), timeline: crit("pass", ["done by March"]),
      budget: crit("unclear"), decision_maker: crit("pass", ["happy to go ahead"]) } };
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (url.includes("generativelanguage")) {
    calls.gemini++;
    const prompt = JSON.parse(init.body).contents[0].parts[0].text;
    lastPrompt = prompt;
    return ok({ candidates: [{ content: { parts: [{ text: JSON.stringify(geminiFor(prompt)) }] } }] });
  }
  if (url.includes("oauth2.googleapis.com/token")) return ok({ access_token: "tok", expires_in: 3600 });
  if (url.includes("googleapis.com/calendar") && url.endsWith("/freeBusy"))
    return ok({ calendars: { [JSON.parse(init.body).items[0].id]: { busy: [] } } });
  if (url.includes("googleapis.com/calendar") && method === "POST") {
    calls.inserts++;
    if (calFailTimes > 0) { calFailTimes--; return new Response("{}", { status: 500 }); }
    const b = JSON.parse(init.body);
    const key = decodeURIComponent(url.split("/calendars/")[1].split("/events")[0]) + "/" + b.id;
    if (events.has(key)) return new Response("{}", { status: 409 });
    events.set(key, b);
    return ok({ id: b.id, start: b.start });
  }
  if (url.includes("googleapis.com/calendar") && method === "GET") {
    const m = url.split("/calendars/")[1].split("/events/");
    const e = events.get(decodeURIComponent(m[0]) + "/" + m[1]);
    return e ? ok({ id: m[1], start: e.start }) : new Response("{}", { status: 404 });
  }
  if (url.includes("resend.com")) { const b = JSON.parse(init.body); calls.emails.push({ to: b.to[0], subject: b.subject, text: b.text }); return ok({ id: "e" }); }
  if (url.includes("hubapi.com/crm/v3/objects/notes")) { calls.notes.push(init.body); return ok({ id: "n" }, 201); }
  if (url.includes("hubapi.com")) { calls.aggregates++; return ok({}); }
  throw new Error("unexpected fetch " + url);
}) as typeof fetch;

/** Wrap a (callId, transcript) into Vaani's verified call_postprocessing envelope and sign it. */
function vaaniBody(callId: string, transcript?: string, extra: object[] = []) {
  const ts = "2026-09-25T09:15:00+00:00";
  return {
    event: "call_postprocessing_batch", timestamp: ts,
    events: [...extra, { event: "call_postprocessing", call_id: callId, timestamp: ts, data: { room_name: callId, call_id: callId, call_duration: 120, end_reason: "completed", ...(transcript ? { transcript } : {}) } }],
  };
}
const post = (body: object, sig?: string) => {
  const raw = JSON.stringify(body);
  return webhook(new Request("http://x/api/webhooks/vaani/call-completed", {
    method: "POST", headers: { "x-webhook-signature": sig ?? "sha256=" + signForTests(raw, "whsec") }, body: raw,
  }));
};
const first = async (res: Response) => (await res.json()).results[0] as { callId: string; duplicate: boolean; status: string };

before(async () => {
  await migrate();
  await query(`INSERT INTO designers (name,email,access_token_hash,calendar_id) VALUES
    ('Asha','asha@studio.test',$1,'asha@studio.test'), ('Ravi','ravi@studio.test',$2,'ravi@studio.test')`, [sha256("tok-asha"), sha256("tok-ravi")]);
});

test("bad signature is rejected and nothing is stored", async () => {
  const res = await post(vaaniBody("bad", "hi"), "sha256=deadbeef");
  assert.equal(res.status, 401);
  assert.equal((await query("SELECT 1 FROM calls")).length, 0);
});

test("Vaani's webhook_test delivery is acknowledged but not stored", async () => {
  const res = await post({ event: "webhook_test", timestamp: "x", events: [{ event: "call_postprocessing", call_id: "test_room_123", data: { transcript: "x" } }] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).test, true);
  assert.equal((await query("SELECT 1 FROM calls")).length, 0);
});

test("qualified call: persist -> evaluate -> assign -> Google Calendar -> notify; duplicates are safe", async () => {
  const body = vaaniBody("c-1", FIXTURES.t01);
  const r = await first(await post(body));
  const id = r.callId;
  // persisted before evaluation (after() isn't running outside Next, so evaluation hasn't happened)
  assert.equal((await query("SELECT status FROM calls WHERE id=$1", [id]))[0].status, "received");
  assert.equal((await query("SELECT 1 FROM evaluations")).length, 0);

  const dup = await first(await post(body));
  assert.equal(dup.duplicate, true);
  await Promise.all([processCall(id), processCall(id)]);
  await processCall(id);

  assert.equal(calls.gemini, 1, "evaluated exactly once");
  // Gemini must be told the call's date (from the payload timestamp, in IST) to resolve phrases like "by March".
  assert.match(lastPrompt, /TODAY is the date of this call: Friday, 25 September 2026/);
  assert.equal(calls.inserts, 1, "calendar event created exactly once");
  assert.equal((await query("SELECT outcome FROM evaluations WHERE call_id=$1", [id]))[0].outcome, "qualified");
  const q = (await query("SELECT booking_status, calendar_event_id FROM enquiries WHERE call_id=$1", [id]))[0];
  assert.equal(q.booking_status, "booked");
  assert.equal(q.calendar_event_id, eventIdFor(id));
  assert.deepEqual(calls.emails.map((e) => e.to).sort(), ["asha@studio.test", "priya@example.com"]);
  // The caller's preferred window (evenings after 5) is honoured: the event starts at 17:00 IST, and both emails mention it.
  assert.match(String([...events.values()][0].start.dateTime), /T11:30:00/);
  assert.match(calls.emails.find((e) => e.to === "priya@example.com")!.text, /weekday evenings after 5/);
  assert.match(calls.emails.find((e) => e.to === "asha@studio.test")!.text, /preferred time: weekday evenings after 5/);
  assert.equal((await query("SELECT delivery_count FROM calls WHERE id=$1", [id]))[0].delivery_count, 2);
});

test("disqualified call: stored with evidence, no enquiry, no email, ONE HubSpot note without caller PII", async () => {
  const emailsBefore = calls.emails.length;
  const id = (await first(await post(vaaniBody("c-2", FIXTURES.t03)))).callId;
  await processCall(id);
  await processCall(id);
  const ev = (await query("SELECT outcome, criteria FROM evaluations WHERE call_id=$1", [id]))[0];
  assert.equal(ev.outcome, "disqualified");
  assert.deepEqual(ev.criteria.service_area.evidence, ["I'm in Nashik"]);
  assert.equal((await query("SELECT 1 FROM enquiries WHERE call_id=$1", [id])).length, 0);
  assert.equal(calls.emails.length, emailsBefore);
  assert.equal(calls.notes.length, 1, "exactly one note, even though processed twice");
  const note = calls.notes[0];
  assert.match(note, /Service area/);
  assert.match(note, /I&#39;m in Nashik|I'm in Nashik/);
  assert.match(note, /c-2/);
  assert.doesNotMatch(note, /Suresh|Patil/i);
  assert.doesNotMatch(note, /suresh@x\.com|98765/);
  assert.match(note, /\[caller\]/);
  assert.match(note, /"id":"42"/);
});

test("booking failure is flagged, then retry is idempotent (no second calendar event)", async () => {
  calFailTimes = 1; const before = calls.inserts;
  const id = (await first(await post(vaaniBody("c-3", FIXTURES.t01 + " ")))).callId;
  await processCall(id);
  let q = (await query("SELECT booking_status, last_error FROM enquiries WHERE call_id=$1", [id]))[0];
  assert.equal(q.booking_status, "failed");
  assert.match(q.last_error, /500/);
  assert.ok(calls.emails.some((e) => e.subject.startsWith("[ACTION NEEDED]")));

  await retryPending();
  await retryPending();
  q = (await query("SELECT booking_status FROM enquiries WHERE call_id=$1", [id]))[0];
  assert.equal(q.booking_status, "booked");
  assert.equal(calls.inserts - before, 2, "1 failed attempt + 1 success, none after");
  // a crashed-after-insert retry finds the existing event by its deterministic id instead of creating another
  await query("UPDATE enquiries SET booking_status='failed', booking_attempts=1 WHERE call_id=$1", [id]);
  await retryPending();
  assert.equal(calls.inserts - before, 2);
  assert.equal((await query("SELECT booking_status FROM enquiries WHERE call_id=$1", [id]))[0].booking_status, "booked");
});

test("demo rows never trigger calendar events or emails, even through the retry job", async () => {
  const [call] = await query<{ id: string }>(`INSERT INTO calls (vaani_call_id, raw_payload, status, transcript, is_demo) VALUES ('demo-x','{}'::jsonb,'evaluated','t',true) RETURNING id`);
  await query(`INSERT INTO evaluations (call_id,outcome,call_type,criteria,decision_reasons,summary,model) VALUES ($1,'qualified','new_enquiry','{}'::jsonb,'[]'::jsonb,'s','demo-seed')`, [call.id]);
  const designer = (await query<{ id: string }>(`SELECT id FROM designers LIMIT 1`))[0];
  await query(`INSERT INTO enquiries (call_id,designer_id,booking_status) VALUES ($1,$2,'failed')`, [call.id, designer.id]);
  const before = { inserts: calls.inserts, emails: calls.emails.length };
  await retryPending();
  assert.equal(calls.inserts, before.inserts);
  assert.equal(calls.emails.length, before.emails);
  assert.equal((await query(`SELECT booking_status FROM enquiries WHERE call_id=$1`, [call.id]))[0].booking_status, "failed");
  await query(`DELETE FROM enquiries WHERE call_id=$1`, [call.id]);
  await query(`DELETE FROM evaluations WHERE call_id=$1`, [call.id]);
  await query(`DELETE FROM calls WHERE id=$1`, [call.id]);
});

test("event without transcript is stored but not evaluated; other event types in a batch are ignored", async () => {
  const g = calls.gemini;
  const res = await (await post(vaaniBody("c-4", undefined, [{ event: "call_started", call_id: "c-4" }]))).json();
  assert.equal(res.ignoredEvents, 1);
  assert.equal(res.results[0].status, "needs_transcript");
  await processCall(res.results[0].callId);
  assert.equal(calls.gemini, g);
});

test("unclear call: not forwarded, no designer/email, HubSpot note says front desk to call back and lists criteria still met", async () => {
  const emailsBefore = calls.emails.length, notesBefore = calls.notes.length;
  const id = (await first(await post(vaaniBody("c-5", "Caller: This is a COMPLAINT about my project in Viman Nagar, nobody replied.")))).callId;
  await processCall(id);
  await processCall(id);
  assert.equal((await query("SELECT outcome FROM evaluations WHERE call_id=$1", [id]))[0].outcome, "unclear");
  assert.equal((await query("SELECT 1 FROM enquiries WHERE call_id=$1", [id])).length, 0);
  assert.equal(calls.emails.length, emailsBefore);
  assert.equal(calls.notes.length, notesBefore + 1, "exactly one note");
  const note = calls.notes[calls.notes.length - 1];
  assert.match(note, /front desk to call back/);
  assert.match(note, /Criteria met \(1 of 5\)/);
  assert.match(note, /Service area/);
  assert.doesNotMatch(note, /Sheetal/);
});

test("role access: designer sees only own enquiries; founder sees aggregates only", async () => {
  const asha = await (await designerGet(new Request("http://x", { headers: { authorization: "Bearer tok-asha" } }))).json();
  const ravi = await (await designerGet(new Request("http://x", { headers: { authorization: "Bearer tok-ravi" } }))).json();
  assert.equal(asha.enquiries.length + ravi.enquiries.length, 2);
  assert.ok(asha.enquiries.every((e: any) => !("transcript" in e)));
  const withDetails = [...asha.enquiries, ...ravi.enquiries].find((e: any) => e.details?.locality === "Kothrud");
  assert.equal(withDetails.details.size_sqft, 1400);
  assert.equal(withDetails.details.lead_source, "Referral: Shruti Joshi");
  assert.equal((await designerGet(new Request("http://x", { headers: { authorization: "Bearer nope" } }))).status, 401);

  const m = await (await metricsGet(new Request("http://x", { headers: { authorization: "Bearer founder-token" } }))).json();
  assert.deepEqual(Object.keys(m).sort(), ["bookings_confirmed", "bookings_failed", "calls_total", "disqualified", "evaluated", "not_forwarded", "qualified", "unclear"]);
  assert.equal(m.qualified, 2);
  assert.equal(m.disqualified, 1);
  assert.equal(m.unclear, 1);
  assert.equal(m.not_forwarded, 2);
  assert.equal((await metricsGet(new Request("http://x"))).status, 401);
});
