// Showcase data derived from the Sept 2026 phone transcripts (T01..T20). All names/contacts are demo values.
// Usage: npm run db:seed-demo -- "Designer Name" designer@email.com    (re-run safe)
//        npm run db:seed-demo -- --clear                                 (removes demo rows only)
// The designer signs in with a simple password: DESIGNER_PASSWORD env var, default "designer_aangan" (demo only; change before real use).
import { config } from "dotenv";
config({ path: ".env.local" });
import { query } from "../src/lib/db";
import { sha256 } from "../src/lib/auth";
import { migrate } from "./migrate";

type V = "pass" | "unclear" | "fail";
type C = [V, string, string[]];
type Demo = {
  id: string; when: string; phone: string; name: string | null; email: string | null; project: string; note: string;
  c: [C, C, C, C, C]; // real_project, service_area, timeline, budget, decision_maker
  outcome: "qualified" | "disqualified" | "unclear"; callType?: string;
  booking?: "booked" | "failed" | "needs_email"; slot?: string; err?: string; uncertain?: string[];
};
const p = (r: string, e: string[] = []): C => ["pass", r, e];
const u = (r: string, e: string[] = []): C => ["unclear", r, e];
const f = (r: string, e: string[]): C => ["fail", r, e];
const none = u("Not discussed on the call.");
const budgetNone = p("No budget mentioned; treated as qualified per rubric.");

