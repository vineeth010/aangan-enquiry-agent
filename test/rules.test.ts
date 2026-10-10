import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, sanitizeCriteria, type Criteria } from "../src/core/rules";
import { verifyVaaniSignature, signForTests } from "../src/integrations/vaani/signature";
import { parseVaaniWebhook } from "../src/integrations/vaani/payload";
import { resolveRecipient } from "../src/integrations/resend";

const c = (over: Partial<Record<keyof Criteria, "pass" | "fail" | "unclear">> = {}): Criteria => {
  const mk = (v: "pass" | "fail" | "unclear") => ({ verdict: v, rationale: "r", evidence: ["the caller said hello there"] });
  return {
    real_project: mk(over.real_project ?? "pass"), service_area: mk(over.service_area ?? "pass"),
    timeline: mk(over.timeline ?? "pass"), budget: mk(over.budget ?? "pass"), decision_maker: mk(over.decision_maker ?? "pass"),
  };
};

test("all pass => qualified", () => assert.equal(decide("new_enquiry", c()).outcome, "qualified"));
test("any fail => disqualified", () => assert.equal(decide("new_enquiry", c({ service_area: "fail" })).outcome, "disqualified"));
test("budget fail => disqualified (volunteered misaligned budget)", () => assert.equal(decide("new_enquiry", c({ budget: "fail" })).outcome, "disqualified"));
test("unclear budget/decision-maker => qualified with uncertainty note", () => {
  const d = decide("new_enquiry", c({ budget: "unclear", decision_maker: "unclear" }));
  assert.equal(d.outcome, "qualified");
  assert.equal(d.uncertainties.length, 2);
});
test("unclear timeline => human review", () => assert.equal(decide("new_enquiry", c({ timeline: "unclear" })).outcome, "unclear"));
test("existing-client complaint is never auto-closed or forwarded", () => assert.equal(decide("existing_client_issue", c()).outcome, "unclear"));

test("fail without verifiable quote is downgraded to unclear", () => {
  const crit = c({ service_area: "fail" });
  crit.service_area.evidence = ["a made up quote that is not present"];
  const out = sanitizeCriteria("Caller: I live in Kothrud", crit);
  assert.equal(out.service_area.verdict, "unclear");
  assert.equal(decide("new_enquiry", out).outcome, "unclear");
});

test("signature verification", () => {
  process.env.VAANI_WEBHOOK_SECRET = "s3cret";
  const body = '{"a":1}';
  const h = (v?: string) => new Headers(v ? { "x-webhook-signature": v } : {});
  assert.equal(verifyVaaniSignature(body, h(signForTests(body, "s3cret"))), true);
  assert.equal(verifyVaaniSignature(body, h("sha256=" + signForTests(body, "s3cret"))), true);
  assert.equal(verifyVaaniSignature(body, h(signForTests(body, "wrong"))), false);
  assert.equal(verifyVaaniSignature(body + " ", h(signForTests(body, "s3cret"))), false);
  assert.equal(verifyVaaniSignature(body, h()), false);
  delete process.env.VAANI_WEBHOOK_SECRET;
  assert.equal(verifyVaaniSignature(body, h(signForTests(body, "s3cret"))), false); // fails closed
});

test("email test mode redirects every recipient to the test inbox and labels the subject", () => {
  process.env.EMAIL_TEST_MODE = "true";
  process.env.EMAIL_TEST_RECIPIENT = "me@example.com";
  assert.deepEqual(resolveRecipient("client@x.com"), { to: "me@example.com", subjectPrefix: "[TEST for client@x.com] " });
  delete process.env.EMAIL_TEST_RECIPIENT;
  assert.throws(() => resolveRecipient("client@x.com"), /EMAIL_TEST_RECIPIENT/);
  process.env.EMAIL_TEST_MODE = "false";
  assert.deepEqual(resolveRecipient("client@x.com"), { to: "client@x.com", subjectPrefix: "" });
  delete process.env.EMAIL_TEST_MODE;
});

const envelope =(events: object[], event = "call_postprocessing_batch") => ({ event, timestamp: "2026-10-10T10:00:00Z", events });

test("Vaani test delivery is recognised and not stored", () => {
  assert.equal(parseVaaniWebhook("{}", { event: "webhook_test", events: [{ event: "call_postprocessing", call_id: "test_room_123" }] }).kind, "test");
});

test("call_postprocessing events become calls; other event types are ignored", () => {
  const p = parseVaaniWebhook("x", envelope([
    { event: "call_started", call_id: "a" },
    { event: "call_postprocessing", call_id: "abc", timestamp: "2026-10-10T10:00:00Z", data: { call_duration: 120.4, transcript: "Caller: hi" } },
  ]));
  assert.equal(p.kind, "calls");
  if (p.kind !== "calls") return;
  assert.equal(p.ignored, 1);
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].call.vaaniCallId, "abc");
  assert.equal(p.calls[0].call.transcript, "Caller: hi");
  assert.equal(p.calls[0].call.durationSeconds, 120);
});

test("event without transcript or id: null transcript, hash fallback id", () => {
  const p = parseVaaniWebhook("x", envelope([{ event: "call_postprocessing", data: {} }]));
  if (p.kind !== "calls") throw new Error("expected calls");
  assert.equal(p.calls[0].call.transcript, null);
  assert.equal(p.calls[0].call.callIdSource, "body_hash");
});

test("real flat single-event delivery (as sent by a Vaani web call) is parsed, with true start time and no fake phone", () => {
  const real = {
    event: "call_postprocessing", timestamp: "2026-10-10T14:04:41.842169+00:00", from: "web-user", to: "aangan-enquiry-agent", call_id: "webrtc-179-abc",
    data: { call_id: "webrtc-179-abc", phone_number: "web-user", call_started_at: "2026-10-10T14:03:35.261353+00:00", call_duration: 61.58,
      transcript: "[14:03:36] AGENT: Hello\n[14:03:42] USER: Hi", dispositions: { "Enquiry Outcome": "Not a fit" } },
  };
  const p = parseVaaniWebhook(JSON.stringify(real), real);
  if (p.kind !== "calls") throw new Error("expected calls");
  assert.equal(p.calls.length, 1);
  const c = p.calls[0].call;
  assert.equal(c.vaaniCallId, "webrtc-179-abc");
  assert.equal(c.startedAt, "2026-10-10T14:03:35.261Z");
  assert.equal(c.durationSeconds, 62);
  assert.equal(c.callerPhone, null);
  assert.match(c.transcript!, /AGENT: Hello/);
  const phoneCall = { ...real, from: "+919800000000", data: { ...real.data, phone_number: "+919800000000" } };
  const pp = parseVaaniWebhook(JSON.stringify(phoneCall), phoneCall);
  if (pp.kind !== "calls") throw new Error("expected calls");
  assert.equal(pp.calls[0].call.callerPhone, "+919800000000");
});

test("non-object payload is invalid", () => assert.equal(parseVaaniWebhook("x", null).kind, "invalid"));
