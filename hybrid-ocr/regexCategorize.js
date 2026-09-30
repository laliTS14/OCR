// Fully deterministic organize+categorize — no LLM call anywhere in this
// demo. Two tiers, tried in order:
//
//   TIER A — exact pattern match for one specific lab's template (Helpline
//   Pathology / MAX LIFE, the `mrs.babita khandelwal` document used
//   throughout this project's testing). Report boundaries come from that
//   template's own "<name> Sample Tested In : <specimen>" marker; rows are
//   tab-separated in a fixed shape. This is the original, narrowest, most
//   reliable path — used whenever that marker is present at all.
//
//   TIER B — a looser, more GENERIC fallback for documents that don't use
//   that marker at all (confirmed needed: neither the Redcliffe nor the
//   K Naresh Naidu sample reports use it). It looks for common structural
//   signals instead of one lab's literal wording: a "Test Name/Description
//   ... Result/Value" style column-header line marks where a report's rows
//   start, the nearest heading-like line above it becomes the report name,
//   and rows are parsed against several common shapes (tab-separated,
//   single-line "test value range unit", and a value line that continues a
//   test name from 1-2 lines above it).
//
// IMPORTANT — READ THIS BEFORE TRUSTING EITHER TIER ON A NEW DOCUMENT:
// this is still pattern matching, not understanding. Tier B covers MORE
// shapes than Tier A, not ALL shapes — confirmed on 3 real documents (see
// PROGRESS.md, Sept 2026): it recovers real rows from the K Naresh Naidu
// report that Tier A missed entirely, but still returns nothing for the
// Redcliffe report, whose rows sit under narrative headings with no
// column-header line or table structure at all. No LLM fallback exists
// here — by design, on explicit instruction — so a document neither tier
// can parse returns geniunely empty output rather than a guess. Making a
// tier MORE permissive to catch more shapes also raises the risk of a
// generic pattern matching something irrelevant as if it were real data
// (see the age-field false-positive documented in PROGRESS.md) — this is
// the fundamental trade-off of adding coverage without adding reasoning.

// ===================== Patient info (both tiers) =====================
// Tried in priority order, most-specific-label-match first, most-generic
// last. First match wins per field — this matters because a generic
// pattern (e.g. "any number followed by the word years") can match
// boilerplate text far from the real patient block if a more specific,
// clearly-labeled pattern doesn't get a chance to match first.

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  return '';
}

function extractPatient(text) {
  const name = firstMatch(text, [
    /Patient\s*Name\s*:\s*(.+)/i, // "Patient Name : MR. K NARESH NAIDU"
    /^(.+?)\t+Name\s*$/m, // Helpline's reversed, tab-joined "value\tName"
    /^Name\s*\n(.+)$/m, // label-then-value on separate lines (Redcliffe)
  ]);

  const patient_id = firstMatch(text, [
    /Patient\s*ID\s*:\s*(\S+)/i, // "Patient ID : 10697"
    /^(\S+)\t+Reg No\s*$/m, // Helpline's reversed "value\tReg No"
    /^Patient\s*ID\s*\n(\S+)$/im, // label-then-value on separate lines (Redcliffe)
    /Reg(?:istration)?\s*No\.?\s*:\s*(\S+)/i,
  ]);

  const age = firstMatch(text, [
    /Age\s*\/\s*Sex\s*:\s*(\d{1,3})/i, // "Age / Sex : 32 YEARS / MALE"
    /DOB\/Age\/Gender\s*:\s*(\d{1,3})/i, // "DOB/Age/Gender : 24 Y/Male"
    /^Age\s*\n(\d{1,3})/im, // label-then-value on separate lines (Redcliffe)
    /(\d{1,3})\s*Years?\b/i, // last resort — no label context, can false-match boilerplate (see PROGRESS.md)
  ]);

  const sex = firstMatch(text, [
    /Age\s*\/\s*Sex\s*:\s*\d{1,3}\s*YEARS?\s*\/\s*(MALE|FEMALE)/i,
    /\d{1,3}\s*Y\/(Male|Female)/i,
    /^Gender\s*\n(Male|Female|M|F)\s*$/im,
    /\b(Female|Male)\b/i, // last resort — first occurrence anywhere, can get lucky or unlucky
  ]);

  return {
    name,
    age,
    sex: /^m$/i.test(sex) ? 'Male' : /^f$/i.test(sex) ? 'Female' : sex,
    patient_id,
    contact_number: '',
  };
}

// ===================== Tier A: Helpline template =====================

const REPORT_HEADER_RE = /^(.*?)\s*Sample Tested In\s*:\s*(.*)$/gm;
const KNOWN_UNIT_RE = /\s+(gm\/dL|thou\/uL|million\/uL|mg\s*\/\s*dl|mg\/dL|lacks\/cumm|U\/L|g\/dL|mm 1st Hou[er]|\/uL|\/hpf|fL|Pg|%|ratio)$/i;
const QUALITATIVE_RESULT_RE = /(Pale Yellow|Non[- ]?Reactive|Reactive|Not Detected|Detected|Normal|Positive|Negative|Yellow|Clear|Straw|Trace|Nil)\s*$/i;
const EMBEDDED_NUMERIC_RE = /^(.*?)\s+(-?\d+(\.\d+)?)\s+(.*)$/;
const JUNK_ROW_RE = /^-+$|Performed By|^Ref Range for|^Remarks\s*:|^Method\s*:|^Note\s*:/i;

