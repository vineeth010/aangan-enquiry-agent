import { checkEnvToken } from "@/lib/auth";
import { retryPending } from "@/core/pipeline";

export const runtime = "nodejs";
export const maxDuration = 60;

// Call from a cron (e.g. every 5 min). Re-runs failed evaluations, bookings and notifications.
export async function POST(req: Request) {
  if (!checkEnvToken(req, "JOBS_TOKEN")) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(await retryPending());
}
