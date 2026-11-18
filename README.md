# OCR — DC Report Extraction POCs

> Reference doc for what's in this folder and how each approach works.
> For the running history of what's been tried, found, and what's next,
> see `PROGRESS.md` — read that first if you're picking this up fresh.

## What this is

Standalone proof-of-concept area, independent of the main TPA PIMS
backend/frontend — not wired into either. Eight demos exploring how to
turn a DC-uploaded diagnostic report (PDF or scanned image) into
structured data: patient details + one or more reports, each with
test/value/unit/range rows. Six compare LLM-based reading/structuring
approaches — see `OCR_for_DC_Report_Extraction.pptx` for the
pitch/rationale. `regex-based/` is a deliberate outlier: no LLM call
anywhere, a direct speed/accuracy comparison against the Ollama-based
approach. `hybrid-ocr/` combines the two: the fast regex path first,
falling back to the LLM path only when a confidence check says the regex
result isn't trustworthy (see both demos' own sections below).

This folder is its own git repo (separate from the parent `alphonsol-PIMS`
repo it lives inside) — see `PROGRESS.md` for details on that split and
why it matters if you're editing files here.

None of the eight demos share an npm workspace/root — each is its own
`package.json`, run and `npm install`ed independently.

## `real/` — single-call Gemini approach

- **Stack:** Express (`server.js`, port `8787` default) + `multer`
  (in-memory upload, 15MB max, `application/pdf`/`image/jpeg`/`image/png`
  only) + a single shared module `extractor.js`.
- **How it works:** the raw file (PDF or image) is sent directly to
  Google's Gemini (`gemini-3.6-flash` default, via
  `GEMINI_API_KEY`/`GEMINI_MODEL` in `real/.env`) as inline base64
  data with `responseMimeType: 'application/json'` and a fixed
  `responseSchema` — one model call does reading (OCR) and structuring
  together. Retries on `429`/`503`/network errors, up to 6 attempts.
  When Google's error response includes a `RetryInfo.retryDelay` (as
  quota-exceeded `429`s do), that exact delay is honored instead of
  guessing — blindly retrying a quota error on a fixed schedule just
  burns more of the same limited request budget. Falls back to
  exponential backoff (1s, 2s, 4s, 8s, 16s, capped at 16s) when Google
  doesn't supply a delay, e.g. a plain `503` overload.
- **Output schema:** `{ patient: { name, age, sex, patient_id,
  contact_number }, reports: [{ report_type, lab_name,
  referring_doctor, sample_collected_date, report_date, rows: [{ test,
  value, unit, range }] } ] }`. Splits multiple bundled reports (e.g. CBC
  + Lipid Profile in one PDF) into separate entries. Missing fields come
  back as empty strings, never guessed.
- **`test-extract.js`** — CLI script hitting the same `extractor.js`
  logic directly against a local file, so the web path and the CLI test
  never drift apart.
- **No validation step** — `server.js` returns Gemini's structured
  output as-is (`data`), unlike `azure-llm` below.
- **Cost:** per-call Gemini API fee. Not free.

### Running this locally

```bash
cd real
npm install
copy .env.example .env   # then add your GEMINI_API_KEY
npm start                # http://localhost:8787
node test-extract.js "<path to a report>"   # CLI test, same extractor.js logic
```

Needs `GEMINI_API_KEY` (get one free at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey)) and
optionally `GEMINI_MODEL` (default `gemini-3.6-flash`) in `real/.env`.

## `sarvam/` — single-call Sarvam AI Document AI (Extract) approach

Architecturally the same shape as `real/` (Gemini) — one call does OCR +
structuring together — but against an Indian vendor's API instead of
Google's. Added to directly compare against `real/` after confirming
Sarvam's **Extract** endpoint (distinct from their **Digitise**
endpoint, which is OCR-only and closer to Azure's role below) takes a
document plus a JSON Schema and returns structured fields in one flow,
the same way Gemini's `responseSchema` does.

**Supports two document types, selectable per upload** — a radio button
in the UI, a `mode` form field for the API, or a second CLI arg
(`node test-extract.js <file> mer`):
- **`lab`** (default) — diagnostic/pathology reports, the same
  `patient`/`reports[]`/`rows[]` contract as the other three demos.
  **First real run succeeded** — all 9 of 9 report panels captured on
  the same document `paddleocr/` has only ever gotten 4-5 of 9 panels
  on, no malformed values, no fabricated fields.
- **`mer`** — Medical Examination Report questionnaires (insurance
  underwriting forms: Yes/No and numeric/free-text answers to
  standardized questions), a `patient`/`qa_pairs[]` contract instead.
  **First two real runs succeeded** on a genuinely scanned PDF (no text
  layer — the first real test of Sarvam's OCR-from-image path in this
  project) — 66 then 56 question/answer pairs across two runs (see
  `PROGRESS.md` for why the count moved).

