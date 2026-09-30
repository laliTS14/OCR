// Fixed catalog of report types a user can select BEFORE any section
// detection runs (the "select first, then only extract what was selected"
// flow — see selectReports.js / PROGRESS.md). Each type lists the heading
// names labs actually print for it; patterns are matched case-insensitively
// against heading-like lines only (see isHeadingLike in selectReports.js),
// never against result rows or prose.
//
// ORDER MATTERS: a heading line is assigned to the FIRST type whose pattern
// matches, so more specific types come before broader ones (e.g. COTININE
// before URINE, since "URINE COTININE TEST" must not count as urine routine).
//
// Extending: add synonyms here as new lab templates turn up. A synonym that
// is also a common word inside prose/rows (e.g. plain "hemoglobin", which is
// also a CBC row and part of the HbA1c heading) must NOT be added bare.

const REPORT_TYPES = [
  {
    id: 'CBC',
    label: 'CBC (Complete Blood Count)',
    patterns: [/complete blood count/i, /\bcbc\b/i, /\bha?emogram\b/i, /^blood counts?$/i],
  },
  {
    id: 'ESR',
    label: 'ESR',
    patterns: [/^esr\b/i, /erythrocyte sedimentation rate/i],
  },
  {
    id: 'LIPID',
    label: 'Lipid Profile',
    // Some labs (e.g. Helpline) print each lipid as its own heading instead
    // of one "Lipid Profile" heading — adjacent ones are merged into one
    // section by selectReports.js.
    patterns: [/lipid (profile|panel)/i, /^total cholesterol\b/i, /^triglycerides?\b/i, /^(hdl|ldl|vldl) cholesterol\b/i],
  },
  {
    id: 'KFT',
    label: 'Kidney Function (KFT / RFT)',
    patterns: [/kidney (function|profile)/i, /renal (function|profile)/i, /\b(kft|rft)\b/i, /^creatinine\b/i, /^bun\b/i, /blood urea nitrogen/i, /^(serum |blood )?urea\b/i, /^uric acid\b/i, /^(serum )?calcium( serum)?$/i, /^(serum )?phosph(orus|ate)\b/i],
  },
  {
    id: 'ELECTROLYTE',
    label: 'Electrolytes',
    patterns: [/electrolytes?\b/i, /^(serum )?(sodium|potassium|chloride|bicarbonate|magnesium)\b/i],
  },
  {
    id: 'LFT',
    label: 'Liver Function (LFT)',
    // Bare protein/albumin names only as a whole-line heading (Redcliffe
    // prints "Total Protein" as its own heading); as rows they carry a
    // value, so isHeadingLike() already rejects them.
    patterns: [/liver function/i, /liver profile/i, /\blft\b/i, /hepatic function/i, /^(total protein|serum protein|protein total|albumin|bilirubin)$/i],
  },
  {
    id: 'GLUCOSE',
    label: 'Blood Glucose / Sugar',
    patterns: [/^glucose (fasting|random|pp|post)/i, /^(fasting|random|post ?prandial) (plasma |blood )?(glucose|sugar)/i, /^blood sugar\b/i, /\b(fbs|ppbs|rbs)\b/i],
  },
  {
    id: 'HBA1C',
    label: 'HbA1c',
    patterns: [/hba1c/i, /glycosylated ha?emoglobin/i, /glycated ha?emoglobin/i, /^diabetes monitoring$/i],
  },
  {
    id: 'THYROID',
    label: 'Thyroid Profile',
    patterns: [/thyroid (profile|function|panel)/i, /\btft\b/i, /^tsh\b/i, /thyroid stimulating hormone/i],
  },
  {
    id: 'HORMONE',
    label: 'Hormones (FSH, LH, Prolactin, Testosterone…)',
    patterns: [/hormon(e|al) (profile|assay|panel)/i, /fertility (profile|panel)/i, /^(serum )?(fsh|lh|prolactin|testosterone|estradiol|oestradiol|progesterone|cortisol|insulin|amh|pth|dhea-?s?|growth hormone)\b/i, /^(beta|β)[- ]?hcg\b/i],
  },
  {
    id: 'VITAMIN',
    label: 'Vitamins (D, B12, Folate)',
    patterns: [/vitamins? profile/i, /^vitamin[ -]?(d|b ?12|b ?9)\b/i, /25[ -]?(oh|hydroxy)/i, /^(serum )?folate\b|^folic acid\b/i],
  },
  {
    id: 'IRON',
    label: 'Iron Studies / Ferritin',
    patterns: [/iron (studies|profile|panel)/i, /^(serum )?ferritin\b/i, /^serum iron\b/i, /^iron\b/i, /\btibc\b/i, /transferrin/i, /^(anemia|anaemia) (studies|profile)$/i],
  },
  {
    id: 'COAG',
    label: 'Coagulation (PT/INR, APTT)',
    patterns: [/coagulation/i, /prothrombin time/i, /^pt\s*(\/|and|&|with)?\s*inr\b/i, /\baptt\b|\bptt\b/i, /bleeding time/i, /clotting time/i, /\bd[- ]?dimer\b/i, /fibrinogen/i, /^blood clotting$/i],
  },
  {
    id: 'CARDIAC',
    label: 'Cardiac Markers',
    patterns: [/cardiac (markers?|enzymes?|biomarkers?)/i, /troponin/i, /\bck[- ]?mb\b/i, /^(cpk|ck)\b/i, /\bnt[- ]?pro ?bnp\b|\bbnp\b/i, /^ldh\b|lactate dehydrogenase/i, /homocysteine/i],
  },
  {
    id: 'PANCREAS',
    label: 'Amylase / Lipase',
    patterns: [/^(serum )?amylase\b/i, /^(serum )?lipase\b/i, /pancrea(s|tic) (profile|panel|enzymes?)/i],
  },
  {
    id: 'INFLAM',
    label: 'CRP / RA Factor / ASO',
    patterns: [/c[- ]?reactive protein/i, /^(hs[- ]?|quantitative )?crp\b/i, /\bra factor\b|rheumatoid factor/i, /\baso\b|anti[- ]?streptolysin/i, /procalcitonin/i],
  },
  {
    id: 'INFECT',
    label: 'Infection Serology (Widal, Dengue, Malaria, VDRL…)',
    patterns: [/widal/i, /dengue/i, /malaria|malarial parasite/i, /typh(i|oid)/i, /\bvdrl\b|\brpr\b|syphilis|\btpha\b/i, /chikungunya/i, /leptospir/i, /\bns1\b/i, /scrub typhus/i, /tuberculosis|\bmantoux\b/i],
  },
  {
    id: 'IMMUNO',
    label: 'Immunology (ANA, IgE…)',
    patterns: [/^(total )?ig[aegm]\b/i, /\bana\b|antinuclear/i, /anti[- ]?(ccp|dsdna|tpo|tg)\b/i, /immunoglobulins?/i],
  },
  {
    id: 'TUMOR',
    label: 'Tumour Markers',
    patterns: [/tumou?r markers?/i, /^(total |free )?psa\b|prostate specific antigen/i, /^cea\b|carcino ?embryonic/i, /\bca[- ]?(125|19[- ]?9|15[- ]?3)\b/i, /alpha[- ]?feto ?protein|^afp\b/i],
  },
  {
    id: 'BLOODGROUP',
    label: 'Blood Group & Rh',
    patterns: [/blood group/i, /\babo\b/i, /\brh\s*(type|typing|factor|grouping)\b/i],
  },
  {
    id: 'HAEM_OTHER',
    label: 'Other Haematology (Smear, Retic, G6PD, Hb Electrophoresis)',
    patterns: [/peripheral (blood )?smear/i, /\bpbs\b/i, /reticulocyte/i, /\bg6pd\b/i, /h(a)?emoglobin electrophoresis|\bhb electrophoresis|hb variant/i, /sickling/i],
  },
  {
    id: 'HIV',
    label: 'HIV',
    patterns: [/\bhiv\b/i],
  },
  {
    id: 'HBSAG',
    label: 'HBsAg (Hepatitis B)',
    patterns: [/\bhbs ?ag\b/i, /hepatitis b surface/i],
  },
  {
    id: 'HCV',
    label: 'HCV (Hepatitis C)',
    patterns: [/\bhcv\b/i, /hepatitis c\b/i],
  },
  {
    id: 'COTININE',
    label: 'Urine Cotinine',
    patterns: [/cotinine/i, /\buct\b/i],
  },
  {
    id: 'UALB',
    label: 'Urine Microalbumin / ACR / 24h Urine',
    patterns: [/micro ?albumin/i, /albumin[- \/]*creatinine ratio|\bacr\b|\buacr\b/i, /24 ?h(ou)?rs? urine/i, /urine (protein|creatinine) ratio/i],
  },
  {
    id: 'URINE',
    label: 'Urine Routine',
    patterns: [/urine (routine|examination|analysis|r ?\/ ?m|re\b)/i, /urinalysis/i, /routine urine/i, /urine (culture|pregnancy)/i],
  },
  {
    id: 'STOOL',
    label: 'Stool Examination',
    patterns: [/stool (routine|examination|analysis|r ?\/ ?m|for)/i, /^stool\b/i, /occult blood/i, /faecal|fecal/i],
  },
  {
    id: 'SEMEN',
    label: 'Semen Analysis',
    patterns: [/semen (analysis|examination)/i, /seminogram/i, /sperm count/i],
  },
];

// Pseudo-type for every row that fits none of the types above. Rows are
// never dropped for not being in the catalog/dictionary — they are grouped
// here under the heading they were printed under.
const OTHER_TYPE = { id: 'OTHER', label: 'Other tests (not in the list above)', patterns: [] };

// Not selectable — only mark where the PREVIOUS section stops, so a
// selected section doesn't run on into the next unrelated block. Matched
// against the whole trimmed line (anchored), since these words are common.
const BOUNDARY_PATTERNS = [
  /^(haematology|hematology|biochemistry|clinical biochemistry|serology|immunology|immuno ?assay|clinical pathology|microbiology|endocrinology|pathology)$/i,
  /^(histopathology|cytology|molecular biology|special chemistry|hormone assay|clinical chemistry)$/i,
  /^cardiac profile$/i,
  /end of (the )?report/i,
];

module.exports = { REPORT_TYPES, OTHER_TYPE, BOUNDARY_PATTERNS };