const DEMO: Demo[] = [
  { id: "T01", when: "2026-09-02T10:23:00+05:30", phone: "+91 98100 00001", name: "Priya", email: "priya.demo@example.com",
    project: "3BHK, ~1,400 sq ft carpet, Dahanukar Colony, Kothrud. Full redo: kitchen, living room, both bedrooms.",
    note: "Referred by past client Shruti Joshi (Aundh). Owner with husband; he is on board. Wants it done by March, no rush.",
    c: [p("Full redesign of kitchen, living room and bedrooms.", ["We want to redo the whole thing -- kitchen, living room, both bedrooms."]),
      p("Kothrud is in Pune.", ["We have a 3BHK in Kothrud -- Dahanukar Colony."]),
      p("March target leaves ample time.", ["We'd like to be done by March. We're in no rush."]), budgetNone,
      p("Owner, husband authorised.", ["He knows we're calling and is happy to go ahead."])],
    outcome: "qualified", booking: "booked", slot: "2026-10-13T11:00:00+05:30" },
  { id: "T02", when: "2026-09-03T14:41:00+05:30", phone: "+91 98100 00002", name: null, email: "wakad.caller.demo@example.com",
    project: "2BHK, ~950 sq ft, Wakad. Full redesign: modular kitchen, wardrobes, living room, both bedrooms.",
    note: "Found us on Instagram. Pressed twice for a ballpark; deflected, accepted the consultation. Name not captured.",
    c: [p("Full redesign scope.", ["Full redesign -- modular kitchen, wardrobes, living room, both bedrooms."]),
      p("Wakad is in PCMC/Pune.", ["I have a 2BHK in Wakad"]),
      p("Design from October, move in November.", ["We move in November -- so maybe starting design from October?"]), budgetNone,
      u("Authority not explicitly confirmed.", [])],
    outcome: "qualified", booking: "booked", slot: "2026-10-14T15:00:00+05:30", uncertain: ["decision_maker: Authority not explicitly confirmed. Wanted a rough ballpark; do not quote before the site visit."] },
  { id: "T05", when: "2026-09-05T10:52:00+05:30", phone: "+91 98100 00005", name: "Aarti Mehta", email: null,
    project: "4BHK, ~2,400 sq ft carpet, Koregaon Park. Complete redesign incl. new flooring, kitchen, four bedrooms. Currently vacated.",
    note: "Referred by Vikram Agarwal (friend of Nikhil). Wants to move back by February (~4 months). Prefers a site visit. Email not captured: call her to confirm a time.",
    c: [p("Complete redesign with new flooring.", ["Complete redesign. New flooring, kitchen, all four bedrooms."]),
      p("Koregaon Park is in Pune.", ["We have a 4BHK in Koregaon Park"]),
      p("About 4 months until move-in.", ["We want to move back in by February. About 4 months."]), budgetNone, u("Decision-maker not explicitly asked; she leads the project.", [])],
    outcome: "qualified", booking: "needs_email", err: "Caller email not captured on the call", uncertain: ["decision_maker: Not explicitly asked; she is leading the project."] },
  { id: "T06", when: "2026-09-05T15:28:00+05:30", phone: "+91 98100 00006", name: null, email: "startup.founder.demo@example.com",
    project: "Startup office fit-out, ~800 sq ft, Baner. Bare shell. 20 workstations, small cabin, meeting room, break area.",
    note: "Founder is the decision-maker. Needs to be operational by December; team currently remote. Name not captured.",
    c: [p("Full commercial fit-out within the 3,000 sq ft limit.", ["We need workstations for 20 people, a small cabin, a meeting room, and a break area."]),
      p("Baner is in Pune.", ["just got our first proper office space in Baner. About 800 sq ft."]),
      p("December operational target; tight but workable.", ["We want to be operational by December."]), budgetNone,
      p("Founder confirmed.", ["Yes, I'm the founder."])],
    outcome: "qualified", booking: "booked", slot: "2026-10-13T16:00:00+05:30", uncertain: ["timeline: December go-live is tight; confirm execution capacity at consultation."] },
  { id: "T11", when: "2026-09-12T10:18:00+05:30", phone: "+91 98100 00011", name: null, email: "baner.tenant.demo@example.com",
    project: "Rented 2BHK in Baner (3-year lease). Design living room, bedroom and kitchen. No structural changes.",
    note: "Landlord is fine with it as long as walls are not broken. Modular, reversible kitchen suggested. Name not captured.",
    c: [p("Design and fittings with execution, no structural work.", ["I want to properly design the living room, bedroom, and kitchen -- no structural changes, just design and fittings."]),
      p("Baner is in Pune.", ["It's a 2BHK in Baner."]), none, budgetNone,
      p("Tenant with landlord approval.", ["they're fine with it as long as we don't break walls."])],
    outcome: "qualified", booking: "booked", slot: "2026-10-15T10:30:00+05:30", uncertain: ["timeline: Not discussed on the call; confirm at consultation."] },
  { id: "T12", when: "2026-09-15T10:05:00+05:30", phone: "+91 98100 00012", name: "Anand Sharma", email: "anand.demo@example.com",
    project: "Villa, ~5,500 sq ft (ground + 2 floors), Kalyani Nagar. New construction, empty. Full end-to-end design.",
    note: "Possession last month. Move-in target March, no rush. Wants the principal designer on site this week or next.",
    c: [p("Full end-to-end design of a new villa.", ["Full end-to-end design."]),
      p("Kalyani Nagar is in Pune.", ["I'm calling about a villa project in Kalyani Nagar."]),
      p("March move-in gives ample lead time.", ["March next year to move in. No rush."]), budgetNone,
      p("Owner speaking.", ["Possession was last month."])],
    outcome: "qualified", booking: "booked", slot: "2026-10-12T12:00:00+05:30" },
  { id: "T13", when: "2026-09-16T12:19:00+05:30", phone: "+91 98100 00013", name: null, email: "aundh.caller.demo@example.com",
    project: "3BHK, ~1,100 sq ft, Aundh. Kitchen, wardrobes in both bedrooms, living room.",
    note: "Asked twice for a rough price range; deflected, no number given. Booking could not be completed automatically: please call to arrange the consultation.",
    c: [p("Kitchen, wardrobes and living room redesign.", ["Kitchen, wardrobes in both bedrooms, living room."]),
      p("Aundh is in Pune.", ["I want to redo my flat in Aundh."]), none, budgetNone, none],
    outcome: "qualified", booking: "failed", err: "No available slot in the next 14 days", uncertain: ["timeline: Not discussed.", "decision_maker: Not discussed."] },
  { id: "T14", when: "2026-09-17T11:41:00+05:30", phone: "+91 98100 00014", name: null, email: "hadapsar.son.demo@example.com",
    project: "Parents' 3BHK in Hadapsar, new possession. Proper design requested.",
    note: "Caller is the son doing initial checking; the parents decide and will attend the consultation. Make sure the parents are present.",
    c: [p("Wants a proper design.", ["They want a proper design."]), p("Hadapsar is in Pune.", ["They have a 3BHK in Hadapsar -- new possession."]), none, budgetNone,
      u("Son is researching; parents decide and will attend.", ["I'm doing the initial checking."])],
    outcome: "qualified", booking: "booked", slot: "2026-10-16T17:00:00+05:30", uncertain: ["decision_maker: Son is researching; parents decide and will attend the consultation."] },
  { id: "T15", when: "2026-09-18T15:12:00+05:30", phone: "+91 98100 00015", name: "Smita", email: "smita.demo@example.com",
    project: "2BHK, 875 sq ft, Undri. Full package: kitchen, wardrobes, living room. Site available now via builder.",
    note: "Possession in about six weeks; wants to start design immediately. Husband told her to go ahead and book.",
    c: [p("Full home package.", ["Full home -- kitchen, wardrobes, living room. The full package."]),
      p("Undri is in Pune.", ["I'm getting possession of my flat in Undri in about six weeks."]),
      p("Design can start now, before possession.", ["We can go now -- the builder will let us in."]), budgetNone,
      p("Owner, husband authorised.", ["He said to go ahead and book the consultation."])],
    outcome: "qualified", booking: "booked", slot: "2026-10-14T10:00:00+05:30" },
  { id: "T17", when: "2026-09-22T14:16:00+05:30", phone: "+91 98100 00017", name: "Ritu Kapoor", email: "ritu.demo@example.com",
    project: "3BHK, ~1,050 sq ft, Pimple Saudagar. Kitchen, wardrobes, living room (builder furniture currently).",
    note: "First call dropped after 1 min 12 s; she called back. Done by March, plenty of time.",
    c: [p("Kitchen, wardrobes and living room.", ["Kitchen, wardrobes, living room."]),
      p("Pimple Saudagar is in PCMC.", ["I'm Ritu Kapoor from Pimple Saudagar."]),
      p("March target.", ["Ideally done by March. Plenty of time."]), budgetNone, u("Owner implied; not explicitly confirmed.", [])],
    outcome: "qualified", booking: "booked", slot: "2026-10-17T11:30:00+05:30" },
  { id: "T20", when: "2026-09-25T09:15:00+05:30", phone: "+91 98100 00020", name: "Pooja", email: "pooja.demo@example.com",
    project: "2BHK, ~900 sq ft, Magarpatta (Cybercity). Kitchen, both bedrooms, living room.",
    note: "Owner with husband; both will attend. January start for execution would be ideal.",
    c: [p("Kitchen, bedrooms and living room.", ["Kitchen, both bedrooms, living room."]),
      p("Magarpatta is in Pune.", ["I have a 2BHK in Magarpatta -- Cybercity area."]),
      p("January start works.", ["a January start for execution would be ideal."]), budgetNone,
      p("Owner with husband.", ["Yes -- my husband and I. We both want to be at the consultation."])],
    outcome: "qualified", booking: "booked", slot: "2026-10-18T10:00:00+05:30" },
  // --- not forwarded to designers (for founder aggregate metrics) ---
  { id: "T03", when: "2026-09-03T16:15:00+05:30", phone: "+91 98100 00003", name: "Suresh Patil", email: null, project: "Home office and study, Nashik", note: "Outside service area.",
    c: [p("Home office redesign."), f("Site is in Nashik.", ["I'm in Nashik"]), none, budgetNone, none], outcome: "disqualified" },
  { id: "T04", when: "2026-09-04T11:07:00+05:30", phone: "+91 98100 00004", name: null, email: null, project: "Living room ideas", note: "Advice only.",
    c: [f("Wants suggestions only, not design and execution.", ["Just want suggestions on colours, furniture arrangement, what to change."]), none, none, budgetNone, none], outcome: "disqualified" },
  { id: "T10", when: "2026-09-11T14:04:00+05:30", phone: "+91 98100 00010", name: null, email: null, project: "Kitchen and one bedroom, 1BHK Kharadi", note: "Volunteered budget far below scope.",
    c: [p("Kitchen and bedroom with execution."), p("Kharadi is in Pune."), none,
      f("Volunteered budget clearly below scope.", ["My budget is 1 to 1.5 lakh maximum for everything."]), none], outcome: "disqualified" },
  { id: "T19", when: "2026-09-24T16:02:00+05:30", phone: "+91 98100 00019", name: null, email: null, project: "Restaurant interiors, Koregaon Park", note: "Hospitality is out of scope.",
    c: [f("Restaurant is out of scope.", ["I'm planning to open a restaurant in Koregaon Park."]), p("Koregaon Park is in Pune."), none, budgetNone, none], outcome: "disqualified" },
  { id: "T09", when: "2026-09-10T11:32:00+05:30", phone: "+91 98100 00009", name: "Sheetal Deshpande", email: null, project: "Existing client complaint", note: "Not a new enquiry.",
    c: [none, none, none, none, none], outcome: "unclear", callType: "existing_client_issue" },
];

