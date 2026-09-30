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
    cells.forEach((c, i) => { // value ⇥ label (reversed text layer)
      if (!used.has(i) && labelOf(c) && i > 0 && !used.has(i - 1) && !labelOf(cells[i - 1])) out.push([c, cells[i - 1]]);
    });
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

// → { patient: {name, age, sex, patient_id, contact_number}, meta: {referring_doctor, sample_collected_date, report_date} }
function parseHeader(headerText) {
  const res = {};
  const all = String(headerText || '').split('\n').filter((l) => l.trim());
  // drop each credential line and the 2 lines after it
  const lines = all.filter((l, i) => !all.slice(Math.max(0, i - 2), i + 1).some((x) => CREDENTIAL_RE.test(x)));
  lines.forEach((line, i) => {
    const pairs = pairsOf(line);
    // Vertical layout: a label alone on its line, its value on the next
    // ("Gender" ⏎ "M", "Patient ID" ⏎ "15409949").
    const next = lines[i + 1];
    if (!pairs.length && labelOf(line) && next && !labelOf(next) && !/:/.test(line)) pairs.push([line, next]);
    for (const [label, rawValue] of pairs) {
      const field = labelOf(label);
      if (!field || field === 'skip') continue;
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
