import { query } from "@/lib/db";
import type { NormalizedCall } from "@/integrations/vaani/payload";
import { evaluateWithGemini } from "@/integrations/gemini";
import { createConsultationEvent, eventIdFor, firstAvailableSlot, getExistingEvent } from "@/integrations/gcal";
import { sendEmail } from "@/integrations/resend";
import { createRejectedCallNote, hubspotConfigured, pushAggregate } from "@/integrations/hubspot";
import { getAggregate } from "./metrics";
import { decide, sanitizeCriteria } from "./rules";

const MAX_BOOKING_ATTEMPTS = 5;
const log = (...a: unknown[]) => console.log("[pipeline]", ...a);

/* ------------------------------------------------------------------ ingest */

/** Persist the call BEFORE any evaluation. Duplicate deliveries collapse onto one row. */
export async function ingestCall(raw: string, json: unknown, n: NormalizedCall) {
  const status = n.transcript ? "received" : "needs_transcript";
  const rows = await query<{ id: string; inserted: boolean; status: string }>(
    `INSERT INTO calls (vaani_call_id, raw_payload, caller_phone, started_at, duration_seconds, transcript, status, last_error)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (vaani_call_id) DO UPDATE SET
       delivery_count = calls.delivery_count + 1,
       transcript = COALESCE(calls.transcript, EXCLUDED.transcript),
       status = CASE WHEN calls.status = 'needs_transcript' AND EXCLUDED.transcript IS NOT NULL
                     THEN 'received' ELSE calls.status END
     RETURNING id, (xmax = 0) AS inserted, status`,
    [
      n.vaaniCallId,
      JSON.stringify(json ?? { unparsed: raw.slice(0, 2000) }),
      n.callerPhone,
      n.startedAt,
      n.durationSeconds,
      n.transcript,
      status,
      n.transcript ? null : "Webhook payload carried no recognisable transcript (see vaani/payload.ts)",
    ],
  );
  return rows[0];
}

/* --------------------------------------------------------------- evaluation */

export async function processCall(callId: string) {
  // Atomic claim: only one worker evaluates a call, and only once it has a transcript.
  const claimed = await query<{ id: string; transcript: string; call_at: string }>(
    `UPDATE calls SET status='evaluating', last_error=NULL
     WHERE id=$1 AND status IN ('received','eval_failed') AND transcript IS NOT NULL
     RETURNING id, transcript, COALESCE(started_at, received_at) AS call_at`,
    [callId],
  );
  if (!claimed.length) return;
  const { transcript, call_at } = claimed[0];
  try {
    const { result, model } = await evaluateWithGemini(transcript, new Date(call_at));
    const criteria = sanitizeCriteria(transcript, result.criteria);
    const d = decide(result.call_type, criteria);
    const email = result.caller_email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.caller_email) ? result.caller_email : null;
    await query(
      `INSERT INTO evaluations (call_id, outcome, call_type, criteria, decision_reasons, summary, handoff_note,
         caller_name, caller_email, project_summary, uncertainties, model, details)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb)
       ON CONFLICT (call_id) DO NOTHING`,
      [
        callId, d.outcome, result.call_type, JSON.stringify(criteria), JSON.stringify(d.reasons),
        result.summary, result.handoff_note, result.caller_name, email, result.project_summary,
        JSON.stringify(d.uncertainties), model, JSON.stringify(result.details ?? {}),
      ],
    );
    await query(`UPDATE calls SET status='evaluated' WHERE id=$1`, [callId]);
  } catch (e) {
    await query(`UPDATE calls SET status='eval_failed', last_error=$2 WHERE id=$1`, [callId, (e as Error).message]);
    log("evaluation failed", callId, (e as Error).message);
    return;
  }
  await routeQualified(callId).catch((e) => log("routing error", callId, (e as Error).message));
  await routeRejected(callId).catch((e) => log("rejected-call routing error", callId, (e as Error).message));
  await syncMetrics();
}

export async function syncMetrics() {
  try {
    await pushAggregate(await getAggregate());
  } catch (e) {
    log("HubSpot sync failed", (e as Error).message);
  }
}

/* ------------------------------------------------------------------ routing */

type Ctx = {
  call_id: string; outcome: string; caller_name: string | null; caller_email: string | null;
  caller_phone: string | null; handoff_note: string | null; project_summary: string | null;
  criteria: Record<string, { verdict: string; rationale: string; evidence: string[] }>;
  uncertainties: string[]; is_demo: boolean; details: Record<string, any> | null;
  enquiry_id: string | null; designer_id: string | null; booking_status: string | null;
  booking_attempts: number | null; scheduled_start: string | null; last_error: string | null;
  designer_name: string | null; designer_email: string | null; calendar_id: string | null;
};