// Structured facts + call length per seed transcript (call durations are in the PDF headers).
type Det = { space_type: "residential" | "commercial" | null; locality: string | null; size_sqft: number | null; timeline: string | null; lead_source: string | null; is_rented: boolean | null };
const D = (space_type: Det["space_type"], locality: string | null, size_sqft: number | null, timeline: string | null, lead_source: string | null, is_rented: boolean | null = null): Det =>
  ({ space_type, locality, size_sqft, timeline, lead_source, is_rented });
const DETAILS: Record<string, { det: Det; seconds: number }> = {
  T01: { seconds: 252, det: D("residential", "Kothrud (Dahanukar Colony)", 1400, "Done by March, no rush", "Referral: Shruti Joshi (past client, Aundh)", false) },
  T02: { seconds: 308, det: D("residential", "Wakad", 950, "Design from October, move in November", "Instagram") },
  T03: { seconds: 160, det: D("residential", "Nashik", null, null, "LinkedIn") },
  T04: { seconds: 202, det: D("residential", null, null, "Exploring only", null) },
  T05: { seconds: 404, det: D("residential", "Koregaon Park", 2400, "Move back in by February (~4 months)", "Referral: Vikram Agarwal (friend of Nikhil)", false) },
  T06: { seconds: 301, det: D("commercial", "Baner", 800, "Operational by December", null) },
  T09: { seconds: 352, det: D("residential", "Viman Nagar", null, null, null) },
  T10: { seconds: 220, det: D("residential", "Kharadi", 550, null, null) },
  T11: { seconds: 382, det: D("residential", "Baner", null, null, null, true) },
  T12: { seconds: 450, det: D("residential", "Kalyani Nagar", 5500, "March next year, no rush", null, false) },
  T13: { seconds: 368, det: D("residential", "Aundh", 1100, null, null) },
  T14: { seconds: 295, det: D("residential", "Hadapsar", null, null, "Via the owners' son (initial checking)") },
  T15: { seconds: 344, det: D("residential", "Undri", 875, "Possession in ~6 weeks; start design now", null, false) },
  T17: { seconds: 270, det: D("residential", "Pimple Saudagar", 1050, "Done by March", null, false) },
  T19: { seconds: 170, det: D("commercial", "Koregaon Park", null, null, null) },
  T20: { seconds: 284, det: D("residential", "Magarpatta (Cybercity)", 900, "January start for execution", null, false) },
};

