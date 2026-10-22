// Page-level document classification: lab (pathology results) | mer
// (medical examination questionnaire) | other (letters, emails, cover
// pages, TMT/ECG graphs) | no_text (no usable text — scanned page or
// blank; needs OCR). Merged PDFs mix these (a case file can
// be "MER + reports"), so this runs per page; only LAB pages go to the
// pathology parser — MER pages will get their own pipeline later, and
// nothing is dropped silently (every page's class is reported).
//
// Signals are general, not tied to any lab or insurer:
//   lab — rows the rules parser actually finds (strongest), plus lab
//         vocabulary (reference range, investigation, specimen, pathologist…)
//   mer — questionnaire vocabulary (medical examination report, life
//         assured, examinee, proposer, declaration, family history…),
//         numbered sub-questions ("a.", "iii)", "5. a."), Yes/No pairs,
//         question marks.
//   not pathology — ECG / radiology / cardiology report vocabulary,
//         identity documents (Aadhaar, PAN…) and other non-medical papers
//         that land in Single Group uploads (train tickets, salary slips): their numbers look like a
//         couple of result rows ("Vent Rate (BPM) 148", a PIN code), so
//         with ≥ 2 such words and fewer than 2 confident rows the page is
//         'other', never 'lab'.
// A case file is read in order, so classifyPages() also looks at the page
// before: a lab report's last page often holds only a test or two buried
// in explanation text (urine "Ketones Not present — Presence may
// indicate…"); an 'other' page with lab vocabulary right after a lab page
// is the same report → 'lab'.

const { parseSection } = require('./rowParser');

const LAB_WORDS = /\b(reference (range|interval)|biological ref\w*|bio\.? ref\w*|investigations?|test (name|description)|observed value|specimen|sample (type|collected|received)|pathologist|nabl|laboratory|lab (no|report)|method(ology)?\s*:|haematology|hematology|biochemistry|serology|clinical pathology|immunoassay)\b/gi;
const MER_WORDS = /\b(medical examination|medical examiner|examinee|life (to be )?assured|proposer|proposal|declaration|questionnaire|family history|habits|addictions?|personal physician|hospitali[sz]ed|surgery|operation|disabilit\w+|insurability|underwrit\w+|doctor'?s comments|signature of|thumb impression|marital status|occupation|identification mark|mark or mole)\b/gi;
const NON_PATHOLOGY_WORDS = /\b(ecg|e\.c\.g|electrocardiogra\w*|qrs|p[\s.-]?wave|st[\s-]segment|pr interval|qt\s*\/?\s*qtc|vent\.?\s*rate|bpm|treadmill|tmt|echocardiogra\w*|2d echo|ejection fraction|x-?ray|radiograph\w*|radiolog\w*|ultrasound|ultrasonograph\w*|sonograph\w*|usg|mammogra\w*|spirometr\w*|aadhaa?r|uidai|unique identification|proof of identity|citizenship|income tax department|permanent account number|driving licen[cs]e|election commission|pnr|irctc|passengers?|boarding|berth|railway|salary|payslip|pay slip|net pay|earnings|deductions)\b/gi;
const QUESTION_LINE = /^\s*(\d{1,2}\s*[.)]\s*)?([a-h]|i{1,3}|iv|v|vi{0,3})\s*[.)]\s+\S/i;

const count = (text, re) => (text.match(re) || []).length;

// Fewer letters than this = no usable text on the page (a scanned page
// inside an otherwise digital PDF, or a blank page) → 'no_text', reported
// as needing OCR rather than silently treated as 'other'.
const MIN_PAGE_LETTERS = 30;

function classifyPage(text) {
  const t = String(text || '');
  const letters = (t.match(/[a-z]/gi) || []).length;
  if (letters < MIN_PAGE_LETTERS) return { type: 'no_text', signals: { letters } };
  const lines = t.split('\n').filter((l) => l.trim());
  const { rows } = parseSection(`\n${t}`, ''); // empty heading line (skipped by the parser)
  const highRows = rows.filter((r) => r.confidence === 'high').length;
  const labWords = count(t, LAB_WORDS);
  const merWords = count(t, MER_WORDS);
  const yes = count(t, /\byes\b/gi);
  const no = count(t, /\bno\b/gi);
  const questionLines = lines.filter((l) => QUESTION_LINE.test(l)).length;
  const questionMarks = count(t, /\?/g);
  const nonPathWords = count(t, NON_PATHOLOGY_WORDS);

  const labScore = highRows * 3 + (rows.length - highRows) + labWords * 2;
  const merScore = merWords * 3 + Math.min(yes, no) + questionLines * 2 + questionMarks;
  const signals = { rows: rows.length, highRows, labWords, merWords, nonPathWords, yesNoPairs: Math.min(yes, no), questionLines, questionMarks, labScore, merScore };

  let type;
  if (merScore >= 8 && merScore > labScore) type = 'mer';
  // ECG / radiology / ID document: not pathology, however its numbers parse
  else if (nonPathWords >= 2 && highRows < 2) type = 'other';
  // Strong lab vocabulary alone also counts: a lab page whose rows the
  // parser misses must still be parsed (and reach the LLM fallback), not
  // dropped as 'other'. A single-test page (HIV, HBsAg, cotinine) has one
  // row, often qualitative, plus the lab's own wording.
  else if (highRows >= 1 || rows.length >= 2 || labWords >= 3 || (rows.length >= 1 && labWords >= 2)) type = 'lab';
  else type = 'other';
  return { type, signals };
}

// Per-page classes for a whole document, in page order ([{ page, text }]),
// with the continuation rule applied (see the header).
function classifyPages(pages) {
  const out = pages.map((p) => ({ page: p.pageNumber, ...classifyPage(p.text) }));
  for (let i = 1; i < out.length; i++) {
    const s = out[i].signals;
    if (out[i].type === 'other' && out[i - 1].type === 'lab' && s.labWords >= 2 && !s.nonPathWords) {
      out[i] = { ...out[i], type: 'lab', signals: { ...s, continuesLabPage: out[i - 1].page } };
    }
  }
  return out;
}

module.exports = { classifyPage, classifyPages };
