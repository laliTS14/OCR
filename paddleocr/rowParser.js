// Rules-based row parser for one located report section (selectReports.js)
// — no LLM, no lab-specific templates. It works from what EVERY lab report
// row is made of: a test name, a value (number or qualitative phrase), a
// unit and a reference range, written with a shared vocabulary
// (labVocabulary.js). Only the LAYOUT differs between labs, and the parser
// handles the layouts generically:
//
//   A. one line, tab cells:   "Haemoglobin ( Hb ) gm/dL⇥13.6 12 - 15⇥*"
//   B. one line, spaces:      "MCV 85.6 83 - 101 fl"
//   C. name / method / value: "Hemoglobin" ⏎ "Cyanide-free Spectrophotometry" ⏎ "8.8 g/dL 13.0 - 17.0"
//   D. qualitative:           "Urine Protein Negative Negative", "HIV Antibody , Elisa Non Reactive"
//   E. range continued below: "42.6 Normal - > 40" ⏎ "Borderline - 40 - 60" ⏎ "High Risk - < 60"
//
// How a line is split into name | value | unit | range: every position where
// a value could start (a number or a qualitative phrase) is tried left to
// right; the first one where EVERYTHING after it is value/unit/range
// vocabulary wins. Anything else (dates, meta lines, prose) is rejected
// rather than guessed at — a missed row is recoverable, a wrong one isn't.
//
// paramDictionary.js only labels and sanity-checks rows (canonical name,
// plausibility, confidence); rows for tests it doesn't know still come out.

const V = require('./labVocabulary');
const { matchParam, normUnit, nameTokens } = require('./paramDictionary');

const UNIT_SET = new Set(V.UNITS.map(normUnit));
const QUALS = V.QUALITATIVE.map((q) => q.toLowerCase().split(/\s+/)).sort((a, b) => b.length - a.length);
const QUAL_WORDS = new Set(V.QUALITATIVE.flatMap((q) => q.toLowerCase().match(/[a-z]+/g) || []));

const NUM_RE = /^[<>≤≥]=?\d+(?:[.,]\d+)*$|^\d+(?:[.,]\d+)*$|^\.\d+$/;
const NUM_RANGE_TOKEN_RE = /^\d+(?:\.\d+)?[-–]\d+(?:\.\d+)?$/; // "1-2", "0-10"
const NEG_NUM_RE = /^[-–]\d+(?:\.\d+)?$/; // "-7.5" (range tail written without a space)
const COMPARATORS = new Set(['<', '>', '<=', '>=', '≤', '≥', '=<', '=>']);
const MAX_NAME_LEN = 80;

const clean = (t) => t.replace(/[,;]+$/, '');
const isNum = (t) => !!t && NUM_RE.test(clean(t));
const isNumLike = (t) => !!t && (isNum(t) || NUM_RANGE_TOKEN_RE.test(t) || NEG_NUM_RE.test(t));

// Number glued to a unit ("1-2/hpf", "20ML", "5.3%") → two tokens.
const GLUED_RE = /^([<>]?\d+(?:\.\d+)?(?:[-–]\d+(?:\.\d+)?)?)((?:\/|%|[a-zµμ]).*)$/i;

function tokenize(line) {
  const toks = [];
  // "NON - REACTIVE" → "NON-REACTIVE", so it matches the qualitative list;
  // "> =" → ">="
  const norm = line.replace(/\b(non|not)\s*-\s*(?=[a-z])/gi, '$1-').replace(/([<>])\s+=/g, '$1=');
  norm.split('\t').forEach((cell, ci) => {
    // a separator cell prefix ("⇥: 0.60", "⇥= Negative") isn't part of the value
    cell.trim().replace(/^[:=]\s*/, '').split(/\s+/).filter(Boolean).forEach((t, ti) => {
      const g = t.match(GLUED_RE);
      const parts = g && UNIT_SET.has(normUnit(g[2])) ? [g[1], g[2]] : [t];
      parts.forEach((p, k) => toks.push({ t: p, cellStart: ci > 0 && ti === 0 && k === 0, cell: ci }));
    });
  });
  // "<" "2" → "<2"
  for (let i = 0; i < toks.length - 1; i++) {
    if (COMPARATORS.has(toks[i].t) && isNum(toks[i + 1].t)) {
      toks.splice(i, 2, { ...toks[i], t: toks[i].t + toks[i + 1].t });
    }
  }
  return toks;
}

