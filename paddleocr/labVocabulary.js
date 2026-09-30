// The shared vocabulary of diagnostic lab reports — units, qualitative
// results, method names, reference-range labels, note/interpretation
// markers. None of this is specific to one lab or template: it is what ANY
// lab report is written with, which is what lets rowParser.js parse rows
// from labs it has never seen. Extend these lists when a new lab uses a word
// that isn't here yet; never add a lab-specific layout rule.

// Units, written the way labs print them. Matching is done on a normalized
// form (lowercase, no spaces, µ/μ → u, trailing dots dropped) so "mg / dL",
// "mg/dl" and "MG/DL" are all the same unit.
const UNITS = [
  // counts
  '10^3/ul', '10^6/ul', '10^9/l', '10^12/l', 'x10^3/ul', 'x10^6/ul', 'x10³/ul', 'x10⁶/ul', '10³/ul', '10⁶/ul',
  'cells/cumm', 'cells/ul', 'cells/mm3', 'cells/cu.mm', '/cumm', '/cu.mm', '/mm3', '/ul', '/hpf', '/lpf',
  'lakh/cumm', 'lakhs/cumm', 'lacs/cumm', 'lacks/cumm', 'lakh/ul', 'thou/ul', 'thou/cumm', 'million/ul', 'million/cumm',
  'mill/cumm', 'mil/ul', 'millions/cumm', 'miu/ul', 'milli/cu.mm', 'milli./cu.mm', 'mill/cu.mm', 'million/cu.mm',
  'lakh/cu.mm', 'lakhs/cu.mm', 'lac/cu.mm', 'lacs/cu.mm', 'thou/cu.mm', 'cells/cu.mm',
  // concentrations
  'g/dl', 'gm/dl', 'gm%', 'g%', 'g/l', 'mg/dl', 'mg/l', 'mg/24hrs', 'mg/24h', 'ug/dl', 'mcg/dl', 'ug/l', 'ng/ml', 'ng/dl',
  'ng/l', 'pg/ml', 'pmol/l', 'nmol/l', 'umol/l', 'mmol/l', 'meq/l', 'mosm/kg', 'iu/ml', 'iu/l', 'miu/ml', 'uiu/ml',
  'u/l', 'u/ml', 'mu/l', 'kiu/l', 'ku/l', 'mg/g', 'mg/mmol', 'mcg/l',
  // sizes, rates, ratios, misc
  'fl', 'pg', '%', 'ratio', 'mm/hr', 'mm/1hr', 'mm/1sthr', 'mm/isthr', 'mm1sthour', 'mm1sthr', 'mmin1sthr',
  'mm/h', 'mmfirsthour', 'mm/firsthour', 'mmfirsthr', 'mminfirsthour', 'mmatendof1sthr', 'mmatendof1sthour', 'mmafter1hr', 'mm/1sthour', 'mm/fhr', 'ml', 'sec', 'secs', 'seconds', 'ml/min', 'ml/min/1.73sqm', 'ml/min/1.73m2', 'ml/min/1.73m²', 'mg/min', 'index',
];

// Qualitative results (multi-word phrases allowed). Longest match wins.
const QUALITATIVE = [
  'non reactive', 'non-reactive', 'nonreactive', 'reactive', 'weakly reactive',
  'not detected', 'detected', 'not seen', 'seen', 'not found',
  'negative', 'positive', 'weakly positive', 'equivocal', 'indeterminate', 'borderline',
  'absent', 'present', 'nil', 'trace', 'normal', 'abnormal',
  'clear', 'slightly turbid', 'turbid', 'hazy', 'cloudy',
  'pale yellow', 'dark yellow', 'straw yellow', 'straw', 'yellow', 'amber', 'colourless', 'colorless', 'reddish', 'red', 'brown',
  'acidic', 'alkaline', 'neutral', 'occasional', 'few', 'moderate', 'plenty', 'numerous', 'many',
  '+', '++', '+++', '++++', '1+', '2+', '3+', '4+',
];