const loadCtx = async (callId: string) =>
  (await query<Ctx>(
    `SELECT ev.call_id, ev.outcome, ev.caller_name, ev.caller_email, c.caller_phone, ev.handoff_note,
            ev.project_summary, ev.criteria, ev.uncertainties, c.is_demo, ev.details,
            q.id AS enquiry_id, q.designer_id, q.booking_status, q.booking_attempts, q.scheduled_start, q.last_error,
            d.name AS designer_name, d.email AS designer_email, COALESCE(d.calendar_id, d.email) AS calendar_id
     FROM evaluations ev JOIN calls c ON c.id = ev.call_id
     LEFT JOIN enquiries q ON q.call_id = ev.call_id
     LEFT JOIN designers d ON d.id = q.designer_id
     WHERE ev.call_id = $1`,
    [callId],
  ))[0];

/** Idempotent + resumable: safe to call repeatedly (retry job does exactly that). */
export async function routeQualified(callId: string) {
  let ctx = await loadCtx(callId);
  if (!ctx || ctx.outcome !== "qualified" || ctx.is_demo) return; // demo rows never trigger real side effects

  // 1. Assign designer (least recently assigned), once.
  await query(`INSERT INTO enquiries (call_id) VALUES ($1) ON CONFLICT (call_id) DO NOTHING`, [callId]);
  const assigned = await query(
    `UPDATE enquiries SET designer_id = (SELECT id FROM designers WHERE active ORDER BY last_assigned_at NULLS FIRST, name LIMIT 1)
     WHERE call_id=$1 AND designer_id IS NULL AND EXISTS (SELECT 1 FROM designers WHERE active) RETURNING designer_id`,
    [callId],
  );
  if (assigned.length) await query(`UPDATE designers SET last_assigned_at = now() WHERE id=$1`, [assigned[0].designer_id]);
  ctx = await loadCtx(callId);
  if (!ctx.designer_id) {
    await alertOps(callId, "unassigned", "No active designer available to assign.");
    return;
  }

  // 2. Book on the designer's Google Calendar (claim -> lookup by deterministic id -> create); failures are flagged, not thrown.
  const claim = await query(
    `UPDATE enquiries SET booking_status='booking', booking_attempts = booking_attempts + 1, booking_attempted_at = now()
     WHERE id=$1 AND ((booking_status IN ('pending','failed') AND booking_attempts < $2)
                      OR (booking_status='booking' AND booking_attempted_at < now() - interval '5 minutes'))
     RETURNING id`,
    [ctx.enquiry_id, MAX_BOOKING_ATTEMPTS],
  );
  if (claim.length) {
    try {
      if (!ctx.calendar_id) throw new Error("Designer has no calendar configured");
      const eventId = eventIdFor(callId);
      let b = await getExistingEvent(ctx.calendar_id, eventId);
      if (!b) {
        const d = ctx.details ?? {};
        const pref = { date: d.preferred_date, hourFrom: d.preferred_hour_from, hourTo: d.preferred_hour_to };
        const hasPref = !!(pref.date || pref.hourFrom != null || pref.hourTo != null);
        // Honour the caller's preferred time when a free slot matches; otherwise fall back to the first free slot.
        const slot = (hasPref ? await firstAvailableSlot(ctx.calendar_id, pref) : null) ?? (await firstAvailableSlot(ctx.calendar_id));
        if (!slot) throw new Error("No available slot in the next 14 days");
        b = await createConsultationEvent({
          calendarId: ctx.calendar_id, eventId, start: slot,
          summary: `Aangan consultation: ${ctx.caller_name || "new enquiry"}`,
          description: calendarDescription(ctx),
        });
      }
      await query(
        `UPDATE enquiries SET booking_status='booked', calendar_event_id=$2, scheduled_start=$3, last_error=NULL WHERE id=$1`,
        [ctx.enquiry_id, b.uid, b.start],
      );
    } catch (e) {
      await query(`UPDATE enquiries SET booking_status='failed', last_error=$2 WHERE id=$1`, [ctx.enquiry_id, (e as Error).message]);
    }
  }

  // 3. Notifications (each sent at most once).
  ctx = await loadCtx(callId);
  const state = ctx.booking_status;
  if (state === "booking" || state === "pending") return; // in flight elsewhere
  const manual = state !== "booked";
  const when = ctx.scheduled_start
    ? new Date(ctx.scheduled_start).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) + " IST"
    : null;

  await sendOnce(callId, manual ? "designer_handoff_manual" : "designer_handoff_booked", ctx.designer_email!,
    `${manual ? "[ACTION NEEDED] " : ""}New qualified enquiry: ${ctx.caller_name ?? "Unnamed caller"}`,
    designerEmail(ctx, manual, when));
  if (state === "booked" && ctx.caller_email) {
    const pt = ctx.details?.preferred_time;
    await sendOnce(callId, "client_confirmation", ctx.caller_email, "Your Aangan Studio consultation is booked",
      [
        `Hello ${ctx.caller_name ?? "there"},`,
        "",
        "Thank you for calling Aangan Studio. Your free consultation is booked:",
        "",
        `  Date and time: ${when}`,
        `  With: ${ctx.designer_name}, Aangan Studio`,
        "",
        pt ? `You mentioned that ${pt} suits you; we have scheduled the closest slot we could.` : "",
        "Your designer will walk you through the scope, materials and pricing at the consultation, with no obligation.",
        "",
        "If this time does not work, just reply to this email and we will find another. Our front desk is also available from 10am to 7pm.",
        "",
        "Warm regards,",
        "Aangan Studio, Pune",
      ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n"));
  }
  if (manual) await alertOps(callId, state!, ctx.last_error ?? "");
}

function calendarDescription(c: Ctx) {
  return [
    `Caller: ${c.caller_name ?? "n/a"} | Phone: ${c.caller_phone ?? "n/a"} | Email: ${c.caller_email ?? "n/a (not captured; call to confirm)"}`,
    `Project: ${c.project_summary ?? "n/a"}`,
    c.details?.preferred_time ? `Caller's preferred time: ${c.details.preferred_time}` : "",
    `Handoff: ${c.handoff_note ?? ""}`,
    c.uncertainties?.length ? `Confirm at consultation: ${c.uncertainties.join("; ")}` : "",
  ].filter(Boolean).join("\n");
}

function designerEmail(c: Ctx, manual: boolean, when: string | null) {
  const crit = Object.entries(c.criteria)
    .map(([k, v]) => `- ${k}: ${v.verdict.toUpperCase()} — ${v.rationale}${v.evidence.length ? `\n    evidence: "${v.evidence.join('" | "')}"` : ""}`)
    .join("\n");
  return [
    manual
      ? `BOOKING NOT CONFIRMED (${c.booking_status}): ${c.last_error ?? ""}. Please contact the caller to arrange the consultation.`
      : `Consultation booked: ${when} (added to your Google Calendar)${c.caller_email ? "" : ". No caller email was captured, so no confirmation was sent: please call to confirm the time."}`,
    "",
    `Caller: ${c.caller_name ?? "n/a"} | Phone: ${c.caller_phone ?? "n/a"} | Email: ${c.caller_email ?? "n/a"}`,
    `Project: ${c.project_summary ?? "n/a"}`,
    c.details?.preferred_time ? `Caller's preferred time: ${c.details.preferred_time}` : "",
    "",
    `Handoff note: ${c.handoff_note ?? ""}`,
    c.uncertainties?.length ? `\nTo confirm at consultation:\n${c.uncertainties.map((u) => `- ${u}`).join("\n")}` : "",
    "",
    "Qualification rationale:",
    crit,
  ].join("\n");
}

async function alertOps(callId: string, kind: string, detail: string) {
  const to = process.env.OPS_ALERT_EMAIL;
  if (!to) return;
  // Deliberately no caller details: just the flag and technical reason.
  await sendOnce(callId, `ops_${kind}`, to, `Aangan agent: enquiry needs attention (${kind})`,
    `Call record ${callId} needs follow-up: ${kind}.\nReason: ${detail}\nDesigner view has the details.`);
}

/** Run a side effect at most once per (call, kind); failed or stale-'sending' attempts can be retried. */
async function once(callId: string, kind: string, effect: () => Promise<void>) {
  const claimed = await query(
    `INSERT INTO notifications (call_id, kind) VALUES ($1,$2)
     ON CONFLICT (call_id, kind) DO UPDATE SET status='sending', error=NULL, created_at=now()
       WHERE notifications.status='failed' OR (notifications.status='sending' AND notifications.created_at < now() - interval '10 minutes')
     RETURNING id`,
    [callId, kind],
  );
  if (!claimed.length) return;
  try {
    await effect();
    await query(`UPDATE notifications SET status='sent' WHERE call_id=$1 AND kind=$2`, [callId, kind]);
  } catch (e) {
    await query(`UPDATE notifications SET status='failed', error=$3 WHERE call_id=$1 AND kind=$2`, [callId, kind, (e as Error).message]);
  }
}

const sendOnce = (callId: string, kind: string, to: string, subject: string, text: string) =>
  once(callId, kind, () => sendEmail({ to, subject, text, idempotencyKey: `${callId}:${kind}` }));

/* ---------------------------------------------------- rejected calls -> HubSpot */

const CRITERION_LABEL: Record<string, string> = {
  real_project: "Real project", service_area: "Service area", timeline: "Timeline", budget: "Budget", decision_maker: "Decision-maker",
};

/**
 * Every call that is NOT forwarded to a designer (disqualified, or unclear / outside the rubric) is visible
 * to Nikhil in HubSpot as a count plus an expandable note (why, which criteria were still met, Vaani call id).
 * For unclear calls the voice agent has promised a front-desk callback; nothing else is automated for them.
 */
export async function routeRejected(callId: string) {
  if (!hubspotConfigured()) return;
  const [r] = await query<{ preferred_time: string | null; outcome: string; summary: string; criteria: Record<string, any>; reasons: string[]; vaani_call_id: string; started_at: string | null; received_at: string; caller_name: string | null; caller_email: string | null; caller_phone: string | null }>(
    `SELECT ev.outcome, ev.summary, ev.criteria, ev.decision_reasons AS reasons, c.vaani_call_id, c.started_at, c.received_at,
            ev.caller_name, ev.caller_email, c.caller_phone, ev.details->>'preferred_time' AS preferred_time
     FROM evaluations ev JOIN calls c ON c.id = ev.call_id WHERE ev.call_id=$1 AND NOT c.is_demo`,
    [callId],
  );
  if (!r || (r.outcome !== "disqualified" && r.outcome !== "unclear")) return;
  await once(callId, "hubspot_rejected_note", () =>
    createRejectedCallNote({
      vaaniCallId: r.vaani_call_id,
      callDate: new Date(r.started_at ?? r.received_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " IST",
      outcomeLabel: r.outcome === "unclear" ? "Not forwarded: front desk to call back" : "Not forwarded to a designer",
      reasons: r.reasons,
      summary: r.summary,
      preferredTime: r.preferred_time,
      redact: [r.caller_name, r.caller_email, r.caller_phone],
      criteria: Object.entries(r.criteria).map(([k, v]) => ({ label: CRITERION_LABEL[k] ?? k, verdict: v.verdict, rationale: v.rationale, evidence: v.evidence ?? [] })),
    }),
  );
}

/* -------------------------------------------------------------------- retry */

export async function retryPending() {
  const stuckCalls = await query<{ id: string }>(
    `SELECT id FROM calls WHERE transcript IS NOT NULL AND (status='eval_failed' OR status='received'
       OR (status='evaluating' AND received_at < now() - interval '10 minutes'))`,
  );
  for (const c of stuckCalls) {
    await query(`UPDATE calls SET status='eval_failed' WHERE id=$1 AND status='evaluating'`, [c.id]);
    await processCall(c.id);
  }
  const routes = await query<{ call_id: string }>(
    `SELECT ev.call_id FROM evaluations ev JOIN calls c ON c.id = ev.call_id LEFT JOIN enquiries q ON q.call_id = ev.call_id
     WHERE ev.outcome='qualified' AND NOT c.is_demo AND (q.id IS NULL OR q.designer_id IS NULL OR q.booking_status IN ('pending','failed','booking')
       OR NOT EXISTS (SELECT 1 FROM notifications n WHERE n.call_id = ev.call_id AND n.kind LIKE 'designer_handoff%' AND n.status='sent')
       OR EXISTS (SELECT 1 FROM notifications n WHERE n.call_id = ev.call_id AND n.status IN ('failed','sending')))`,
  );
  for (const r of routes) await routeQualified(r.call_id);
  const rejected = hubspotConfigured()
    ? await query<{ call_id: string }>(
        `SELECT ev.call_id FROM evaluations ev JOIN calls c ON c.id = ev.call_id
         WHERE ev.outcome IN ('disqualified','unclear') AND NOT c.is_demo
           AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.call_id = ev.call_id AND n.kind='hubspot_rejected_note' AND n.status='sent')`)
    : [];
  for (const r of rejected) await routeRejected(r.call_id);
  await syncMetrics();
  return { evaluationsRetried: stuckCalls.length, routesRetried: routes.length, rejectedNotesRetried: rejected.length };
}