function unitLenAt(toks, i) {
  for (let len = Math.min(6, toks.length - i); len >= 1; len--) {
    const s = normUnit(toks.slice(i, i + len).map((x) => x.t).join(''));
    if (UNIT_SET.has(s) || UNIT_SET.has(s.replace(/^\(|\)$/g, ''))) return len;
  }
  return 0;
}

function qualLenAt(toks, i) {
  for (const q of QUALS) {
    if (i + q.length > toks.length) continue;
    if (q.every((w, k) => clean(toks[i + k].t).toLowerCase() === w)) return q.length;
  }
  return 0;
}

const hasNumberFrom = (toks, from) => toks.slice(from).some((x) => isNumLike(x.t));

// Words in a range string that aren't range/unit/qualitative vocabulary.
function junkWords(toks) {
  let junk = 0;
  for (let i = 0; i < toks.length; i++) {
    const ul = unitLenAt(toks, i);
    if (ul) { i += ul - 1; continue; }
    for (const w of toks[i].t.toLowerCase().match(/[a-z]+/g) || []) {
      if (!V.RANGE_WORDS.has(w) && !QUAL_WORDS.has(w)) junk++;
    }
  }
  return junk;
}

// Tries to read toks as: value [flag] [unit] [range] [unit] [flag].
// Returns null when toks don't START with a value.
function parseRest(toks) {
  if (!toks.length) return null;
  let value;
  let i;
  let qualitative = false;
  const ql = qualLenAt(toks, 0);
  if (ql) {
    value = toks.slice(0, ql).map((x) => clean(x.t)).join(' ');
    i = ql;
    qualitative = true;
  } else if (NUM_RANGE_TOKEN_RE.test(toks[0].t)) {
    if (!hasNumberFrom(toks, 1)) return null; // just a range, no value
    value = toks[0].t;
    i = 1;
  } else if (isNum(toks[0].t)) {
    value = clean(toks[0].t);
    i = 1;
    const next = toks[1] && toks[1].t;
    if (next === '-' && isNum(toks[2] && toks[2].t)) {
      if (!hasNumberFrom(toks, 3)) return null; // "70 - 100": a range, no value
      value = `${value} - ${clean(toks[2].t)}`; // range-valued result, e.g. pus cells "3 - 4"
      i = 3;
    } else if (next && NEG_NUM_RE.test(next) && !hasNumberFrom(toks, 2)) {
      return null; // "4.7 -7.5": a range, no value
    }
  } else {
    return null;
  }

  let rest = toks.slice(i);
  const flags = [];
  // "13.6 H 12 - 15", "* 8.8"
  while (rest.length && (V.FLAG_TOKENS.has(rest[0].t.toLowerCase()) || /^(high|low)$/i.test(rest[0].t))) {
    flags.push(rest.shift().t);
  }
  let unit = '';
  if (qualitative && rest.length && unitLenAt(rest, 0) === rest.length) {
    unit = rest.map((x) => x.t).join(' '); // "Nil /hpf"
    rest = [];
  } else if (!qualitative) {
    for (let j = 0; j < rest.length; j++) {
      const ul = unitLenAt(rest, j);
      if (ul) {
        unit = rest.slice(j, j + ul).map((x) => x.t).join(' ').replace(/\s*\/\s*/g, '/');
        rest = [...rest.slice(0, j), ...rest.slice(j + ul)];
        break;
      }
    }
  }
  rest = rest.filter((x) => {
    if (V.FLAG_TOKENS.has(x.t.toLowerCase())) { flags.push(x.t); return false; }
    return true;
  });
  const range = rest.map((x) => x.t).join(' ').replace(/^[:\-\s]+/, '').trim();
  return { value, unit, range, flags, qualitative, junk: junkWords(rest) };
}

