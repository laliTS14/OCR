// "Select first" flow: the user picks report types (reportCatalog.js) up
// front, and ONLY those sections are cut out of the reading stage's text —
// no per-page LLM "identify" pass (sections.js's identifyReports(), ~140s and
// prone to inventing section names) ever runs. Everything here is plain
// string matching and runs in milliseconds.
//
// Steps, for the whole document:
//  1. Split into pages (reuses sections.js's splitIntoPages) and number
//     every line with its page.
//  2. Find heading lines: short, match a catalog pattern, and contain no
//     result-like numbers (so "HbA1c %\t4.8 4.2 - 6.5" is a row, not a
//     heading). Generic boundaries (department names, "End of the Report")
//     are found too, but only ever end a section.
//  3. A section runs from its heading to the next heading of a DIFFERENT
//     type (or a boundary). Consecutive same-type headings merge — this is
//     how Helpline's separate TOTAL CHOLESTEROL / TRIGLYCERIDES / HDL
//     headings become one Lipid section.
//  4. If a type occurs in several places (e.g. Redcliffe's summary pages
//     repeat every profile name before the detailed results), keep the one
//     with the most result-looking lines.
//  5. Lines repeated on most pages (lab letterhead, patient block, footer
//     disclaimers) are stripped from section text; the first section keeps
//     its page's header so patient details still reach categorize().

const { REPORT_TYPES, BOUNDARY_PATTERNS } = require('./reportCatalog');
const { splitIntoPages } = require('./sections');
const { normalizeReadingText } = require('./textNormalize');

const MAX_HEADING_LEN = 100;
const MAX_SECTION_LINES = 150;
const MAX_HEADER_LINES = 45;
const PATIENT_FIELD_RE = /\b(patient|name|age|gender|sex|uhid|reg\.? ?no|dob|mobile|contact|phone|referred|ref\.?\s*by|p\.?\s*id)\b/i;

const normLine = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');

// A heading carries no result: no decimals, no tab-separated numeric cell,
// no "number + unit" tail. Digits inside words (HBA1C, B12) are fine.
function isHeadingLike(line) {
  const t = line.trim();
  if (!t || t.length > MAX_HEADING_LEN) return false;
  if (/\d+\.\d+/.test(t)) return false;
  if (/\t\s*[<>]?\s*\d/.test(line)) return false;
  if (/\s\d+\s*(%|mg|g\/dl|ng|pg|u\/l|iu|mm|fl|\/ul|thou|lakh|lacs|million)/i.test(t)) return false;
  return true;
}

function classifyLine(line) {
  if (!isHeadingLike(line)) return null;
  const t = line.trim();
  for (const type of REPORT_TYPES) {
    if (type.patterns.some((p) => p.test(t))) return { kind: 'type', typeId: type.id };
  }
  if (BOUNDARY_PATTERNS.some((p) => p.test(t))) return { kind: 'boundary' };
  return null;
}

const PAGE_MARKER_RE = /^(--\s*\d+\s+of\s+\d+\s*--|---\s*page\s+\d+\s+of\s+\d+\s*---|=== text layer.*===|page\s+\d+\s+of\s+\d+|\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\s*\/?)$/i;
// Explanation paragraphs ("Clinical Significance: ...") — long, untabbed
// prose lines. Result rows are far shorter; dropping these cuts prompt
// tokens a lot without losing data.
const PROSE_MIN_LEN = 110;
const isProse = (line) => line.trim().length >= PROSE_MIN_LEN && !line.includes('\t');

function scoreSection(lines) {
  // Result-looking = has a digit and is not just a page marker / date line.
  return lines.filter((l) => /\d/.test(l.text) && !PAGE_MARKER_RE.test(l.text.trim())).length;
}

// Letterhead/patient block/footer lines. 30% (min 3 pages), not 50%:
// Redcliffe prints its patient block only on the detailed-result pages,
// about half of its 19. Result rows essentially never repeat verbatim.
function findRepeatedLines(pages) {
  if (pages.length < 2) return new Set();
  const minPages = pages.length < 4 ? 2 : Math.max(3, Math.ceil(pages.length * 0.3));
  const counts = new Map();
  for (const p of pages) {
    const seen = new Set(p.text.split('\n').map(normLine).filter(Boolean));
    for (const l of seen) counts.set(l, (counts.get(l) || 0) + 1);
  }
  return new Set([...counts].filter(([, c]) => c >= minPages).map(([l]) => l));
}

