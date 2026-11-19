// Accuracy against the human answer key (review-data/gold/, written by the
// review screen when a reviewer ticks "Fully checked" — see reviewStore.js).
//
//   node gold-eval.js                  score the current parser
//   node gold-eval.js --save           …and store it as the baseline
//   node gold-eval.js --compare        …and compare with the baseline; exits 1
//                                      if any metric dropped (regression gate:
//                                      run before keeping any parser/dictionary
//                                      change — PROGRESS.md "Design rule")
//   node gold-eval.js --verbose        list every missed / junk / wrong row
//
// Each answer key stores the document text, so this re-parses it with the
// CURRENT code in milliseconds — no PDF, no OCR. No LLM (rules path only).
const fs = require('fs');
const path = require('path');
const { parseDocument } = require('./documentParser');
const { parseHeader } = require('./headerParser');
const { listJson, ROOT } = require('./reviewStore');

const BASELINE = path.join(ROOT, 'gold-baseline.json');
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
const normTest = (s) => norm(s).replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (s) => new Set(normTest(s).split(' ').filter((t) => t.length >= 2));
const FIELDS = ['value', 'unit', 'range', 'report_type'];
const PATIENT_FIELDS = ['name', 'age', 'sex', 'patient_id', 'contact_number'];

// Pair each answer-key row with at most one extracted row: same printed name,
// else same dictionary test, else same value + a shared name word.
function matchRows(gold, pred) {
  const used = new Set();
  const pairs = [];
  const tryPass = (ok) => gold.forEach((g, gi) => {
    if (pairs.some((p) => p.gi === gi)) return;
    const pi = pred.findIndex((p, k) => !used.has(k) && ok(g, p));
    if (pi >= 0) { used.add(pi); pairs.push({ gi, pi }); }
  });
  tryPass((g, p) => normTest(g.test) === normTest(p.test));
  tryPass((g, p) => g.param_id && g.param_id === p.param_id);
  tryPass((g, p) => norm(g.value) === norm(p.value) && [...tokens(g.test)].some((t) => tokens(p.test).has(t)));
  const matchedGold = new Set(pairs.map((p) => p.gi));
  return {
    pairs,
    missed: gold.filter((_, i) => !matchedGold.has(i)),
    junk: pred.filter((_, i) => !used.has(i)),
  };
}

function evalGold(g) {
  const doc = parseDocument(g.sourceText);
  const wantAll = !g.selected || g.selected.includes('ALL');
  const pred = doc.reports.filter((r) => wantAll || g.selected.includes(r.typeId))
    .flatMap((r) => r.rows.map((row) => ({ ...row, report_type: r.report_type })));
  const { pairs, missed, junk } = matchRows(g.rows, pred);
  const fieldOk = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  const wrong = [];
  for (const { gi, pi } of pairs) {
    const a = g.rows[gi];
    const b = pred[pi];
    for (const f of FIELDS) {
      if (norm(a[f]) === norm(b[f])) fieldOk[f]++;
      else wrong.push({ test: a.test, field: f, expected: a[f], got: b[f] });
    }
  }
  const patient = parseHeader(doc.headerText).patient || {};
  const pf = PATIENT_FIELDS.filter((f) => norm(g.patient[f]));
  const patientOk = pf.filter((f) => norm(g.patient[f]) === norm(patient[f])).length;
  return {
    file: g.fileName, dc: g.dc, expected: g.rows.length, extracted: pred.length, matched: pairs.length,
    fieldOk, patientFields: pf.length, patientOk, missed, junk, wrong,
  };
}

const pct = (n, d) => (d ? +((100 * n) / d).toFixed(1) : null);
function summarize(results) {
  const t = results.reduce((a, r) => {
    a.expected += r.expected; a.extracted += r.extracted; a.matched += r.matched;
    a.patientFields += r.patientFields; a.patientOk += r.patientOk;
    FIELDS.forEach((f) => { a.fieldOk[f] += r.fieldOk[f]; });
    return a;
  }, { expected: 0, extracted: 0, matched: 0, patientFields: 0, patientOk: 0, fieldOk: Object.fromEntries(FIELDS.map((f) => [f, 0])) });
  const rowsFullyRight = results.reduce((a, r) => a + r.matched - new Set(r.wrong.map((w) => w.test)).size, 0);
  return {
    documents: results.length, dcs: new Set(results.map((r) => r.dc)).size,
    found: pct(t.matched, t.expected), // tests in the answer key that were extracted
    precision: pct(t.matched, t.extracted), // extracted rows that are real tests
    valueCorrect: pct(t.fieldOk.value, t.matched), unitCorrect: pct(t.fieldOk.unit, t.matched),
    rangeCorrect: pct(t.fieldOk.range, t.matched), reportTypeCorrect: pct(t.fieldOk.report_type, t.matched),
    rowsFullyRight: pct(rowsFullyRight, t.expected), // found AND every field right
    patientCorrect: pct(t.patientOk, t.patientFields),
  };
}

const LABELS = {
  found: 'Tests found', precision: 'Extracted rows that are real', valueCorrect: 'Value correct',
  unitCorrect: 'Unit correct', rangeCorrect: 'Range correct', reportTypeCorrect: 'Report type correct',
  rowsFullyRight: 'Rows fully right', patientCorrect: 'Patient fields correct',
};

(() => {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const gold = listJson('gold');
  if (!gold.length) {
    console.log('No answer-key reports yet. Review a report on /select.html and tick "Fully checked" to add one.');
    return;
  }
  const results = gold.map(evalGold);
  for (const r of results) {
    console.log(`\n${r.file}  [${r.dc}]  found ${r.matched}/${r.expected}, ${r.junk.length} junk, ${r.wrong.length} wrong field(s)`);
    if (verbose) {
      r.missed.forEach((m) => console.log(`   missed  ${m.test} = ${m.value} ${m.unit}`));
      r.junk.forEach((j) => console.log(`   junk    ${j.test} = ${j.value} ${j.unit}`));
      r.wrong.forEach((w) => console.log(`   wrong   ${w.test} · ${w.field}: expected "${w.expected}", got "${w.got}"`));
    }
  }
  const s = summarize(results);
  console.log(`\n== ${s.documents} answer-key report(s) from ${s.dcs} DC(s) ==`);
  const base = args.includes('--compare') && fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
  let dropped = [];
  for (const [k, label] of Object.entries(LABELS)) {
    const v = s[k];
    let line = `${label.padEnd(30)} ${v == null ? '—' : `${v}%`}`;
    if (base && base.documents === s.documents && base[k] != null && v != null) {
      const d = +(v - base[k]).toFixed(1);
      line += `   (baseline ${base[k]}%, ${d >= 0 ? '+' : ''}${d})`;
      if (d < 0) dropped.push(label);
    }
    console.log(line);
  }
  if (args.includes('--compare')) {
    if (!base) console.log('\nNo baseline yet — run with --save first.');
    else if (base.documents !== s.documents) console.log(`\nNote: baseline had ${base.documents} report(s), now ${s.documents} — re-save the baseline after adding answer keys.`);
  }
  if (args.includes('--save')) {
    fs.writeFileSync(BASELINE, JSON.stringify({ ...s, savedAt: new Date().toISOString() }, null, 2));
    console.log(`\nBaseline saved → ${path.relative(__dirname, BASELINE)}`);
  }
  if (dropped.length) {
    console.log(`\nREGRESSION: ${dropped.join(', ')} dropped — do not keep this change.`);
    process.exitCode = 1;
  }
})();