function splitByTestedInMarker(text) {
  const matches = [...text.matchAll(REPORT_HEADER_RE)];
  const blocks = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const name = m[1].trim();
    if (!name) continue;
    const specimen = m[2].trim();
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    blocks.push({ name, specimen, body: text.slice(start, end) });
  }
  return blocks;
}

function splitValueAndRange(valueAndRange) {
  const m = valueAndRange.match(/^(-?\d+(\.\d+)?)\s*(.*)$/);
  if (m) return { value: m[1], range: m[3].trim() };
  return { value: valueAndRange.trim(), range: '' };
}

function splitDescriptionAndQualitativeValue(description, reportName) {
  const qualMatch = description.match(QUALITATIVE_RESULT_RE);
  if (qualMatch) {
    const value = qualMatch[1];
    const test = description.slice(0, qualMatch.index).trim();
    return { test: test || reportName, value, range: '' };
  }
  const numMatch = description.match(EMBEDDED_NUMERIC_RE);
  if (numMatch) {
    return { test: numMatch[1].trim() || reportName, value: numMatch[2], range: numMatch[4].trim() };
  }
  return { test: description, value: '', range: '' };
}

function parseHelplineRow(line, reportName) {
  const cells = line.split('\t').map((c) => c.trim());
  if (cells.length < 2) return null;
  const last = cells[cells.length - 1];
  if (last !== '*') return null;

  if (cells.length === 2) {
    const description = cells[0];
    if (!description || JUNK_ROW_RE.test(description)) return null;
    const { test, value, range } = splitDescriptionAndQualitativeValue(description, reportName);
    return { test, value, unit: '', range };
  }

  const testAndUnit = cells[0];
  const valueAndRange = cells.slice(1, -1).join(' ').trim();
  if (!testAndUnit || JUNK_ROW_RE.test(testAndUnit)) return null;

  let test = testAndUnit;
  let unit = '';
  const unitMatch = testAndUnit.match(KNOWN_UNIT_RE);
  if (unitMatch) {
    unit = unitMatch[1];
    test = testAndUnit.slice(0, unitMatch.index).trim();
  }

  const { value, range } = splitValueAndRange(valueAndRange);
  return { test, value, unit, range };
}

// ===================== Tier B: generic fallback =====================

// A column-header row is a strong, common signal across many Indian lab
// report templates that real data rows start right after it, regardless of
// how that particular lab phrases everything else.
const COLUMN_HEADER_RE = /Test\s*(Name|Description)[\s\S]{0,30}?(Result|Value)/i;

// Lines that mean "a new page's patient/report header block has started" —
// stops a section's body from running past a page break into the next
// page's repeated patient info (confirmed necessary: K Naresh Naidu repeats
// the full patient block before every page's table).
const SECTION_TERMINATOR_RE = /^(Patient\s*Name\s*:|Age\s*\/\s*Sex\s*:|Age\s*\/\s*Gender|\*\*END OF REPORT\*\*|Page\s+\d+\s+of\s+\d+|Reported\s*By|Report Status\s*:)/i;

