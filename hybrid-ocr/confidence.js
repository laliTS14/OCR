// Scores how much to trust regexCategorize.js's output on THIS document,
// so the pipeline can decide: keep the fast (milliseconds) regex result, or
// fall back to the slow (minutes) but general Ollama LLM path. This is the
// piece that ../regex-based/ deliberately does NOT have (built pure, no
// fallback, on explicit instruction) — this demo exists specifically to add
// it back as a separate mode. See PROGRESS.md for the calibration data this
// was tuned against (3 real documents, one per lab template).
//
// Signals used, in order of how much they matter:
//   1. Which regex tier matched (Tier A = this exact known template via its
//      own "Sample Tested In :" marker, much more trustworthy; Tier B = the
//      generic cross-template fallback in regexCategorize.js, inherently
//      riskier — see that file's own header for why).
//   2. Zero reports or zero rows at all — an immediate, maximal red flag.
//   3. How many report sections couldn't be named (generic "Report" — a
//      sign the structural heuristics didn't recognize this layout well).
//   4. How many report sections came back with zero rows.
//   5. Row density — average rows per non-empty report. A document that's
//      "technically found some rows" but at very low density per section is
//      a sign of a bad partial match, not a good one (confirmed on the
//      Redcliffe document: 1.43 rows/section on a real failure vs. 4-6 on
//      the two real successes).
//   6. How many of the 4 core patient fields (name/age/sex/patient_id) came
//      back empty.
//
// Calibrated against 3 real documents (Sept 2026):
//   - Helpline (Tier A): score 1.00 → keep regex result (correct — 14
//     reports, 57 correct rows, no LLM needed).
//   - Redcliffe (Tier B, noisy): score 0.00 → escalate to LLM (correct —
//     22 report entries but only 10 real rows, 41% generically named,
//     68% empty, 1.43 rows/section).
//   - K Naresh Naidu (Tier B, clean): score 0.65 → keep regex result
//     (correct — 14 reports, 25 real rows, 29% generic, 57% empty but at
//     4.17 rows/section on the ones that did have data — a genuinely good
//     partial result, not a bad one).
// Re-calibrate these constants against more real documents before trusting
// the threshold blindly — 3 documents is a starting point, not proof.

const TIER_B_PENALTY = 0.35;
const GENERIC_RATIO_THRESHOLD = 0.35;
const GENERIC_RATIO_PENALTY = 0.25;
const EMPTY_RATIO_THRESHOLD = 0.6;
const EMPTY_RATIO_PENALTY = 0.2;
const MIN_AVG_ROWS_PER_NONEMPTY_REPORT = 2;
const LOW_DENSITY_PENALTY = 0.25;
const MISSING_PATIENT_FIELDS_THRESHOLD = 2;
const MISSING_PATIENT_PENALTY = 0.2;

const CONFIDENCE_THRESHOLD = 0.6; // below this, recommend the LLM fallback

function scoreConfidence({ patient, reports }, tier) {
  const reasons = [];

  if (reports.length === 0) {
    return { score: 0, tier, recommendFallback: true, reasons: ['Zero report sections found at all.'] };
  }
  const totalRows = reports.reduce((n, r) => n + r.rows.length, 0);
  if (totalRows === 0) {
    return { score: 0, tier, recommendFallback: true, reasons: ['Report sections were found but contain zero data rows.'] };
  }

  let score = 1;

  if (tier === 'B') {
    score -= TIER_B_PENALTY;
    reasons.push('Generic cross-template fallback pattern matching was used (no exact template match), which is inherently less reliable than an exact template match.');
  } else {
    reasons.push('Exact known template matched via its own boundary marker — the most reliable path.');
  }

  const genericNamed = reports.filter((r) => r.report_type === 'Report').length;
  const genericRatio = genericNamed / reports.length;
  if (genericRatio > GENERIC_RATIO_THRESHOLD) {
    score -= GENERIC_RATIO_PENALTY;
    reasons.push(`${genericNamed}/${reports.length} report sections could not be named (${(genericRatio * 100).toFixed(0)}% generic "Report") — the layout's headings weren't reliably recognized.`);
  }

  const emptyReports = reports.filter((r) => r.rows.length === 0).length;
  const emptyRatio = emptyReports / reports.length;
  if (emptyRatio > EMPTY_RATIO_THRESHOLD) {
    score -= EMPTY_RATIO_PENALTY;
    reasons.push(`${emptyReports}/${reports.length} report sections (${(emptyRatio * 100).toFixed(0)}%) came back with zero rows.`);
  }

  const nonEmptyReports = reports.length - emptyReports;
  const avgRowsPerNonEmpty = nonEmptyReports > 0 ? totalRows / nonEmptyReports : 0;
  if (avgRowsPerNonEmpty < MIN_AVG_ROWS_PER_NONEMPTY_REPORT) {
    score -= LOW_DENSITY_PENALTY;
    reasons.push(`Only ${avgRowsPerNonEmpty.toFixed(2)} rows per non-empty report section on average — a sign of a shallow, likely-wrong partial match rather than a genuine one.`);
  }

  const missingPatientFields = ['name', 'age', 'sex', 'patient_id'].filter((f) => !patient[f]).length;
  if (missingPatientFields >= MISSING_PATIENT_FIELDS_THRESHOLD) {
    score -= MISSING_PATIENT_PENALTY;
    reasons.push(`${missingPatientFields}/4 core patient fields (name, age, sex, patient ID) came back empty.`);
  }

  score = Math.max(0, Math.min(1, score));
  return { score: Number(score.toFixed(2)), tier, recommendFallback: score < CONFIDENCE_THRESHOLD, reasons };
}

module.exports = { scoreConfidence, CONFIDENCE_THRESHOLD };
