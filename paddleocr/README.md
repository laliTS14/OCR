# PaddleOCR + Local LLM — DC Report Extraction POC

Third OCR proof-of-concept in this repo (alongside `../real/` and
`../azure-llm/`). Goal: match `../azure-llm/`'s 4-stage pipeline
(triage → read → categorize → validate) but with a **fully free, self-hosted**
OCR engine instead of a paid cloud API — chosen for a modest accuracy target
(~60-70%), not best-in-class results. See root `../../ocr.md` for how this
compares to the other two POCs.

## Why two processes

PaddleOCR/PaddlePaddle has no first-class Node.js bindings, so this demo
splits into:

- **`paddle_service.py`** — a small Python/Flask microservice that does the
  actual OCR (PaddleOCR + PP-Structure for table detection). Plays the exact
  same role as `../azure-llm/azure.js`, just over HTTP to a local process
  instead of Azure's REST API.
- **`server.js`** — the Node/Express pipeline (same shape as the other two
  POCs' `server.js`) that calls the Python service, then hands its output to
  the same local-LLM categorization (`ollama.js`) and deterministic
  validation (`validate.js`) used by `../azure-llm/`.

Both must be running at the same time for `/api/extract` to work end to end.

## Setup

**Python version matters:** `paddlepaddle` currently ships wheels for Python
3.9-3.13 only — no 3.14 build exists yet. If `python --version` on your
machine is 3.14+, install a 3.10-3.12 interpreter alongside it (e.g. `winget
install Python.Python.3.12` on Windows) and build the venv against that one
specifically, not whatever `python`/`python3` resolves to by default.

```bash
# 1. Python OCR service
cd OCR/paddleocr
py -3.12 -m venv .venv         # use your 3.9-3.13 interpreter here, not a 3.14+ one
.venv\Scripts\activate         # Windows; use `source .venv/bin/activate` on macOS/Linux
pip install -r requirements.txt
python paddle_service.py       # runs on http://localhost:8791 — leave this running

# 2. Node pipeline (separate terminal)
cd OCR/paddleocr
npm install
cp .env.example .env           # defaults already point at localhost:8791/11434, edit if needed
npm start                      # runs on http://localhost:8792
```

You'll also need [Ollama](https://ollama.com) installed and running with the
categorization model pulled once: `ollama pull llama3.2:3b`.

First run of `paddle_service.py` downloads PP-StructureV3's ~10 sub-models
(layout detection, text detection/recognition, table classification/
structure/cell-detection, formula recognition, doc-orientation — several
hundred MB total, cached under `~/.paddlex/official_models/` afterwards) —
expect the first request (or even just constructing `PPStructureV3(...)`) to
take a few minutes.

**A CPU/oneDNN crash you may hit, and the fix already applied here:** on at
least one tested Windows/CPU combination, paddlepaddle 3.3.1's default
oneDNN-accelerated execution path throws `NotImplementedError:
ConvertPirAttribute2RuntimeAttribute not support
[pir::ArrayAttribute<pir::DoubleAttribute>]` the moment `PPStructureV3`
actually runs inference (construction succeeds, `.predict()` fails). This is
a paddlepaddle/oneDNN compatibility bug, not an app bug — `paddle_service.py`
already works around it by setting `FLAGS_use_mkldnn=false` before importing
paddle and passing `enable_mkldnn=False` to `PPStructureV3(...)`. If a future
paddlepaddle release fixes this upstream, both can be removed; if you hit a
*different* crash, this is the first thing to suspect.

**A second, unresolved crash — large/complex images can kill the process
outright, likely from RAM pressure.** Tested against a real 5-page DC report
(`Suresh kumar sharma mergd-8-12.pdf`, a real diagnostic report with 4
digital lab-result pages and one scanned ECG page):

- Pages 1-4 (digital, text-based lab results — CBC, HbA1c, urine routine,
  ESR/cholesterol/SGPT/creatinine) worked as expected: the triage stage
  correctly found a real text layer and skipped OCR entirely, for free.
- Page 5 (a scanned ECG strip — a rotated, dense, ~2340×1650px waveform
  image with small printed lead labels and handwriting, no test/value/unit/
  range structure at all) **crashed the Python process outright** — no
  Python traceback, the connection just reset (`curl` exit 56 / connection
  refused on retry). Confirmed this is a resource issue, not a code bug:
  the test machine has only 7.7GB total RAM, and `PPStructureV3` loads ~10
  sub-models by default (including formula/chart/seal recognition a lab
  report never needs). `use_formula_recognition`/`use_chart_recognition`/
  `use_seal_recognition`/`use_region_detection` are now all disabled in
  `paddle_service.py` to cut that down — this did **not** fix the crash on
  this specific image, but is a real improvement regardless (fewer models
  loaded, lower baseline memory).
  - Downscaling the same image to ~900px avoided the crash, confirming
    image size/complexity (not just total model count) as the trigger —
    but at that resolution the small printed text became illegible and the
    OCR output was garbage (`"AW"`), so this isn't a usable workaround.
  - **Bottom line: full-resolution, large/complex/dense scanned images may
    crash this pipeline on a low-RAM machine.** If you hit this, check
    available RAM first (`Get-CimInstance Win32_OperatingSystem` on
    Windows) before assuming it's your input file or this code. More RAM,
    or running on a machine with more headroom, is the direct fix — no
    further PPStructureV3 flag exists (as tested) to avoid this at full
    resolution on this hardware.
  - Separately: an ECG waveform page isn't the kind of content this
    pipeline is meant to extract from at all (no test/value/unit/range
    table) — even without the crash, there'd be nothing meaningful for the
    categorization stage to structure from it.

## Usage

- **Web UI:** open `http://localhost:8792` and upload a PDF/JPG/PNG.
- **CLI:** `node test-extract.js "<path to a real report>" [--show-ocr]`

### Try it yourself, step by step

1. **Install Python 3.10-3.12** if `python --version` shows 3.14+ (see the
   Setup section above). On Windows: `winget install Python.Python.3.12`.
2. **Build the venv and install dependencies:**
   ```bash
   cd OCR/paddleocr
   py -3.12 -m venv .venv
   .venv\Scripts\activate          # Windows; `source .venv/bin/activate` on macOS/Linux
   pip install -r requirements.txt
   ```
3. **Start the Python OCR service** in its own terminal and leave it running:
   ```bash
   python paddle_service.py
   ```
   Watch its output — the first run downloads ~8 models (a few hundred MB
   total, cached afterwards) and can take a few minutes before you see
   `PaddleOCR microservice running at http://localhost:8791`.
4. **Install and start Ollama** (needed for the categorization stage —
   without it, the pipeline gets as far as OCR text/tables but errors out
   trying to categorize):
   ```bash
   ollama pull llama3.2:3b
   ollama serve       # usually starts automatically after install; leave it running
   ```
5. **Start the Node pipeline** in a third terminal:
   ```bash
   cd OCR/paddleocr
   npm install
   copy .env.example .env    # Windows; `cp` on macOS/Linux — defaults already point at the ports above
   npm start                 # http://localhost:8792
   ```
6. **Test it** either way:
   - **Browser:** open `http://localhost:8792`, upload a real DC report
     (PDF/JPG/PNG, up to 15MB), and step through the 4-stage viewer
     (Triage → Reading → Categorized → Validated).
   - **CLI**, if you'd rather see raw output in the terminal:
     ```bash
     node test-extract.js "C:\path\to\a\real\report.pdf" --show-ocr
     ```
     `--show-ocr` prints the raw OCR text/table dump (Stage 2) before the
     categorized/validated JSON — useful for judging accuracy at the
     reading stage independent of what the LLM does with it.
7. **A quick sanity check before trusting any result:** open the "Reading"
   stage panel (or `--show-ocr` output) and compare it against the actual
   report by eye. If the plain text/table dump is already garbled or
   missing rows at that stage, no amount of LLM categorization downstream
   will fix it — the fault is in the OCR step, not the model.

**If the Python service crashes on a specific file** (goes unresponsive,
connection refused on retry): check whether it's a large/complex/dense
scanned image on a low-RAM machine — see the crash write-up above. Try a
smaller or simpler test file first to confirm the rest of the pipeline
works, then treat that specific file's crash as a resource-limit finding to
report, not a bug to chase further on the same hardware.

## Files

| File | Role |
|---|---|
| `paddle_service.py` | Python/Flask microservice — PaddleOCR + PP-Structure reading (text + table extraction) |
| `requirements.txt` | Python dependencies for the service above |
| `paddle.js` | Node client for the Python service — same interface shape as `../azure-llm/azure.js` |
| `triage.js` | Digital-PDF-vs-scan check (copy of `../azure-llm/pdfText.js`) |
| `ollama.js` | Local LLM categorization call (copy of `../azure-llm/ollama.js`) |
| `validate.js` | Deterministic range/value validation (copy of `../azure-llm/validate.js`) |
| `server.js` | Express pipeline wiring the 4 stages together, `/api/extract` |
| `test-extract.js` | CLI equivalent of the web flow, for quick local testing |
| `public/index.html` | Same step-by-step stage viewer UI as the other two POCs |

`triage.js`/`ollama.js`/`validate.js` are deliberate copies, not shared
modules — each OCR POC folder in this repo is meant to be run and read
standalone.

## Known limitations (read before trusting a result)

- **Tested against one real DC report so far** (see the crash write-up
  above) — digital text-layer pages worked correctly (with the known
  column-jumbling caveat below); the one scanned page in that file crashed
  the service. No categorization/validation stage testing has been done at
  all yet — Ollama was not installed in the environment this was tested in,
  so only the triage+OCR half of the pipeline has been exercised against
  real content. Test against your own representative reports (and get
  Ollama running) before drawing any conclusion about whether this hits the
  ~60-70% bar end-to-end.
- **Digital PDFs with multi-column report layouts extract in a jumbled
  order.** On the real report tested, a page's reference-range, result, and
  test-name text came out interleaved (e.g. `"11.5 - 17.5 g/dL"` /
  `"14.3 g/dL"` / `"Haemoglobin"` as three separate lines, not one row) —
  this is the direct-text-layer path's documented trade-off (see `triage.js`
  and `../azure-llm/pdfText.js`) actually manifesting on real content. The
  categorization LLM stage is what's supposed to untangle this back into
  clean rows — untested here since Ollama wasn't available.
- **Large/complex scanned images can crash the process on a low-RAM
  machine** — see the dedicated write-up above. Not just a theoretical
  concern; this is exactly what happened on a real ECG page in testing.
- **Table detection needs visible border lines, at least based on the
  synthetic tests run so far.** A table drawn *with* ruled borders was
  correctly detected as a table region (`table_res_list` populated, correct
  `pred_html`); the same content *without* borders was classified as plain
  text instead, and its cells came back as flattened lines in `fullText`
  rather than a structured table. Most printed lab reports do have ruled
  table borders, but this is worth specifically checking against your real
  reports — a borderless/pseudo-table layout may silently lose its
  row/column structure.
- PP-Structure's table-to-HTML conversion, then HTML-to-grid parsing here,
  is a reasonable general approach but hasn't been validated against more
  complex layouts (multi-header tables, merged cells, etc. — those can
  still produce jumbled grids).
- No GPU-specific setup here — `pip install paddlepaddle` installs the
  CPU-only build. CPU inference is noticeably slower per page than the Azure
  API call in `../azure-llm/`; that's part of the free-vs-cost trade-off.
- Same modest-accuracy caveat applies to the Ollama categorization step as
  in `../azure-llm/` — it's a small (~3B parameter) model, not a frontier one.
