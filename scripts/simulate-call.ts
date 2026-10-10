// Sends a signed fake call_postprocessing webhook (Vaani's verified envelope shape) to a running server.
// Usage: npm run simulate -- <t01|t03|t10> [baseUrl]
import { config } from "dotenv";
config({ path: ".env.local" });
import { signForTests } from "../src/integrations/vaani/signature";
import { FIXTURES } from "../test/fixtures";

async function main() {
  const [key = "t01", base = "http://localhost:3000"] = process.argv.slice(2);
  const f = FIXTURES[key];
  if (!f) throw new Error(`Unknown fixture ${key}; have ${Object.keys(FIXTURES).join(", ")}`);
  const secret = process.env.VAANI_WEBHOOK_SECRET;
  if (!secret) throw new Error("VAANI_WEBHOOK_SECRET not set");
  const id = `sim-${key}-${Date.now()}`;
  const ts = new Date().toISOString();
  const body = JSON.stringify({
    event: "call_postprocessing_batch", timestamp: ts,
    events: [{ event: "call_postprocessing", call_id: id, timestamp: ts, data: { room_name: id, call_id: id, call_duration: 120, end_reason: "completed", summary: "", transcript: f } }],
  });
  const res = await fetch(`${base}/api/webhooks/vaani/call-completed`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-signature": `sha256=${signForTests(body, secret)}` },
    body,
  });
  console.log(res.status, await res.text());
}
main().catch((e) => { console.error(e.message); process.exit(1); });
