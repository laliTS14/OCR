// Master dictionary of common lab parameters: canonical name, the names
// labs actually print for it, typical units, and a PLAUSIBLE range (what a
// living patient can physically have — not the normal range). Used by
// rowParser.js to:
//   - give every row a canonical name regardless of how the lab spelled it,
//   - flag physically implausible values (lost decimal point, OCR misread),
//   - decide whether an ambiguous line is really a test,
//   - score confidence.
// The parser does NOT require a dictionary match to extract a row — tests
// missing from here still come through, just without a canonical name.
//
// Entry: [id, canonical name, report types, synonyms, units, plausible [min, max] | null]
// `plausible` is only set where the unit is (nearly) universal, and is
// checked only when the row's unit is one of `units`.
// Synonyms are matched as whole words after normalization (lowercase,
// punctuation → space); the LONGEST matching synonym wins, and entries whose
// report type matches the section and whose units match the row win ties.

const P = [
  // ---- Haematology / CBC ----
  ['HB', 'Haemoglobin', ['CBC'], ['haemoglobin', 'hemoglobin', 'hb', 'hgb', 'haemoglobin hb'], ['g/dl', 'gm/dl', 'gm%', 'g%'], [2, 25]],
  ['RBC', 'RBC Count', ['CBC'], ['rbc count', 'rbc', 'red blood cell count', 'red blood cells', 'erythrocyte count', 'total rbc', 'rbc total count'], ['million/ul', 'mill/cumm', 'millions/cumm', '10^6/ul', 'x10^6/ul', 'miu/ul', 'mil/ul', 'million/cumm'], [0.5, 10]],
  ['HCT', 'Haematocrit (PCV)', ['CBC'], ['pcv', 'packed cell volume', 'hematocrit', 'haematocrit', 'hct'], ['%'], [5, 75]],
  ['MCV', 'MCV', ['CBC'], ['mcv', 'mean corpuscular volume', 'mean cell volume'], ['fl'], [40, 150]],
  ['MCH', 'MCH', ['CBC'], ['mch', 'mean corpuscular hemoglobin', 'mean corpuscular haemoglobin', 'mean cell hemoglobin'], ['pg'], [10, 50]],
  ['MCHC', 'MCHC', ['CBC'], ['mchc', 'mean corpuscular hemoglobin concentration', 'mean corpuscular haemoglobin concentration'], ['g/dl', 'gm/dl', '%'], [20, 45]],
  ['RDWCV', 'RDW-CV', ['CBC'], ['rdw', 'rdw cv', 'red cell distribution width', 'rdw cv red cell distribution width'], ['%'], [5, 40]],
  ['RDWSD', 'RDW-SD', ['CBC'], ['rdw sd'], ['fl'], [15, 100]],
  ['WBC', 'Total WBC Count (TLC)', ['CBC'], ['wbc', 'wbc count', 'total wbc count', 'tlc', 'total leucocyte count', 'total leukocyte count', 'total count', 'white blood cell count', 'white blood cells', 'leucocyte count', 'leukocyte count', 'total wbc count tlc'], ['cells/cumm', 'cells/ul', '/cumm', '/ul', 'thou/ul', '10^3/ul', 'x10^3/ul', '10^9/l'], null],
  ['NEUT', 'Neutrophils %', ['CBC'], ['neutrophils', 'neutrophil', 'polymorphs', 'segmented neutrophils', 'pmn', 'polymorphonuclear'], ['%'], [0, 100]],
  ['LYMPH', 'Lymphocytes %', ['CBC'], ['lymphocytes', 'lymphocyte'], ['%'], [0, 100]],
  ['MONO', 'Monocytes %', ['CBC'], ['monocytes', 'monocyte'], ['%'], [0, 100]],
  ['EOS', 'Eosinophils %', ['CBC'], ['eosinophils', 'eosinophil'], ['%'], [0, 100]],
  ['BASO', 'Basophils %', ['CBC'], ['basophils', 'basophil'], ['%'], [0, 100]],
  ['ANC', 'Absolute Neutrophil Count', ['CBC'], ['absolute neutrophil count', 'anc', 'neutrophils absolute', 'absolute neutrophils'], ['/ul', 'cells/ul', 'cells/cumm', '/cumm', '10^3/ul', 'x10^3/ul', '10^9/l'], null],
  ['ALC', 'Absolute Lymphocyte Count', ['CBC'], ['absolute lymphocyte count', 'alc', 'lymphocytes absolute', 'absolute lymphocytes'], ['/ul', 'cells/ul', 'cells/cumm', '/cumm', '10^3/ul', 'x10^3/ul', '10^9/l'], null],
  ['AMC', 'Absolute Monocyte Count', ['CBC'], ['absolute monocyte count', 'amc', 'monocytes absolute', 'absolute monocytes'], ['/ul', 'cells/ul', 'cells/cumm', '/cumm', '10^3/ul', 'x10^3/ul', '10^9/l'], null],
  ['AEC', 'Absolute Eosinophil Count', ['CBC'], ['absolute eosinophil count', 'aec', 'eosinophils absolute', 'absolute eosinophils'], ['/ul', 'cells/ul', 'cells/cumm', '/cumm', '10^3/ul', 'x10^3/ul', '10^9/l'], null],
  ['ABC', 'Absolute Basophil Count', ['CBC'], ['absolute basophil count', 'abc', 'basophils absolute', 'absolute basophils'], ['/ul', 'cells/ul', 'cells/cumm', '/cumm', '10^3/ul', 'x10^3/ul', '10^9/l'], null],
  ['PLT', 'Platelet Count', ['CBC'], ['platelet count', 'platelets', 'plt', 'platelet', 'total platelet count'], ['lakh/cumm', 'lakhs/cumm', 'lacs/cumm', 'lacks/cumm', 'lakh/ul', '10^3/ul', 'x10^3/ul', 'thou/ul', '/cumm', 'cells/cumm', '10^9/l'], null],
  ['MPV', 'MPV', ['CBC'], ['mpv', 'mean platelet volume'], ['fl'], [3, 20]],
  ['PCT', 'Plateletcrit (PCT)', ['CBC'], ['pct', 'plateletcrit', 'platelet hematocrit', 'platelet haematocrit', 'thrombocrit'], ['%'], [0, 2]],
  ['PDW', 'PDW', ['CBC'], ['pdw', 'platelet distribution width'], ['fl', '%'], [3, 40]],
  ['PLCR', 'P-LCR', ['CBC'], ['p lcr', 'platelet large cell ratio'], ['%'], [0, 100]],
  ['PLCC', 'P-LCC', ['CBC'], ['p lcc', 'platelet large cell count'], ['10^9/l', '10^3/ul'], null],
  ['MENTZER', 'Mentzer Index', ['CBC'], ['mentzer index'], null, null],
  ['ESR', 'ESR', ['ESR', 'CBC'], ['esr', 'erythrocyte sedimentation rate', 'sedimentation rate'], ['mm/hr', 'mm/1hr', 'mm/1sthr', 'mm/isthr', 'mm1sthour', 'mm1sthr', 'mmin1sthr', 'mm/h'], [0, 200]],

  // ---- Glucose ----
  ['FBS', 'Fasting Blood Glucose', ['GLUCOSE'], ['fasting plasma glucose', 'fasting blood glucose', 'fasting blood sugar', 'glucose fasting', 'fbs', 'fasting glucose', 'plasma glucose fasting', 'blood sugar fasting', 'sugar fasting', 'fasting sugar', 'glucose f'], ['mg/dl', 'mmol/l'], null],
  ['PPBS', 'Post-prandial Blood Glucose', ['GLUCOSE'], ['post prandial glucose', 'post prandial blood sugar', 'ppbs', 'glucose pp', 'glucose post prandial', 'postprandial glucose', 'plasma glucose pp', 'sugar pp', 'pp sugar', 'sugar post prandial'], ['mg/dl', 'mmol/l'], null],
  ['RBS', 'Random Blood Glucose', ['GLUCOSE'], ['random blood glucose', 'random blood sugar', 'rbs', 'glucose random', 'random glucose', 'plasma glucose random', 'sugar random', 'random sugar'], ['mg/dl', 'mmol/l'], null],
  ['HBA1C', 'HbA1c', ['HBA1C'], ['hba1c', 'glycosylated hemoglobin', 'glycosylated haemoglobin', 'glycated hemoglobin', 'glycated haemoglobin', 'a1c', 'glycosylated hemoglobin hba1c'], ['%'], [2, 20]],
  ['EAG', 'Estimated Average Glucose', ['HBA1C'], ['mean plasma glucose', 'estimated average glucose', 'eag', 'average blood glucose', 'avg blood glucose', 'avg blood glucose level', 'average glucose', 'mean blood glucose'], ['mg/dl', 'mmol/l'], null],

  // ---- Lipids ----
  ['CHOL', 'Total Cholesterol', ['LIPID'], ['total cholesterol', 'cholesterol total', 'serum cholesterol', 'cholesterol', 'cholesterol serum'], ['mg/dl', 'mmol/l'], null],
  ['TG', 'Triglycerides', ['LIPID'], ['triglycerides', 'triglyceride', 'tg', 'serum triglycerides'], ['mg/dl', 'mmol/l'], null],
  ['HDL', 'HDL Cholesterol', ['LIPID'], ['hdl cholesterol', 'cholesterol hdl', 'hdl', 'hdl c', 'hdl direct', 'cholesterol hdl direct'], ['mg/dl', 'mmol/l'], null],
  ['LDL', 'LDL Cholesterol', ['LIPID'], ['ldl cholesterol', 'cholesterol ldl', 'ldl', 'ldl c', 'ldl direct'], ['mg/dl', 'mmol/l'], null],
  ['VLDL', 'VLDL Cholesterol', ['LIPID'], ['vldl cholesterol', 'vldl', 'cholesterol vldl'], ['mg/dl', 'mmol/l'], null],
  ['NONHDL', 'Non-HDL Cholesterol', ['LIPID'], ['non hdl cholesterol', 'non hdl'], ['mg/dl', 'mmol/l'], null],
  ['CHOLHDL', 'Total Cholesterol / HDL Ratio', ['LIPID'], ['chol hdl ratio', 'chol hdl', 'cholesterol hdl', 'total c hdl c', 'total c hdl c ratio', 'tc hdl c', 'cholesterol hdl ratio', 'total cholesterol hdl ratio', 'tc hdl ratio', 'tc hdl'], ['ratio'], [0.5, 20]],
  ['LDLHDL', 'LDL / HDL Ratio', ['LIPID'], ['ldl hdl ratio', 'ldl hdl', 'ldl chol hdl chol ratio', 'ldl c hdl c ratio', 'ldl cholesterol hdl cholesterol ratio'], ['ratio'], [0.1, 15]],

  // ---- Kidney ----
  ['CREAT', 'Creatinine', ['KFT'], ['creatinine', 'serum creatinine', 'creatinine serum'], ['mg/dl', 'umol/l'], null],
  ['UREA', 'Urea', ['KFT'], ['urea', 'blood urea', 'serum urea'], ['mg/dl', 'mmol/l'], null],
  ['BUN', 'Blood Urea Nitrogen (BUN)', ['KFT'], ['bun', 'blood urea nitrogen', 'urea nitrogen', 'blood urea nitrogen bun'], ['mg/dl', 'mmol/l'], null],
  ['URIC', 'Uric Acid', ['KFT'], ['uric acid', 'serum uric acid'], ['mg/dl', 'umol/l'], null],
  ['EGFR', 'eGFR', ['KFT'], ['egfr', 'estimated gfr', 'egfr ckd epi', 'gfr'], ['ml/min/1.73sqm', 'ml/min/1.73m2', 'ml/min'], [1, 200]],
  ['BUNCR', 'BUN / Creatinine Ratio', ['KFT'], ['bun creatinine ratio', 'bun creat ratio', 'urea creatinine ratio'], ['ratio'], null],
  ['CA', 'Calcium', ['KFT'], ['calcium', 'serum calcium', 'calcium serum', 'total calcium'], ['mg/dl', 'mmol/l'], null],
  ['NA', 'Sodium', ['ELECTROLYTE', 'KFT'], ['sodium', 'serum sodium', 'na'], ['meq/l', 'mmol/l'], [90, 200]],
  ['K', 'Potassium', ['ELECTROLYTE', 'KFT'], ['potassium', 'serum potassium', 'k'], ['meq/l', 'mmol/l'], [1, 10]],
  ['CL', 'Chloride', ['ELECTROLYTE', 'KFT'], ['chloride', 'serum chloride', 'cl'], ['meq/l', 'mmol/l'], [60, 150]],
  ['PHOS', 'Phosphorus', ['KFT'], ['phosphorus', 'inorganic phosphorus', 'serum phosphorus', 'phosphate'], ['mg/dl', 'mmol/l'], null],

  // ---- Liver ----
  ['TBIL', 'Bilirubin Total', ['LFT'], ['bilirubin total', 'total bilirubin', 'serum bilirubin total', 'bilirubin t'], ['mg/dl', 'umol/l'], null],
  ['DBIL', 'Bilirubin Direct', ['LFT'], ['bilirubin direct', 'direct bilirubin', 'conjugated bilirubin', 'serum bilirubin direct', 'bilirubin d'], ['mg/dl', 'umol/l'], null],
  ['IBIL', 'Bilirubin Indirect', ['LFT'], ['bilirubin indirect', 'indirect bilirubin', 'unconjugated bilirubin', 'serum bilirubin indirect'], ['mg/dl', 'umol/l'], null],
  ['AST', 'SGOT / AST', ['LFT'], ['sgot', 'ast', 'sgot ast', 'aspartate aminotransferase', 'aspartate transaminase', 'ast sgot'], ['u/l', 'iu/l'], [0, 20000]],
  ['ALT', 'SGPT / ALT', ['LFT'], ['sgpt', 'alt', 'sgpt alt', 'alanine aminotransferase', 'alanine transaminase', 'alt sgpt'], ['u/l', 'iu/l'], [0, 20000]],
  ['ALP', 'Alkaline Phosphatase', ['LFT'], ['alkaline phosphatase', 'alkaline phosphate', 'alp', 'serum alkaline phosphatase'], ['u/l', 'iu/l'], [0, 5000]],
  ['GGT', 'Gamma GT (GGT)', ['LFT'], ['ggt', 'gamma gt', 'ggtp', 'gamma glutamyl transferase', 'y glutamyl transferase', 'gamma glutamyl transpeptidase'], ['u/l', 'iu/l'], [0, 5000]],
  ['TP', 'Total Protein', ['LFT'], ['total protein', 'protein total', 'serum protein', 'total proteins', 'serum total protein'], ['g/dl', 'gm/dl', 'g/l'], null],
  ['ALB', 'Albumin', ['LFT'], ['albumin', 'serum albumin'], ['g/dl', 'gm/dl', 'g/l'], null],
  ['GLOB', 'Globulin', ['LFT'], ['globulin', 'serum globulin'], ['g/dl', 'gm/dl', 'g/l'], null],
  ['AGR', 'A/G Ratio', ['LFT'], ['a g ratio', 'a g', 'albumin globulin ratio', 'albumin globulin a g ratio', 'ag ratio'], ['ratio'], [0.1, 5]],
  ['ASTALT', 'SGOT / SGPT Ratio', ['LFT'], ['sgot sgpt ratio', 'ast alt ratio', 'de ritis ratio'], ['ratio'], [0.1, 10]],

  // ---- Thyroid ----
  ['TSH', 'TSH', ['THYROID'], ['tsh', 'thyroid stimulating hormone', 'thyrotropin', 'tsh ultrasensitive', 'thyroid stimulating hormone ultrasensitive'], ['uiu/ml', 'miu/l', 'miu/ml'], [0, 200]],
  ['T3', 'Total T3', ['THYROID'], ['t3', 'total t3', 'triiodothyronine', 't3 total', 'triiodothyronine total'], ['ng/dl', 'ng/ml', 'nmol/l'], null],
  ['T4', 'Total T4', ['THYROID'], ['t4', 'total t4', 'thyroxine', 't4 total', 'thyroxine total'], ['ug/dl', 'mcg/dl', 'nmol/l'], null],
  ['FT3', 'Free T3', ['THYROID'], ['free t3', 'ft3', 'free triiodothyronine'], ['pg/ml', 'pmol/l'], null],
  ['FT4', 'Free T4', ['THYROID'], ['free t4', 'ft4', 'free thyroxine'], ['ng/dl', 'pmol/l'], null],

  // ---- Vitamins / iron ----
  ['VITD', 'Vitamin D (25-OH)', ['VITAMIN'], ['vitamin d', 'vitamin d 25 hydroxy', '25 hydroxy vitamin d', '25 oh vitamin d', 'vitamin d total', '25 oh d', 'vit d'], ['ng/ml', 'nmol/l'], [1, 300]],
  ['B12', 'Vitamin B12', ['VITAMIN'], ['vitamin b12', 'vitamin b 12', 'cyanocobalamin', 'b12', 'vit b12'], ['pg/ml', 'pmol/l'], [20, 5000]],
  ['FERR', 'Ferritin', ['IRON'], ['ferritin', 'serum ferritin'], ['ng/ml', 'ug/l'], null],
  ['IRON', 'Serum Iron', ['IRON'], ['serum iron', 'iron'], ['ug/dl', 'mcg/dl', 'umol/l'], null],
  ['TIBC', 'TIBC', ['IRON'], ['tibc', 'total iron binding capacity'], ['ug/dl', 'mcg/dl', 'umol/l'], null],

  // ---- Serology (qualitative) ----
  ['HIV', 'HIV I & II Antibody', ['HIV'], ['hiv', 'hiv antibody', 'hiv i ii', 'hiv 1 2', 'hiv 1 2 antibody', 'hiv i ii antibody', 'hiv antibody elisa', 'anti hiv'], null, null],
  ['HBSAG', 'HBsAg', ['HBSAG'], ['hbsag', 'hbs ag', 'hbs antigen', 'hepatitis b surface antigen', 'australia antigen'], null, null],
  ['HCV', 'Anti-HCV', ['HCV'], ['hcv', 'anti hcv', 'hcv antibody', 'hepatitis c antibody', 'hepatitis c virus'], null, null],
  ['VDRL', 'VDRL', ['INFECT'], ['vdrl', 'rpr', 'syphilis'], null, null],
  ['COT', 'Urine Cotinine', ['COTININE'], ['cotinine', 'urine cotinine', 'nicotine'], ['ng/ml'], null],

  // ---- General pathology coverage (standard tests across all common panels) ----
  // Haematology — other
  ['RETIC', 'Reticulocyte Count', ['HAEM_OTHER', 'CBC'], ['reticulocyte count', 'reticulocytes', 'retic count', 'retic'], ['%'], [0, 30]],
  ['G6PD', 'G6PD', ['HAEM_OTHER'], ['g6pd', 'glucose 6 phosphate dehydrogenase'], ['u/g hb', 'u/gm hb', 'u/l'], null],
  ['HBA2', 'HbA2', ['HAEM_OTHER'], ['hba2', 'hb a2'], ['%'], [0, 15]],
  ['HBF', 'HbF (Foetal Haemoglobin)', ['HAEM_OTHER'], ['hbf', 'foetal haemoglobin', 'fetal hemoglobin'], ['%'], [0, 100]],
  ['SICKLE', 'Sickling Test', ['HAEM_OTHER'], ['sickling test', 'sickle cell test', 'sickling'], null, null],
  ['PBS', 'Peripheral Smear', ['HAEM_OTHER'], ['peripheral smear', 'peripheral blood smear', 'pbs', 'rbc morphology', 'wbc morphology', 'platelet morphology'], null, null],
  ['BANDS', 'Band Forms', ['CBC'], ['band forms', 'bands', 'band cells', 'stab cells'], ['%'], [0, 100]],
  ['NRBC', 'NRBC', ['CBC'], ['nrbc', 'nucleated rbc', 'nucleated red blood cells'], ['/100 wbc', '%'], null],
  ['MPXI', 'Immature Granulocytes', ['CBC'], ['immature granulocytes', 'ig'], ['%'], [0, 100]],
  ['BG', 'Blood Group (ABO)', ['BLOODGROUP'], ['blood group', 'abo group', 'abo', 'abo grouping', 'blood grouping'], null, null],
  ['RH', 'Rh Factor', ['BLOODGROUP'], ['rh factor', 'rh type', 'rh typing', 'rh', 'rh d'], null, null],

  // Coagulation
  ['PT', 'Prothrombin Time (PT)', ['COAG'], ['prothrombin time', 'pt', 'pt test', 'pt patient'], ['sec', 'secs', 'seconds'], [5, 150]],
  ['PTC', 'PT Control', ['COAG'], ['pt control', 'control', 'control time'], ['sec', 'secs', 'seconds'], [5, 60]],
  ['INR', 'INR', ['COAG'], ['inr', 'international normalized ratio', 'international normalised ratio'], null, [0.5, 15]],
  ['APTT', 'APTT', ['COAG'], ['aptt', 'ptt', 'activated partial thromboplastin time', 'partial thromboplastin time'], ['sec', 'secs', 'seconds'], [10, 200]],
  ['BT', 'Bleeding Time', ['COAG'], ['bleeding time', 'bt'], null, null],
  ['CT', 'Clotting Time', ['COAG'], ['clotting time', 'ct', 'coagulation time'], null, null],
  ['DDIMER', 'D-Dimer', ['COAG'], ['d dimer', 'ddimer'], ['ng/ml', 'ug/ml', 'mg/l'], null],
  ['FIB', 'Fibrinogen', ['COAG'], ['fibrinogen'], ['mg/dl', 'g/l'], null],

  // Iron studies (Ferritin / Serum Iron / TIBC above)
  ['UIBC', 'UIBC', ['IRON'], ['uibc', 'unsaturated iron binding capacity'], ['ug/dl', 'mcg/dl', 'umol/l'], null],
  ['TSAT', 'Transferrin Saturation', ['IRON'], ['transferrin saturation', 'tsat', 'iron saturation', '% saturation'], ['%'], [0, 100]],
  ['TRANSF', 'Transferrin', ['IRON'], ['transferrin', 'serum transferrin'], ['mg/dl', 'g/l'], null],

  // Electrolytes / minerals (Sodium, Potassium, Chloride, Calcium, Phosphorus above)
  ['BICARB', 'Bicarbonate', ['ELECTROLYTE'], ['bicarbonate', 'hco3', 'total co2', 'serum bicarbonate'], ['meq/l', 'mmol/l'], [2, 60]],
  ['MG', 'Magnesium', ['ELECTROLYTE', 'KFT'], ['magnesium', 'serum magnesium', 'mg'], ['mg/dl', 'mmol/l', 'meq/l'], null],
  ['ICA', 'Ionised Calcium', ['ELECTROLYTE', 'KFT'], ['ionised calcium', 'ionized calcium', 'ica'], ['mmol/l', 'mg/dl'], null],

  // Kidney — extra
  ['CYSC', 'Cystatin C', ['KFT'], ['cystatin c'], ['mg/l'], null],
  ['UREACR', 'Urea / Creatinine Ratio', ['KFT'], ['urea creatinine ratio'], ['ratio'], null],

  // Liver — extra
  ['LDH', 'LDH', ['CARDIAC', 'LFT'], ['ldh', 'lactate dehydrogenase', 'ld'], ['u/l', 'iu/l'], [0, 20000]],
  ['AMMONIA', 'Ammonia', ['LFT'], ['ammonia', 'serum ammonia'], ['umol/l', 'ug/dl'], null],

  // Cardiac
  ['TROPI', 'Troponin I', ['CARDIAC'], ['troponin i', 'trop i', 'ctni', 'hs troponin i'], ['ng/ml', 'pg/ml', 'ng/l'], null],
  ['TROPT', 'Troponin T', ['CARDIAC'], ['troponin t', 'trop t', 'ctnt', 'hs troponin t'], ['ng/ml', 'pg/ml', 'ng/l'], null],
  ['CKMB', 'CK-MB', ['CARDIAC'], ['ck mb', 'ckmb', 'cpk mb'], ['u/l', 'iu/l', 'ng/ml'], null],
  ['CPK', 'CPK (Total CK)', ['CARDIAC'], ['cpk', 'ck', 'creatine kinase', 'creatine phosphokinase', 'total ck', 'cpk total'], ['u/l', 'iu/l'], [0, 100000]],
  ['BNP', 'BNP / NT-proBNP', ['CARDIAC'], ['bnp', 'nt pro bnp', 'nt probnp', 'pro bnp'], ['pg/ml'], null],
  ['HCY', 'Homocysteine', ['CARDIAC'], ['homocysteine'], ['umol/l'], null],
  ['APOA', 'Apolipoprotein A1', ['LIPID'], ['apolipoprotein a1', 'apo a1', 'apoa1'], ['mg/dl', 'g/l'], null],
  ['APOB', 'Apolipoprotein B', ['LIPID'], ['apolipoprotein b', 'apo b', 'apob'], ['mg/dl', 'g/l'], null],
  ['LPA', 'Lipoprotein (a)', ['LIPID'], ['lipoprotein a', 'lp a', 'lpa'], ['mg/dl', 'nmol/l'], null],

  // Pancreas
  ['AMY', 'Amylase', ['PANCREAS'], ['amylase', 'serum amylase'], ['u/l', 'iu/l'], [0, 20000]],
  ['LIP', 'Lipase', ['PANCREAS'], ['lipase', 'serum lipase'], ['u/l', 'iu/l'], [0, 20000]],

  // Inflammation
  ['CRP', 'C-Reactive Protein (CRP)', ['INFLAM'], ['crp', 'c reactive protein', 'hs crp', 'hscrp', 'high sensitivity crp', 'crp quantitative'], ['mg/l', 'mg/dl'], null],
  ['RAF', 'RA Factor', ['INFLAM'], ['ra factor', 'rheumatoid factor', 'ra test', 'rf'], ['iu/ml', 'iu/l'], null],
  ['ASO', 'ASO Titre', ['INFLAM'], ['aso', 'aso titre', 'aso titer', 'anti streptolysin o'], ['iu/ml', 'iu/l'], null],
  ['PCT_INF', 'Procalcitonin', ['INFLAM'], ['procalcitonin'], ['ng/ml'], null],

  // Infection serology
  ['WIDAL_TO', 'Widal S. Typhi O', ['INFECT'], ['s typhi o', 'salmonella typhi o', 'typhi o', 'to'], null, null],
  ['WIDAL_TH', 'Widal S. Typhi H', ['INFECT'], ['s typhi h', 'salmonella typhi h', 'typhi h', 'th'], null, null],
  ['WIDAL_AH', 'Widal S. Paratyphi AH', ['INFECT'], ['s paratyphi ah', 'paratyphi a h', 'paratyphi ah', 'ah'], null, null],
  ['WIDAL_BH', 'Widal S. Paratyphi BH', ['INFECT'], ['s paratyphi bh', 'paratyphi b h', 'paratyphi bh', 'bh'], null, null],
  ['WIDAL', 'Widal Test', ['INFECT'], ['widal', 'widal test'], null, null],
  ['TYPHIDOT', 'Typhoid IgM/IgG', ['INFECT'], ['typhidot', 'typhoid igm', 'typhoid igg', 'salmonella igm'], null, null],
  ['DENGNS1', 'Dengue NS1 Antigen', ['INFECT'], ['dengue ns1', 'ns1 antigen', 'ns1'], null, null],
  ['DENGIGM', 'Dengue IgM', ['INFECT'], ['dengue igm'], null, null],
  ['DENGIGG', 'Dengue IgG', ['INFECT'], ['dengue igg'], null, null],
  ['MALARIA', 'Malaria Parasite / Antigen', ['INFECT'], ['malaria', 'malarial parasite', 'malaria parasite', 'mp', 'malaria antigen', 'plasmodium vivax', 'plasmodium falciparum', 'p vivax', 'p falciparum'], null, null],
  ['CHIK', 'Chikungunya', ['INFECT'], ['chikungunya', 'chikungunya igm'], null, null],
  ['TPHA', 'TPHA', ['INFECT'], ['tpha', 'treponema pallidum'], null, null],
  ['HBEAG', 'HBeAg', ['INFECT', 'HBSAG'], ['hbeag', 'hepatitis b e antigen'], null, null],
  ['ANTIHBS', 'Anti-HBs', ['INFECT', 'HBSAG'], ['anti hbs', 'hbs antibody', 'hepatitis b surface antibody'], ['miu/ml'], null],
  ['HAV', 'Hepatitis A (Anti-HAV IgM)', ['INFECT'], ['anti hav', 'hav igm', 'hepatitis a'], null, null],
  ['HEV', 'Hepatitis E (Anti-HEV IgM)', ['INFECT'], ['anti hev', 'hev igm', 'hepatitis e'], null, null],
  ['MANTOUX', 'Mantoux Test', ['INFECT'], ['mantoux', 'tuberculin test', 'ppd'], ['mm'], null],

  // Hormones
  ['FSH', 'FSH', ['HORMONE'], ['fsh', 'follicle stimulating hormone'], ['miu/ml', 'iu/l'], null],
  ['LH', 'LH', ['HORMONE'], ['lh', 'luteinizing hormone', 'luteinising hormone'], ['miu/ml', 'iu/l'], null],
  ['PRL', 'Prolactin', ['HORMONE'], ['prolactin', 'prl', 'serum prolactin'], ['ng/ml', 'uiu/ml', 'miu/l'], null],
  ['TESTO', 'Testosterone', ['HORMONE'], ['testosterone', 'total testosterone', 'free testosterone'], ['ng/dl', 'ng/ml', 'nmol/l', 'pg/ml'], null],
  ['E2', 'Estradiol (E2)', ['HORMONE'], ['estradiol', 'oestradiol', 'e2'], ['pg/ml', 'pmol/l'], null],
  ['PROG', 'Progesterone', ['HORMONE'], ['progesterone'], ['ng/ml', 'nmol/l'], null],
  ['CORT', 'Cortisol', ['HORMONE'], ['cortisol', 'serum cortisol', 'cortisol morning', 'cortisol am'], ['ug/dl', 'mcg/dl', 'nmol/l'], null],
  ['INS', 'Insulin', ['HORMONE', 'GLUCOSE'], ['insulin', 'fasting insulin', 'serum insulin'], ['uiu/ml', 'miu/l', 'pmol/l'], null],
  ['CPEP', 'C-Peptide', ['HORMONE', 'GLUCOSE'], ['c peptide'], ['ng/ml', 'nmol/l'], null],
  ['BHCG', 'Beta hCG', ['HORMONE'], ['beta hcg', 'b hcg', 'hcg', 'beta human chorionic gonadotropin'], ['miu/ml', 'iu/l'], null],
  ['AMH', 'AMH', ['HORMONE'], ['amh', 'anti mullerian hormone'], ['ng/ml', 'pmol/l'], null],
  ['PTH', 'PTH (Parathyroid Hormone)', ['HORMONE'], ['pth', 'parathyroid hormone', 'intact pth'], ['pg/ml', 'pmol/l'], null],
  ['DHEAS', 'DHEA-S', ['HORMONE'], ['dhea s', 'dheas', 'dhea sulphate', 'dhea sulfate'], ['ug/dl', 'mcg/dl', 'umol/l'], null],
  ['GH', 'Growth Hormone', ['HORMONE'], ['growth hormone', 'gh', 'hgh'], ['ng/ml'], null],
  ['ANTITPO', 'Anti-TPO', ['THYROID', 'IMMUNO'], ['anti tpo', 'tpo antibody', 'anti thyroid peroxidase', 'thyroid peroxidase antibody'], ['iu/ml', 'u/ml'], null],
  ['ANTITG', 'Anti-Thyroglobulin', ['THYROID', 'IMMUNO'], ['anti tg', 'anti thyroglobulin', 'thyroglobulin antibody'], ['iu/ml', 'u/ml'], null],

  // Vitamins (D, B12 above)
  ['FOLATE', 'Folic Acid (Folate)', ['VITAMIN'], ['folic acid', 'folate', 'serum folate', 'vitamin b9'], ['ng/ml', 'nmol/l'], null],

  // Tumour markers
  ['PSA', 'PSA', ['TUMOR'], ['psa', 'total psa', 'prostate specific antigen', 'psa total'], ['ng/ml'], [0, 10000]],
  ['FPSA', 'Free PSA', ['TUMOR'], ['free psa', 'psa free'], ['ng/ml'], null],
  ['CEA', 'CEA', ['TUMOR'], ['cea', 'carcino embryonic antigen', 'carcinoembryonic antigen'], ['ng/ml'], null],
  ['CA125', 'CA-125', ['TUMOR'], ['ca 125', 'ca125'], ['u/ml'], null],
  ['CA199', 'CA 19-9', ['TUMOR'], ['ca 19 9', 'ca19 9', 'ca 199'], ['u/ml'], null],
  ['CA153', 'CA 15-3', ['TUMOR'], ['ca 15 3', 'ca15 3'], ['u/ml'], null],
  ['AFP', 'Alpha-Fetoprotein (AFP)', ['TUMOR'], ['afp', 'alpha feto protein', 'alpha fetoprotein'], ['ng/ml', 'iu/ml'], null],

  // Immunology
  ['IGE', 'Total IgE', ['IMMUNO'], ['ige', 'total ige', 'serum ige'], ['iu/ml', 'kiu/l'], null],
  ['IGG', 'IgG', ['IMMUNO'], ['igg', 'immunoglobulin g'], ['mg/dl', 'g/l'], null],
  ['IGA', 'IgA', ['IMMUNO'], ['iga', 'immunoglobulin a'], ['mg/dl', 'g/l'], null],
  ['IGM', 'IgM', ['IMMUNO'], ['igm', 'immunoglobulin m'], ['mg/dl', 'g/l'], null],
  ['ANA', 'ANA', ['IMMUNO'], ['ana', 'antinuclear antibody', 'anti nuclear antibody', 'ana ifa'], null, null],
  ['ANTICCP', 'Anti-CCP', ['IMMUNO', 'INFLAM'], ['anti ccp', 'ccp antibody', 'anti cyclic citrullinated peptide'], ['u/ml'], null],
  ['DSDNA', 'Anti-dsDNA', ['IMMUNO'], ['anti dsdna', 'dsdna', 'ds dna'], ['iu/ml'], null],
  ['HLAB27', 'HLA-B27', ['IMMUNO'], ['hla b27', 'hla b 27'], null, null],

  // Urine — microalbumin / 24 h
  ['UMALB', 'Urine Microalbumin', ['UALB'], ['microalbumin', 'urine microalbumin', 'micro albumin'], ['mg/l', 'mg/24hrs', 'ug/min'], null],
  ['UACR', 'Albumin / Creatinine Ratio (ACR)', ['UALB'], ['albumin creatinine ratio', 'acr', 'uacr', 'microalbumin creatinine ratio'], ['mg/g', 'mg/mmol'], null],
  ['UCREAT', 'Urine Creatinine', ['UALB'], ['urine creatinine', 'urinary creatinine'], ['mg/dl', 'mmol/l', 'g/24hrs'], null],
  ['UPROT24', '24h Urine Protein', ['UALB'], ['24 hrs urine protein', '24 hour urine protein', 'urine protein 24 hrs', 'total urine protein'], ['mg/24hrs', 'g/24hrs', 'mg/dl'], null],
  ['UVOL24', '24h Urine Volume', ['UALB'], ['24 hrs urine volume', '24 hour urine volume', 'total volume'], ['ml', 'ml/24hrs'], null],
  ['UPCR', 'Urine Protein / Creatinine Ratio', ['UALB'], ['protein creatinine ratio', 'upcr'], ['mg/g', 'ratio'], null],
  ['UPREG', 'Urine Pregnancy Test', ['URINE', 'HORMONE'], ['urine pregnancy test', 'upt', 'pregnancy test'], null, null],

  // Stool
  ['S_COLOR', 'Stool Colour', ['STOOL'], ['colour', 'color'], null, null],
  ['S_CONS', 'Stool Consistency', ['STOOL'], ['consistency', 'form'], null, null],
  ['S_MUCUS', 'Mucus', ['STOOL', 'URINE'], ['mucus', 'mucous'], null, null],
  ['S_BLOOD', 'Stool Blood', ['STOOL'], ['blood', 'visible blood'], null, null],
  ['S_OCCULT', 'Occult Blood', ['STOOL'], ['occult blood', 'fecal occult blood', 'faecal occult blood', 'fobt'], null, null],
  ['S_OVA', 'Ova / Cysts', ['STOOL'], ['ova', 'cysts', 'ova cysts', 'ova and cysts', 'parasites', 'ova parasites'], null, null],
  ['S_PUS', 'Stool Pus Cells', ['STOOL'], ['pus cells'], ['/hpf'], null],
  ['S_RBC', 'Stool RBC', ['STOOL'], ['rbc', 'red blood cells'], ['/hpf'], null],
  ['S_FAT', 'Fat Globules', ['STOOL'], ['fat globules', 'fat'], null, null],
  ['S_REDSUB', 'Reducing Substances', ['STOOL'], ['reducing substances', 'reducing substance'], null, null],
  ['S_PH', 'Stool pH', ['STOOL'], ['ph', 'reaction'], null, [3, 10]],

  // Semen
  ['SEM_VOL', 'Semen Volume', ['SEMEN'], ['volume', 'semen volume'], ['ml'], [0, 20]],
  ['SEM_COUNT', 'Sperm Count', ['SEMEN'], ['sperm count', 'total sperm count', 'sperm concentration', 'count'], ['million/ml', 'millions/ml'], null],
  ['SEM_MOT', 'Motility', ['SEMEN'], ['motility', 'total motility', 'progressive motility', 'motile', 'active motile', 'sluggish motile', 'non motile'], ['%'], [0, 100]],
  ['SEM_MORPH', 'Morphology (Normal Forms)', ['SEMEN'], ['morphology', 'normal forms', 'normal morphology', 'abnormal forms'], ['%'], [0, 100]],
  ['SEM_LIQ', 'Liquefaction Time', ['SEMEN'], ['liquefaction time', 'liquefaction'], ['min', 'mins', 'minutes'], null],
  ['SEM_VISC', 'Viscosity', ['SEMEN'], ['viscosity'], null, null],

  // ---- Urine routine ----
  ['U_QTY', 'Quantity', ['URINE'], ['quantity', 'volume', 'urine volume', 'urine quantity'], ['ml'], null],
  ['U_DEP', 'Deposits', ['URINE'], ['deposits', 'deposit', 'sediment'], null, null],
  ['U_COLOR', 'Colour', ['URINE'], ['colour', 'color'], null, null],
  ['U_APPEAR', 'Appearance', ['URINE'], ['appearance', 'transparency', 'clarity', 'transparency appearance'], null, null],
  ['U_SG', 'Specific Gravity', ['URINE'], ['specific gravity', 'sp gravity', 'sp gr'], null, [1.0, 1.06]],
  ['U_PH', 'pH', ['URINE'], ['ph', 'reaction ph', 'reaction'], null, [4, 9.5]],
  ['U_GLU', 'Urine Glucose', ['URINE'], ['glucose', 'urine glucose', 'urine sugar', 'sugar', 'urine glucose sugar'], null, null],
  ['U_PRO', 'Urine Protein', ['URINE'], ['protein', 'protien', 'urine protein', 'albumin', 'urine albumin'], null, null],
  ['U_KET', 'Ketones', ['URINE'], ['ketones', 'ketone', 'ketone bodies', 'urine ketones', 'acetone'], null, null],
  ['U_BIL', 'Urine Bilirubin', ['URINE'], ['bilirubin', 'urine bilirubin', 'bile pigments'], null, null],
  ['U_URO', 'Urobilinogen', ['URINE'], ['urobilinogen'], null, null],
  ['U_NIT', 'Nitrite', ['URINE'], ['nitrite', 'nitrites'], null, null],
  ['U_LE', 'Leucocyte Esterase', ['URINE'], ['leucocyte esterase', 'leukocyte esterase'], null, null],
  ['U_BLOOD', 'Blood', ['URINE'], ['blood', 'occult blood'], null, null],
  ['U_PUS', 'Pus Cells', ['URINE'], ['pus cells', 'pus cell', 'wbc', 'leucocytes', 'leukocytes'], ['/hpf'], null],
  ['U_RBC', 'Urine RBC', ['URINE'], ['rbc', 'r b c', 'red blood cells', 'rbcs', 'erythrocytes'], ['/hpf'], null],
  ['U_EPI', 'Epithelial Cells', ['URINE'], ['epithelial cells', 'epithelial cell', 'squamous epithelial cells'], ['/hpf'], null],
  ['U_CAST', 'Casts', ['URINE'], ['casts', 'cast'], ['/lpf', '/hpf'], null],
  ['U_CRYS', 'Crystals', ['URINE'], ['crystals', 'crystal'], ['/hpf'], null],
  ['U_BACT', 'Bacteria', ['URINE'], ['bacteria'], ['/hpf'], null],
  ['U_YEAST', 'Yeast Cells', ['URINE'], ['yeast', 'yeast cells', 'budding yeast'], ['/hpf'], null],
];

