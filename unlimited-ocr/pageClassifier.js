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

const { parseSection } = require('./rowParser');

const LAB_WORDS = /\b(reference (range|interval)|biological ref\w*|bio\.? ref\w*|investigations?|test (name|description)|observed value|specimen|sample (type|collected|received)|pathologist|nabl|laboratory|lab (no|report)|method(ology)?\s*:|haematology|hematology|biochemistry|serology|clinical pathology|immunoassay)\b/gi;
const MER_WORDS = /\b(medical examination|medical examiner|examinee|life (to be )?assured|proposer|proposal|declaration|questionnaire|family history|habits|addictions?|personal physician|hospitali[sz]ed|surgery|operation|disabilit\w+|insurability|underwrit\w+|doctor'?s comments|signature of|thumb impression|marital status|occupation|identification mark|mark or mole)\b/gi;
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
  const { rows } = parseSection(`(page)\n${t}`, '');
  const highRows = rows.filter((r) => r.confidence === 'high').length;
  const labWords = count(t, LAB_WORDS);
  const merWords = count(t, MER_WORDS);
  const yes = count(t, /\byes\b/gi);
  const no = count(t, /\bno\b/gi);
  const questionLines = lines.filter((l) => QUESTION_LINE.test(l)).length;
  const questionMarks = count(t, /\?/g);

  const labScore = highRows * 3 + (rows.length - highRows) + labWords * 2;
  const merScore = merWords * 3 + Math.min(yes, no) + questionLines * 2 + questionMarks;
  const signals = { rows: rows.length, highRows, labWords, merWords, yesNoPairs: Math.min(yes, no), questionLines, questionMarks, labScore, merScore };

  let type;
  if (merScore >= 8 && merScore > labScore) type = 'mer';
  // Strong lab vocabulary alone also counts: a lab page whose rows the
  // parser misses must still be parsed (and reach the LLM fallback), not
  // dropped as 'other'.
  else if (highRows >= 1 || rows.length >= 2 || labWords >= 3) type = 'lab';
  else type = 'other';
  return { type, signals };
}

module.exports = { classifyPage };
