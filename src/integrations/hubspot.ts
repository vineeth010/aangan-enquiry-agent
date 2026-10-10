/**
 * HubSpot (Nikhil's view). Two things are pushed, nothing else:
 *  1. Aggregate counts as number properties on ONE company record (HUBSPOT_COMPANY_ID).
 *  2. One Note per not-forwarded (disqualified) call on that same company record: the reason, the
 *     evidence quotes and the Vaani call id. Nikhil sees the counts first and expands a note to see
 *     why a call was discarded. Caller name / phone / email are deliberately NOT sent.
 *
 * ASSUMPTIONS to verify: properties named aangan_<metric> exist (run `npm run setup:hubspot`);
 * the private-app token has company read/write and note write scopes; note->company association
 * type id 190 (HubSpot-defined).
 */
import type { Aggregate } from "@/core/metrics";

const base = "https://api.hubapi.com";
// Strip anything that is not printable ASCII (stray BOM / newline from pasted env values breaks the header).
const clean = (v?: string) => v?.replace(/[^\x21-\x7e]/g, "");
const conf = () => ({ token: clean(process.env.HUBSPOT_TOKEN), id: clean(process.env.HUBSPOT_COMPANY_ID) });
export const hubspotConfigured = () => !!(conf().token && conf().id);

const hs = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${conf().token}`, "content-type": "application/json", ...(init.headers ?? {}) } });

export async function pushAggregate(m: Aggregate): Promise<"synced" | "skipped"> {
  if (!hubspotConfigured()) return "skipped";
  const properties = Object.fromEntries(Object.entries(m).map(([k, v]) => [`aangan_${k}`, v]));
  const res = await hs(`/crm/v3/objects/companies/${encodeURIComponent(conf().id!)}`, { method: "PATCH", body: JSON.stringify({ properties }) });
  if (!res.ok) throw new Error(`HubSpot aggregate HTTP ${res.status}`);
  return "synced";
}

export type RejectedNote = {
  vaaniCallId: string; callDate: string; outcomeLabel: string;
  reasons: string[]; summary: string; preferredTime?: string | null;
  criteria: { label: string; verdict: string; rationale: string; evidence: string[] }[];
  /** Caller identifiers (name, email, phone) that must never appear in HubSpot. */
  redact: (string | null | undefined)[];
};

/** Remove caller identifiers from free text: known name parts / email / phone, plus any email or long digit run. */
export function scrub(text: string, redact: (string | null | undefined)[]): string {
  let out = text;
  for (const term of redact) {
    if (!term) continue;
    const parts = [term, ...term.split(/\s+/)].filter((p) => p.replace(/\W/g, "").length >= 3);
    for (const p of parts) out = out.replace(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[caller]");
  }
  return out
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    .replace(/\+?\d[\d\s-]{7,}\d/g, "[phone]");
}

export async function createRejectedCallNote(n: RejectedNote): Promise<void> {
  const failed = n.criteria.filter((c) => c.verdict === "fail");
  const met = n.criteria.filter((c) => c.verdict === "pass");
  const open = n.criteria.filter((c) => c.verdict === "unclear");
  const s = (t: string) => esc(scrub(t, n.redact));
  const body = [
    `<b>${n.outcomeLabel}</b> · ${n.callDate}`,
    `<b>Why:</b> ${n.reasons.map(s).join("; ")}`,
    ...failed.map((c) => `<b>${esc(c.label)}:</b> ${s(c.rationale)}${c.evidence.length ? `<br><i>"${c.evidence.map(s).join('" | "')}"</i>` : ""}`),
    // Even a rejected call may satisfy some of the five criteria; Nikhil should see which ones.
    met.length
      ? `<b>Criteria met (${met.length} of ${n.criteria.length}):</b><br>${met.map((c) => `✓ ${esc(c.label)}: ${s(c.rationale)}`).join("<br>")}`
      : `<b>Criteria met:</b> none could be confirmed on this call`,
    open.length ? `<b>Not settled on the call:</b> ${open.map((c) => esc(c.label)).join(", ")}` : "",
    n.preferredTime ? `<b>Caller's preferred time for a call back:</b> ${s(n.preferredTime)}` : "",
    `<b>Call summary:</b> ${s(n.summary)}`,
    `<b>Vaani call id:</b> ${esc(n.vaaniCallId)} (transcript is in Vaani)`,
  ].filter(Boolean).join("<br><br>");
  const res = await hs("/crm/v3/objects/notes", {
    method: "POST",
    body: JSON.stringify({
      properties: { hs_timestamp: new Date().toISOString(), hs_note_body: body },
      associations: [{ to: { id: conf().id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 190 }] }],
    }),
  });
  if (!res.ok) throw new Error(`HubSpot note HTTP ${res.status}`);
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
