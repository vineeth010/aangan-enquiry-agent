# Aangan Studio Enquiry Agent (MVP)

Incoming phone enquiries only. Vaani (voice) → webhook → Neon → Gemini evaluation → designer routing (Google Calendar, Resend) and Nikhil's HubSpot (aggregate counts + one expandable note per not-forwarded call).

```
Vaani call-completed webhook
  → verify signature → persist call+transcript (Neon, dedupe) → 200
  → Gemini scores 5 criteria with verbatim evidence   (AI judges, code decides: src/core/rules.ts)
  → qualified: assign designer → Google Calendar event (deterministic id = idempotent) → Resend (designer + client) → HubSpot counts
  → disqualified: HubSpot note on Nikhil's company record (reason + evidence, no caller PII); transcript stays in Vaani
  → unclear (complaints, dropped calls, unresolved timeline): stored only. Out of scope: the front desk's existing manual process owns these; no automation here
```

## Run
```bash
npm install
cp .env.example .env.local        # fill in values (DATABASE_URL=pglite:.pglite works with no Neon)
npm run db:migrate
npm run db:seed-designers -- "Asha:asha@x.com:123456"   # name:email:calcomEventTypeId; tokens -> .designer-tokens.local.json
npm run dev
npm run simulate -- t01            # signed fake webhook (t01 qualified, t03 Nashik, t10 low budget)
npm test                           # 15 tests, offline (embedded Postgres + faked APIs)
```
Cron `POST /api/jobs/retry` (Bearer `JOBS_TOKEN`) every ~5 min to retry failed evaluations, bookings and emails.

## Access
- Designer: `/designer` page / `GET /api/designer/enquiries` (Bearer designer token) → only own assigned enquiries, no transcript.
- Founder: `GET /api/metrics` (Bearer `FOUNDER_TOKEN`) → aggregate counts only; same counts pushed to HubSpot.
- Founder's Office rejected transcripts: Vaani's own interface (unconfirmed, see below). Nothing built here.

## Unverified assumptions (each isolated in one file)
| Area | File | Assumption |
|---|---|---|
| Vaani webhook | `src/integrations/vaani/` | VERIFIED via Vaani Test Connectivity: header x-webhook-signature = sha256=HMAC-SHA256(raw body, secret); event call_postprocessing carries data.transcript. Unverified: where the caller phone number appears |
| Caller email | `vaani/agent-prompt.md` | Agent asks for it so the client confirmation email can be sent; without it the booking still happens and the designer is told to call |
| Google Calendar | `src/integrations/gcal.ts` | Service account; each designer shares their calendar with its email. Service accounts cannot invite attendees, so the caller is emailed via Resend |
| HubSpot | `src/integrations/hubspot.ts` | Custom aangan_* number properties (run npm run setup:hubspot) + Notes on one company record; note->company association id 190 |

## Source-file conflicts noticed
- Timeline: `qualified.md` says 8–10 weeks, `services.md` says <6 weeks is the hard limit. Evaluator fails only when clearly impossible (~<6 wks).
- T18 (180 sq ft coworking pod) was declined citing a 500 sq ft commercial minimum that is not in `services.md`; not encoded.
- `knowledge/` holds read-only copies of the three source md files used in the Gemini prompt.
