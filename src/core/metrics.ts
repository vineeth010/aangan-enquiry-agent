import { query } from "@/lib/db";

// Aggregate counts only. Deliberately no per-call fields anywhere in this type.
export type Aggregate = {
  calls_total: number;
  evaluated: number;
  qualified: number;
  disqualified: number;
  unclear: number;
  not_forwarded: number; // disqualified + unclear
  bookings_confirmed: number;
  bookings_failed: number;
};

export async function getAggregate(): Promise<Aggregate> {
  const [r] = await query<Record<string, string>>(`
    SELECT
      (SELECT count(*) FROM calls) AS calls_total,
      (SELECT count(*) FROM evaluations) AS evaluated,
      (SELECT count(*) FROM evaluations WHERE outcome='qualified') AS qualified,
      (SELECT count(*) FROM evaluations WHERE outcome='disqualified') AS disqualified,
      (SELECT count(*) FROM evaluations WHERE outcome='unclear') AS unclear,
      (SELECT count(*) FROM evaluations WHERE outcome IN ('disqualified','unclear')) AS not_forwarded,
      (SELECT count(*) FROM enquiries WHERE booking_status='booked') AS bookings_confirmed,
      (SELECT count(*) FROM enquiries WHERE booking_status IN ('failed','needs_email')) AS bookings_failed`);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)])) as Aggregate;
}
