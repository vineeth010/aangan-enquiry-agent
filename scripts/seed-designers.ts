// Usage: npm run db:seed-designers -- "Name:email[:calendarId]" ["Name2:email2" ...]
// calendarId defaults to the designer's email (their primary Google Calendar, shared with the service account).
// Every designer gets the password in DESIGNER_PASSWORD (default "designer_aangan"; demo only).
import { config } from "dotenv";
config({ path: ".env.local" });
import { query } from "../src/lib/db";
import { sha256 } from "../src/lib/auth";
import { migrate } from "./migrate";

async function main() {
  const specs = process.argv.slice(2);
  if (!specs.length) throw new Error('Pass designers as "Name:email[:calendarId]"');
  await migrate();
  const out: Record<string, string> = {};
  for (const s of specs) {
    const [name, email, cal] = s.split(":");
    if (!name || !email) throw new Error(`Bad spec: ${s}`);
    const token = process.env.DESIGNER_PASSWORD || "designer_aangan";
    await query(
      `INSERT INTO designers (name, email, access_token_hash, calendar_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, access_token_hash=EXCLUDED.access_token_hash,
         calendar_id=EXCLUDED.calendar_id, active=true`,
      [name, email, sha256(token), cal || email],
    );
    out[email] = token;
  }
  console.log(`Seeded ${specs.length} designer(s). Password: DESIGNER_PASSWORD or the default.`);
}
main().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
