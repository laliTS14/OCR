// Deterministic, code-based validation — the opposite of asking the LLM to
// self-report a confidence score. Comparing a number against a range is
// exactly the kind of mechanical task that doesn't need AI at all, and a
// regex-based check is trustworthy in a way a model's own "I'm 98% sure"
// never was in our earlier tests. This runs AFTER categorization, as a
// cheap first-pass filter before anything reaches a human reviewer.

function parseLeadingNumber(str) {
  const m = String(str || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

// Handles the messy real-world range formats we actually saw on a real
// report: "12 - 15", "Adults: 44 - 147", "Normal - 70 - 100", "Up to 40",
// "> 40", "< 200". Anything it can't confidently parse returns null,
// which correctly falls back to "needs a human" rather than a guess.
function parseRange(rangeStr) {
  const s = String(rangeStr || '').replace(/,/g, '');

  const between = s.match(/(-?\d+(\.\d+)?)\s*-\s*(-?\d+(\.\d+)?)\s*$/);
  if (between) return { min: parseFloat(between[1]), max: parseFloat(between[3]) };

  const upTo = s.match(/(?:up to|less than|<)\s*(-?\d+(\.\d+)?)/i);
  if (upTo) return { min: -Infinity, max: parseFloat(upTo[1]) };

  const atLeast = s.match(/(?:>|greater than|more than)\s*(-?\d+(\.\d+)?)/i);
  if (atLeast) return { min: parseFloat(atLeast[1]), max: Infinity };

  return null;
}

// status: "normal" | "high" | "low" | "unchecked"
// "unchecked" means the value or range wasn't a plain number — common for
// qualitative results ("Non Reactive", "Clear") — not an error, just not
// something code logic can judge, so it's routed to a human either way.
function validateRow(row) {
  const value = parseLeadingNumber(row.value);
  const range = parseRange(row.range);

  if (value == null || !range) {
    return { status: 'unchecked', reason: 'Non-numeric value or unrecognized range format — needs manual review.' };
  }
  if (value < range.min) {
    return { status: 'low', reason: `${value} is below the reference minimum of ${range.min}.` };
  }
  if (value > range.max) {
    return { status: 'high', reason: `${value} is above the reference maximum of ${range.max}.` };
  }
  return { status: 'normal', reason: null };
}

// Mutates nothing — returns a new structure with a `validation` object
// added to every row, plus a summary count.
function validate(data) {
  const reports = (data.reports || []).map((report) => ({
    ...report,
    rows: (report.rows || []).map((row) => ({ ...row, validation: validateRow(row) })),
  }));

  let normal = 0, flagged = 0, unchecked = 0;
  reports.forEach((r) => r.rows.forEach((row) => {
    if (row.validation.status === 'normal') normal++;
    else if (row.validation.status === 'unchecked') unchecked++;
    else flagged++;
  }));

  return {
    patient: data.patient,
    reports,
    validationSummary: { normal, flagged, unchecked },
  };
}

module.exports = { validate, validateRow, parseLeadingNumber, parseRange };
