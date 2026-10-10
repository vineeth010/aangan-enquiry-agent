"use client";
import { useEffect, useMemo, useState } from "react";

type Crit = { verdict: "pass" | "fail" | "unclear"; rationale: string; evidence: string[] };
type Details = {
  space_type?: "residential" | "commercial" | null; locality?: string | null; size_sqft?: number | null;
  timeline?: string | null; lead_source?: string | null; is_rented?: boolean | null;
};
type Enquiry = {
  id: string; created_at: string; started_at: string | null; is_demo: boolean;
  duration_seconds: number | null; details: Details;
  booking_status: "booked" | "failed" | "needs_email" | "pending" | "booking";
  scheduled_start: string | null; last_error: string | null;
  caller_name: string | null; caller_email: string | null; caller_phone: string | null;
  project_summary: string | null; handoff_note: string | null;
  criteria: Record<string, Crit>; uncertainties: string[];
};

const LABEL: Record<string, string> = {
  real_project: "Real project", service_area: "Service area", timeline: "Timeline", budget: "Budget", decision_maker: "Decision-maker",
};
const fmt = (s: string | null, opts: Intl.DateTimeFormatOptions) =>
  s ? new Date(s).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", ...opts }) : "n/a";
const needsAction = (q: Enquiry) => q.booking_status !== "booked";

/** Front desk covers 10am-7pm IST; ~1/3 of real enquiries arrive outside that. */
function afterHours(iso: string | null) {
  if (!iso) return false;
  const h = Number(new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }));
  return h < 10 || h >= 19;
}
const mins = (s: number | null) => (s == null ? null : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);

function chips(q: Enquiry) {
  const d = q.details ?? {};
  const out: [string, string][] = [];
  if (d.space_type) out.push(["Type", d.space_type === "commercial" ? "Commercial" : "Residential"]);
  if (d.locality) out.push(["Area", d.locality]);
  if (d.size_sqft) out.push(["Size", `${d.size_sqft.toLocaleString("en-IN")} sq ft`]);
  if (d.timeline) out.push(["Timeline", d.timeline]);
  if (d.is_rented) out.push(["Property", "Rented"]);
  if (d.lead_source) out.push(["Lead source", d.lead_source]);
  return out;
}

// Baseline figures from the Case 03 brief (not live numbers).
const STUDIO: [string, string][] = [
  ["Team", "60 people, 14 designers"], ["Front desk", "2 people, 10am to 7pm"], ["Enquiries", "~200 per month"],
  ["No reply in 48h", "~48% (before this agent)"], ["Outside desk hours", "~33% of enquiries"],
  ["Speed matters", "Answered within 1h converts 4× vs next day"], ["Average project", "8 to 14 lakh"],
];