const HEADING_CANDIDATE_RE = /^[A-Za-z][A-Za-z0-9 ()&/.,'-]{2,60}$/;

function looksLikeHeading(line) {
  if (!HEADING_CANDIDATE_RE.test(line)) return false;
  if (/\d/.test(line)) return false;
  if (JUNK_ROW_RE.test(line) || SECTION_TERMINATOR_RE.test(line)) return false;
  return true;
}

function splitByGenericHeadings(text) {
  const lines = text.split('\n');
  const headerIdxs = [];
  lines.forEach((l, i) => {
    if (COLUMN_HEADER_RE.test(l.trim())) headerIdxs.push(i);
  });
  if (headerIdxs.length === 0) return [];

  const blocks = [];
  for (let h = 0; h < headerIdxs.length; h++) {
    const idx = headerIdxs[h];

    let name = 'Report';
    let bodyStart = idx + 1;

    // Try above the column header first (Redcliffe's shape: heading, then
    // "Test Name / Result").
    for (let j = idx - 1; j >= Math.max(0, idx - 5); j--) {
      const cand = lines[j].trim();
      if (!cand) continue;
      if (looksLikeHeading(cand)) name = cand;
      break; // only ever look at the nearest non-blank line above the header
    }

    // Some templates put the heading BELOW the column header instead (K
    // Naresh Naidu's shape: "Test Description..." then "Complete Blood
    // Count ( CBP )" then "Hemoglobin"). A bare test name looks identical to
    // a heading by text shape alone, so only treat idx+1 as the heading when
    // idx+2 ALSO looks like a bare line (i.e. two non-data lines in a row —
    // real test names here are followed by "Method :" or a value line, not
    // by another bare line).
    if (name === 'Report') {
      const nextLine = lines[idx + 1] ? lines[idx + 1].trim() : '';
      const afterNext = lines[idx + 2] ? lines[idx + 2].trim() : '';
      if (nextLine && looksLikeHeading(nextLine) && afterNext && looksLikeHeading(afterNext)) {
        name = nextLine;
        bodyStart = idx + 2;
      }
    }

    let end = lines.length;
    for (let k = bodyStart; k < lines.length; k++) {
      const cand = lines[k].trim();
      if (SECTION_TERMINATOR_RE.test(cand)) { end = k; break; }
      if (h + 1 < headerIdxs.length && k >= headerIdxs[h + 1] - 3) { end = headerIdxs[h + 1]; break; }
    }

    blocks.push({ name, body: lines.slice(bodyStart, end).join('\n') });
  }
  return blocks;
}

// Lines that are never a test name or a value, regardless of lab —
// narrative/administrative text a generic pattern should never mistake for
// data.
const GENERIC_JUNK_LINE_RE = /^Method\s*:|^Comments\s*$|^Reported By|^\*\*END OF REPORT\*\*|^Page\s+\d+\s+of\s+\d+|^Please Watchout$|^Everything looks good$|^•/i;

// "<test> <value> <range> <unit>" all on one line, space-separated — e.g.
// "Platelet Count 2.26 1.50 - 4.50 lakh/cumm".
const GENERIC_ROW_WITH_RANGE_RE = /^(.+?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?\s*-\s*-?\d+(?:\.\d+)?)\s+(\S.*)$/;

// A bare value line with no test name of its own — continues whatever bare
// test-name line came just before it, e.g. "Hemoglobin" / "Method : ..." /
// "14.3 13.0 - 17.0 g/dL".
const PURE_VALUE_LINE_RE = /^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?\s*-\s*-?\d+(?:\.\d+)?)\s+(\S.*)$/;

function parseGenericRows(bodyLines) {
  const rows = [];
  let pendingTest = null;

  for (const raw of bodyLines) {
    const line = raw.trim();
    if (!line) continue;
    if (GENERIC_JUNK_LINE_RE.test(line)) continue;

    // Shape 1: tab-separated "test\tvalue[ range]" (e.g. "RBC Count \t4.3")
    const tabCells = line.split('\t').map((c) => c.trim()).filter(Boolean);
    if (tabCells.length === 2 && /^-?\d/.test(tabCells[1])) {
      const { value, range } = splitValueAndRange(tabCells[1]);
      rows.push({ test: tabCells[0], value, unit: '', range });
      pendingTest = null;
      continue;
    }

    // Shape 2: single line, test+value+range+unit together
    let m = line.match(GENERIC_ROW_WITH_RANGE_RE);
    if (m) {
      rows.push({ test: m[1].trim(), value: m[2], range: m[3].trim(), unit: m[4].trim() });
      pendingTest = null;
      continue;
    }

    // Shape 3: a bare value line continuing a test name from 1-2 lines above
    m = line.match(PURE_VALUE_LINE_RE);
    if (m && pendingTest) {
      rows.push({ test: pendingTest, value: m[1], range: m[2].trim(), unit: m[3].trim() });
      pendingTest = null;
      continue;
    }

    // Shape 4: a bare test-name candidate — remember it in case the next
    // line (possibly after a skipped "Method :" line) is its value.
    if (!/\d/.test(line) && line.length <= 80 && HEADING_CANDIDATE_RE.test(line)) {
      pendingTest = line;
      continue;
    }
    // Anything else (narrative prose, disclaimers) is ignored without
    // disturbing whatever test name is currently pending.
  }

  return rows;
}

// ===================== Entry point =====================

function categorize(ocrDump) {
  const patient = extractPatient(ocrDump);

  let blocks = splitByTestedInMarker(ocrDump);
  let tier = 'A';
  if (blocks.length === 0) {
    blocks = splitByGenericHeadings(ocrDump);
    tier = 'B';
  }

  const reports = blocks.map((block) => {
    const rows = tier === 'A'
      ? block.body.split('\n').map((line) => parseHelplineRow(line, block.name)).filter(Boolean)
      : parseGenericRows(block.body.split('\n'));
    return {
      report_type: block.name,
      lab_name: '',
      referring_doctor: '',
      sample_collected_date: '',
      report_date: '',
      rows,
    };
  });

  // `tier` is extra vs. ../regex-based/'s copy of this file — this demo's
  // confidence.js needs to know which tier matched to score trust in the
  // result. validate.js only ever reads .patient/.reports, so this addition
  // is harmless to the rest of the pipeline.
  return { patient, reports, tier };
}

module.exports = { categorize, splitByTestedInMarker, splitByGenericHeadings, extractPatient };
