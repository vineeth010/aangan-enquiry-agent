/**
 * Resend adapter. Uses the documented POST /emails with an Idempotency-Key header.
 *
 * Test mode (default ON, same convention as the earlier case build): every email is redirected to
 * EMAIL_TEST_RECIPIENT and the subject names the intended recipient, so nothing reaches a real
 * client or designer while the pipeline is being verified. Set EMAIL_TEST_MODE=false to send for real.
 */
export function resolveRecipient(intended: string): { to: string; subjectPrefix: string } {
  if (process.env.EMAIL_TEST_MODE === "false") return { to: intended, subjectPrefix: "" };
  const test = process.env.EMAIL_TEST_RECIPIENT;
  if (!test) throw new Error("EMAIL_TEST_MODE is on but EMAIL_TEST_RECIPIENT is not set");
  return { to: test, subjectPrefix: `[TEST for ${intended}] ` };
}

export async function sendEmail(p: { to: string; subject: string; text: string; idempotencyKey: string }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) throw new Error("RESEND_API_KEY / EMAIL_FROM not set");
  const { to, subjectPrefix } = resolveRecipient(p.to);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "idempotency-key": p.idempotencyKey,
    },
    body: JSON.stringify({ from, to: [to], subject: subjectPrefix + p.subject, text: p.text }),
  });
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}`);
}
