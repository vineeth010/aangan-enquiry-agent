import { config } from "dotenv";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
config({ path: ".env.local" });
import { query } from "../src/lib/db";

export async function migrate() {
  const dir = path.join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const statements = readFileSync(path.join(dir, f), "utf8").split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
    for (const s of statements) await query(s);
    console.log("applied", f);
  }
}

if (process.argv[1]?.endsWith("migrate.ts")) migrate().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