// Returns { results: [{ typeId, label, found, heading, pageNumbers, text, lineCount, occurrences }] }
// in the same order as the requested typeIds.
function extractSelectedSections(ocrDump, typeIds) {
  // OCR (HTML tables) and text-layer output → the same plain-line shape
  const pages = splitIntoPages(normalizeReadingText(ocrDump));
  const repeated = findRepeatedLines(pages);

  const lines = [];
  for (const p of pages) {
    for (const text of p.text.split('\n')) lines.push({ page: p.pageNumber, text });
  }

  // Heading/boundary positions in document order.
  const marks = [];
  lines.forEach((l, i) => {
    const c = classifyLine(l.text);
    if (c) marks.push({ index: i, ...c });
  });

  // Build every section: merge consecutive same-type headings, stop at the
  // next different-type heading or boundary.
  const sectionsByType = new Map();
  for (let m = 0; m < marks.length; m++) {
    const mark = marks[m];
    if (mark.kind !== 'type') continue;
    if (m > 0 && marks[m - 1].kind === 'type' && marks[m - 1].typeId === mark.typeId) continue; // merged into previous
    let n = m + 1;
    while (n < marks.length && marks[n].kind === 'type' && marks[n].typeId === mark.typeId) n++;
    const end = n < marks.length ? marks[n].index : lines.length;
    const body = lines.slice(mark.index, Math.min(end, mark.index + MAX_SECTION_LINES));
    const section = { start: mark.index, heading: lines[mark.index].text.trim(), body };
    if (!sectionsByType.has(mark.typeId)) sectionsByType.set(mark.typeId, []);
    sectionsByType.get(mark.typeId).push(section);
  }

  const results = typeIds.map((typeId) => {
    const type = REPORT_TYPES.find((t) => t.id === typeId);
    const candidates = sectionsByType.get(typeId) || [];
    if (!candidates.length) {
      return { typeId, label: type.label, found: false, occurrences: 0 };
    }
    // Most result-looking lines wins; ties go to the later one (detailed
    // results usually follow summary pages).
    let best = candidates[0];
    for (const c of candidates) if (scoreSection(c.body) >= scoreSection(best.body)) best = c;

    const kept = best.body.filter((l) => {
      const t = l.text.trim();
      return t && !PAGE_MARKER_RE.test(t) && !isProse(l.text) && !repeated.has(normLine(t));
    });
    return {
      typeId,
      label: type.label,
      found: true,
      occurrences: candidates.length,
      heading: best.heading,
      start: best.start,
      pageNumbers: [...new Set(best.body.map((l) => l.page))],
      lineCount: kept.length,
      text: kept.map((l) => l.text).join('\n'),
    };
  });

  // Patient header: attached to one result only, so patient details are
  // extracted once, not per section.
  const found = results.filter((r) => r.found);
  if (found.length) {
    const first = found.reduce((a, b) => (a.start <= b.start ? a : b));
    first.headerText = buildHeaderText(lines, first.start);
  }

  for (const r of results) delete r.start;
  return { results };
}

// The patient/report header for a section starting at line index `start`:
// the lines above it on its own page (unfiltered — this is where
// name/age/ID live).
function buildHeaderText(lines, start) {
  const page = lines[start].page;
  const above = lines
    .map((l, i) => ({ ...l, i }))
    .slice(0, start)
    .filter((l) => l.page === page && l.text.trim() && !PAGE_MARKER_RE.test(l.text.trim()))
    .slice(-MAX_HEADER_LINES);
  // Some templates print the patient block BELOW the results in text-layer
  // order — only then take patient-field lines from further down the page
  // (not otherwise: footers can carry a pathologist's "Reg No", which would
  // compete with the patient's). Patient info = a labeled field, an
  // "NN Years" age line, or a titled name line ("MR. X").
  const hasPatientAbove = above.some((l) => PATIENT_FIELD_RE.test(l.text)
    || /\b\d{1,3}\s*(y|yrs?|years?)\b/i.test(l.text) || /^(mr|mrs|ms|miss|master|baby|smt|shri)\.?\s+[a-z]/i.test(l.text.trim()));
  const patientLines = hasPatientAbove ? [] : lines
    .map((l, i) => ({ ...l, i }))
    .filter((l) => l.page === page && l.i >= start && PATIENT_FIELD_RE.test(l.text));
  return [...new Map([...above, ...patientLines].map((l) => [l.i, l])).values()]
    .sort((a, b) => a.i - b.i)
    .map((l) => l.text)
    .join('\n');
}

module.exports = {
  extractSelectedSections, REPORT_TYPES,
  // shared with documentParser.js
  classifyLine, findRepeatedLines, buildHeaderText, isProse, PAGE_MARKER_RE, normLine,
};
