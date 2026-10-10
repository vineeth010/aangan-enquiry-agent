import { designerFromRequest } from "@/lib/auth";
import { query } from "@/lib/db";

export const runtime = "nodejs";

// Designer: only enquiries assigned to the authenticated designer. No transcript is returned.
export async function GET(req: Request) {
  const d = await designerFromRequest(req);
  if (!d) return Response.json({ error: "unauthorized" }, { status: 401 });
  const rows = await query(
    `SELECT q.id, q.created_at, q.booking_status, q.scheduled_start, q.last_error,
            ev.caller_name, ev.caller_email, c.caller_phone, c.started_at, c.duration_seconds, c.is_demo, ev.details, ev.project_summary, ev.handoff_note,
            ev.criteria, ev.uncertainties
     FROM enquiries q JOIN evaluations ev ON ev.call_id = q.call_id JOIN calls c ON c.id = q.call_id
     WHERE q.designer_id = $1 ORDER BY q.created_at DESC LIMIT 100`,
    [d.id],
  );
  return Response.json({ designer: d.name, enquiries: rows });
}