// Strips a trailing unit (Helpline prints "Haemoglobin ( Hb ) gm/dL"),
// flags and punctuation off a printed test name.
// OCR often merges the method sub-line into the name cell:
// "Vitamin - B12Method: CMIA" → "Vitamin - B12".
const METHOD_SUFFIX_RE = /\s*method\s*[:\-].*$/i;
// "Result : Negative", "Observed Value : Non Reactive"
const RESULT_LABEL_RE = /^(?:result|observed value|finding)\s*[:\-]\s*(.+)$/i;

function cleanName(name) {
  let toks = tokenize(name.replace(/\t/g, ' ').replace(METHOD_SUFFIX_RE, ''));
  let unit = '';
  for (let len = Math.min(4, toks.length); len >= 1; len--) {
    const start = toks.length - len;
    if (start >= 0 && unitLenAt(toks, start) === len) {
      unit = toks.slice(start).map((x) => x.t).join(' ').replace(/\s*\/\s*/g, '/');
      toks = toks.slice(0, start);
      break;
    }
  }
  const text = toks.map((x) => x.t).join(' ')
    .replace(/^[*•\-\s]+/, '')
    .replace(/[\s*:.,\-]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { name: /[a-z]/i.test(text) ? text : '', unit };
}

// ---- Tab-cell layouts: classify each cell by CONTENT, not position ----
// The PDF text layer can emit columns in any order — e.g. one lab comes out
// as "11.5 - 17.5 g/dL⇥14.3 g/dL⇥Haemoglobin" (range, value, name).
// Each cell is typed N (name), V (value, optionally with unit/range),
// R (range only), U (unit only).
function classifyCell(cell) {
  const toks = tokenize(cell);
  if (!toks.length) return null;
  const text = cell.trim();
  if (V.FLAG_TOKENS.has(text.toLowerCase())) return null;
  const pr = parseRest(toks);
  // "Normal Or High: >= 90" starts with a qualitative word but is a range
  const qualWithNumbers = pr && pr.qualitative && /\d/.test(text);
  if (pr && pr.junk === 0 && !isComparatorOnly(pr) && !qualWithNumbers) return { kind: 'V', text, parsed: pr };
  if (isRangeLike(text)) return { kind: 'R', text };
  if (unitLenAt(toks, 0) === toks.length) return { kind: 'U', text };
  if (/[a-z]/i.test(text)) return { kind: 'N', text };
  return null;
}

const cellsOf = (raw) => raw.split('\t').map(classifyCell).filter(Boolean);

// "<6.0 Non Diabetic", "> 200" with no unit: a reference-range line, not a
// result.
const isComparatorOnly = (pr) => !pr.qualitative && /^[<>≤≥]/.test(pr.value) && !pr.unit;

function parseCells(raw, valueAfterRange) {
  const cells = cellsOf(raw);
  if (cells.length < 2) return null;
  const names = cells.filter((c) => c.kind === 'N');
  const values = cells.filter((c) => c.kind === 'V');
  const ranges = cells.filter((c) => c.kind === 'R');
  const units = cells.filter((c) => c.kind === 'U');
  let valueCell = values[0];
  let rangeCells = ranges;
  if (!valueCell && ranges.length >= 2) {
    // Two range-looking cells ("1-2/hpf⇥1-2 /hpf"): one is a range-valued
    // result. The section's usual column order decides which.
    const pick = valueAfterRange ? ranges[ranges.length - 1] : ranges[0];
    const pt = tokenize(pick.text);
    const ui = pt.findIndex((x, j) => unitLenAt(pt, j));
    valueCell = {
      kind: 'V',
      text: pick.text,
      parsed: {
        value: pt.slice(0, ui < 0 ? pt.length : ui).map((x) => x.t).join(' '),
        unit: ui < 0 ? '' : pt.slice(ui).map((x) => x.t).join(' '),
        range: '', qualitative: false, flags: [],
      },
    };
    rangeCells = ranges.filter((c) => c !== pick);
  } else if (values.length >= 2) {
    valueCell = valueAfterRange ? values[values.length - 1] : values[0];
    rangeCells = [...ranges, ...values.filter((c) => c !== valueCell)];
  }
  if (!valueCell) return null;
  const pr = valueCell.parsed;
  const rangeText = [pr.range, ...rangeCells.map((c) => c.text)].filter(Boolean).join(' ');
  // A unit may also sit inside the range cell ("11.5 - 17.5 g/dL").
  let unit = pr.unit || (units[0] && units[0].text) || '';
  let range = rangeText;
  if (!unit) {
    const rt = tokenize(rangeText);
    for (let j = 0; j < rt.length; j++) {
      const ul = unitLenAt(rt, j);
      if (ul) { unit = rt.slice(j, j + ul).map((x) => x.t).join(' '); break; }
    }
  }
  if (unit) range = range.replace(new RegExp(`\\s*${unit.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&').replace(/\s+/g, '\\s*')}\\.?\\s*$`, 'i'), '').trim();
  const base = { value: pr.value, unit: unit.replace(/\s*\/\s*/g, '/'), range, qualitative: pr.qualitative, flags: pr.flags || [], junk: 0 };
  if (!names.length) return { kind: 'value', ...base };
  return { kind: 'row', name: names.map((c) => c.text).join(' '), ...base };
}

// Section-level column order: in lines with exactly one value cell and one
// range cell, does the value usually come AFTER the range?
function detectValueAfterRange(lines) {
  let after = 0;
  let before = 0;
  for (const raw of lines) {
    if (!raw.includes('\t')) continue;
    const cells = cellsOf(raw);
    const vi = cells.findIndex((c) => c.kind === 'V');
    const ri = cells.findIndex((c) => c.kind === 'R');
    if (vi < 0 || ri < 0 || cells.filter((c) => c.kind === 'V').length !== 1) continue;
    if (vi > ri) after++; else before++;
  }
  return after > before;
}

// Classifies one line.
function parseLine(raw, valueAfterRange = false) {
  const toks = tokenize(raw);
  if (!toks.length) return { kind: 'empty' };
  if (raw.includes('\t')) {
    const pc = parseCells(raw, valueAfterRange);
    if (pc && (pc.kind === 'value' || !/[:]/.test(pc.name) || /\t/.test(raw))) {
      if (pc.kind === 'value' || /[a-z]/i.test(pc.name)) {
        const words = (pc.name || '').toLowerCase().match(/[a-z]+/g) || [];
        if (words.filter((w) => V.PROSE_WORDS.has(w)).length < 2) return pc;
      }
    }
  }
  const r0 = parseRest(toks);
  if (r0 && r0.junk === 0) return { kind: 'value', ...r0 };
  if (unitLenAt(toks, 0) === toks.length) return { kind: 'unit', unit: raw.trim() };

  // Candidate value starts: tab-cell boundaries first (most reliable), then
  // every other token, left to right.
  const order = [];
  toks.forEach((x, i) => { if (i > 0 && x.cellStart) order.push(i); });
  toks.forEach((x, i) => { if (i > 0 && !x.cellStart) order.push(i); });
  for (const i of order) {
    if (!qualLenAt(toks, i) && !isNumLike(toks[i].t)) continue;
    const r = parseRest(toks.slice(i));
    if (!r || r.junk > 0) continue;
    const name = toks.slice(0, i).map((x) => x.t).join(' ');
    // A bare number with no unit, no range and no cell boundary is part of
    // the name ("HIV 1", "Type 2"), not a result.
    if (!r.qualitative && !r.unit && !r.range && !toks[i].cellStart) continue;
    if (!/[a-z]/i.test(name)) continue;
    const words = name.toLowerCase().match(/[a-z]+/g) || [];
    if (words.filter((w) => V.PROSE_WORDS.has(w)).length >= 2) continue;
    return { kind: 'row', name, ...r };
  }
  return { kind: 'text' };
}

// "70 - 100", "Borderline - 40 - 60", "M 0.45-1.45" — but not a unit-first
// value line like "mg /dl⇥91.06 73 - 140" or a unit like "mm 1st Houe".
function isRangeOnly(t) {
  if (!/\d/.test(t)) return false;
  const toks = tokenize(t);
  if (!toks.some((x) => isNumLike(x.t)) || unitLenAt(toks, 0)) return false;
  if (junkWords(toks) !== 0) return false;
  const pr = parseRest(toks);
  return !pr || pr.qualitative; // "Normal Or High: >= 90" is a range, not a result
}

// Range-only, or a comparator line with no unit ("< 6.0 Non Diabetic").
function isRangeLike(t) {
  if (isRangeOnly(t)) return true;
  const pr = parseRest(tokenize(t));
  return !!(pr && pr.junk === 0 && isComparatorOnly(pr));
}

const unbalanced = (s) => (s.match(/\(/g) || []).length > (s.match(/\)/g) || []).length;
const joinRange = (a, b) => {
  const t = b.replace(/\s+/g, ' ').trim();
  return a ? `${a}; ${t}` : t;
};
const notName = (l) => V.METHOD_RE.test(l) || V.SPECIMEN_RE.test(l.trim());

function checkRow(row, typeId, group) {
  let m = matchParam(row.test, row.unit, typeId);
  if ((!m || m.unitMismatch) && group) {
    const g = matchParam(`${group} ${row.test}`, row.unit, typeId);
    // the heading may only help choose between names matching the row's OWN
    // words — "Avg. Blood Glucose Level" under "Hb A1C - Glycated Hb" must
    // not become Haemoglobin because of the heading's "Hb"
    const own = new Set(nameTokens(row.test));
    if (g && !g.unitMismatch && g.synTokens.some((t) => own.has(t))) m = g;
  }
  const { _group, ...out } = row;
  const flags = [];
  if (m && !m.unitMismatch) {
    out.canonical = m.param.name;
    out.param_id = m.param.id;
    const num = parseFloat(String(row.value).replace(/^[<>≤≥=]+/, ''));
    const unitOk = !m.param.units || m.param.units.includes(normUnit(row.unit));
    if (m.param.plausible && unitOk && !Number.isNaN(num) && /^[<>≤≥=]*\d/.test(row.value)) {
      const [lo, hi] = m.param.plausible;
      if (num < lo || num > hi) flags.push(`implausible value for ${m.param.name} (possible decimal/OCR error)`);
    }
  }
  const hasSignal = row.unit || row.range || /^[a-z]/i.test(row.value);
  out.confidence = flags.length ? 'low' : m && !m.unitMismatch ? 'high' : hasSignal ? 'medium' : 'low';
  if (flags.length) out.flags = flags;
  return out;
}

// Stacked columns: a run of N test names printed one per line, then the N
// values in the same order (common in OCR output and some text layers):
//   SERUM CHOLESTEROL ⏎ HDL CHOLESTEROL ⏎ … ⏎ RESULT⇥UNIT⇥NORMAL VALUE ⏎
//   160.0⇥mg/dl⇥100 to 250 ⏎ 38.0⇥mg/dl⇥30 to 70 ⏎ …
// Paired in order only when the counts match exactly — or match after
// keeping just the names the dictionary recognizes; otherwise left alone.
function unstackColumns(lines, valueAfterRange, typeId) {
  const out = [...lines];
  const kinds = lines.map((l) => {
    const t = l.trim();
    if (!t || /^[\W_]+$/.test(t) || (V.COLUMN_HEADER_RE.test(t) && !/\d/.test(t) && !RESULT_LABEL_RE.test(t))) return 'skip';
    const p = parseLine(l, valueAfterRange);
    if (p.kind === 'value') return 'value';
    if (p.kind === 'text' && /[a-z]/i.test(t) && t.length <= MAX_NAME_LEN && !/:/.test(t) && !notName(t) && !V.NOTES_RE.test(t)) return 'name';
    return 'other';
  });
  let i = 0;
  while (i < lines.length) {
    if (kinds[i] !== 'name') { i++; continue; }
    const names = [];
    let j = i;
    while (j < lines.length && (kinds[j] === 'name' || kinds[j] === 'skip')) { if (kinds[j] === 'name') names.push(j); j++; }
    const values = [];
    while (j < lines.length && (kinds[j] === 'value' || kinds[j] === 'skip')) { if (kinds[j] === 'value') values.push(j); j++; }
    if (values.length >= 2 && names.length >= 2) {
      const known = names.filter((n) => { const m = matchParam(lines[n], '', typeId); return m && !m.unitMismatch; });
      // sanity: the run must really be test names (≥ half recognized tests)
      const use = known.length * 2 < names.length ? [] : names.length === values.length ? names : known;
      if (use.length === values.length) {
        use.forEach((n, k) => { out[values[k]] = `${lines[n].trim()}\t${lines[values[k]]}`; out[n] = ''; });
      }
    }
    i = j > i ? j : i + 1;
  }
  return out;
}

// → { rows, stats: { lines, rows, unparsed, dictionaryMatched }, needsFallback }
function parseSection(sectionText, typeId) {
  const rawLines = sectionText.split('\n');
  const lines = [rawLines[0], ...unstackColumns(rawLines.slice(1), detectValueAfterRange(rawLines), typeId)];
  const rows = [];
  let pending = [];
  let group = '';
  let last = null;
  let contOpen = false;
  let notes = false;
  let unparsed = 0;
  let preRange = []; // range lines printed ABOVE their value (reversed layouts)
  const valueAfterRange = detectValueAfterRange(lines);

  const pickPending = () => {
    const names = pending.filter((l) => !notName(l));
    const pick = names.length ? names[names.length - 1] : pending[0] || '';
    if (names.length > 1) group = names[names.length - 2];
    return cleanName(pick).name;
  };
  const emit = (name, p, fallbackUnit) => {
    // A test name contains at least one real word (3+ letters) or is a known
    // short test name (pH, Hb, Na, T3): OCR noise from graphs/stamps
    // ("22A192 2a0-1900272", "£LL12601") is neither.
    const hasWord = String(name).replace(/[^a-z\s]/gi, ' ').split(/\s+/).some((w) => /^[a-z]{3,}$/i.test(w));
    if (!hasWord && !matchParam(name, '', typeId)) return;
    // "Blood Counts ⇥ 2 / 14": a summary scorecard count (abnormal of total),
    // not a result — a real reference range never starts with "/".
    if (/^\/\s*\d/.test(String(p.range || '').trim())) return;
    const range = p.range || preRange.join('; ');
    const row = { test: name, value: p.value, unit: p.unit || fallbackUnit || '', range, _group: group };
    preRange = [];
    rows.push(row);
    last = row;
    contOpen = true;
    pending = [];
  };
  const strongName = (text) => {
    const m = matchParam(text, '', typeId);
    return !!(m && (m.exact || m.strong));
  };

  lines.forEach((raw, idx) => {
    const t = raw.trim();
    if (!t) return;
    if (idx === 0) {
      // Single-test sections can have the result ON the heading line
      // ("Non Reactive⇥HBSAG") — then it's a row, not just a heading.
      const p0 = parseLine(raw, valueAfterRange);
      if (p0.kind === 'row') {
        const { name, unit } = cleanName(p0.name);
        if (name) { emit(name, p0, unit); return; }
      }
      // Otherwise the heading is often the test name itself ("Total
      // Cholesterol", "Creatinine, Serum") — keep it as a name candidate.
      const h = t.replace(/\s*sample tested in.*$/i, '').trim();
      if (h) pending.push(h);
      return;
    }
    if (/^[\W_]+$/.test(t) && !(contOpen && last && !last.unit && UNIT_SET.has(normUnit(t)))) return; // "....", "-----", "*" (but not a lone "%" unit)
    // column header row — but "Result : Negative" is a result, not a header
    if (V.COLUMN_HEADER_RE.test(t) && !/\d/.test(t) && !RESULT_LABEL_RE.test(t)) { pending = []; contOpen = false; return; }
    if (V.NOTES_RE.test(t)) { notes = true; pending = []; contOpen = false; preRange = []; return; }

    // "Result : TEST IS NEGATIVE" under a single-test heading → a row named
    // after the test above it.
    const res = t.match(RESULT_LABEL_RE);
    if (res && !notes) {
      const qt = tokenize(res[1]);
      for (let k = 0; k < qt.length; k++) {
        const ql = qualLenAt(qt, k);
        if (!ql) continue;
        const name = pickPending() || (last && last.test);
        if (name) emit(name, { value: qt.slice(k, k + ql).map((x) => clean(x.t)).join(' '), unit: '', range: '' }, '');
        return;
      }
    }
    // "Blood Glucose : 92.3 mg/dL" → a test row, when the value is a number
    // WITH a unit (header fields like "Barcode No : 30537971" have none).
    const colon = raw.replace(/\t/g, ' ').match(/^\s*([A-Za-z][^:]{1,60}?)\s*:\s*(.+)$/);
    if (colon && !/^(result|observed value)$/i.test(colon[1].trim())) {
      const pr = parseRest(tokenize(colon[2]));
      if (pr && pr.junk === 0 && !pr.qualitative && pr.unit && /^[<>≤≥=]?\d/.test(pr.value)) raw = `${colon[1].trim()}\t${colon[2].trim()}`;
    }

    const p = parseLine(raw, valueAfterRange);
    const isNewTest = p.kind === 'row' && strongName(cleanName(p.name).name);
    const rangeLine = !isNewTest && (V.RANGE_LABEL_RE.test(t) || V.LABEL_NUMBER_RE.test(t) || isRangeLike(t));

    if (contOpen && last) {
      if (p.kind === 'unit') { if (!last.unit) last.unit = t; return; }
      const continues = rangeLine || (!isNewTest && /[:;]\s*$/.test(last.range) && t.length <= 40); // "Less than 20 ng/ml :" ⏎ "Negative"
      if (continues) { last.range = joinRange(last.range, t); return; }
    } else if (rangeLine && !notes && (p.kind !== 'row' || /[<>≤≥]/.test(t.trim()[0]))) {
      // No open row: in reversed layouts the range comes BEFORE its value
      // ("M 0.45-1.45" ⏎ "F 0.45-1.45" ⏎ "0.93 mg/dL⇥CREATININE").
      preRange.push(t.replace(/\s+/g, ' '));
      return;
    }

    if (notes) {
      if (p.kind === 'row' && strongName(cleanName(p.name).name)) notes = false;
      else if (p.kind === 'text' && strongName(t)) notes = false;
      else return;
    }

    if (p.kind === 'row') {
      const { name: printed, unit: nameUnit } = cleanName(p.name);
      const nonMethod = pending.filter((l) => !notName(l));
      if (printed && nonMethod.length) group = nonMethod[nonMethod.length - 1];
      const name = printed || pickPending(); // name was only a unit, e.g. "mg /dl⇥91.06 73 - 140"
      if (!name) { unparsed++; return; }
      if (/:/.test(p.name.replace(METHOD_SUFFIX_RE, '')) && !strongName(name)) { contOpen = false; pending = []; return; } // "Barcode NO : 30537971"
      if (V.RANGE_LABEL_RE.test(name) && !strongName(name)) { contOpen = false; return; } // stray range line
      emit(name, p, nameUnit);
      return;
    }
    if (p.kind === 'value') {
      const name = pickPending();
      if (!name) { if (!contOpen) unparsed++; return; }
      if (!p.qualitative && !p.unit && !p.range && !strongName(name)) return; // "Age" ⏎ "24"
      emit(name, p, '');
      return;
    }
    if (p.kind === 'unit') return;

    // text-only line: a pending test name, a group header, a method or a label
    contOpen = false;
    preRange = [];
    if (/[:]\s*$/.test(t) || / : /.test(t) || /^method\b/i.test(t)) return;
    if (V.RANGE_LABEL_RE.test(t) && !strongName(t)) return;
    if (!/[a-z]/i.test(t)) return;
    if (t.length > MAX_NAME_LEN) { if (/\d/.test(t)) unparsed++; return; }
    const prev = pending[pending.length - 1];
    if (prev && (unbalanced(prev) || /^\(/.test(t))) pending[pending.length - 1] = `${prev} ${t}`;
    else pending.push(t);
  });

  // Same test + value twice (templates that print a name twice, or a
  // summary row next to the detailed one) → keep the first.
  const seen = new Set();
  const unique = rows.filter((r) => {
    const k = `${r.test.toLowerCase()}|${r.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // _group: the sub-header a row sat under ("Absolute Leukocyte Counts"),
  // used only to disambiguate its dictionary match.
  const checked = unique.map((r) => checkRow(r, typeId, r._group));
  const dictionaryMatched = checked.filter((r) => r.canonical).length;
  const stats = { lines: lines.length, rows: checked.length, unparsed, dictionaryMatched };
  const needsFallback = checked.length === 0 || unparsed > Math.max(2, checked.length * 0.5);
  return { rows: checked, stats, needsFallback };
}

module.exports = { parseSection, parseLine, cleanName };
