// One-time: creates the aggregate-metric number properties on HubSpot companies (idempotent).
// Needs HUBSPOT_TOKEN with crm.schemas.companies.write. Usage: npm run setup:hubspot
import { config } from "dotenv";
config({ path: ".env.local" });

const METRICS: [string, string][] = [
  ["calls_total", "Aangan: total calls"], ["evaluated", "Aangan: evaluated calls"], ["qualified", "Aangan: qualified"],
  ["disqualified", "Aangan: not forwarded (disqualified)"], ["unclear", "Aangan: unclear (front desk to call back)"],
  ["not_forwarded", "Aangan: not forwarded (disqualified + unclear)"],
  ["bookings_confirmed", "Aangan: consultations booked"], ["bookings_failed", "Aangan: bookings needing follow-up"],
];

async function main() {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN is not set");
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const g = await fetch("https://api.hubapi.com/crm/v3/properties/companies/groups", {
    method: "POST", headers: h, body: JSON.stringify({ name: "aangan_agent", label: "Aangan Enquiry Agent", displayOrder: -1 }),
  });
  if (!g.ok && g.status !== 409) throw new Error(`Group create failed: HTTP ${g.status}`);
  for (const [k, label] of METRICS) {
    const r = await fetch("https://api.hubapi.com/crm/v3/properties/companies", {
      method: "POST", headers: h,
      body: JSON.stringify({ name: `aangan_${k}`, label, type: "number", fieldType: "number", groupName: "aangan_agent" }),
    });
    console.log(`aangan_${k}:`, r.ok ? "created" : r.status === 409 ? "exists" : `FAILED HTTP ${r.status}`);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
