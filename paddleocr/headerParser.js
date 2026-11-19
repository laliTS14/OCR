// Rules-based patient/report-header parser — no LLM. Report headers use a
// small, shared set of labels (Name, Age, Sex/Gender, Patient ID/UHID/Reg No,
// Referred By, Collected On, Reported On…) in a few layouts, all handled:
//   "Label : value"            Patient Name : MR. K NARESH NAIDU
//   "value ⇥ Label"            Mrs. BABITA KHANDELWAL⇥Name   (text layer reversed)
//   "Label ⇥ : value"          Patient NAME ⇥: Mr Lalit Pahadiya
//   combined fields            Age / Sex : 32 YEARS / MALE,  DOB/Age/Gender : 24 Y/Male
//   unlabeled lines            MR. SURESH KUMAR SHARMA ⏎ 65 Years /M
// Only values literally present in the header text are ever returned.

const LABELS = [
  ['patient_id', /^(patient\s*id(\s*\/\s*uhid)?|uhid|mr\.?\s*no|mrn|reg(istration)?\.?\s*no\.?|patient\s*code|p\.?\s*id|lab\s*id|pid|cr\s*no)$/i],
  ['name', /^(patient'?s?\s*name|name\s*of\s*(the\s*)?patient|patient|name)$/i],
  // any label naming both age and sex/gender ("Age / Sex", "DOB/Age/Gender",
  // OCR's "DOR/Age/Gender")
  ['agesex', /\bage\b.*\b(sex|gender)\b|\b(sex|gender)\b.*\bage\b/i],
  ['age', /^(age|dob\s*\/\s*age|age\s*\(yrs?\))$/i],
  ['sex', /^(sex|gender)$/i],
  ['contact_number', /^(mobile|mobile\s*no\.?|phone|phone\s*no\.?|contact|contact\s*no\.?|tel\.?)$/i],
  ['referring_doctor', /^(ref(erred|erring)?\.?\s*(by|dr\.?|doctor|physician)|referral|consultant|dr\.?\s*name)$/i],
  ['sample_collected_date', /^((sample\s*)?collect(ed|ion)\s*(on|date|at|time)?|sample\s*date|date\s*of\s*collection)$/i],
  ['report_date', /^(report(ed)?\s*(on|date|time)|date\s*of\s*report|report\s*generated\s*on)$/i],
];
// Never patient fields even though they look ID-ish.
const NOT_PATIENT_ID = /\b(lab\s*reg|barcode|sample\s*id|serial|invoice|bill|visit)\b/i;

const AGE_RE = /\b(\d{1,3})\s*(y|yr|yrs|year|years)\b\.?/i;
const SEX_RE = /\b(male|female|m|f|transgender|other)\b/i;
const TITLE_NAME_RE = /^(mr|mrs|ms|miss|master|baby|smt|shri|kum|mast)\.?\s+[a-z][a-z .']{2,60}$/i;

const clean = (s) => String(s || '').replace(/^[:\s\-]+|[:\s]+$/g, '').replace(/\s+/g, ' ').trim();
const normSex = (s) => (/^f/i.test(s) ? 'Female' : /^m/i.test(s) ? 'Male' : s);

function labelOf(s) {
  // a format hint in brackets doesn't change the label: "Age (Y-M-D)", "Sex (M/F)"
  const t = clean(s).replace(/\.$/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (!t || t.length > 40) return null;
  if (NOT_PATIENT_ID.test(t)) return 'skip';
  for (const [field, re] of LABELS) if (re.test(t)) return field;
  return null;
}

// Candidate (label, value) pairs from one line, whichever side the label is
// on; a line can hold several pairs ("Name⇥: Mrs X⇥Reg No⇥: R-002301").
function pairsOf(line) {
  const out = [];
  const cells = line.split('\t').map((c) => c.trim()).filter((c) => c && c !== ':' && c !== '/');
  if (cells.length >= 2) {
    const used = new Set();
    cells.forEach((c, i) => { // label ⇥ value
      if (labelOf(c) && cells[i + 1] && !labelOf(cells[i + 1])) { out.push([c, cells[i + 1]]); used.add(i).add(i + 1); }
    });
    cells.forEach((c, i) => { // value ⇥ label (reversed text layer) — not for "Label:", whose value follows
      if (!used.has(i) && labelOf(c) && !/:\s*$/.test(c) && i > 0 && !used.has(i - 1) && !labelOf(cells[i - 1])) out.push([c, cells[i - 1]]);
    });
    // each cell its own "Label : value" ("PID : 555⇥Ref. By: Dr. X⇥Reported on: …")
    for (const c of cells) {
      const cm = c.match(/^\s*([A-Za-z][A-Za-z .\/()&']{0,40}?)\s*:\s*(.+)$/);
      if (cm && labelOf(cm[1]) && labelOf(cm[1]) !== 'skip') out.push([cm[1], cm[2]]);
    }
  }
  // "Label : value" on a plain line
  const m = line.replace(/\t/g, ' ').match(/^\s*([A-Za-z][A-Za-z .\/()&']{0,40}?)\s*:\s*(.*)$/);
  if (m && !out.length) out.push([m[1], m[2]]);
  return out;
}

// Signature blocks ("DR. X ⏎ MBBS, MD-(PATHOLOGY) ⏎ REG. NO. :MP-28676")
// carry the DOCTOR's registration number — never a patient field.
const CREDENTIAL_RE = /\b(mbbs|m\.?\s?d\b|dnb|dcp|ph\.?\s?d|pathologist|consultant|microbiologist|biochemist|technician|technologist|lab\s*in-?charge|authori[sz]ed\s*signatory)\b/i;

function setAgeSex(res, value) {
  const a = value.match(AGE_RE);
  if (a && !res.age) res.age = a[0].trim();
  const rest = a ? value.replace(a[0], ' ') : value;
  const s = rest.match(SEX_RE);
  if (s && !res.sex) res.sex = normSex(s[1]);
}

// One-cell-per-line text layers split every header field over several
// lines: "Age" ⏎ "/" ⏎ "Sex" ⏎ ":" ⏎ "46" ⏎ "YRS/M", "Mr." ⏎ "VADLAMUDI" ⏎
// "VENKATA" ⏎ "KUMAR". When the header looks like that (3+ lines that are
// just ":"), rebuild "Label : value" lines: the label is the longest run of
// up to 3 lines before the ":" that names a known field, the value is
// everything up to the next label (at most 3 lines); a lone title line is
// joined with the name words after it.
const TITLE_ONLY_RE = /^(mr|mrs|ms|miss|master|baby|smt|shri|kum|mast)\.?$/i;
function rejoinCellLines(lines) {
  const t = lines.map((l) => l.replace(/\t/g, ' ').trim());
  // isolated ":" lines only — a column of consecutive ":" belongs to a
  // tabular layout ("value ⇥ label" with the colons in their own column)
  const colons = t.map((l, i) => (l === ':' && t[i - 1] !== ':' && t[i + 1] !== ':' && i > 0 && i < t.length - 1 ? i : -1)).filter((i) => i >= 0);
  if (colons.length < 3) return lines;
  const labelStart = colons.map((c, n) => {
    const floor = n ? colons[n - 1] + 2 : 0; // leave at least one value line for the previous field
    for (let k = 3; k >= 1; k--) {
      if (c - k < floor) continue;
      const f = labelOf(t.slice(c - k, c).join(' '));
      if (f && f !== 'skip') return c - k;
    }
    // an unknown label is still words, not a value: "Registered" ⏎ "on"
    if (c - 2 >= floor && LABEL_WORD_RE.test(t[c - 2]) && LABEL_WORD_RE.test(t[c - 1])) return c - 2;
    return Math.max(floor, c - 1);
  });
  const out = [];
  // lines before the first field: join a lone title with the name after it
  for (let i = 0; i < labelStart[0]; i++) {
    if (TITLE_ONLY_RE.test(t[i])) {
      const words = [];
      let j = i + 1;
      while (j < labelStart[0] && words.length < 5 && /^[a-z][a-z .']*$/i.test(t[j])) words.push(t[j++]);
      if (words.length) { out.push(`${t[i]} ${words.join(' ')}`); i = j - 1; continue; }
    }
    out.push(lines[i]);
  }
  colons.forEach((c, n) => {
    const limit = Math.min(n + 1 < colons.length ? labelStart[n + 1] : t.length, c + 4);
    // the value's first line, plus short follow-ons ("46" ⏎ "YRS/M",
    // "01:12" ⏎ "PM", "Dr." ⏎ "TATA" ⏎ "AIA") — not a heading after it
    let end = Math.min(c + 2, limit);
    while (end < limit && (t[end].length <= 6 || /^\d/.test(t[end]))) end++;
    out.push(`${t.slice(labelStart[n], c).join(' ')} : ${t.slice(c + 1, end).join(' ')}`);
    if (n + 1 === colons.length) out.push(...lines.slice(end));
  });
  return out;
}
const LABEL_WORD_RE = /^[a-z][a-z.]{0,15}$/i;

// → { patient: {name, age, sex, patient_id, contact_number}, meta: {referring_doctor, sample_collected_date, report_date} }
function parseHeader(headerText) {
  const res = {};
  const all = rejoinCellLines(String(headerText || '').split('\n').filter((l) => l.trim()));
  // Credential lines are never patient fields; within 2 lines after one,
  // ID-like fields belong to the doctor ("MBBS, MD ⏎ REG. NO. :MP-28676"),
  // but a patient's age / sex / name printed there still count.
  const nearCredential = new Set();
  all.forEach((l, i) => { if (CREDENTIAL_RE.test(l)) for (let k = i; k <= i + 2; k++) nearCredential.add(k); });
  const keep = all.map((l, i) => i).filter((i) => !CREDENTIAL_RE.test(all[i]));
  const lines = keep.map((i) => all[i]);
  const idBlocked = new Set(keep.map((orig, i) => (nearCredential.has(orig) ? i : -1)).filter((i) => i >= 0));
  lines.forEach((line, i) => {
    const pairs = pairsOf(line);
    // Vertical layout: a label alone on its line, its value on the next
    // ("Gender" ⏎ "M", "Patient ID" ⏎ "15409949").
    const next = lines[i + 1];
    if (!pairs.length && labelOf(line) && next && !labelOf(next) && !/:/.test(line)) pairs.push([line, next]);
    for (const [label, rawValue] of pairs) {
      const field = labelOf(label);
      if (!field || field === 'skip') continue;
      if (idBlocked.has(i) && (field === 'patient_id' || field === 'contact_number')) continue;
      const value = clean(rawValue);
      if (!value) continue;
      if (field === 'agesex' || field === 'age' || field === 'sex') { setAgeSex(res, value); if (field === 'age' && !res.age && /^\d{1,3}$/.test(value)) res.age = value; continue; }
      if (field === 'name' && (labelOf(value) || value.length > 60)) continue;
      if (!res[field]) res[field] = value;
    }
  });
  // Unlabeled fallbacks: a titled name line, an "NN Years / M" line.
  if (!res.name) {
    const n = lines.map((l) => clean(l.split('\t')[0])).find((l) => TITLE_NAME_RE.test(l));
    if (n) res.name = n;
  }
  if (!res.age || !res.sex) {
    for (const l of lines) {
      if (AGE_RE.test(l) && l.length <= 40) { setAgeSex(res, l); }
      if (res.age && res.sex) break;
    }
  }
  if (!res.sex) {
    const s = lines.map((l) => l.match(/\b(male|female)\b/i)).find(Boolean);
    if (s) res.sex = normSex(s[1]);
  }
  const pick = (keys) => Object.fromEntries(keys.filter((k) => res[k]).map((k) => [k, res[k]]));
  return {
    patient: pick(['name', 'age', 'sex', 'patient_id', 'contact_number']),
    meta: pick(['referring_doctor', 'sample_collected_date', 'report_date']),
  };
}

// True for a line that is patient/report header information rather than a
// test result ("Patient Name : X", "Mrs. X⇥Name", "MR. X", "65 Years /M",
// "Page 3") — so whole-document parsing never turns it into a test row.
function isHeaderLine(line) {
  const t = clean(line);
  if (!t) return false;
  if (/^page\s*(no\.?)?\s*:?\s*\d+(\s*(of|\/)\s*\d+)?$/i.test(t)) return true;
  if (TITLE_NAME_RE.test(clean(line.split('\t')[0]))) return true;
  if (AGE_RE.test(t) && t.length <= 30 && !/\d+\.\d+/.test(t)) return true;
  return pairsOf(line).some(([label]) => {
    const f = labelOf(label);
    return f && f !== 'skip';
  });
}

module.exports = { parseHeader, isHeaderLine };
