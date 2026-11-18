// Deterministic, code-based validation — the opposite of asking the LLM to
// self-report a confidence score. Comparing a number against a range is
// exactly the kind of mechanical task that doesn't need AI at all. This runs
// AFTER categorization, as a cheap first-pass filter before anything reaches
// a human reviewer. Identical to ../unlimited-ocr/validate.js,
// ../hybrid-ocr/validate.js and ../regex-based/validate.js — copied, not
// shared, so each OCR demo stays fully standalone.
//
// Every row also gets the reference range split in two, each number kept
// exactly as printed: range_min / range_max ("0.10", "4000"; null = open
// end or not parseable) — what the PIMS DB stores in tbl_ocr_data.min_range
// / max_range. The printed range stays
// in `range`.

// ".51" is a number too (0.51) — reports print it that way; reading it as
// 51 flagged in-range values as high.
function parseLeadingNumber(str) {
  const m = String(str || '').replace(/,/g, '').match(/-?(?:\d+(?:\.\d+)?|\.\d+)/);
  return m ? parseFloat(m[0]) : null;
}

const NUM = '-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';

// One range expression, no sex labels: "12 - 15", "13.0 – 17.0", "13 to 17",
// "0.6-1.2 mg/dL", "Adults: 44 - 147", "Normal - 70 - 100", "Up to 40",
// "< 200", "<= 5", "> 40". Several "a - b" pairs → the last one (the most
// specific, e.g. after an "Adults:" label). null when nothing parses —
// that correctly falls back to "needs a human" rather than a guess.
function parseRangeText(text) {
  const s = String(text || '')
    .replace(/,/g, '')
    .replace(/[‐-―−]/g, '-')                       // en/em dash, minus sign
    .replace(new RegExp(`(${NUM})\\s+to\\s+(${NUM})`, 'gi'), '$1 - $2');

  // minText / maxText: the numbers exactly as printed ("0.10", not 0.1) —
  // what gets stored; min / max: numeric, for the high/low check.
  const pairs = [...s.matchAll(new RegExp(`(${NUM})\\s*-\\s*(${NUM})`, 'g'))];
  if (pairs.length) {
    const p = pairs[pairs.length - 1];
    return { min: parseFloat(p[1]), max: parseFloat(p[2]), minText: p[1], maxText: p[2] };
  }

  const upTo = s.match(new RegExp(`(?:up\\s*to|less\\s+than|below|<\\s*=?|≤)\\s*(${NUM})`, 'i'));
  if (upTo) return { min: -Infinity, max: parseFloat(upTo[1]), minText: null, maxText: upTo[1] };

  const atLeast = s.match(new RegExp(`(?:greater\\s+than|more\\s+than|above|>\\s*=?|≥)\\s*(${NUM})`, 'i'));
  if (atLeast) return { min: parseFloat(atLeast[1]), max: Infinity, minText: atLeast[1], maxText: null };

  return null;
}

// Sex-specific ranges: "Male: 13-17 Female: 12-15", "M 13-17 F 12-15",
// "Men 13 - 17 / Women 12 - 15". Returns { male, female } texts, or null
// when the range isn't labelled by sex.
const SEX_LABEL = /\b(female|male|women|men|f|m)\b\s*[:\-]?\s*/gi;
function splitBySex(text) {
  const s = String(text || '');
  const labels = [...s.matchAll(SEX_LABEL)];
  if (labels.length < 2) return null;
  const out = {};
  labels.forEach((m, i) => {
    const sex = /^(f|female|women)$/i.test(m[1]) ? 'female' : 'male';
    const end = i + 1 < labels.length ? labels[i + 1].index : s.length;
    const part = s.slice(m.index + m[0].length, end);
    if (!out[sex] && parseRangeText(part)) out[sex] = part;
  });
  return out.male && out.female ? out : null;
}

// Interpretation tables instead of one range: "<5.8 % : Non Diabetic;
// 5.8 - 6.6 % : Near Normal", "Deficiency: < 10, Insufficient: 10-30,
// Sufficient: 30-100, Hypervitaminosis: > 100", "Adults: 44 - 147;
// Children: 54 - 369", "0.35 - 4.94; Pregnancy: 1st Trimester 0.1 - 2.5 …".
// Two or more segments that each hold a number → use, in order:
//   1. the segment labelled as the healthy category (normal, sufficient …),
//   2. the adult segment (insurance applicants are adults),
//   3. a leading segment with no label — the general reference range, the
//      labelled ones after it being special cases (pregnancy, children);
// none of these → null (unchecked) rather than guess — e.g. risk tables.
// Returns undefined when the text isn't such a table.
const HEALTHY_LABEL = /\b(normal|non[\s-]*diabetic|desirable|sufficient|optimal|negative|non[\s-]*reactive)\b/i;
const NOT_HEALTHY_LABEL = /\b(near|borderline|pre|in)[\s-]*(normal|diabetic|sufficient)\b|\babove\s+normal\b/i;
const ADULT_LABEL = /\badults?\b/i;
const hasLabel = (x) => /[A-Za-z]{3,}/.test(x.replace(/\b(mg|g|ng|pg|mcg|ug|iu|miu|u|mmol|umol|mEq|dl|ml|l|fl|hpf|lpf|cumm|mm|hr|sec|min)\b/gi, ''));
function parseInterpretationTable(text) {
  const segments = String(text || '')
    .split(/[;\n|]|,\s*(?=[A-Za-z])/)
    .map((x) => x.trim())
    .filter((x) => /\d/.test(x));
  if (segments.length < 2 || !segments.some(hasLabel)) return undefined;
  const pick = segments.find((x) => HEALTHY_LABEL.test(x) && !NOT_HEALTHY_LABEL.test(x))
    || segments.find((x) => ADULT_LABEL.test(x))
    || (!hasLabel(segments[0]) ? segments[0] : null);
  return pick ? parseRangeText(pick) : null;
}

// rangeStr → { min, max } (±Infinity for an open end) or null.
// sex ('Male' / 'Female' / 'M' / 'F' …) picks the matching half of a
// sex-specific range; when the sex is unknown such a range returns null
// (unchecked) rather than guessing — previously the last (usually female)
// half was always used.
function parseRange(rangeStr, sex) {
  const bySex = splitBySex(rangeStr);
  if (bySex) {
    const s = String(sex || '').trim().toLowerCase();
    const key = /^(f|female|woman|women)/.test(s) ? 'female' : /^(m|male|man|men)/.test(s) ? 'male' : null;
    return key ? parseRangeText(bySex[key]) : null;
  }
  const table = parseInterpretationTable(rangeStr);
  if (table !== undefined) return table;
  return parseRangeText(rangeStr);
}


// status: "normal" | "high" | "low" | "unchecked"
// "unchecked" means the value or range wasn't a plain number — common for
// qualitative results ("Non Reactive", "Clear") — not an error, just not
// something code logic can judge, so it's routed to a human either way.
function validateRow(row, sex) {
  const value = parseLeadingNumber(row.value);
  const range = parseRange(row.range, sex);

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

// Mutates nothing — returns a new structure with range_min / range_max and a
// `validation` object added to every row, plus a summary count.
function validate(data) {
  const sex = data.patient && data.patient.sex;
  const reports = (data.reports || []).map((report) => ({
    ...report,
    rows: (report.rows || []).map((row) => {
      const range = parseRange(row.range, sex);
      return {
        ...row,
        range_min: range ? range.minText : null,
        range_max: range ? range.maxText : null,
        validation: validateRow(row, sex),
      };
    }),
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
