// Deterministic decision layer. Gemini only judges each criterion with evidence;
// the outcome is computed here from qualified.md's boundary rules so it is auditable.
export const CRITERIA = ["real_project", "service_area", "timeline", "budget", "decision_maker"] as const;
export type CriterionKey = (typeof CRITERIA)[number];
export type Verdict = "pass" | "fail" | "unclear";
export type CallType = "new_enquiry" | "existing_client_issue" | "incomplete_or_other";
export type Outcome = "qualified" | "disqualified" | "unclear";

export type Criterion = {
  verdict: Verdict;
  rationale: string;
  evidence: string[]; // verbatim transcript quotes
};
export type Criteria = Record<CriterionKey, Criterion>;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Keep only quotes that really appear in the transcript. */
export function verifyEvidence(transcript: string, quotes: string[]): { verified: string[]; dropped: number } {
  const hay = norm(transcript);
  const verified = quotes.filter((q) => norm(q).length > 3 && hay.includes(norm(q)));
  return { verified, dropped: quotes.length - verified.length };
}

/**
 * A "fail" must be backed by at least one verified quote; otherwise it is downgraded
 * to "unclear" so a hallucinated disqualification can never silently close a lead.
 */
export function sanitizeCriteria(transcript: string, c: Criteria): Criteria {
  const out = {} as Criteria;
  for (const k of CRITERIA) {
    const { verified } = verifyEvidence(transcript, c[k].evidence ?? []);
    let verdict = c[k].verdict;
    let rationale = c[k].rationale;
    if (verdict === "fail" && verified.length === 0) {
      verdict = "unclear";
      rationale = `[Downgraded: failure not supported by a verifiable quote] ${rationale}`;
    }
    out[k] = { verdict, rationale, evidence: verified };
  }
  return out;
}

export function decide(callType: CallType, c: Criteria): { outcome: Outcome; reasons: string[]; uncertainties: string[] } {
  const reasons: string[] = [];
  const uncertainties: string[] = [];
  if (callType !== "new_enquiry") {
    return { outcome: "unclear", reasons: [`Not a new enquiry (${callType}); needs a human.`], uncertainties };
  }
  const fails = CRITERIA.filter((k) => c[k].verdict === "fail");
  if (fails.length) {
    // qualified.md: "If it fails one, close gracefully" and two+ fails => decline.
    return { outcome: "disqualified", reasons: fails.map((k) => `${k}: ${c[k].rationale}`), uncertainties };
  }
  const blocking = (["real_project", "service_area", "timeline"] as const).filter((k) => c[k].verdict === "unclear");
  if (blocking.length) {
    return {
      outcome: "unclear",
      reasons: blocking.map((k) => `${k} unresolved on the call: ${c[k].rationale}`),
      uncertainties,
    };
  }
  // 4 or 5 unclear => forward, but flag for the designer.
  for (const k of ["budget", "decision_maker"] as const) {
    if (c[k].verdict === "unclear") uncertainties.push(`${k}: ${c[k].rationale}`);
  }
  return { outcome: "qualified", reasons: ["All five criteria pass or are non-blocking unknowns."], uncertainties };
}
