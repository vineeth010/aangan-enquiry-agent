// Fills Nikhil's HubSpot company record with the facts from the Case 03 brief and adds demo "not forwarded" notes.
//   npm run hubspot:demo            -> profile + baseline properties + [DEMO] notes (re-run safe)
//   npm run hubspot:demo -- --clear -> removes only the [DEMO] notes
// Needs HUBSPOT_TOKEN, HUBSPOT_COMPANY_ID and DATABASE_URL. Never prints the token.
import { config } from "dotenv";
config({ path: ".env.local" });
import { query } from "../src/lib/db";
import { createRejectedCallNote } from "../src/integrations/hubspot";

const clean = (v?: string) => (v ?? "").replace(/[^\x21-\x7e]/g, "");
const TOKEN = clean(process.env.HUBSPOT_TOKEN);
const ID = clean(process.env.HUBSPOT_COMPANY_ID);
const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const api = (path: string, init: RequestInit = {}) => fetch(`https://api.hubapi.com${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });

// Baseline facts from the case brief (labelled as such in HubSpot; they are not live numbers).
const BASELINE: { name: string; label: string; type: "number" | "string"; value: number | string }[] = [
  { name: "aangan_designers", label: "Aangan baseline: designers", type: "number", value: 14 },
  { name: "aangan_front_desk_staff", label: "Aangan baseline: front desk staff", type: "number", value: 2 },
  { name: "aangan_monthly_enquiries", label: "Aangan baseline: enquiries per month", type: "number", value: 200 },
  { name: "aangan_pct_no_reply_48h", label: "Aangan baseline: % with no reply in 48h", type: "number", value: 48 },
  { name: "aangan_pct_outside_desk_hours", label: "Aangan baseline: % arriving outside 10am-7pm", type: "number", value: 33 },
  { name: "aangan_conversion_uplift_1h", label: "Aangan baseline: conversion multiple if answered within 1h", type: "number", value: 4 },
  { name: "aangan_avg_project_value", label: "Aangan baseline: average project value", type: "string", value: "8 to 14 lakh" },
  { name: "aangan_service_area", label: "Aangan service area", type: "string", value: "Pune city and PCMC" },
  { name: "aangan_desk_hours", label: "Aangan front desk hours", type: "string", value: "10am to 7pm" },
];

async function clearDemoNotes() {
  const a = await (await api(`/crm/v4/objects/companies/${ID}/associations/notes`)).json();
  let removed = 0;
  for (const r of a.results ?? []) {
    const n = await (await api(`/crm/v3/objects/notes/${r.toObjectId}?properties=hs_note_body`)).json();
    if ((n.properties?.hs_note_body ?? "").includes("[DEMO]")) {
      await api(`/crm/v3/objects/notes/${r.toObjectId}`, { method: "DELETE" });
      removed++;
    }
  }
  return removed;
}

async function main() {
  if (!TOKEN || !ID) throw new Error("HUBSPOT_TOKEN / HUBSPOT_COMPANY_ID not set");
  const removed = await clearDemoNotes();
  console.log(`removed ${removed} old [DEMO] notes`);
  if (process.argv.includes("--clear")) return;

  // 1. Baseline custom properties (idempotent).
  for (const b of BASELINE) {
    const r = await api("/crm/v3/properties/companies", {
      method: "POST",
      body: JSON.stringify({ name: b.name, label: b.label, type: b.type, fieldType: b.type === "number" ? "number" : "text", groupName: "aangan_agent" }),
    });
    if (!r.ok && r.status !== 409) throw new Error(`property ${b.name}: HTTP ${r.status}`);
  }

  // 2. Company profile + baseline values.
  const properties: Record<string, string | number> = {
    name: "Aangan Studio",
    domain: "aangan-enquiry-agent-vineeth010.vercel.app",
    industry: "DESIGN",
    numberofemployees: 60,
    city: "Pune",
    state: "Maharashtra",
    country: "India",
    description:
      "Interior design studio in Pune: end-to-end design and execution for homes and small offices (up to ~3,000 sq ft) across Pune city and PCMC. 60 people including 14 designers. Phone enquiries are answered and qualified by the Aangan enquiry agent.",
    ...Object.fromEntries(BASELINE.map((b) => [b.name, b.value])),
  };
  const p = await api(`/crm/v3/objects/companies/${ID}`, { method: "PATCH", body: JSON.stringify({ properties }) });
  if (!p.ok) throw new Error(`company update: HTTP ${p.status} ${(await p.text()).slice(0, 200)}`);
  console.log("company profile + baseline properties updated");

  // 3. Demo "not forwarded" notes, built from the demo rows in Neon (caller identifiers redacted).
  const rows = await query<{ outcome: string; vaani_call_id: string; started_at: string | null; received_at: string; summary: string; reasons: string[]; criteria: Record<string, any>; caller_name: string | null; caller_email: string | null; caller_phone: string | null }>(
    `SELECT ev.outcome, c.vaani_call_id, c.started_at, c.received_at, ev.summary, ev.criteria, ev.decision_reasons AS reasons,
            ev.caller_name, ev.caller_email, c.caller_phone
     FROM calls c JOIN evaluations ev ON ev.call_id = c.id WHERE c.is_demo AND ev.outcome IN ('disqualified','unclear') ORDER BY c.started_at`,
  );
  const L: Record<string, string> = { real_project: "Real project", service_area: "Service area", timeline: "Timeline", budget: "Budget", decision_maker: "Decision-maker" };
  for (const r of rows) {
    const failed = Object.entries(r.criteria).filter(([, v]) => v.verdict === "fail").map(([k, v]) => `${L[k]}: ${v.rationale}`);
    await createRejectedCallNote({
      vaaniCallId: r.vaani_call_id,
      callDate: new Date(r.started_at ?? r.received_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " IST",
      outcomeLabel: r.outcome === "unclear" ? "[DEMO] Not forwarded: front desk to call back" : "[DEMO] Not forwarded to a designer",
      reasons: failed.length ? failed : r.reasons?.length ? r.reasons : [r.summary],
      summary: r.summary,
      redact: [r.caller_name, r.caller_email, r.caller_phone],
      criteria: Object.entries(r.criteria).map(([k, v]) => ({ label: L[k] ?? k, verdict: v.verdict, rationale: v.rationale, evidence: v.evidence ?? [] })),
    });
  }
  console.log(`created ${rows.length} [DEMO] not-forwarded notes`);
}
main().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