One or two runs per mode only so far — see `PROGRESS.md` ("two confirmed
working modes") before treating either as confirmed accurate.

- **Stack:** Express (`server.js`, port `8790` default) + `multer` (same
  15MB/PDF+JPEG+PNG limits as `real/`/`azure-llm/`) + a single shared
  module `extractor.js`.
- **How it works:** unlike Gemini's single synchronous call, Sarvam's
  Extract API is an **async job**: `POST /doc-ai/v1/job/extract` (file +
  JSON Schema + language + output format, multipart) returns a `job_id`;
  poll `GET /doc-ai/v1/job/{job_id}/status` until `completed` (or
  `failed`/`rejected`); fetch `GET /doc-ai/v1/job/{job_id}/results` for
  the structured JSON. Auth via an `api-subscription-key` header, base
  URL `https://api.sarvam.ai`. Sarvam caps every job at **10 pages**.
- **Output schema:** same shared contract as the other three demos
  (`patient` + `reports[]` with `rows[]`) — but Sarvam's API can't
  accept that nested shape directly. **Confirmed:** their stated max
  schema nesting depth of 4 levels is real and the natural `reports[]` →
  `rows[]` nesting exceeds it (`reports.items.rows.items` = 5). Fixed by
  sending Sarvam a flattened schema instead (a single `rows[]` array
  where every row repeats its own report-level fields) and re-grouping
  the response back into the nested shape client-side —
  `groupRowsIntoReports()` in `sarvam/extractor.js`. Confirmed working
  correctly on one real run (grouped into exactly 9 report objects,
  matching the 9 real panels), but its core assumption (Sarvam repeats
  report-level fields identically per row) isn't stress-tested yet.
- **`test-extract.js`** — CLI script hitting the same `extractor.js`
  logic directly against a local file, same pattern as `real/`'s. No
  timeout on the poll loop — jobs have taken 200s+ just sitting in
  `pending` before starting; it polls indefinitely with a heartbeat log
  instead of guessing a ceiling.
- **No validation step**, same as `real/` — trusts Sarvam's structured
  output as-is. Unlike Gemini, Sarvam's Extract response includes a
  **per-field confidence score** (not yet surfaced in this POC's output
  normalization — `extractor.js` currently only returns `patient` +
  `reports`), which could feed a validation step later.
- **Cost:** ₹0.50/page flat (same rate as the Digitise endpoint), no
  scheduled price increase, vs. Gemini's ~₹0.20-0.48/page today which
  doubles Jan 2027. ₹100 free credits on signup. See
  `ocr_cost_accuracy_comparison.xlsx` in this folder for the full
  cost/accuracy/difficulty comparison across every approach.

### Running this locally

```bash
cd sarvam
npm install
copy .env.example .env       # then add your SARVAM_API_KEY
npm start                        # http://localhost:8790 — pick lab/MER mode in the UI
node test-extract.js "<path>"        # CLI test, lab mode (default)
node test-extract.js "<path>" mer    # CLI test, MER questionnaire mode
```

Needs `SARVAM_API_KEY` (get one at
[dashboard.sarvam.ai](https://dashboard.sarvam.ai)) and optionally
`SARVAM_BASE_URL`/`SARVAM_LANGUAGE` in `sarvam/.env`.

## `paddleocr/` — the default pipeline: per-page reading, RapidOCR/PaddleOCR text OCR, rules-based categorization (Sept 30 – Oct 1, 2026)

**This is now the main demo.** Rebuilt as a copy of `unlimited-ocr/`'s full
pipeline (see that section's "Whole-report flow" and "Rules-based row
parser" for how each stage works) with a light PP-OCR text engine for
scanned pages. **Default engine: RapidOCR** (PP-OCR models on ONNX Runtime,
~6.6 s/page on this CPU); PaddleOCR (~24-30 s/page here) remains selectable.
Both gave the same results as Unlimited-OCR (~3.5 min/page) on the 15
scanned pages compared (`PROGRESS.md` "Faster OCR on CPU", "PaddleOCR vs
Unlimited-OCR"). The previous PP-Structure + full-document LLM version of
this folder is kept in `paddleocr/legacy/` for reference.

Pipeline: per-page reading (`pageReader.js`: text layer where usable, OCR
only for the pages without one, cached per engine in `ocr-cache/<engine>/`) → page
classification (`pageClassifier.js`: only lab pages parsed) → whole-document
rules parser (`documentParser.js` + `rowParser.js` + `labVocabulary.js` +
`paramDictionary.js` + `headerParser.js` + `reportCatalog.js`) → source check
→ validate. The LLM (`ollama.js`) is only a per-section fallback.

- **OCR service:** `paddle_text_service.py` (Flask, port **8794**), engine
  chosen with `OCR_ENGINE`:
  - `rapid` (**default**) — RapidOCR (`rapidocr-onnxruntime`): PP-OCRv4
    mobile detection (bundled) + **English PP-OCRv3 recognition**
    `onnx-models/en_PP-OCRv3_rec_infer.onnx` (8.97 MB, from
    `huggingface.co/SWHL/RapidOCR` → `PP-OCRv3/`; gitignored, download it
    once). The default Chinese rec model drops spaces between English words,
    so the English model is required. Runs in **`.venv-rapid`**.
  - `paddle` — PaddleOCR PP-OCRv5 mobile det + English rec, oneDNN off (it
    crashes on this machine). Runs in **`.venv`**.
  Both are text only (no layout/table models). The service corrects page
  skew from the text boxes' own angle, then rebuilds reading-order lines,
  turning wide column gaps into tabs, so an OCR'd page looks like a PDF text
  layer. Node client: `ocrClient.js` (one client for every engine's
  service — same `/ocr` contract; same functions as
  `unlimited-ocr/unlimitedocr.js`); set the same `OCR_ENGINE` for the Node
  app so it uses that engine's cache folder.
- **OCR engines + double OCR (Oct 22, 2026):** `ocrEngines.js` holds the
  engine flags — `OCR_PRIMARY_ENGINE` (`paddle` default / `tesseract` /
  `gemini`), `OCR_ENGINE_{PADDLE,TESSERACT,GEMINI}_ENABLED` (Gemini is a
  reserved slot, not built) and `OCR_DOUBLE_ENABLED`. A report is
  **double-OCR'd** only when that master switch is on **and** the report asks
  for it (`tbl_ocr_report_details.double_ocr = 1`, `--double`, or the
  "Double OCR" checkbox): its scanned pages are also read by **Tesseract**
  (`../tesseract-ocr/tesseract_text_service.py`, port 8799), **for
  comparison only** — RapidOCR's result is still the one saved to
  `tbl_ocr_data`; Tesseract's own result goes to `tbl_ocr_tesseract_report`
  / `tbl_ocr_data_tesseract` (`api/Ocr/SaveTesseractResult`), never merged;
  a Tesseract failure never fails the report (`doubleOcr.js`). Every row
  carries `ocr_engine` (engine or `TEXT_LAYER`) and `ocr_confidence` (the
  parser's own). Details: `../tesseract-ocr/README.md`.
- **Shared code:** the parser/dictionary/catalog/classifier files are copies
  of `unlimited-ocr/`'s — keep the two copies identical when changing either
  (the only intended differences are `ocrClient.js`/`ocrEngines.js`,
  `pageReader.js`'s reading client, `server.js` strings/port, `ollama.js`
  always using the plain-text prompt, and `test-extract.js`). Every `.js`
  file and `public/` is also copied, identically, into `../tesseract-ocr/`.
- **Human review (`reviewStore.js`, `gold-eval.js`):** below the results on
  `/select.html`, a "Review & correct" table lets a reviewer fix any test /
  value / unit / range / report type, delete junk rows, add missed tests and
  fix patient fields (DC name required). `POST /api/review` saves the answer
  with a per-row diff (ok / edited / retyped / deleted / added) next to what
  the pipeline produced; `GET /api/review-stats` gives totals. Ticking
  **Fully checked** also stores the report (with its document text) as an
  answer key. Everything goes to `review-data/` (gitignored — patient data):
  `extractions/`, `corrections/`, `gold/` (keyed by file hash).
  `node gold-eval.js [--verbose] [--save | --compare]` re-parses every
  answer key with the current code (no PDF/OCR, milliseconds) and reports
  tests found, junk rows, and value / unit / range / report-type / patient
  accuracy; `--compare` exits 1 if any metric dropped vs the saved baseline.
- **Also still here:** `paddle_service.py` (PP-Structure, port 8791) — not
  used by the new pipeline.

### Running this locally

```bash
# 1. OCR service — default engine RapidOCR (separate venv; Python 3.12)
cd paddleocr
py -3.12 -m venv .venv-rapid
.venv-rapid\Scripts\pip install rapidocr-onnxruntime flask
#   + download onnx-models/en_PP-OCRv3_rec_infer.onnx (see "OCR service" above)
set PYTHONIOENCODING=utf-8 & set PYTHONUTF8=1   # Windows console encoding
.venv-rapid\Scripts\python paddle_text_service.py   # http://localhost:8794 — leave running
#   PaddleOCR instead: set OCR_ENGINE=paddle & .venv\Scripts\python paddle_text_service.py

# 2. Node app (separate terminal)
cd paddleocr
npm install
npm start                       # http://localhost:8792 → open /select.html
node test-extract.js "<file>"   # CLI: pages, patient, every test, validation
node test-extract.js "<file>" --double   # + Tesseract's own result, printed separately (OCR_DOUBLE_ENABLED=true)
node batch-eval.js "<folder>" --ocr   # whole folder, OCR only where needed (--engine tesseract to compare)
node gold-eval.js --compare     # accuracy vs the human answer key (review-data/gold/)
node page-eval.js --verbose     # page classification vs review-data/page-key.json
```
Ollama is only needed for the optional LLM fallback (`engine=auto` when a
section can't be parsed, or `engine=llm`).

**Shared pipeline:** `pipeline.js` (`extractDocument()`: read → rules parse
→ LLM fallback → source check → validate) is used by both `server.js`'s
`/api/extract-selected` and `worker.js`, so both produce identical output.
Each output report also carries `type_id`, `page_numbers` and `method`
(`rules` / `llm` / `llm-fallback`), and every row carries `range_min` /
`range_max` — the printed reference range split in two by `validate.js`,
each number kept exactly as printed (`"0.10"`, a string; sex-specific
ranges use `patient.sex`; interpretation tables use the
normal/sufficient/adult segment; `null` = open end or not parseable).
The worker stores them in `tbl_ocr_data.min_range` / `max_range` (text).
`tbl_ocr_data` keeps `value` as printed only — no numeric copy, flag,
confidence or row sequence (the high/low `validation` stays in the
pipeline output / `result_json`).

### OCR worker (`worker.js`) — PIMS integration, through the OCR API

Processes the PIMS OCR queue **through the OCR insertion API**
(`backend/Health_360_OCR` in the parent repo — ASP.NET, same layered
architecture as the PIMS backend; plain JSON + an `X-Api-Key` header;
client: `ocrApiClient.js`).
The worker never connects to the DB. Report-upload QC
(`sp_update_qc_remark`, status 22) queues each case's pathology files
(`tbl_report_upload_document.Group_test_type_id = 3`) into
`tbl_ocr_case_list` / `tbl_ocr_report_details`; the worker claims one
report at a time (`api/Ocr/ClaimReport`),
downloads it, runs `extractDocument()` on everything (`typeIds ['ALL']`),
and saves the result (`api/Ocr/SaveOcrResult` → `tbl_ocr_data`, one row per
test, mapped to PIMS tests) or records the failure
(`api/Ocr/MarkReportFailed`, 3 attempts). Tables/SPs live in the parent
repo: `database/tables/ocr_extraction_tables.sql`,
`database/tables/ocr_test_mapping.sql`, `database/tables/ocr_job_log.sql`,
`database/stored_procedures/ocr_extraction_sps.sql`,
`database/stored_procedures/ocr_sp_update_qc_remark.sql`,
`database/stored_procedures/ocr_queue_job.sql` (see the parent
`database.md` / `backend.md`).

**Who fills the queue: the database, not the worker.** Report QC queues
files the moment it passes; the MySQL event `ev_queue_ocr_reports` (every
10 min, `sp_job_queue_ocr_reports`) re-queues reports stuck in PROCESSING
> 30 min and queues QC-passed pathology files that are not queued yet
(cases from before OCR existed, anything QC missed) — at most 200 per run,
oldest first — and logs each run in `tbl_ocr_job_log`
(`SELECT * FROM tbl_ocr_job_log ORDER BY ocr_job_log_id DESC LIMIT 20;`).
The worker only consumes the queue.

```bash
cd paddleocr
npm install
node worker.js --file "<pdf>"      # dry run: what would be saved — no API / DB at all
node worker.js --file "<pdf>" --case <case_id>
                                   # TEST: queue a local file for that case (as if uploaded +
                                   # report QC passed) and save it now (api/Ocr/QueueManualReport) —
                                   # the case needs a tbl_digi_master row; rows are tagged
                                   # file_path 'manual-upload/…' and get one attempt only
npm run worker                     # run continuously (Ctrl+C finishes the current report)
node worker.js --once              # process at most one queued report
```

Needs the OCR API running (`dotnet run --project OCR_API/OCR_API.csproj` in
`backend/Health_360_OCR`) and `paddle_text_service.py` for scanned pages.
`.env` keys: `OCR_API_URL` (dev `https://localhost:7196`),
`OCR_API_KEY` (must equal `OcrApi:ApiKey` in the API's
`appsettings.json`), `OCR_API_INSECURE_TLS=1` (accept the dev self-signed certificate),
`REPORT_UPLOAD_BASE_URL` (backend `paths:ReportUploadDocBaseUrl`) or
`REPORT_UPLOAD_BASE_FOLDER` (read from disk on the file server),
`OCR_WORKER_ENGINE` (`rules` default / `auto` / `llm`),
`OCR_WORKER_CONCURRENCY` (default 1),
`OCR_WORKER_POLL_MS` (5000),
`PIPELINE_VERSION` (default `<engine>-<git short hash>`).

**Running on a server** (`paddleocr/deploy/`, Windows, no extra tools) —
step-by-step guide from a bare server: `paddleocr/deploy/SERVER_SETUP.md`:

```powershell
# elevated PowerShell, after: .venv-rapid set up, npm install, .env pointing at the
# installed OCR API (backend/Health_360_OCR/deploy/install-service.ps1 → OCR_API_URL=http://localhost:5235)
.\deploy\install-tasks.ps1          # register + start all
.\deploy\uninstall-tasks.ps1
Get-ScheduledTask -TaskName 'Health360 OCR*' | Select TaskName, State
```

`install-tasks.ps1` registers Task Scheduler tasks that start at boot as
SYSTEM: **Health360 OCR Text Service** (`deploy\run-ocr-service.cmd` →
`paddle_text_service.py`), **Health360 OCR Tesseract Service**
(`deploy\run-tesseract-service.cmd` → `../tesseract-ocr/tesseract_text_service.py`,
port 8799, for double OCR — registered only if `../tesseract-ocr/.venv`
exists; Tesseract itself must be installed) and **Health360 OCR Worker**
(`deploy\run-worker.cmd` → `worker.js`, 1 min after boot). Each `.cmd`
restarts its process 10 s after it exits or crashes; logs go to
`paddleocr/logs/service/` (`ocr-service.log`, `tesseract-service.log`,
`worker.log`, appended — no rotation). Double OCR also needs
`OCR_DOUBLE_ENABLED=true` in `.env` and, on UAT, the parent repo's
`database/stored_procedures/ocr_double_ocr_uat_rollout.sql` (see
`PROGRESS.md` "UAT go-live"). The `.ps1` / `.cmd` files are kept pure ASCII: Windows
PowerShell 5.1 reads BOM-less scripts as ANSI, and an em dash once broke
the parse.

Accepted files: any PDF or image (JPEG, PNG, WEBP, TIFF, BMP, GIF —
first frame only for multi-page TIFF / GIF). The type is taken from the
downloaded bytes, never the extension (DCs upload JPEG photos named
`.png`); anything that is neither fails — the report-upload site returns
HTTP 200 with its `index.html` for a missing file, reported as "File not
found".

The file name passed to the pipeline is prefixed with the file's sha256,
because the per-page OCR cache is keyed by file name and DC uploads often
share names.

### Previous version (now in `paddleocr/legacy/`)

The original PaddleOCR demo, kept for reference:

- **Two processes, not one:** PaddleOCR/PaddlePaddle has no first-class
  Node bindings, so the OCR stage is a separate Python/Flask microservice
  (`paddle_service.py`, port `8791` default) using **`PPStructureV3`** —
  table detection and general text OCR in one pass. PDFs are rasterized
  page-by-page via PyMuPDF at ~200 DPI, since PP-Structure only accepts
  images. The Node app (`server.js`, port `8792` default) calls this
  service over plain HTTP via `paddle.js` (mirrors `azure.js`'s interface
  exactly). Both processes must be running for `/api/extract` to work —
  see "Running this locally" below.
- **4 stages:** Triage (`triage.js`, digital-PDF-vs-scan check, copy of
  `azure-llm/pdfText.js`) → Reading (direct text-layer pull for digital
  PDFs, else PaddleOCR) → Categorization (`ollama.js`, a local LLM via
  Ollama) → Validation (`validate.js`, deterministic code, not AI).
- **Cost trade-off, by design:** no Azure/Gemini API bill, but CPU-only
  PaddleOCR/Ollama inference is slower per page, and accuracy on messy
  scans, regional-language text, or unusual layouts is expected to be
  weaker than Azure Document Intelligence's out-of-the-box robustness —
  acceptable here because the accuracy target is intentionally modest,
  not best-in-class. See `PROGRESS.md` for how this has actually played
  out against real reports.

Running the legacy version (from before the Sept 30 rebuild):

```bash
# 1. Python OCR service
cd paddleocr
py -3.12 -m venv .venv         # paddlepaddle needs Python 3.9-3.13, not 3.14+
.venv\Scripts\activate          # Windows; `source .venv/bin/activate` on macOS/Linux
pip install -r requirements.txt
python paddle_service.py        # http://localhost:8791 — leave running

# 2. Node pipeline (separate terminal)
cd paddleocr
npm install
copy .env.example .env          # defaults point at localhost:8791/11434
npm run dev                     # http://localhost:8792, auto-restarts on file changes
```

You'll also need [Ollama](https://ollama.com) installed and running with
a categorization model pulled: `ollama pull llama3.2:3b`. Full setup
detail, environment gotchas (Python version pinning, an oneDNN CPU crash
workaround, a RAM-pressure crash on large scanned images), and known
limitations are in `paddleocr/README.md` — read that before assuming a
result is trustworthy.

## `tesseract-ocr/` — the paddleocr pipeline on Tesseract; second engine for double OCR (Oct 22, 2026)

Same code as `paddleocr/` (every `.js` file and `public/` copied, kept
identical) with **Tesseract 5** reading the scanned pages:
`tesseract_text_service.py` (Flask, port **8799**, same `/ocr` contract as
`paddle_text_service.py`; psm 6, pages scaled to ~300 dpi, wide gaps → tabs).
Standalone demo on port 8800 (`OCR_PRIMARY_ENGINE` defaults to `tesseract`
in this folder), and the service `paddleocr/worker.js` calls as the second
engine when a report is double-OCR'd. Needs the Tesseract program (UB
Mannheim Windows build). Full details, flags and how double OCR is stored:
`tesseract-ocr/README.md`.

## `azure-llm/` — 4-stage pipeline (Azure OCR + local LLM)

- **Stack:** Express (`server.js`, port `8788` default) + `multer` (same
  15MB/PDF+JPEG+PNG limits, explicitly kept equal to the Gemini POC "for
  a fair comparison"). Four modules, one per pipeline stage:

  1. **Triage** (`pdfText.js`) — for PDFs only, checks whether the file
     already has an embedded text layer (`pdf-parse`, ≥200 non-whitespace
     chars = "digital") vs. is a scan with no real text. A digital PDF's
     text is pulled directly — free, instant, no OCR call at all. Images
     always go to OCR. Known trade-off: direct text extraction does
     **not** reconstruct table structure, so rows/columns can come out
     jumbled — messier input for the LLM stage than Azure's table-aware
     path would give.
  2. **OCR** (`azure.js`) — for anything not "digital": Azure Document
     Intelligence's `prebuilt-layout` model (`AZURE_DOCINTEL_ENDPOINT`/
     `AZURE_DOCINTEL_KEY` in `azure-llm/.env`), submit-then-poll async
     API (~1.2s interval, ~48s cap), retries `429`/`503`. Returns plain
     text plus tables reconstructed as 2D arrays from cell
     rowIndex/columnIndex data. Deliberately has *zero* understanding of
     meaning — purely "what's on the page."
  3. **Categorization** (`ollama.js`) — a small **locally self-hosted**
     LLM via Ollama (`llama3.2:3b` default, `OLLAMA_URL`/`OLLAMA_MODEL`),
     schema-constrained JSON output (`format` param), same
     patient/reports/rows schema as the Gemini POC. Only reasons over the
     already-extracted plain text/table dump — never re-reads the
     image/PDF itself.
  4. **Validation** (`validate.js`) — deterministic code, not AI. Parses
     each row's numeric value and reference range (handles messy
     real-world formats: `"12 - 15"`, `"Up to 40"`, `"> 40"`, `"Adults: 44
     - 147"`) and flags `normal`/`high`/`low`/`unchecked` (non-numeric or
     unparseable range — routed to a human either way, not treated as an
     error). Runs after categorization as a cheap first-pass filter
     before any human review.

- **Response shape:** `server.js` returns every stage's real
  intermediate output (`stages: { triage, ocr, categorized, validated }`)
  alongside the final `data` — built so the UI can show what actually
  happened at each step rather than a simulated version of it.
- **`test-extract.js`** — CLI equivalent, same pattern as `real/`'s.
- **Cost:** per-page Azure Document Intelligence fee (free tier: ~500
  pages/month) + your own hosting for Ollama.

### Running this locally

```bash
cd azure-llm
npm install
copy .env.example .env   # then add your Azure Document Intelligence keys
npm start                 # http://localhost:8788
node test-extract.js "<path to a report>"
```

Needs `AZURE_DOCINTEL_ENDPOINT`/`AZURE_DOCINTEL_KEY` (create a free
Document Intelligence resource at [portal.azure.com](https://portal.azure.com),
F0 tier gives ~500 pages/month) and `OLLAMA_URL`/`OLLAMA_MODEL` (default
`llama3.2:3b`) in `azure-llm/.env`. Requires
[Ollama](https://ollama.com) installed and running, with the
categorization model pulled: `ollama pull llama3.2:3b`.

## `deepseek-ocr/` — 4-stage pipeline (self-hosted DeepSeek-OCR + local LLM)

Structurally a fork of `paddleocr/` — same triage/categorize/validate
code, same output contract — with the OCR stage swapped from PaddleOCR
(a separate Python microservice) to **DeepSeek-OCR**, a vision-language
OCR model that runs entirely through the same Ollama instance the
categorization step already uses. **No Python process at all** — PDF
pages are rasterized to PNG in pure Node via `pdf-parse`'s bundled
`getScreenshot()` (its own pdf.js + native canvas, no poppler/
ImageMagick needed).

**Built, runs end-to-end — the open problem is reading-stage reliability,
not categorization. See `PROGRESS.md` ("`deepseek-ocr/` demo" and its
follow-up) for the full test data before relying on this:**
- **Confirmed across 3 real attempts, identical image, identical code:
  DeepSeek-OCR gave 3 different results.** Run 1: clean and correct
  (every test value right, including independently reproducing Sarvam's
  exact `"lacks/cumm"` misreading of this document). Run 2: fell into a
  repetition loop, re-printing the same block ~20 times and corrupting
  the downstream categorization. Run 3 (after strengthening
  `repeat_penalty`/`repeat_last_n`): no loop this time, but a
  *differently* garbled reading — test names run together with no
  values between them, words in the interpretation paragraph missing
  their spaces, values attached to the wrong tests.
- `options.repeat_penalty`/`repeat_last_n` in `deepseek.js` reduce the
  repetition-loop's likelihood — they do **not** reliably eliminate it,
  contrary to what an earlier version of this section claimed after only
  one successful retry. A deterministic `dedupeRepeatedBlocks()` safety
  net was added as a second line of defense (verified directly against
  the real captured loop: collapsed 21 repeated sections down to 2).
- The categorization prompt (`ollama.js`) has been rewritten specifically
  for DeepSeek-OCR's bullet/short-block output shape (units and ranges
  frequently detached from their test, administrative labels that aren't
  tests, repeated blocks flagged as an OCR glitch) — a real improvement
  to the reading-to-categorization handoff, confirmed via code review and
  unit-testing the dedup logic, but it **cannot fix a reading-stage
  result that's simply wrong**, which run 3 above still was.
- Slow: ~50-155s/page for reading depending on the run (plus a one-time
  ~275s cold start per unique image), and categorization time varies a
  lot (108s-240s across runs) depending on how messy that run's reading
  output was.

- **Stack:** Express (`server.js`, port `8793` default) + `multer` (same
  15MB/PDF+JPEG+PNG limits as the other demos) + `deepseek.js` (reading +
  a deterministic repeated-block dedup pass) + `ollama.js` (categorization,
  rewritten for this reading stage's actual output shape) + `validate.js`
  (copied unchanged).
- **`test-extract.js`** — CLI script, same pattern as `paddleocr/`'s.
- **Cost:** $0 API cost — just your own compute (CPU/GPU), same as
  `paddleocr/`.

### Running this locally

```bash
cd deepseek-ocr
npm install
copy .env.example .env   # defaults point at localhost:11434
npm start                 # http://localhost:8793
node test-extract.js "<path to a report>"
```

Needs [Ollama](https://ollama.com) installed and running, with **both**
models pulled: `ollama pull llama3.2:3b` (categorization) and
`ollama pull deepseek-ocr` (reading). No separate Python process —
everything goes through the one Ollama instance. Optional env vars:
`DEEPSEEK_OCR_MODEL`, `CATEGORIZE_MODEL`, `PAGE_RENDER_WIDTH`.

## `unlimited-ocr/` — 4-stage pipeline (self-hosted Unlimited-OCR, forced CPU + local LLM), plus a selective per-report categorization flow

Structurally a fork of `paddleocr/` — same triage/categorize/validate
shape — with the OCR stage swapped to **Baidu's Unlimited-OCR**, a
document-parsing vision-language model. Unlike `deepseek-ocr/`, this one
isn't Ollama-servable (it's a plain Hugging Face Transformers model), so
it needs its own Python microservice (`unlimited_ocr_service.py`,
mirroring `paddle_service.py`'s role exactly, just a different backend)
— **two processes, same as `paddleocr/`**.

**Important context this whole demo only exists under:** Unlimited-OCR
is officially **CUDA-only** — the model's own README example does
`model.eval().cuda()`, and this project's machine has **no NVIDIA GPU at
all** (confirmed via `Get-CimInstance Win32_VideoController` — Intel
Iris Xe integrated graphics only). This demo was built anyway at the
user's explicit request, accepting the risk of wasted effort. Getting it
running on CPU took two real fixes, both documented in
`unlimited_ocr_service.py`'s file header and `PROGRESS.md`:
1. `model/modeling_unlimitedocr.py` hardcodes 14 `.cuda()` calls in its
   `infer()` method — patched to `.to(self.device)`
   (`model/modeling_unlimitedocr.py.orig` keeps the untouched original;
   re-downloading the model from Hugging Face will restore the broken
   version, re-apply the same patch if that happens).
2. `transformers` must be pinned to exactly `4.57.1` — a newer version
   (confirmed broken: `5.17.0`) removed `is_torch_fx_available`, which
   the model's own code imports at load time.

**Confirmed via two real runs against the same page — best raw reading
quality of any free approach in this project, but a real, unfixed
categorization gap:**
- **Reading (Unlimited-OCR itself): excellent and consistent both
  times.** Real document layout analysis, not just OCR — headers,
  tables, text blocks, and footers all correctly segmented. The main
  test-panel table came back as genuine, correctly-labeled HTML
  `<table>` markup with all 24/24 test/value pairs right both runs,
  including a test ("Absolute Lymphocyte Count") every other approach in
  this project has dropped or merged into an adjacent row. Saves a clean
  `result.md` automatically. Cost: ~2-3s one-time model load (once, at
  the microservice's startup) + ~260-268s (~4.5 min) per page — slow,
  but the quality was worth it both times.
- **Categorization (`llama3.2:3b`) has a specific, real gap the prompt
  did not fix.** Units and reference ranges come back as a *separate*
  HTML table from the main test table, in matching row order — the
  prompt explicitly instructs the categorizer to match them by row
  position, but on the second real run it did not populate a single
  unit or range across 24 rows, and separately fabricated an empty
  `"BIOCHEMISTRY"` report section not present in the page's actual
  content. **Positionally zipping two separate tables from a text
  prompt is too hard a task for a 3B model to reliably execute**, even
  with explicit instructions — a different category of problem than
  `deepseek-ocr/`'s earlier gap (which a better-described prompt did
  fix). The more promising fix, not yet implemented: parse both HTML
  tables and zip them **deterministically in code** before the
  categorizer ever sees the text, the same way
  `paddleocr/paddle_service.py`'s `html_table_to_grid()` already
  deterministically turns PP-Structure's HTML into a grid.

### Selective per-report categorization (new)

The full-document flow above (`/api/extract`, one `categorize()` call over
the whole OCR dump) hits Ollama's default 2048-token context window on any
multi-panel report — the model silently never sees the *front* of the
document, so early sections go missing (see `PROGRESS.md`'s "Categorization
confirmed as the real bottleneck" for the root-cause writeup). Rather than
raising `num_ctx` (a real fix, but ~3x slower per report — see
`PROGRESS.md`'s "Suggested next steps"), this demo now offers a second,
two-step flow that sidesteps the truncation problem entirely by never
sending the whole document to Ollama in one call:

1. **`POST /api/identify-reports`** — runs triage + reading exactly like
   `/api/extract`, then hands off to `sections.js`: splits the OCR dump into
   per-page chunks (using the page-boundary markers both reading paths
   already emit — `-- N of M --` from the digital-text-layer shortcut,
   `--- Page N of M ---` from real OCR), and asks Ollama a **cheap,
   per-page** question ("what report/test panel names are on this one
   page?") via `identifySections()` in `ollama.js`. Each call's input is
   naturally small, so nothing gets truncated — no `num_ctx` change needed.
   Returns a `sessionId` (server holds the split pages + identified sections
   in memory, 30-min TTL) and the list of identified sections for the
   frontend to render as a picker.
2. **`POST /api/categorize-report`** (`{ sessionId, sectionId }`) — looks up
   the cached session, rebuilds a reduced OCR dump containing only the
   page(s) the chosen section came from (`getTextForSection()`), and runs
   the *existing* `categorize()` on that much smaller input — same prompt,
   same schema, same validate() afterwards.

The frontend (`public/index.html`) now has 5 stages instead of 4: Triage →
Read → **Select report** → Categorize → Validate. Stage 3 shows a radio-button
list of identified sections with their page numbers; picking one and
clicking "Categorize selected report" runs step 2 above.

**Confirmed via a real test (Sept 2026, `mrs.babita khandelwal` 7-page
document, `llama3.2:3b`, default 2048 context — same document/model used
throughout `PROGRESS.md`'s truncation writeup):**
- **The identify step saw all 7 pages** (vs. the full-document flow, which
  only ever categorized the last 4 of ~9-10 real sections on this exact
  document) — confirms the per-page splitting genuinely avoids truncation.
- **Categorizing one selected section (CBC, page 1) recovered all 22/22 real
  test rows with correct values** — this exact panel came back completely
  empty (0 rows) under the full-document flow, so this is a real, confirmed
  fix for the missing-panels problem, at least for whichever single section
  the user picks.
- **Two gaps, not fixed by this change, not new either — pre-existing
  `llama3.2:3b` quality issues:** (a) unit/reference-range field-boundary
  confusion (the range got written into the `unit` field, `range` came back
  `"None"`) — the same category of bug already logged in `PROGRESS.md`;
  (b) the identify step itself hallucinates some section names onto pages
  that don't contain them (e.g. "Total Cholesterol" appeared on pages 1-3
  where it isn't present) and doesn't merge near-duplicate names for the
  same test across pages (e.g. "CBC FEMALE ( COMPLETE BLOOD COUNT )" vs.
  "Complete Blood Count" show up as two separate picker entries) — a name
  fuzzy-matching or dedup pass is the natural next improvement, not yet
  built.
- **`/api/extract` (the original full-document flow) is unchanged and still
  available** — this is an additive second flow, not a replacement.

### Whole-report flow: every test extracted, report types only filter (Sept 29-30, 2026)

A third flow, at **`/select.html`** (linked from the main page). No
per-page LLM identify step; **every test in the report is extracted** —
including tests in no known category — and the user's report-type choice
only filters what's shown:

1. **`GET /api/report-types`** — the catalog from `reportCatalog.js`:
   28 report types (CBC, ESR, Lipid, Kidney, Electrolytes, Liver, Glucose,
   HbA1c, Thyroid, Hormones, Vitamins, Iron, Coagulation, Cardiac,
   Pancreas, CRP/RA/ASO, Infection serology, Immunology, Tumour markers,
   Blood group, Other haematology, HIV, HBsAg, HCV, Cotinine, Urine
   microalbumin/24h, Urine routine, Stool, Semen) + **OTHER**, each with
   the heading names labs print for it.
2. **`POST /api/extract-selected`** (multipart: `file`, `reportTypes` =
   JSON array of ids or `["ALL"]`, `engine`) — triage + read as usual, then
   `documentParser.js` parses the **whole document** (~10-50ms, no LLM):
   - each page is first classified by `pageClassifier.js` as `lab`,
     `mer`, `other` or `no_text`; only `lab` pages are parsed (the rest are
     reported in `stages.pages`, MER handling comes later). A page with
     ≥ 2 ECG / radiology / ID-document / non-medical words (ECG, QRS, bpm,
     X-ray, USG, Aadhaar, UIDAI, PAN, PNR, passenger, salary …) and < 2
     confident rows is `other`, never
     `lab`; a single-test page (one row + lab wording) is `lab`; an
     `other` page with lab wording right after a lab page is the same
     report's continuation → `lab` (`classifyPages()`). The worker stores
     the lab page numbers in `tbl_ocr_report_details.pathology_pages`.
     `node page-eval.js [--verbose]` scores this against a hand-checked
     answer key (`review-data/page-key.json`, 279 pages of 26 files);
   - it's split into blocks at every recognized heading (a short line
     matching a catalog pattern or a generic boundary like a department
     name, with no result-like numbers — so `HbA1c %\t4.8 4.2 - 6.5` is a
     row, not a heading) plus the text before the first heading;
     consecutive same-type headings merge;
   - each block is cleaned (lines repeated on ≥30% of pages, page markers,
     prose, patient-header lines) and run through the rules parser;
   - every row is labelled: the dictionary's panel for the test if the
     heading disagrees, else the heading's type, else the dictionary's,
     else **OTHER** under its printed heading — **never dropped**;
   - duplicates (summary + detailed pages) collapse, keeping the richer row;
   - the patient header comes from the page of the first block with rows.

   Engines (`engine` form field / UI picker):
   - **`auto` (default)** — rules; the LLM (`categorize()`) runs only for a
     recognized, selected report-type block the rules got no rows from.
   - **`rules`** — never calls the LLM.
   - **`llm`** — one `categorize()` call per selected report-type block.
   Results are merged, source-checked and validated. A selected type with
   no tests in the file comes back `found: false` — "Not found" in the UI.

#### Rules-based row parser (no LLM, no per-lab templates)

Built on what every lab report shares, not on any one lab's layout:

- **`textNormalize.js`** — makes OCR output look like the text layer: HTML
  `<table>` rows → tab-separated lines; Unlimited-OCR's split tables
  ("test | value" + "unit | range") zipped back together **only when the
  result rows and unit/range rows match one-to-one**, else left alone.
  Cyrillic / Greek look-alike letters inside Latin words are folded to
  Latin (some PDF fonts write "HЕМАТOCRIT" with Cyrillic Е М А Т).
- **`labVocabulary.js`** — the shared vocabulary: units (normalized, so
  `mg / dL` = `MG/DL`), qualitative results (`Non Reactive`, `Not
  Detected`, `Pale Yellow`…), method and specimen lines, reference-range
  labels (`Borderline`, `Adults:`, `FEMALES ;`), note/interpretation markers,
  column headers, flags.
- **`rowParser.js`** — per line: tab cells are classified by **content**
  (name / value / range / unit), not position, because text layers can emit
  columns in any order (one lab comes out as `range ⇥ value ⇥ name`); the
  section's usual column order breaks ties. Untabbed lines try every
  possible value start and accept the first where everything after it is
  value/unit/range vocabulary. Handles name → method → value line
  sequences, ranges continued on following lines *or* printed above the
  value, unit-only lines, notes blocks, and rejects prose/meta lines
  instead of guessing. Returns `needsFallback` when a section parses badly.
  H / L flag cells and flag-only lines are dropped before parsing (in
  one-cell-per-line text layers the flag sits between name and value), and
  a name split over several short lines ("TOTAL" ⏎ "LEUKOCYTE" ⏎ "COUNT")
  is joined back when that names a known test better than the last line.
  A remarks column after the value ("Ketones⇥Not present⇥Presence may
  indicate…") is dropped (a test name is never a sentence); a
  "unit⇥range" line right after a value is that row's unit and range.
  Never emitted as rows: a 9+-digit plain number with no unit (phone / ID /
  PIN on a letterhead) and page furniture ("End of report", "Page 2 of 7").
- **`paramDictionary.js`** — 217 standard pathology tests (all 28 panels) with synonyms, unit
  families and physically plausible ranges. Used only to label rows
  (`canonical`), disambiguate (Neutrophils % vs absolute), flag implausible
  values (`Hb 136` → possible lost decimal) and score `confidence`; tests
  not in it are still extracted. A ratio name ("Total Cholesterol/HDL",
  "TG/HDL", "SGOT/SGPT", anything saying "ratio") only ever matches a
  ratio entry — never one of the two tests it divides; with no ratio entry
  it gets no code.
- **`headerParser.js`** — patient/report fields from `Label : value`,
  `value ⇥ Label`, vertical `Label ⏎ value`, combined `Age / Sex` fields
  and unlabeled `MR. NAME` / `65 Years /M` lines; each tab cell as its
  own `Label : value`; skips doctors' signature-block registration numbers
  (ID fields only — a patient's age/sex printed there still count).
  One-cell-per-line headers (3+ isolated `:` lines: `Age` ⏎ `/` ⏎ `Sex`
  ⏎ `:` ⏎ `46` ⏎ `YRS/M`) are rebuilt into `Label : value` lines first.

Row output keeps the shared contract (`test, value, unit, range`) and adds
optional `canonical`, `param_id`, `confidence` (`high|medium|low`), `flags`.

**Reading is per page** (`unlimited-ocr/pageReader.js`, used by every
flow): each page's text layer is used if it's usable; only pages without
one — scanned pages, garbled embedded OCR layers, lab-looking pages whose
text yields no results — are rendered and sent to Unlimited-OCR, cached per
page in `ocr-cache/` (gitignored). A mixed "scanned MER + digital report"
PDF only OCRs its scanned pages. Run the OCR service with
`PYTHONIOENCODING=utf-8 PYTHONUTF8=1` on Windows (it crashes printing
non-ASCII characters otherwise).

**Batch check:** `node batch-eval.js "<folder>" [--ocr] [--only a,b] [--save out.json]` runs
per-page reading → page classification → whole-document rules parser over
every PDF in a folder (no LLM; pages needing OCR are skipped unless `--ocr`,
which OCRs only those pages, cached) and prints per-file page types and
total rows/confidence. Judge parser
changes with this over many reports, not on one file.

**Confirmed (Sept 29):** on 4 real lab reports from 4 different labs
(Helpline/Babita, Redcliffe, K Naresh Naidu, and Suresh Kumar Sharma —
the last one never looked at while building) plus Babita's page 1 read by
OCR: 185 text-layer rows + 22 OCR rows, all values correct, whole
pipeline ~170-230ms per document with zero LLM calls. See `PROGRESS.md`
for the details and what's still weak. Unknown standalone tests can still
bleed into the previous section until they're added to
`BOUNDARY_PATTERNS` — extra rows, not lost ones.

- **Stack:** Express (`server.js`, port `8795` default) + `multer` (same
  limits as the other demos) + `unlimitedocr.js` (PDF rasterization via
  the same `pdf-parse` approach as `deepseek-ocr/`, then per-page calls
  to the Python microservice) + `ollama.js` (categorization, written for
  this reading stage's real HTML-table output) + `validate.js` (copied
  unchanged) + `unlimited_ocr_service.py` (Flask, port `8796` default,
  loads the model once at startup).
- **`test-extract.js`** — CLI script, same pattern as `paddleocr/`'s.
- **Cost:** $0 API cost — just your own compute. In practice, a real
  GPU (which this machine doesn't have) rather than a CPU workaround, if
  this is ever pursued beyond a proof of concept — ~4.5 min/page on CPU
  is not a realistic production number.

### Running this locally

```bash
# 1. Python OCR service
cd unlimited-ocr
py -3.12 -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt
pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision
python unlimited_ocr_service.py      # http://localhost:8796 — leave running
                                      # ~2-3s model load, then idle until called

# 2. Node pipeline (separate terminal)
cd unlimited-ocr
npm install
copy .env.example .env
npm start                            # http://localhost:8795
node test-extract.js "<path to a report>"   # confirmed ~4.5 min/page
```

Requires `./model/` populated with the Unlimited-OCR weights from
Hugging Face before step 1 will work, **plus** the `.cuda()` →
`.to(self.device)` patch in `model/modeling_unlimitedocr.py` (the model
is officially CUDA-only; this project forces it onto CPU) — see
`unlimited_ocr_service.py`'s file header and `PROGRESS.md`'s
"Unlimited-OCR" section for the exact patch to re-apply if the model is
ever re-downloaded. Also needs [Ollama](https://ollama.com) running with
`ollama pull llama3.2:3b`. Optional env vars: `CATEGORIZE_MODEL`,
`PAGE_RENDER_WIDTH`.

## `regex-based/` — same reading stage as `unlimited-ocr/`, zero LLM calls for categorization

Built directly off a real timing measurement: on the `mrs.babita
khandelwal` 7-page digital PDF, `unlimited-ocr/`'s organise+categorize
steps (both Ollama calls) took ~140s + ~150-235s per section — several
minutes total — while the free digital-text-layer extraction itself took
~0.1s. This demo asks "what if organizing and categorizing were also
free and instant, for a report whose layout is known in advance?"

- **Reading stage: identical to `unlimited-ocr/`, not duplicated.**
  `triage.js` and `unlimitedocr.js` are copied unchanged, and
  `UNLIMITED_OCR_URL` in this demo's `.env` points at the **same
  already-running** `unlimited_ocr_service.py` Python microservice
  `unlimited-ocr/` uses — this demo does not ship its own copy of the
  6.67GB model. Only reached for genuine scans; every digital PDF still
  takes the free text-layer shortcut.
- **Categorization stage: `regexCategorize.js`, pure pattern matching, no
  network call, no model, synchronous.** Report boundaries are found via
  this template's own `"<name> Sample Tested In : <specimen>"` marker
  (present on every real panel tested so far); each result row is parsed
  by regex depending on its shape (numeric-with-unit, qualitative-phrase,
  or embedded-numeric-in-one-cell — see the file's own comments for all
  three).
- **The trade-off, stated up front:** this is emphatically **not** a
  general-purpose parser. Every regex here — the report-boundary marker,
  the known-unit list, the qualitative-phrase list — is written against
  ONE lab's exact template (Helpline Pathology / MAX LIFE). A report from
  a different lab with a different layout will silently return wrong or
  empty results, not an error, because nothing here is actually reading
  and reasoning about the text. This is the exact brittleness every other
  demo in this project chose an LLM to avoid. **No LLM fallback exists on
  purpose** (per explicit instruction, Sept 2026) — this demo's only job
  is to answer "how much faster, and is a per-template regex set worth
  maintaining," not to be a production-ready alternative.
- **Confirmed via a real run (Sept 2026, same document used throughout
  this project's testing):** total pipeline time **~130-140ms** (triage
  ~120ms — mostly `pdf-parse` overhead, reading ~2ms since this was a
  digital PDF, categorize ~10ms, validate ~2ms) — **well over 1000x
  faster** than the equivalent `unlimited-ocr/` run. All **14 real report
  panels found, 57 rows total**, 41 validated as numerically normal
  automatically. Field quality on the numeric rows matched or exceeded
  the LLM approach's best runs (e.g. CBC's units/ranges came out clean:
  `"unit": "gm/dL", "range": "12 - 15"`, something the LLM path got wrong
  on more than one run — see `PROGRESS.md`).
- **Stack:** Express (`server.js`, port `8797` default) + `multer` (same
  limits as the other demos) + `unlimitedocr.js`/`triage.js` (copied) +
  `regexCategorize.js` (new, the only real logic in this demo) +
  `validate.js` (copied unchanged).
- **`test-extract.js`** — CLI script, same pattern as `unlimited-ocr/`'s,
  minus the Ollama stage.

### Running this locally

```bash
# Uses the SAME Unlimited-OCR Python microservice as unlimited-ocr/ — start
# that one first if you'll be uploading a real scan (not needed for a
# digital PDF, which never reaches it):
cd ../unlimited-ocr
python unlimited_ocr_service.py      # http://localhost:8796 — leave running

cd regex-based                       # separate terminal
npm install
copy .env.example .env
npm start                            # http://localhost:8797
node test-extract.js "<path to a report>"   # confirmed ~130ms on a digital PDF
```

No Ollama, no `OLLAMA_URL`/`CATEGORIZE_MODEL` — this demo never calls a
local model. Optional env vars: `PAGE_RENDER_WIDTH` (only used if a
non-digital file reaches the shared Unlimited-OCR service).

## `hybrid-ocr/` — regex first, confidence-scored, falls back to the LLM only when needed

Built directly in response to `regex-based/`'s own limitation: fast but
brittle to format. Rather than picking one extreme (always regex, always
LLM), this demo runs the regex path first on every document — it's
essentially free — and uses a confidence score to decide whether to trust
that result or spend the time on the LLM path instead.

- **Pipeline:** triage → read (shared with `unlimited-ocr/`/`regex-based/`)
  → `regexCategorize.js` (a copy of `regex-based/`'s, unchanged except it
  now also reports which tier matched) → `confidence.js` scores the result
  → **if the score is below 0.6, `unlimited-ocr/ollama.js`'s `categorize()`
  runs as a fallback and its result is used instead** → validate. Neither
  `regex-based/` nor `unlimited-ocr/` were modified — this demo is a new
  layer combining both, not a change to either.
- **`confidence.js`** — the only genuinely new logic. Starts at 1.0, docks
  0.35 automatically for a Tier-B (generic, cross-template) regex match,
  then applies further penalties for: too many report sections that
  couldn't be named (generic `"Report"`), too many empty report sections,
  too few rows per non-empty section on average (the single strongest
  signal in testing — it's what actually separated a real partial success
  from a real failure), and too many empty core patient fields. See the
  file's own header for the exact constants and the real documents they
  were calibrated against.
- **Confirmed on the 3 documents used throughout this project's regex
  testing (Sept 2026):**
  - Helpline (exact template match, Tier A) — confidence **1.00**, stayed
    on the fast path, ~130ms, no LLM call.
  - K Naresh Naidu (generic match, but clean) — confidence **0.65**,
    *also* stayed on the fast path — proof the check isn't just "Tier A
    good, Tier B bad," it actually judges the result's quality.
  - Redcliffe (generic match, noisy — 41% unnamed sections, 68% empty,
    1.43 rows/section) — confidence **0.00**, correctly escalated to the
    LLM fallback (~122s), which returned a real but different and
    smaller set of rows, with the LLM path's own already-documented
    flakiness intact (a nonsensical `age` value, a merged `patient_id`) —
    the hybrid makes a better *routing* decision, it doesn't fix the LLM
    fallback's own accuracy ceiling.
- **One real bug found and fixed while building this:** `test-extract.js`
  referenced a `const` declared inside the LLM-fallback `if` block from
  outside that block's scope while computing final timings — threw after
  validation had already succeeded. Fixed by deriving the validation
  stage's start time from `pathTaken` instead.

### Running this locally

```bash
# Same shared Unlimited-OCR service as regex-based/ — only needed for a
# genuine scan (no digital text layer):
cd ../unlimited-ocr
python unlimited_ocr_service.py      # http://localhost:8796 — leave running

cd hybrid-ocr                        # separate terminal
npm install
copy .env.example .env
npm start                            # http://localhost:8798
node test-extract.js "<path to a report>"
```

Needs [Ollama](https://ollama.com) running with `ollama pull llama3.2:3b`
for the fallback path — the fast path never touches it, but the fallback
will error without it. Optional env vars: `CATEGORIZE_MODEL`,
`PAGE_RENDER_WIDTH`.

## Comparison

| | `real/` (Gemini) | `sarvam/` (Sarvam AI Extract) | `azure-llm/` | `paddleocr/` | `deepseek-ocr/` | `unlimited-ocr/` | `regex-based/` | `hybrid-ocr/` |
|---|---|---|---|---|---|---|---|---|
| Reading | Gemini reads the file directly | Sarvam Vision reads the file directly (async job) | Azure Document Intelligence (or free direct text-layer pull for digital PDFs) | PaddleOCR + PP-Structure, self-hosted (or free direct text-layer pull for digital PDFs) | DeepSeek-OCR via Ollama, self-hosted, per-page (or free direct text-layer pull for digital PDFs) | Unlimited-OCR, self-hosted, forced CPU (no GPU on this machine), per-page (or free direct text-layer pull for digital PDFs) | Same as `unlimited-ocr/` — shares its Python microservice, not a copy | Same as `unlimited-ocr/`/`regex-based/` — shared, not a copy |
| Structuring | Same Gemini call, via `responseSchema` | Same Sarvam job, via a JSON Schema passed to `/doc-ai/v1/job/extract` | Separate local LLM call (Ollama), reasoning over Azure's text | Separate local LLM call (Ollama), reasoning over PaddleOCR's text — same prompt/schema as azure-llm | Separate local LLM call (Ollama), same prompt/schema as paddleocr — not yet re-tuned for this reader's output shape | Separate local LLM call (Ollama), written for this reader's real HTML tables — can't yet zip the separate units/range table by position | **No LLM at all** — `regexCategorize.js`, synchronous pattern matching against one known lab template | **Regex first** (same `regexCategorize.js`), **LLM (Ollama) only if `confidence.js` scores the regex result below 0.6** |
| Validation | None — trusts model output as-is | None — trusts Sarvam's output as-is (though Sarvam returns a per-field confidence score, unused so far) | Deterministic post-pass (`validate.js`) | Deterministic post-pass (`validate.js`, copy of azure-llm's) | Deterministic post-pass (`validate.js`, copy of paddleocr's) | Deterministic post-pass (`validate.js`, copy of paddleocr's) | Deterministic post-pass (`validate.js`, copy of paddleocr's) | Deterministic post-pass (`validate.js`) + a pre-categorization confidence check unique to this demo |
| Cost | Per-call Gemini API fee | ₹0.50/page flat, no scheduled increase | Per-page Azure Document Intelligence fee | $0 API cost — just your own compute (CPU/GPU) | $0 API cost — just your own compute (CPU/GPU) | $0 API cost — just your own compute (needs a real GPU for realistic speed; this project only has CPU) | $0 — no model call for categorization, reading stage is the same as `unlimited-ocr/`'s | $0 on the fast path; only pays the LLM's compute cost on documents that actually need the fallback |
| External dependencies | Gemini API only | Sarvam AI Document AI API only | Azure Document Intelligence API + a locally-running Ollama instance | A locally-running Python/PaddleOCR process + a locally-running Ollama instance | A locally-running Ollama instance only — no Python | A locally-running Python/Unlimited-OCR process + a locally-running Ollama instance | Same Python/Unlimited-OCR process as `unlimited-ocr/` (shared, only for real scans) — no Ollama | Same shared Python process (real scans only) + a locally-running Ollama instance (fallback only) |
| Visibility into intermediate steps | No — one opaque call | Partial — job status/results are visible, but internal OCR/structuring isn't split out like azure-llm/paddleocr | Yes — every stage's raw output is returned to the caller | Yes — same stage-by-stage response shape as azure-llm | Yes — same stage-by-stage response shape as paddleocr | Yes — same stage-by-stage response shape as paddleocr | Yes — same stage-by-stage response shape, plus categorization is literally inspectable regex code, not a model's reasoning | Yes — plus the confidence score and its specific reasons are returned, so you see exactly why a document did or didn't get the fast path |
| Target accuracy | Best-in-class (frontier model) | Promising on one real run (9/9 panels, no garbling) — too early to call confirmed | High (commercial OCR + small LLM) | Modest, ~60-70% by design — free-first, not accuracy-first | Unresolved — the reading stage itself gave 3 different results (clean, looped, garbled) across 3 identical calls on the same image; categorization prompt already rewritten, doesn't fix a bad reading | Best reading quality of any free approach here (24/24 correct, twice) — but categorization can't yet reconstruct units/ranges; needs a deterministic table-merge fix | **High, but only on this exact template** (14/14 panels, 57 rows, clean numeric fields on one real run) — zero generalization to a different lab's layout, by design | Confirmed on 3 documents: correctly kept the fast path on 2 (including a Tier-B one) and correctly escalated the 1 genuinely bad case — but the escalation path inherits `unlimited-ocr/`'s own unresolved accuracy issues |

`paddleocr/` is the one under active iteration — free/self-hosted is the
current direction (see `PROGRESS.md` for why). `sarvam/`'s first real
run beat `paddleocr/`'s best result on the same document (9/9 panels vs.
4-5/9), but it's one run — see `PROGRESS.md` ("First successful
end-to-end run") for what to verify next before trusting it further.
`deepseek-ocr/`'s categorization prompt has already been rewritten for
its actual output shape, but 3 identical repeated calls against the same
image gave 3 different reading results (clean, a repetition loop, and a
differently-garbled reading) — the open question is DeepSeek-OCR's own
reading-stage reliability on this hardware, not the categorization step.
`unlimited-ocr/` has the best raw reading quality seen anywhere in this
project, confirmed twice — but it's officially a GPU-only model forced
onto a CPU-only machine here (~4.5 min/page), and its categorization
step has a specific unsolved gap (can't reconstruct units/ranges from a
second table). See `PROGRESS.md` for the full detail on all three newer
LLM-based demos before trusting any of them further.

`regex-based/` sits outside this whole LLM-vs-accuracy trade-off
entirely: on a real document tested, it was **>1000x faster** than
`unlimited-ocr/`'s categorization step (~130ms total pipeline vs. several
minutes) with equal-or-better field accuracy on numeric rows — but that
speed is bought by pattern matching, not understanding. A generic
fallback tier was later added to cover more than one exact template (see
its own section above), which recovered real data from 2 of 2 previously
unrecognized documents — genuinely more useful, but still not general.

`hybrid-ocr/` is the newest addition and directly answers the question
`regex-based/` raises: since regex is fast-but-brittle and the LLM path
is slow-but-general, why not use both, deciding per document? Confirmed
on the same 3 documents: it stayed on the fast path for 2 of them
(including a Tier-B one whose result actually was good) and correctly
escalated to the LLM only for the 1 that genuinely needed it. It doesn't
raise the ceiling on accuracy — the escalation path is exactly
`unlimited-ocr/`'s existing categorization, unsolved gaps and all — it
only makes the fast path safe to rely on instead of an unconditional bet.

## Known gaps / not yet done

- **Tested and ruled out (Sept 2026): swapping Ollama for `llama.cpp`'s own
  server with a larger context does not fix the missing-panels problem.**
  Same model (`llama3.2:3b`, the identical cached weights Ollama already
  had), `-c 16384` instead of Ollama's silent 2048 default — the input
  truncation went away (confirmed via a 4,980-token prompt), but generation
  hit the `max_tokens` ceiling before finishing (~2.9 tok/s on this CPU,
  ~29 minutes, incomplete/unparseable JSON). Root cause: Ollama and
  `llama.cpp` share the same underlying inference engine, so this isn't a
  faster-engine fix, and this model+hardware combination is too slow to
  produce a full multi-panel JSON response regardless of context size. No
  demo was changed. Full writeup in `PROGRESS.md`.
- Not integrated with the main backend (`backend/Health_360_Backend`) or
  frontend (`Frontend_Health_360/main`) in any way — no controller, no
  service, no route references any of the eight demos. Purely standalone
  Node apps today.
- Each demo ships its own `.env.example` (copy to `.env` and fill in the
  keys — see that demo's "Running this locally" section above), but
  there's no single shared one across all eight — no unified setup step,
  just eight separate `copy .env.example .env` commands.
- `index.html` exists at this folder's root (outside all eight
  subfolders) — not yet traced against any demo's `public/` folder;
  unclear if it's an older combined page or shared scaffolding.
- `sarvam/` has one or two successful real runs per mode (see
  `PROGRESS.md`), not several — repeat-run consistency (MER mode's
  question count already moved 66→56 between two runs) and a second
  document per mode are still unconfirmed, same validation gap the
  `qwen3:4b` swap went through above before being judged.
- No decision recorded yet on which approach (or a hybrid) will actually
  be adopted for real DC Report Upload processing (see the main repo's
  `backend.md` Report Upload section, which today has no OCR/extraction
  step at all — `UploadReportDocument` only saves the raw file).