// A text-only line containing one of these is a METHOD line (how the test
// was run), never a test name. Covers the common analyzer/assay methods.
const METHOD_RE = /^method\s*[:\-]|\b(calculated|calculation|derived|impedance|impendence|cytometry|spectrophotometr\w*|photometr\w*|colorimetr\w*|cyanide|sls\b|cmia|clia|eclia|elisa|elfa|hplc|turbidimetr\w*|nephelometr\w*|enzymatic|kinetic|end ?point|biuret|arsenazo|picrate|jaffe'?s?|urease|gldh|ifcc|oxidase|peroxidase|hexokinase|god[- ]?pod|westergren\w*|microscopy|microscopic examination|automated|analy[sz]er|chemiluminescen\w*|immunoassay|immunochromatograph\w*|rapid card|dipstick|reflectance|ion selective|\bise\b|direct measure|agglutination|latex|bromocresol|diazo|dcpip|szasz|flow cell|coulter|capillary electrophoresis)\b/i;

// Words allowed inside a reference-range string. A candidate row whose
// "range" contains other words is rejected (it was probably prose or a
// date/meta line), which is what keeps the parser from inventing rows.
const RANGE_WORDS = new Set([
  'normal', 'borderline', 'high', 'low', 'very', 'risk', 'moderate', 'optimal', 'near', 'above', 'below', 'desirable',
  'undesirable', 'deficiency', 'deficient', 'insufficient', 'insufficiency', 'sufficient', 'toxic', 'toxicity',
  'hypervitaminosis', 'adult', 'adults', 'children', 'child', 'infant', 'infants', 'newborn', 'neonate', 'neonates',
  'male', 'males', 'female', 'females', 'men', 'women', 'm', 'f', 'pregnancy', 'trimester', 'st', 'nd', 'rd', 'th',
  'non', 'diabetic', 'diabetes', 'prediabetes', 'pre', 'at', 'goal', 'therapy', 'of', 'to', 'up', 'upto', 'less',
  'than', 'more', 'greater', 'and', 'or', 'years', 'year', 'yrs', 'yr', 'y', 'age', 'reference', 'range', 'ref',
  'see', 'refer', 'table', 'in', 'is', 'for', 'the', 'elderly', 'premenopausal', 'postmenopausal', 'follicular',
  'luteal', 'phase', 'mid', 'cycle', 'ovulation', 'good', 'poor', 'fair', 'control', 'increased', 'decreased',
  'mild', 'severe', 'failure', 'kidney', 'impaired', 'fasting', 'glucose', 'healthy', 'recommended', 'target',
  'cut', 'off', 'cutoff', 'negative', 'positive', 'reactive', 'equivocal', 'nil', 'absent', 'present', 'detected',
  'not', 'clear', 'yellow', 'pale', 'straw',
]);

// A line starting with one of these is a continuation of the previous
// row's reference range ("Borderline - 40 - 60", "Children: 54 - 369"),
// not a new test.
const RANGE_LABEL_RE = /^(normal|borderline|very high|high risk|low risk|moderate risk|high|low|optimal|near (or above )?optimal|desirable|undesirable|deficien\w*|insufficien\w*|sufficient|toxic\w*|hypervitaminosis|adults?|children|child|infants?|newborns?|new ?borns?|neonates?|males?|females?|men|women|pregnancy|\d+\s*(st|nd|rd|th)\s*trimester|non[- ]?diabetic|pre[- ]?diabet\w*|diabet\w*|at risk|goal|action suggested|therapeutic|good control|poor control|fair control|up ?to|less than|more than|greater than|elderly|pre-?menopausal|post-?menopausal|follicular|luteal|mid[- ]?cycle|mild|severe|kidney failure|impaired)\b/i;

// A line starting with one of these opens a notes/interpretation block:
// everything until the next recognizable test is explanation, not data.
const NOTES_RE = /^(interpretation|interpretations|note|notes|comments?|clinical (significance|use|utility|information)|remarks?|reference (group|range|values?|intervals?)\b|ref\.? range|limitations?|disclaimer|advice|suggestions?|summary|conclusion|impression|methodology|principle|test (details|information))\b/i;

// Specimen lines ("WHOLE BLOOD-EDTA", "Serum", "Fluoride Plasma") — like a
// method line, never a test name.
const SPECIMEN_RE = /^(sample\s*(type)?\s*[:\-]?\s*)?((whole\s*blood|blood|serum|plasma|urine|edta|k2\s*edta|k3\s*edta|fluoride|sodium\s*fluoride|citrate|heparin|stool|swab|csf|spot\s*urine|random\s*urine|24\s*hrs?\s*urine)[\s\-\/,]*)+$/i;

// A reference-range continuation written as "label: number" / "label ; number"
// ("Major Heart Risk: < 40", "FEMALES ; 0.6 - 1.1", "Poor Control : > 180").
const LABEL_NUMBER_RE = /^[A-Za-z][A-Za-z .\-()\/&]{0,40}\s*[:;]\s*[<>≤≥=]*\s*\d/;

// Sentence words — a candidate test name containing two or more of these is
// prose ("eGFR test is applicable for patients aged 18 years"), not a test.
const PROSE_WORDS = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'the', 'this', 'that', 'these', 'with', 'should', 'may', 'can', 'must', 'will', 'patients', 'patient', 'applicable', 'recommended', 'indicates', 'suggests', 'please', 'if', 'your', 'you']);

// Column header rows ("Test Name  Result  Unit  Reference Range").
const COLUMN_HEADER_RE = /\b(test (name|description)|investigations?|parameters?|results?|observed values?|value\(s\)|unit\(s\)|units|reference (range|interval)|biological ref\w*|bio\.? ref\w*)\b/i;

// Flags labs print next to a value to mark it out of range.
const FLAG_TOKENS = new Set(['*', '**', 'h', 'l', '(h)', '(l)', '↑', '↓', 'hi', 'lo', '[h]', '[l]']);

module.exports = { UNITS, QUALITATIVE, METHOD_RE, SPECIMEN_RE, RANGE_WORDS, RANGE_LABEL_RE, LABEL_NUMBER_RE, PROSE_WORDS, NOTES_RE, COLUMN_HEADER_RE, FLAG_TOKENS };