const KEYS = ["real_project", "service_area", "timeline", "budget", "decision_maker"] as const;

async function main() {
  await migrate();
  await query(`DELETE FROM notifications WHERE call_id IN (SELECT id FROM calls WHERE is_demo)`);
  await query(`DELETE FROM enquiries WHERE call_id IN (SELECT id FROM calls WHERE is_demo)`);
  await query(`DELETE FROM evaluations WHERE call_id IN (SELECT id FROM calls WHERE is_demo)`);
  await query(`DELETE FROM calls WHERE is_demo`);
  if (process.argv.includes("--clear")) return console.log("Demo rows removed.");

  const [name, email] = process.argv.slice(2);
  if (!name || !email) throw new Error('Usage: npm run db:seed-demo -- "Designer Name" designer@email.com');
  const token = process.env.DESIGNER_PASSWORD || "designer_aangan";
  const [d] = await query<{ id: string }>(
    `INSERT INTO designers (name, email, access_token_hash, calendar_id) VALUES ($1,$2,$3,$2)
     ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, access_token_hash=EXCLUDED.access_token_hash, active=true RETURNING id`,
    [name, email, sha256(token)],
  );

  for (const t of DEMO) {
    const criteria = Object.fromEntries(KEYS.map((k, i) => [k, { verdict: t.c[i][0], rationale: t.c[i][1], evidence: t.c[i][2] }]));
    const [call] = await query<{ id: string }>(
      `INSERT INTO calls (vaani_call_id, raw_payload, caller_phone, started_at, duration_seconds, transcript, status, is_demo)
       VALUES ($1,'{"demo":true}'::jsonb,$2,$3,$4,$5,'evaluated',true) RETURNING id`,
      [`demo-${t.id}`, t.phone, t.when, DETAILS[t.id]?.seconds ?? null, `[Demo record based on seed transcript ${t.id}]`],
    );
    await query(
      `INSERT INTO evaluations (call_id, outcome, call_type, criteria, decision_reasons, summary, handoff_note, caller_name, caller_email, project_summary, uncertainties, model, details)
       VALUES ($1,$2,$3,$4::jsonb,'[]'::jsonb,$5,$6,$7,$8,$9,$10::jsonb,'demo-seed',$11::jsonb)`,
      [call.id, t.outcome, t.callType ?? "new_enquiry", JSON.stringify(criteria), t.note, t.note, t.name, t.email, t.project, JSON.stringify(t.uncertain ?? []), JSON.stringify(DETAILS[t.id]?.det ?? {})],
    );
    if (t.outcome === "qualified") {
      await query(
        `INSERT INTO enquiries (call_id, designer_id, booking_status, calendar_event_id, scheduled_start, last_error, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [call.id, d.id, t.booking, t.booking === "booked" ? `demo-bk-${t.id}` : null, t.slot ?? null, t.err ?? null, t.when],
      );
    }
  }
  console.log(`Seeded ${DEMO.length} demo calls (${DEMO.filter((x) => x.outcome === "qualified").length} qualified) for ${email}. Password: DESIGNER_PASSWORD or the default.`);
}
main().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