// Plurals folded ("RBCs Count", "PLATELETS", "Counts" → rbc, platelet, count)
// on both the synonym and the printed name, so either spelling matches.
const singular = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
// Runs of single letters are joined, so dotted abbreviations match however
// they're spaced: "G.T." / "g t" → "gt", "R.B.C" → "rbc", "A / G" → "ag".
function joinLetters(toks) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].length === 1 && /[a-z]/.test(toks[i]) && toks[i + 1] && toks[i + 1].length === 1 && /[a-z]/.test(toks[i + 1])) {
      let run = toks[i];
      while (toks[i + 1] && toks[i + 1].length === 1 && /[a-z]/.test(toks[i + 1])) run += toks[++i];
      out.push(run);
    } else out.push(toks[i]);
  }
  return out;
}
const nameTokens = (s) => joinLetters(String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)).map(singular);
const normUnit = (s) => String(s || '').toLowerCase().replace(/[µμ]/g, 'u').replace(/\s+/g, '').replace(/\.+$/, '');

const PARAMS = P.map(([id, name, types, synonyms, units, plausible]) => ({
  id, name, types, units: units ? units.map(normUnit) : null, plausible,
  synonyms: synonyms.map((s) => ({ tokens: nameTokens(s), text: nameTokens(s).join(' ') })),
}));

