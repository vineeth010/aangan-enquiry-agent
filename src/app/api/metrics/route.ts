import { checkEnvToken } from "@/lib/auth";
import { getAggregate } from "@/core/metrics";

export const runtime = "nodejs";

// Founder: aggregate counts only. There is intentionally no call-level route for this role.
export async function GET(req: Request) {
  if (!checkEnvToken(req, "FOUNDER_TOKEN")) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(await getAggregate());
}
