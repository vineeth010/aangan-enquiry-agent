// Thin query wrapper: Neon in production, PGlite (embedded Postgres) when
// DATABASE_URL starts with "pglite:" so the pipeline can be run/tested offline.
type Row = Record<string, any>;
type Runner = (text: string, params?: unknown[]) => Promise<Row[]>;

let runner: Runner | null = null;
let runnerUrl: string | null = null;

async function build(url: string): Promise<Runner> {
  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const target = url.slice("pglite:".length);
    const db = new PGlite(target === "memory" || !target ? undefined : target);
    return async (text, params) => (await db.query<Row>(text, params as any[])).rows;
  }
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);
  return async (text, params) => (await sql.query(text, params as any[])) as Row[];
}

export async function query<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!runner || runnerUrl !== url) {
    runner = await build(url);
    runnerUrl = url;
  }
  return (await runner(text, params)) as T[];
}

export function resetDbForTests() {
  runner = null;
  runnerUrl = null;
}