// Best dictionary entry for a printed test name, or null. A synonym matches
// when ALL its words appear in the name, in any order ("Bilirubin - Direct"
// and "Direct Bilirubin" both match "bilirubin direct"); the longest match
// wins, boosted when the entry belongs to this section's report type and
// when the row's unit is one the entry expects.
//   exact:        synonym is the whole name
//   strong:       synonym covers ≥60% of the name's words
//   unitMismatch: the row has a unit the entry doesn't use (e.g. an
//                 "Neutrophils" row in 10^3/µL is not "Neutrophils %")
// Unit FAMILY, so a lab's own spelling of a unit ("milli./cu.mm",
// "Lakh/cu.mm.") still counts as compatible, while % vs an absolute count
// (Neutrophils % vs Neutrophils 10^3/µL) still doesn't.
function unitFamily(u) {
  if (!u) return '';
  if (u === '%' || u === 'ratio') return u;
  if (/cumm|cu\.?mm|\/ul$|\/mm3|10\^|x10|lakh|lac|thou|mill|mil\/|cells|\/l$|^\/|miu\/ul/.test(u)) return 'count';
  if (/^(fl)$/.test(u)) return 'fl';
  if (/^pg$/.test(u)) return 'pg';
  if (/u\/l|iu\/l|u\/ml|ku\/l/.test(u)) return 'enzyme';
  if (/iu\/ml|uiu|miu\/ml|miu\/l/.test(u)) return 'hormone';
  if (/mmol|umol|nmol|pmol|meq/.test(u)) return 'molar';
  if (/g\/dl|gm|g%|mg|ug|mcg|ng|pg\/ml|g\/l/.test(u)) return 'mass';
  if (/mm/.test(u)) return 'rate';
  if (/ml\/min/.test(u)) return 'gfr';
  if (/hpf|lpf/.test(u)) return 'field';
  return u;
}