export default function DesignerPage() {
  const [token, setToken] = useState("");
  const [data, setData] = useState<{ designer: string; enquiries: Enquiry[] } | null>(null);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "action" | "booked">("all");

  async function load(t: string) {
    setErr("");
    const res = await fetch("/api/designer/enquiries", { headers: { authorization: `Bearer ${t}` } });
    if (!res.ok) { setData(null); setErr(res.status === 401 ? "Wrong password." : "Couldn't load enquiries."); return; }
    const d = await res.json();
    setData(d); setSel(d.enquiries[0]?.id ?? null);
    try { sessionStorage.setItem("designer_token", t); } catch {}
  }
  useEffect(() => {
    try { const t = sessionStorage.getItem("designer_token"); if (t) { setToken(t); load(t); } } catch {}
  }, []);

  const list = useMemo(() => (data?.enquiries ?? []).filter((q) => filter === "all" || (filter === "action" ? needsAction(q) : !needsAction(q))), [data, filter]);
  const current = list.find((q) => q.id === sel) ?? list[0] ?? null;

  if (!data)
    return (
      <main className="gate">
        <form onSubmit={(e) => { e.preventDefault(); load(token); }} className="card gate-card">
          <h1>Designer dashboard</h1>
          <p className="muted">Enter your password to see the enquiries assigned to you.</p>
          <input type="password" placeholder="Password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
          <button type="submit">Sign in</button>
          {err && <p className="err">{err}</p>}
        </form>
      </main>
    );

  const total = data.enquiries.length;
  const action = data.enquiries.filter(needsAction).length;
  const upcoming = data.enquiries.filter((q) => q.booking_status === "booked" && q.scheduled_start && new Date(q.scheduled_start) > new Date()).length;

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <h1>Assigned enquiries</h1>
          <p className="muted">Signed in as <b>{data.designer}</b>{data.enquiries.some((q) => q.is_demo) && <span className="pill demo">Demo data</span>}</p>
        </div>
        <button className="ghost" onClick={() => { try { sessionStorage.removeItem("designer_token"); } catch {} setData(null); setToken(""); }}>Sign out</button>
      </header>

      <section className="stats">
        <div className="card stat"><span>{total}</span>Qualified enquiries</div>
        <div className="card stat"><span>{upcoming}</span>Consultations booked</div>
        <div className={`card stat ${action ? "warn" : ""}`}><span>{action}</span>Need your follow-up</div>
      </section>

      <details className="card snapshot">
        <summary>Studio snapshot · Aangan Studio, Pune <span className="muted small">(case baseline)</span></summary>
        <div className="snap-grid">
          {STUDIO.map(([k, v]) => <div key={k}><span className="muted small">{k}</span><br /><b>{v}</b></div>)}
          <div><span className="muted small">Your leads called after hours</span><br /><b>{data.enquiries.filter((q) => afterHours(q.started_at ?? q.created_at)).length} of {total}</b></div>
        </div>
      </details>

      <div className="tabs">
        {([["all", "All"], ["action", "Needs follow-up"], ["booked", "Booked"]] as const).map(([k, l]) => (
          <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>

      <div className="split">
        <ul className="list">
          {list.map((q) => (
            <li key={q.id}>
              <button className={`item ${q.id === current?.id ? "sel" : ""}`} onClick={() => setSel(q.id)}>
                <div className="row"><b>{q.caller_name ?? "Name not captured"}</b>
                  <span className={`pill ${needsAction(q) ? "bad" : "ok"}`}>{q.booking_status === "booked" ? "Booked" : "Follow up"}</span></div>
                <div className="muted clamp">{q.project_summary}</div>
                <div className="mini">{[q.details?.locality, q.details?.size_sqft ? `${q.details.size_sqft.toLocaleString("en-IN")} sq ft` : null, afterHours(q.started_at ?? q.created_at) ? "after hours" : null].filter(Boolean).join(" · ")}</div>
                <div className="muted small">{fmt(q.started_at ?? q.created_at, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</div>
              </button>
            </li>
          ))}
          {!list.length && <li className="muted pad">Nothing here.</li>}
        </ul>

        {current && (
          <article className="card detail">
            <h2>{current.caller_name ?? "Name not captured"}</h2>
            <div className="contact">
              <span>{current.caller_phone ?? "no phone"}</span>
              <span>{current.caller_email ?? "no email"}</span>
              <span>Called {fmt(current.started_at ?? current.created_at, { dateStyle: "medium", timeStyle: "short" })}</span>
              {mins(current.duration_seconds) && <span>Call length {mins(current.duration_seconds)}</span>}
              {afterHours(current.started_at ?? current.created_at) && <span className="pill unclear">After desk hours</span>}
            </div>
            {chips(current).length > 0 && (
              <div className="chips">{chips(current).map(([k, v]) => <span key={k} className="chip"><i>{k}</i> {v}</span>)}</div>
            )}

            <div className={`banner ${needsAction(current) ? "bad" : "ok"}`}>
              {current.booking_status === "booked"
                ? <>Consultation booked for <b>{fmt(current.scheduled_start, { dateStyle: "full", timeStyle: "short" })} IST</b></>
                : <>Booking not confirmed ({current.booking_status.replace("_", " ")}){current.last_error ? `: ${current.last_error}` : ""}. Please contact the caller to arrange the consultation.</>}
            </div>

            <h3>Project</h3><p>{current.project_summary}</p>
            <h3>Handoff note</h3><p>{current.handoff_note}</p>

            {current.uncertainties?.length > 0 && (
              <div className="note"><b>Confirm at the consultation</b>
                <ul>{current.uncertainties.map((u, i) => <li key={i}>{u.replace(/^[a-z_]+: /, "")}</li>)}</ul></div>
            )}

            <h3>Why this was qualified</h3>
            <div className="crit">
              {Object.keys(LABEL).filter((k) => current.criteria[k]).map((k) => [k, current.criteria[k]] as const).map(([k, v]) => (
                <div key={k} className="c">
                  <div className="row"><b>{LABEL[k] ?? k}</b><span className={`pill ${v.verdict}`}>{v.verdict === "pass" ? "Pass" : v.verdict === "unclear" ? "Not settled" : "Fail"}</span></div>
                  <p>{v.rationale}</p>
                  {v.evidence.map((e, i) => <blockquote key={i}>“{e}”</blockquote>)}
                </div>
              ))}
            </div>
          </article>
        )}
      </div>
    </main>
  );
}
