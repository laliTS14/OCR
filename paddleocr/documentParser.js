// Whole-document parsing: EVERY test in the report is extracted, whether or
// not its report type is in reportCatalog.js or its name is in
// paramDictionary.js. Report-type selection is only a filter on the output.
//
//   1. Split the document into blocks at every heading line a catalog type
//      or boundary recognizes (consecutive same-type headings merge), plus a
//      leading block before the first heading — so text under an unknown or
//      generic heading ("PATHOLOGY", "BIOCHEMISTRY") is parsed too.
//   2. Clean each block (page markers, repeated letterhead/footer lines,
//      prose, patient-header lines) and run the rules parser on it.
//   3. Label each row with a report type: the block's catalog type if its
//      heading was recognized, else the row's dictionary panel, else OTHER
//      (kept under the heading it was printed under — never dropped).
//   4. Drop exact duplicates (summary pages repeating detailed results),
//      keeping the richer row.

const { REPORT_TYPES, OTHER_TYPE } = require('./reportCatalog');
const { splitIntoPages } = require('./sections');
const { normalizeReadingText } = require('./textNormalize');
const { classifyLine, findRepeatedLines, buildHeaderText, isProse, PAGE_MARKER_RE, normLine } = require('./selectReports');
const { parseSection } = require('./rowParser');
const { isHeaderLine } = require('./headerParser');
const { PARAMS } = require('./paramDictionary');
const { classifyPages } = require('./pageClassifier');

const TYPE_BY_ID = new Map([...REPORT_TYPES, OTHER_TYPE].map((t) => [t.id, t]));
const PARAM_BY_ID = new Map(PARAMS.map((p) => [p.id, p]));

// → { reports: [{ typeId, report_type, headings, pageNumbers, rows }],
//     blocks: [{ typeId, heading, pageNumbers, text, rows, needsFallback }],
//     headerText, pageTypes: [{ page, type: lab|mer|other|no_text, signals }] }
function parseDocument(ocrDump) {
  const allPages = splitIntoPages(normalizeReadingText(ocrDump));
  // Only pathology (lab) pages are parsed; MER / other / no-text pages are
  // reported in `pageTypes`, never silently dropped (pageClassifier.js).
  const pageTypes = classifyPages(allPages);
  const pages = allPages.filter((p, i) => pageTypes[i].type === 'lab');
  const repeated = findRepeatedLines(pages);
  const lines = [];
  for (const p of pages) for (const text of p.text.split('\n')) lines.push({ page: p.pageNumber, text });

  const marks = [];
  lines.forEach((l, i) => {
    const c = classifyLine(l.text);
    if (c) marks.push({ index: i, ...c });
  });

  // Block boundaries: document start + every mark (same-type runs merged).
  const starts = [{ index: 0, kind: 'start' }];
  marks.forEach((m, k) => {
    const prev = marks[k - 1];
    if (m.kind === 'type' && prev && prev.kind === 'type' && prev.typeId === m.typeId) return;
    if (m.index === 0) starts[0] = m; else starts.push(m);
  });

  const blocks = starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].index : lines.length;
    const body = lines.slice(s.index, end);
    const heading = s.kind === 'start' ? '' : body[0].text.trim();
    const kept = body.filter((l, j) => {
      const t = l.text.trim();
      if (!t || PAGE_MARKER_RE.test(t) || isProse(l.text) || repeated.has(normLine(t))) return false;
      return j === 0 && s.kind !== 'start' ? true : !isHeaderLine(l.text);
    });
    // the leading block gets an EMPTY heading line — the parser skips it, so
    // no placeholder text can end up used as a test name
    const text = (s.kind === 'start' ? [''] : []).concat(kept.map((l) => l.text)).join('\n');
    const typeId = s.kind === 'type' ? s.typeId : null;
    const parsed = parseSection(text, typeId || '');
    return {
      typeId, heading, start: s.index,
      pageNumbers: [...new Set(body.map((l) => l.page))],
      text, rows: parsed.rows, needsFallback: parsed.needsFallback, stats: parsed.stats,
    };
  });

  // Label rows. The dictionary's panel for a test wins over a heading that
  // disagrees (labs group tests under their own summary headings — "Anemia
  // Studies", "Blood Clotting" — but Hb is still a CBC test); otherwise the
  // heading's type, else the dictionary's, else OTHER.
  // Duplicates (summary page + detailed page) are the same value under the
  // same printed name OR the same dictionary test; keep the richer row.
  const richness = (r) => ['value', 'unit', 'range'].filter((f) => String(r[f] || '').trim()).length + (r.canonical ? 1 : 0);
  const normTest = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const entries = [];
  const byKey = new Map();
  for (const b of blocks) {
    for (const row of b.rows) {
      const param = row.param_id && PARAM_BY_ID.get(row.param_id);
      const typeId = param && param.types.length && !param.types.includes(b.typeId)
        ? param.types[0]
        : b.typeId || (param && param.types[0]) || 'OTHER';
      const v = String(row.value).toLowerCase();
      const keys = [`n|${normTest(row.test)}|${v}`].concat(row.param_id ? [`p|${row.param_id}|${v}`] : []);
      const entry = { typeId, heading: b.heading, page: b.pageNumbers[0], row, order: entries.length, keys };
      const prev = keys.map((k) => byKey.get(k)).find(Boolean);
      if (!prev) {
        entries.push(entry);
        keys.forEach((k) => byKey.set(k, entry));
      } else {
        if (richness(row) > richness(prev.row)) Object.assign(prev, { typeId, heading: b.heading, page: b.pageNumbers[0], row });
        keys.forEach((k) => byKey.set(k, prev));
      }
    }
  }

  // Group into reports: one per report type; OTHER split by printed heading.
  const groups = new Map();
  for (const e of entries.sort((a, b) => a.order - b.order)) {
    const gk = e.typeId === 'OTHER' ? `OTHER|${e.heading}` : e.typeId;
    if (!groups.has(gk)) groups.set(gk, { typeId: e.typeId, report_type: TYPE_BY_ID.get(e.typeId).label, headings: new Set(), pageNumbers: new Set(), rows: [] });
    const g = groups.get(gk);
    if (e.heading) g.headings.add(e.heading);
    g.pageNumbers.add(e.page);
    g.rows.push(e.row);
  }
  const reports = [...groups.values()].map((g) => ({
    ...g,
    report_type: g.typeId === 'OTHER' && g.headings.size ? `Other — ${[...g.headings][0]}` : g.report_type,
    headings: [...g.headings], pageNumbers: [...g.pageNumbers],
  }));

  // Header: page of the first block that produced rows (fallback: page 1).
  const firstWithRows = blocks.find((b) => b.rows.length) || blocks[0];
  const headerText = lines.length && firstWithRows ? buildHeaderText(lines, firstWithRows.start) : '';

  return { reports, blocks: blocks.map(({ start, ...b }) => b), headerText, pageTypes };
}

module.exports = { parseDocument };