const GENERIC_WORDS = new Set(['count', 'control', 'form', 'volume', 'fat', 'blood', 'reaction', 'consistency', 'cyst', 'parasite', 'motile', 'morphology', 'viscosity', 'protein', 'sugar', 'glucose', 'colour', 'color']);

function matchParam(testName, unit, typeId) {
  const nt = nameTokens(testName);
  if (!nt.length) return null;
  const set = new Set(nt);
  const joined = nt.join(' ');
  const u = normUnit(unit);
  const uf = unitFamily(u);
  let best = null;
  for (const p of PARAMS) {
    const families = p.units ? new Set(p.units.map(unitFamily)) : null;
    for (const syn of p.synonyms) {
      if (!syn.tokens.every((t) => set.has(t))) continue;
      // Very short or generic one-word synonyms ("to", "ct", "rh", "count",
      // "volume") only count on short names — otherwise "Mild To Moderate"
      // would become Widal "TO".
      // (…unless it's the name's first word: "ESR (Wintrobe's) mm First hour")
      if (syn.tokens.length === 1 && syn.text.length <= 3 && nt.length > 3 && nt[0] !== syn.text) continue;
      if (syn.tokens.length === 1 && GENERIC_WORDS.has(syn.text) && nt.length > 1 && !p.types.includes(typeId)) continue;
      const exact = syn.text === joined;
      const unitMismatch = !!(u && families && !p.units.includes(u) && !families.has(uf));
      const score = syn.text.length
        + (exact ? 50 : 0)
        + (p.types.includes(typeId) ? 40 : 0)
        + (unitMismatch ? -100 : u && p.units ? 30 : 0)
        // a result with a real unit is unlikely to be a words-only test
        + (u && !p.units && unitFamily(u) !== '%' ? -25 : 0);
      if (!best || score > best.score) {
        best = { param: p, score, exact, strong: syn.tokens.length / nt.length >= 0.6, unitMismatch, synTokens: syn.tokens };
      }
    }
  }
  return best;
}

module.exports = { PARAMS, matchParam, normUnit, nameTokens };
