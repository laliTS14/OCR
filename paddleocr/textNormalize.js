// Normalizes the reading stage's output into plain lines before section
// location and row parsing, so the text-layer path and the OCR path look
// the same to everything downstream:
//   - HTML <table> markup (Unlimited-OCR's output for scans) → one line per
//     <tr>, cells joined by tabs — the same shape a PDF text layer gives.
//   - Two consecutive tables where the second holds only units/ranges
//     (Unlimited-OCR often splits one report table into "test | value" and
//     "unit | range", in the same row order) are zipped back together — but
//     ONLY when the result rows and the unit/range rows match one-to-one;
//     otherwise both are left as they are rather than guessed at.
//   - HTML entities decoded, image placeholders dropped.

const { UNITS } = require('./labVocabulary');

const normUnit = (s) => String(s || '').toLowerCase().replace(/[µμ]/g, 'u').replace(/\s+/g, '').replace(/\.+$/, '');
const UNIT_SET = new Set(UNITS.map(normUnit));

function decode(s) {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function tableRows(html) {
  return html.split(/<\/tr>/i)
    .map((tr) => [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => decode(m[1])).filter((c) => c !== ''))
    .filter((cells) => cells.length);
}

const isUnit = (c) => UNIT_SET.has(normUnit(c));
const isRangeCell = (c) => /\d/.test(c) && /^[\d\s.<>=\-–:%/a-zA-Zµμ^()]*$/.test(c) && !/[a-z]{4,}/i.test(c.replace(/up ?to|less|than|more|normal/gi, ''));
// Row of a "units/ranges" table: every cell is a unit or a range.
const isUnitRangeRow = (cells) => cells.every((c) => isUnit(c) || isRangeCell(c));
// Row of a "test | value" table carrying a real result (not "----" or a method word).
const isResultRow = (cells) => cells.length >= 2 && /[a-z]/i.test(cells[0])
  && /^([<>]?\d|non|not|nil|neg|pos|absent|present|reactive|trace|normal|clear|pale|yellow)/i.test(cells[cells.length - 1]);

function zipTables(a, b) {
  // b may start with a label row ("Sample Tested In : Whole Blood")
  const bData = b.filter(isUnitRangeRow);
  if (bData.length < 2 || bData.length < b.length - 1) return null;
  const aResults = a.filter(isResultRow);
  if (aResults.length !== bData.length) return null; // no clean one-to-one match: don't guess
  let k = 0;
  return a.map((cells) => (isResultRow(cells) ? [...cells, ...bData[k++]] : cells));
}

function normalizeReadingText(text) {
  let out = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  if (!/<table/i.test(out)) return out;

  const parts = out.split(/(<table[\s\S]*?<\/table>)/i);
  const result = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!/^<table/i.test(part)) { result.push(part); continue; }
    let rows = tableRows(part);
    // Look ahead: next non-blank part is another table?
    let j = i + 1;
    while (j < parts.length && !/^<table/i.test(parts[j]) && !parts[j].trim()) j++;
    if (j < parts.length && /^<table/i.test(parts[j])) {
      const zipped = zipTables(rows, tableRows(parts[j]));
      if (zipped) { rows = zipped; i = j; }
    }
    result.push(`\n${rows.map((cells) => cells.join('\t')).join('\n')}\n`);
  }
  return result.join('');
}

module.exports = { normalizeReadingText };
