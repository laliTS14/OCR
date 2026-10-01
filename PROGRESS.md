# OCR Project — Progress Log

> **Read this file first if you're picking up OCR work in a new session.**
> It's the single source of truth for what's been done, what was found,
> what's currently configured, and what's next. `README.md` in this same
> folder covers the architecture/how-to-run side; this file covers the
> narrative — decisions, experiments, dead ends, and the reasoning behind
> the current state. Keep it updated as work continues — overwrite stale
> sections rather than just appending, the way `ocr.md`/`README.md` are
> maintained.

## The goal, in plain terms

Replace manual DC-report data entry with automated OCR + extraction,
eventually wired into the main TPA PIMS backend's Report Upload flow
(currently `UploadReportDocument` just saves the raw file — no
extraction step exists yet). Three POCs exist to compare approaches
(see `README.md`); **`paddleocr/` is the one under active
development**, because:

- **Cost constraint: everything must be free, except hosting**, which is
  already covered (own server). This rules out per-call APIs (Gemini,
  Azure) as the production choice — they're kept only as comparison
  points, not the direction being pursued.
- **Scale target (for now): 5-10 reports processed at a time**, not
  hundreds at once. A queue/worker architecture for high-volume batch
  processing was sketched out in conversation but explicitly deprioritized
  — not worth building until the single-report pipeline is actually
  accurate and fast enough to be useful.

## Current configuration (exact, as of last edit)

If you're re-reading this after time has passed, verify against the
actual files — this is a snapshot, not a guarantee.

- **Model:** `llama3.2:3b` via Ollama (`paddleocr/.env` → `OLLAMA_MODEL`).
  `qwen3:4b` was tried as a replacement and reverted after 3 test runs
  showed no real improvement and a speed regression — see "The `qwen3:4b`
  experiment" below for the full results before re-trying it or a
  different Qwen variant. `ollama.js` sends `think: false` on every
  `/api/generate` call — currently a no-op (`llama3.2` isn't a thinking
  model) but kept so a future hybrid-thinking model doesn't burn time on
  an unneeded reasoning trace.
- **Context window:** Ollama's **default (2048 tokens)** — not
  explicitly set in `ollama.js`. This is a known, accepted trade-off (see
  "The context-window bug" below) — a fix exists but is deliberately not
  applied right now.
- **Request timeout:** **unbounded** — both `ollama.js` and `paddle.js`
  route their HTTP calls through `undici`'s `fetch` with a custom `Agent`
  (`headersTimeout: 0, bodyTimeout: 0`), instead of Node's global `fetch`
  (which has a silent 300-second default that was killing long-running
  local-model calls with a misleading "could not reach service" error).
  This fix **is** applied and active.
- **Reading stage:** triage-based branching — digital PDFs (real text
  layer found) skip PaddleOCR entirely and use the free direct
  text-layer pull; only genuine scans go through PaddleOCR. (A "force
  PaddleOCR for every file" experiment was tried and reverted — see
  below.)
- **Dev workflow:** `npm run dev` (added `"dev": "node --watch server.js"`
  to `package.json`) auto-restarts the server on file changes — use this
  instead of `npm start` when iterating, but be aware an in-flight
  request gets killed if a file changes mid-request (this happened once,
  looked like a mystery "Failed to fetch" bug, wasn't one).

## Accuracy — the real, confirmed numbers

Tested against a real 7-page digital PDF report
(`mrs.babita khandelwal rptinvestigationresultsw.pdf` — Helpline
Pathology, 9 test panels: CBC, ESR, HIV/HBsAg, 5 biochemistry panels,
LFT, HbA1c, urine routine, UCT):

- **With the current (default context) config:** only ~4-5 of 9 panels
  captured — specifically the *later* sections (LFT, HbA1c, urine, UCT).
  The early sections (CBC, ESR, HIV, HBsAg, cholesterol group) are
  **never seen by the model at all** — confirmed via a direct API call
  showing `prompt_eval_count: 2050` against a ~4000-token prompt. This
  is the context-window truncation bug (see below) — understood, fixable,
  currently left unfixed by choice (fixing it costs a lot of processing
  time).
- **Field quality on what does get through is inconsistent between
  runs on identical input.** One run returned clean values
  (`"value": "0.51"`); another run on the exact same document returned
  malformed values (`"value": "Oh 0.51 0.2-1.2"` — a stray word and the
  reference range crammed into the value field). Cause not isolated —
  possibly model sampling variance, possibly something else. **Open
  issue, not yet root-caused.**
- **A second real document** (a Redcliffe Lifetech Vitamin D report,
  `6f03a156-0281-11f1-be25-42010a1400f4_Header 2.pdf`) extracted patient
  info and 3 real test rows correctly, but also **misclassified the
  report's legal disclaimer/terms-and-conditions boilerplate as if it
  were a test report** (`"report_type": "Terms and Conditions"` with a
  fake "row" containing the disclaimer paragraph as its value). **Open
  issue, not yet addressed** — the categorization prompt has no
  instruction telling the model to ignore non-tabular boilerplate text.
- **`llama3.2:1b`** (tried as a speed lever) is **worse, not better** —
  dropped from ~4-5 panels to essentially 1 field extracted. Not a viable
  option; reverted back to `3b`.
- This pipeline's own **design target is only ~60-70% accuracy** (see
  `README.md`) — some inaccuracy is expected. The missing-panels and
  malformed-value issues currently push below even that intended ceiling.

### The `qwen3:4b` experiment (model swap, tried and reverted — 4 runs)

Tried as the "different Ollama model" next step, on the same
`mrs.babita khandelwal` digital PDF as above, at the **same default
2048 context window** both times (`num_ctx` untouched — this is an
isolated model-choice test, not a combined fix):

- **Missing panels: unchanged, confirmed on both runs.** Both times,
  only the same 4 of 9 panels came through (Blood/LFT, HbA1c, urine
  routine, Urine Cotinine) — confirms the truncation bug is a `num_ctx`
  runtime-setting problem, not a model-choice problem. Swapping models
  alone cannot fix it.
- **Malformed lab values (the `"Oh 0.51 0.2-1.2"` style bug): not
  reproduced on either run.** Every numeric value/unit/range on the
  captured panels was clean both times. Two runs isn't full proof, but
  it's a better signal than one.
- **Run-to-run inconsistency on missing-field placeholders: confirmed,
  same failure mode as the original malformed-value bug, just on
  different fields.** The prompt says "use an empty string, never
  guess or invent a value" for absent fields — neither run followed
  it, and each run invented something different:
  - `age`: run 1 → `"N/A"`; run 2 → `"Ninety-Seven"` (spelled out in
    words — looks hallucinated, not read off the page).
  - `contact_number`: run 1 → `"N/A"`; run 2 → `"Not provided in the
    report"` (a full sentence).
  - Dimensionless-unit rows (`Colour`, `Appearance`, `Glucose`, etc.):
    run 1 → `"N/A"`; run 2 → `"-"`. Different placeholder, same
    underlying non-compliance.
- **Field-boundary confusion (range duplicated into `unit`): confirmed
  reproducible.** Both runs put the reference range into `unit` for
  `pH` and `Specific Gravity` (e.g. `"unit": "4.7 -7.5"`). Run 2 also
  showed a new instance of the same category on a different
  row/field — `"Casts /hpf"` got `"Not Detected"` placed in `range`
  instead of `value`.
- **Timing: consistent, and consistently slower than `llama3.2:3b`.**
  Run 1: ~9 min (542,735ms). Run 2: ~7-8 min. Both are at or above the
  old baseline's upper bound (4-7 min).

A third run, on the Redcliffe Vitamin D document (the one that exposed
the boilerplate-misclassification bug under `llama3.2:3b`):

- **Boilerplate misclassification: not reproduced.** Only the 3 correct
  reports (Vitamin D, TSH, Total Protein) came back — no fake "Terms
  and Conditions" section this time. **Caveat: this is one run, not
  confirmed as a real fix** — every other field on this document shows
  the same run-to-run instability seen on the other test document (see
  below), so it would be premature to credit `qwen3:4b` with actually
  understanding "ignore boilerplate" rather than just not hallucinating
  it *this particular time*.
- **Metadata-field fabrication: confirmed again, and worse this time.**
  `age` came back as `"Mythical (24 years old)"` — not a placeholder
  like the other runs, but genuinely invented descriptive text. Across
  all 3 runs so far, `age`/`contact_number` have never once come back
  as the empty string the prompt asks for: `"N/A"`, `"Ninety-Seven"`,
  `"Not provided in the report"`, `"NA"`, `"Mythical (24 years old)"` —
  five different fabrications across three runs. This is a bigger
  concern than the original `llama3.2:3b` malformed-value bug, since
  it's inventing plausible-looking descriptive text rather than
  garbling formatting — riskier if it ever reaches a human reviewer
  who doesn't double-check against the source document.
- **Timing:** ~2.7 min (160,505ms) — much faster than the other test
  document, but not a useful comparison (shorter/simpler document, only
  3 rows vs. 9+ panels) and no `llama3.2:3b` timing exists for this
  specific document to compare against directly.

A **fourth run**, same Redcliffe document, immediately raised the
severity further:

- **A real lab result value got dropped, not just metadata.** The
  Vitamin D row's `value` came back as `"Not provided in the report"` —
  the actual result (`25.5`, correctly extracted on the prior run of
  this exact document) was replaced with the same kind of fabricated
  explanatory text previously only seen on optional metadata fields.
  This is qualitatively worse: garbling or omitting the primary
  clinical data point is a different order of problem than an ugly
  placeholder in `age`.
- `age` this time: `"The patient's age is 24 years"` — a full sentence
  again (not a bare value), though it landed on the correct number (24)
  for the second run in a row, unlike the wildly-varying earlier
  attempts. Consistent age, inconsistent formatting.
- `contact_number`: `"Not provided in the report"` — a repeat of a
  phrasing already seen on the *other* test document, so at least this
  specific phrase isn't unique to one document.
- Boilerplate misclassification: still not reproduced (2/2 on this
  document now) — the closest thing to a stable result so far, though
  still too small a sample to call it fixed behavior vs. coincidence.
- Timing: ~4-5 min — a third different timing figure for the same
  document across its 2 runs (2.7 min, then 4-5 min), underscoring how
  unstable both quality *and* performance are run-to-run on CPU.

**Net assessment: revert, more strongly confirmed.** Across 4 runs
total, `qwen3:4b` never fixed the missing-panels bug (a `num_ctx`
issue, not a model issue), introduced a reproducible field-boundary bug
(range duplicated into `unit`), fabricated a *different* piece of text
for every missing metadata field on every single run, and on one run
**replaced an actual, previously-correct lab result value** with
fabricated text — a more serious failure than anything logged against
`llama3.2:3b`. The one recurring positive (no boilerplate
misclassification on the Redcliffe doc, 2/2 runs) is a small sample set
against a much larger and more serious body of evidence pointing the
other way. **Reverted `OLLAMA_MODEL` back to `llama3.2:3b`** in
`.env`/`.env.example`/`ollama.js`'s fallback default — `qwen3:4b` did
not demonstrate a real improvement on this task, cost more time doing
it, and introduced a worse failure mode (dropped real values, not just
malformed ones). Worth revisiting only if a differently-prompted or
larger Qwen variant is tried later (see
"Models discussed" below).

## Timing — the real, confirmed numbers

| Scenario | Time |
|---|---|
| Current config (default 2048 context, `llama3.2:3b`) | ~4-7 minutes per report |
| Default 2048 context, `qwen3:4b` (current active model) | ~7-9 minutes per report (542,735ms and ~7-8min confirmed across 2 runs on the same test report) — at or above `llama3.2:3b`'s upper bound, for the same partial (4/9 panel) coverage |
| With context bug fixed (`num_ctx: 8192`, sees whole document) | 12-20+ minutes — confirmed via a completed 12-min free-form (no schema) test; the real schema-constrained version was still running past 13 min when manually stopped, never confirmed to finish. Not yet re-tested with `qwen3:4b`. |
| Forcing PaddleOCR on a digital PDF too | Slower still — OCR'ing all 7 pages adds real time on top of categorization; never got a full completed run to measure |

**The core tension:** fixing the missing-panels bug (`num_ctx`)
roughly triples-plus the processing time, because the model then has to
read ~3x more input and generate a larger output. You cannot currently
have both "fast" and "complete" on this CPU-only hardware with this
model. The fast option is what's active right now.

## Bugs found and fixed (currently active)

1. **Node's default `fetch` timeout (300s) was killing long Ollama/PaddleOCR
   calls.** Both `stream:false` (Ollama) and the PaddleOCR HTTP call only
   return a response after all work is done, so any run over 5 minutes
   got killed mid-request with a misleading "Could not reach Ollama/
   PaddleOCR" error — confirmed by timing a real failure at ~303s.
   **Fix (active):** both `ollama.js` and `paddle.js` use `undici`'s
   `fetch` with a custom `Agent` (`headersTimeout: 0, bodyTimeout: 0`).
2. **`FormData`/`undici` mismatch in `paddle.js` broke file uploads to the
   Python service.** Introduced while applying fix #1 — mixing Node's
   *global* `FormData`/`Blob` with a separately-imported `undici` `fetch`
   silently produces a broken multipart body. The Python service reported
   "No file uploaded" even though Node's own `multer` had parsed the
   incoming upload fine; the failure was specifically in the Node→Python
   relay. **Fix (active):** construct `FormData` from `undici`'s own
   export, not the global one. (Global `Blob` was fine to keep.)

## Bugs found, fixed, but currently NOT applied (reverted by choice)

3. **Context-window truncation** (the root cause of missing panels,
   described above). Ollama defaults to a 2048-token context window
   regardless of what the model actually supports (`llama3.2:3b`'s real
   limit is 131072) — nothing in `ollama.js` overrides that default, so
   llama.cpp silently truncates the *front* of any longer prompt.
   **Fix that exists but is reverted:** `options: { num_ctx: 8192 }` in
   the `/api/generate` request. Confirmed via `prompt_eval_count` that
   this fix works at the token-processing level. **Why it's reverted:**
   the resulting 12-20+ minute processing time was deemed too slow for
   the "5-10 reports" scope, and a full run with this fix applied was
   never actually let finish (stopped by hand at ~13 min), so it's
   **unconfirmed whether it truly recovers all 9 panels** — that
   validation never happened. If revisited, re-apply `num_ctx: 8192` and
   let a full run complete before judging it.

## Experiments tried and reverted (not bugs — deliberate dead ends)

4. **Boilerplate-stripping preprocessor** (`textClean.js`, deleted) —
   stripped repeated per-page headers/footers/disclaimer lines before
   the text reached Ollama (34% size reduction, 15,443 → 10,203 chars).
   Looked like a clean speed win (categorization dropped to 88s) until
   the actual output was checked: it came back **completely empty**
   (blank patient info, one placeholder row) — the model silently gave
   up rather than doing less work faster. Reverted. **Lesson:** always
   diff the actual `categorized` JSON before/after a speed change, never
   trust wall-clock time alone — a faster empty answer is strictly worse
   than a slower partial one.
5. **Forcing every file through PaddleOCR**, even digital PDFs with a
   text layer (ignoring triage's `isDigital` result). Theory: the
   text-layer path's documented column-jumbling might be contributing to
   the malformed-value issue, and PaddleOCR's real table detection might
   give cleaner input. Building this is what surfaced bug #2 above.
   **Reverted** because OCR'ing all 7 pages before categorization even
   starts made total time worse, not better, for the current scope.
   **The original motivation was never confirmed either way** — whether
   PaddleOCR's table structure actually reduces malformed values is
   still an open question, just untested (the run was too slow to let
   finish).
6. **`llama3.2:1b` instead of `3b`** — see Accuracy section above.
   Reverted, clearly worse.

## Environment setup notes (this dev machine)

- Machine was upgraded to 16GB RAM during this work (was 7.7GB) —
  relevant because `paddle_service.py`'s known RAM-pressure crash on
  large scanned images (see `paddleocr/README.md`) was found on the
  7.7GB config; not yet re-tested against the upgraded machine.
- Python 3.12 venv required (paddlepaddle has no 3.14 wheel yet) — see
  `paddleocr/README.md` for the full setup.
- Ollama runs as a persistent background Windows app (system tray),
  independent of any terminal — you don't need to `ollama serve`
  manually. The Python and Node processes are plain foreground scripts
  with no such wrapper — closing their terminal kills them.
- `gh` (GitHub CLI) is not installed on this machine.

## GPU sizing (for when the production server gets one)

Discussed but not yet acted on — the server is currently CPU-only. Must
be **NVIDIA** specifically (Ollama's and PaddlePaddle's GPU builds both
require CUDA; AMD/Intel aren't reliably supported).

| Tier | VRAM | Fits |
|---|---|---|
| Minimum viable | 8GB | `llama3.2:3b` + PaddleOCR, low concurrency |
| **Recommended sweet spot** | **12-16GB** | Same models, higher concurrency, room to grow |
| Future-proofed | 24GB | Headroom for a bigger/more accurate model later |

Consumer options: RTX 4060 Ti 16GB, RTX 3060 12GB. Server/datacenter
options: NVIDIA T4 (16GB, low power), NVIDIA L4 (24GB).

## Models discussed for the categorization step

- **`qwen3:4b`** — tried, currently active (see "The `qwen3:4b`
  experiment" above). Supersedes the old `qwen2.5:3b` idea below — Qwen's
  current generation is `qwen3`, not `qwen2.5`. Verdict not yet final
  (see net assessment above).
- ~~`qwen2.5:3b`~~ — the previous generation's equivalent; superseded by
  `qwen3:4b` before it was ever tried. No longer the recommendation.
- **`qwen2.5:7b`** / a larger `qwen3` size (e.g. `qwen3:8b`) — larger,
  likely stronger, still CPU-runnable, not yet tried. Worth trying if
  `qwen3:4b` doesn't pan out, before giving up on the Qwen family.
- `llama3.1:8b`, `phi3.5`, `mistral:7b` — other candidates, lower
  priority than the Qwen family for this specific task.

Longer-term architecture idea (once GPU is available, or worth a CPU
trial given `qwen3:4b`'s reasonable size): a **vision-language model**
could replace PaddleOCR + Ollama's two-stage split entirely — one local
model reads the page image *and* outputs structured JSON directly, same
shape as the `real/` (Gemini) POC's architecture but free/self-hosted.
As of this writing, `qwen3-vl` (the vision sibling of `qwen3`, also
available in a `4b` size, ~3.3GB, with a native 256K context window —
which would sidestep the truncation bug entirely for this path) is the
concrete candidate; `qwen2.5vl:7b` was the earlier idea before `qwen3-vl`
existed. Not attempted yet — the current `qwen3:4b` text-only test above
already runs ~9 minutes on CPU for a *smaller* input (post-OCR text, not
a raw image), so a vision model doing OCR+structuring together should be
expected to run slower still on this hardware. Deferred until the
text-only categorization approach is either fixed or ruled out.

## Alternative self-hosted OCR models explored (Sept 2026)

Four candidates surfaced while looking for a free/self-hosted way to fix
`paddleocr/`'s accuracy problems (see `README.md`'s comparison table for
the summary each was given before testing):

- **`glm-ocr` (Ollama) — tried, confirmed broken, do not use yet.**
  Pulled via `ollama pull glm-ocr` (1.1B params per `ollama show`, 131072
  context) and tested directly against the Ollama HTTP API (not through
  any demo code) with the `mrs.babita khandelwal` PDF's first page
  rasterized to PNG. **Confirmed bug, not a request-format mistake:**
  every call hard-stops at exactly **56 output tokens**
  (`done_reason: "length"`), completely unaffected by an explicit
  `num_predict: 2000` override, reproduced identically on both
  `/api/generate` and `/api/chat`. A cold call (new image, nothing
  cached) took **275 seconds** for that one page — almost entirely
  image/prompt encoding (`prompt_eval_duration` ~265s of the ~275s
  total), not generation; a second identical call was fast (~7s) only
  because Ollama's KV-cache reused the identical prompt, which won't
  happen across different real pages. This matches several currently-open
  upstream issues on `ollama/ollama`: truncated/incomplete reads
  ([#14117](https://github.com/ollama/ollama/issues/14117)), blank
  markdown output after v0.17.1
  ([#14474](https://github.com/ollama/ollama/issues/14474)), crashes from
  missing RoPE dimension metadata
  ([#14401](https://github.com/ollama/ollama/issues/14401),
  [#14171](https://github.com/ollama/ollama/issues/14171)), and load
  failures on several recent versions
  ([#14296](https://github.com/ollama/ollama/issues/14296),
  [#14494](https://github.com/ollama/ollama/issues/14494)). Confirmed
  installed Ollama version (0.34.2) already exceeds the model's stated
  minimum (0.15.5 per `ollama show`), so this isn't a "just upgrade
  Ollama" fix. Even GLM-OCR's own maintainers' official Ollama deployment
  guide (`zai-org/GLM-OCR`) recommends switching to **vLLM or SGLang for
  better performance and stability** rather than relying on Ollama at
  all — i.e. the same GPU-dependent, non-Ollama deployment path as
  Unlimited-OCR below, not a free CPU drop-in. **No demo folder was built
  for this** — wrapping broken output in a POC wouldn't have been a real
  test of anything. Revisit only once the upstream Ollama issues above
  are closed, or if vLLM/SGLang + a GPU is ever pursued.
- **`deepseek-ocr` (Ollama) — tried, works, built into a new `deepseek-ocr/`
  demo folder, accuracy not yet good enough.** 3B params, 6.7GB, 8K context,
  requires Ollama v0.13.0+ (already satisfied). Full detail in
  `deepseek-ocr/`'s own comments (`deepseek.js` file header) and below.
- **Baidu `Unlimited-OCR` — tried via a forced CPU path, and it is by far
  the best result of every approach in this entire file.** MIT-licensed,
  built for "long-horizon" (long-document) OCR + structured parsing on
  top of DeepSeek-OCR. Officially documented as CUDA-only (no CPU path
  mentioned, `model.eval().cuda()` in the README example, `device_map:
  "auto"`), and this machine has **no NVIDIA GPU at all** — confirmed via
  `Get-CimInstance Win32_VideoController` (Intel Iris Xe integrated
  graphics only). Attempted anyway at the user's explicit request,
  accepting the risk of wasted effort. See the new `unlimited-ocr/`
  folder for the setup.

  **What it actually took to get running on CPU:**
  1. Investigated the custom model code on Hugging Face *before*
     downloading 6.67GB of weights: `deepencoder.py` and
     `modeling_deepseekv2.py` turned out to be genuinely device-agnostic
     (flash-attention imports are guarded/optional, MoE routing is plain
     PyTorch) — the `wheel/` folder in the repo is just an optional
     SGLang serving wheel, not a mandatory CUDA extension. The actual
     blocker was narrow: `modeling_unlimitedocr.py`'s `infer()` method
     hardcodes 14 `.cuda()` calls directly on input tensors. Patched all
     14 to `.to(self.device)` (a one-line `sed` across the file, kept as
     `modeling_unlimitedocr.py.orig` for reference) — `self.device`
     works because the class inherits from `DeepseekV2ForCausalLM`, a
     standard `PreTrainedModel`.
  2. **This machine had only 0.57GB free RAM** at the time (Ollama's
     `llama-server` was holding 7.7GB from the DeepSeek-OCR testing
     happening in parallel) — had to `ollama stop deepseek-ocr` to free
     enough headroom (7.35GB) before attempting to load a 6.67GB model.
     Sequence memory-heavy steps like this rather than running them
     concurrently on a 16GB machine.
  3. Two real dependency-version bugs, both fixed: (a) the custom code
     imports `matplotlib`/`requests` without them being in the model
     card's stated requirements — `pip install` fixed it; (b) installing
     a current `transformers` (5.17.0) instead of the model card's
     pinned `transformers==4.57.1` broke on `modeling_deepseekv2.py`
     importing `is_torch_fx_available`, since newer transformers removed
     that function — pin the exact version the model card specifies,
     don't assume "newer is compatible."
  4. Loaded with `torch_dtype=torch.bfloat16, low_cpu_mem_usage=True`,
     no `device_map` (defaults to CPU when no CUDA is visible).

  **Result, one real run against `mrs.babita khandelwal` page 1:**
  genuine document layout analysis (not just OCR) — headers, tables,
  text blocks, images, and footer all correctly segmented with bounding
  boxes. The main test-panel table came back as **real, properly
  labeled HTML `<table>` markup with all 24 test/value pairs correct**,
  including "Absolute Lymphocyte Count" correctly labeled — the exact
  field every other approach in this file (DeepSeek-OCR, Sarvam, the
  earlier `llama3.2:3b` runs) either dropped or merged into an adjacent
  row. Units and reference ranges came back as a *separate* table, not
  merged into the main one — but in the same row order, so a simple
  positional join (row N of table 2 = unit/range for row N of table 1)
  reconstructs complete rows with zero ambiguity, unlike every other
  approach's unlabeled/jumbled unit fragments. Patient info also picked
  up two fields nothing else caught (`Referring Company: MAX LIFE`,
  `Collection Center: MAIN LAB`). Saves a clean `result.md` (real
  markdown + HTML tables) plus cropped sub-images automatically.
  **Cost:** model load 2.1s, inference 267.7s (~4.5 min) for one page —
  slow, comparable to DeepSeek-OCR's cold-start cost, but for
  dramatically higher quality on this one sample.

  **Caveats, same discipline as everywhere else in this file:** this is
  **one run on one page** at the time this was first written — DeepSeek-OCR
  also looked excellent on its first successful run before repeat testing
  revealed a ~50% failure rate on the same image. See the follow-up below
  for a second real run through the actual demo (not just the raw probe).

### Follow-up: full demo built, second real run confirms the reading
### stage but exposes a real categorization gap

Built `unlimited-ocr/` into an actual 4-stage demo (`triage.js` copied
unchanged; `unlimitedocr.js` new — PDF rasterization via the same
pdf-parse `getScreenshot` approach as `deepseek-ocr/`, then per-page
calls to a new persistent Flask microservice,
`unlimited_ocr_service.py`, which loads the model once at startup
(~2-3s) and serves `/ocr` — one request per page image, each taking
~4.5 minutes; `ollama.js` new, written for Unlimited-OCR's real
HTML-`<table>` output shape; `validate.js`/`transactionLog.js` copied
unchanged; `server.js`/`test-extract.js`/`public/index.html` following
the same pattern as every other demo here).

**One real bug found and fixed immediately**, the exact same one already
documented in this file for `paddleocr/` (bug #2): `unlimitedocr.js`
used the global `FormData`/`Blob` alongside `undici`'s `fetch` for the
Node→Python upload, which silently produces a broken multipart body —
Flask reported "No file uploaded" even though the code looked correct.
Fixed by importing `FormData` from `undici` itself, matching
`paddleocr/paddle.js`'s already-established fix. **Lesson reconfirmed:**
this specific mismatch is evidently easy to reintroduce when writing a
new Node→Python HTTP client in this codebase — worth double-checking
for it specifically any time a new one is written.

**Second real end-to-end run, same page, through the actual pipeline
(not the raw probe script):**
- **Reading stage reconfirmed excellent and consistent**: 259.1s (vs.
  the first run's 267.7s — a real second data point, not a fluke), and
  the raw Unlimited-OCR output again had all 24 test/value pairs correct
  in a real HTML table, matching the first run exactly.
- **Categorization (llama3.2:3b) has a specific, real gap the prompt did
  not fix**: it did NOT populate a single unit or reference range across
  all 24 rows — the positional-zip instruction (match row N of the
  units table to row N of the main table) was not followed at all,
  despite being spelled out explicitly in the prompt. Also fabricated an
  empty `"BIOCHEMISTRY"` report section that has no basis in this page's
  actual content (a hallucinated section, not present in the OCR
  output), and misattributed the letterhead's "Customer Care No." as the
  patient's own `contact_number`. Test names also kept their "* " bullet
  prefix, which the prompt explicitly asked to be stripped.
- **Conclusion: positionally zipping two separate HTML tables from a
  text prompt is too hard a task to reliably delegate to a 3B model**,
  even with explicit instructions — this is a different category of
  problem than "describe the input shape better," which is what fixed
  `deepseek-ocr/`'s earlier categorization gaps. The more promising fix,
  not yet implemented: do the table zip **deterministically in code**
  before the categorizer ever sees the text — parse both HTML `<table>`
  tags (e.g. with a real HTML parser, the same way
  `paddleocr/paddle_service.py`'s `html_table_to_grid()` already
  deterministically turns PP-Structure's HTML into a grid) and merge
  them into one pre-joined `test | value | unit | range` grid, the same
  clean shape `paddleocr/`'s categorization prompt already handles well.
  This would remove the hardest part of the job from the LLM entirely
  rather than trying to prompt-engineer around it.

Both fixed dependency issues (`.cuda()` patch, pinned
`transformers==4.57.1`) held up across this second run with no new
version-related failures. Not yet tested: a second document, multi-page
handling in one real run (only ever tested one page at a time so far),
and whether the reading stage's excellent quality holds on a scanned
document from a different lab/template.
- **`Ollama-OCR` (imanoop7/GitHub)** — not tried. Not a model, a Python
  convenience wrapper around existing Ollama vision models (LLaVA,
  Llama3.2-Vision, Moondream, MiniCPM-v, etc.) adding JSON/table/
  key-value output helpers. Lower priority — this project already
  hand-builds the same structured-extraction logic per demo
  (`extractor.js` in each of `real/`/`sarvam/`/`azure-llm/`/`paddleocr/`),
  so adopting a third-party Python wrapper would add a second-language
  dependency without a clear new capability.

## `deepseek-ocr/` demo — fifth demo, built and running, reading reliability is the open problem

A fifth demo folder, `deepseek-ocr/`, was built as a structural fork of
`paddleocr/` — same 4-stage pipeline (triage → read → categorize →
validate), same `triage.js`/`ollama.js`/`validate.js`/`transactionLog.js`
(copied, minor tweaks), same shared `{ patient, reports[] }` output
contract — with only the reading stage swapped: `deepseek.js` calls
DeepSeek-OCR via Ollama instead of PaddleOCR via a Python microservice.
**This demo needs no Python at all** — PDF pages are rasterized to PNG in
pure Node via `pdf-parse`'s bundled `getScreenshot()` (it ships its own
pdf.js + native canvas; no poppler/ImageMagick binary needed, confirmed
working), and DeepSeek-OCR itself runs entirely through the same Ollama
instance `paddleocr/`'s categorization step already uses.

**Confirmed via a live raw-API probe before building anything** (same
discipline as the `glm-ocr` investigation above — verify the model works
before wrapping it in a demo):
- A cold call (first-ever request against a given image) took **275
  seconds** for one page, almost entirely image/prompt encoding
  (`prompt_eval_duration` ~265s), not generation.
- **Without `repeat_penalty` set, the model reliably falls into a
  repetition loop** on real report pages — confirmed reproducible: it
  correctly transcribed the CBC panel, then repeated the same
  units/ranges block over 20 times verbatim until hitting the 2000-token
  budget (`done_reason: "length"`), never reaching the rest of the page.
  This is a decoding issue (the model's `temperature` is hardcoded to 0
  per `ollama show deepseek-ocr`), not a prompt problem.
- **Fix confirmed:** adding `options.repeat_penalty: 1.3` eliminated the
  loop entirely — the retried call finished naturally
  (`done_reason: "stop"`, 712 tokens, ~50s) and transcribed the complete
  page, including the footer ("Page 1 of 7"). This is now baked into
  `deepseek.js` as a default, not a tunable left off — removing it
  reproduces the loop (see the comment at the top of that file).
- **Raw OCR quality, spot-checked against this project's other
  successful extractions of the same document**: every numeric test
  value came back correct (Hemoglobin 13.6, WBC 8.2, RBC 4.50, etc.),
  patient name/doctor/Reg No correct, and it independently made the
  exact same `"lacks/cumm"` misreading Sarvam's Extract API made
  earlier on this same document — good evidence it's genuinely reading
  the image, not guessing, since two unrelated models misread the same
  hard-to-read source text the same way. Multi-column layout (test /
  value / unit / range as four aligned columns) is the real weak point —
  units and reference ranges get jumbled or merged across rows.

**End-to-end pipeline test (`test-extract.js` against the same page,
through the real `deepseek.js`/`ollama.js`/`validate.js` code, not a
one-off script): confirmed working, confirmed not yet accurate enough.**
No crashes, valid schema-conforming JSON came back, but:
- `llama3.2:3b`'s categorization step — reused as-is from `paddleocr/`,
  written against PaddleOCR's clean grid-formatted dump — did noticeably
  worse on DeepSeek-OCR's messier bullet-list/broken-table markdown than
  it does on `paddleocr/`'s input: it got all 20 test values right but
  **left every single unit and reference range blank**, and badly
  mis-parsed the differential leucocyte count section (treated labels
  like "Polymorphs"/"Lymphocytes" as the *value* of a bogus test instead
  of recognizing them as separate rows with their own numbers). Final
  validation summary: 2 normal, 0 flagged, **22 unchecked** out of 24
  rows — far worse than the raw DeepSeek-OCR reading quality alone would
  suggest, because the categorization prompt isn't tuned for this
  reading stage's specific output shape.
- Slow: 396s total for one page (156s reading + **240s categorization** —
  much slower than the same model categorizing PaddleOCR's cleaner dump
  in `paddleocr/`'s own tests, likely because the messier/bulkier
  markdown gives the model more to untangle).
- **Root cause, not yet fixed:** `ollama.js`'s prompt in this new folder
  is a straight copy of `paddleocr/`'s — it was never rewritten to
  describe DeepSeek-OCR's actual output shape (markdown with bullets and
  inline values, not a clean `rows | of | pipe | separated | cells`
  grid). That's the next thing to fix here, not a dead end: either adapt
  the prompt to explicitly describe the bullet/markdown shape, or
  post-process DeepSeek-OCR's markdown into a cleaner grid (similar to
  how `paddleocr/server.js` turns PaddleOCR's table output into a
  pipe-separated dump) before it ever reaches the categorizer.

**Net assessment (superseded by the follow-up below — kept for the
history):** a real, running fifth demo — not broken like `glm-ocr` — but
not yet better than `paddleocr/` in practice, despite DeepSeek-OCR's raw
reading being good. The gap is in the reading-to-categorization handoff,
which is a fixable prompt/formatting problem, not a fundamental model
limitation. Only tested on one page of one document so far.

### Follow-up: prompt rewritten, repetition mitigated — but a more
### fundamental problem surfaced (same session)

Three fixes were made based on the assessment above, all confirmed
working as designed, before finding the real remaining problem:

1. **`ollama.js`'s categorization prompt rewritten** specifically for
   DeepSeek-OCR's actual output shape (bullet/short-block tests, units
   and ranges frequently detached and jumbled elsewhere, administrative
   labels like "Sample Tested In"/"DLC Performed By" that aren't tests,
   explicit instruction that a verbatim-repeated block is an OCR glitch
   worth treating as one occurrence) — no longer a copy of
   `paddleocr/ollama.js`'s grid-oriented prompt.
2. **Stronger repetition mitigation**: `repeat_penalty` raised 1.3→1.5,
   `repeat_last_n: 256` added (wider lookback window for the penalty).
3. **A deterministic dedup safety net added, `dedupeRepeatedBlocks()` in
   `deepseek.js`** — splits DeepSeek-OCR's output on its own "### "
   section markers and collapses runs of 3+ matching sections to one.
   "Matching" is whitespace-normalized with prefix-matching (not exact
   byte comparison), because real captured loop output showed the first
   repeat in a run and the final (num_predict-truncated) repeat are
   *not* byte-identical to the verbatim middle repeats, just reformatted/
   cut short. **Verified against the actual captured 20-repeat loop from
   the original bug report:** reduced 21 occurrences of the repeated
   section down to 2 (a real, confirmed ~90% reduction, unit-tested
   directly against the saved log file before re-running anything live).

**Then a live re-run surfaced a bigger, more honest problem.** The retry
(same image, same code) did NOT loop this time (confirms repeat_penalty
helps sometimes) — but its raw DeepSeek-OCR reading was **worse quality
in a different way** than any prior run: test names ran together with no
values between them ("RBCCount RbcCount Total RBC count MCV MCH RDw...
Dlc..." as one unbroken line), the clinical-interpretation paragraph lost
spaces between words ("estimationof the cellular componentsoflood"), and
values got attached to wrong tests. **This is not a categorization
problem — no prompt fix downstream can recover data the reading stage
never captured correctly.** Combined with the two earlier runs (one
clean/correct, one that looped), that's now 3 real attempts at reading
the exact same image, with 3 different failure characters:
- Run 1 (manual probe, `repeat_penalty: 1.3`): clean, correct, complete.
- Run 2 (first pipeline test, same settings): repetition loop, corrupted
  downstream categorization.
- Run 3 (this run, `repeat_penalty: 1.5` + `repeat_last_n: 256` +
  rewritten prompt): no loop, but a differently-garbled, lower-quality
  reading (concatenated words, misattributed values) — a failure mode
  neither the original bug report nor the prompt rewrite anticipated.

**Corrected net assessment:** the prompt rewrite and dedup logic are
real, verified improvements and should stay — but they address the
*handoff* between reading and categorization, not DeepSeek-OCR's
underlying reading reliability, which is the actual open problem. On
this hardware/setup, DeepSeek-OCR's reading quality is **inconsistent
across identical repeated calls on the exact same image** — not just
"sometimes loops," but sometimes produces meaningfully lower-fidelity
transcription even when it completes normally.

### Failure-rate sample (same session, same image, `repeat_penalty: 1.5`)

Ran 4 more direct API calls (bypassing the pipeline, same raw prompt) to
get an actual failure rate instead of guessing from 1-2 runs. Important
methodology note first: **runs 2-4 came back byte-identical to each
other** — once run 1's prompt/image encoding got cached by Ollama,
`temperature: 0` made every subsequent call against the same cached
prefix fully deterministic. Repeating the *exact same request* does not
produce independent samples once the cache is warm — only genuinely
distinct calls (a cold cache, or a different image) do. Of the two truly
independent results in this batch:
- **Run 1 (cold): looped again** — the identical "Sample Tested In :
  Whole Blood" repetition from the original bug report, ~20 verbatim
  repeats, this time self-terminating (`done_reason: "stop"`) right
  after the loop ran its course instead of being cut off by
  `num_predict`. Confirms `repeat_penalty: 1.5` + `repeat_last_n: 256`
  does **not** reliably prevent this, even after being strengthened from
  1.3.
- **Run 2 (independent, then cached 2x more): clean.** Same shape as the
  very first successful probe from earlier — correct patient info,
  correct core test values, units/ranges still jumbled into an
  unattached block, same `"lacks/cumm"` misread, same
  "Absolute Neutrophil Count / Absolute Lymphocyte Count" label-merge
  gap. Reproducibly good, when it's not looping.

**Running tally across every independent cold attempt at this document
so far (6 total, across this and the prior sessions): 2 looped, 1
differently-garbled (concatenated words), 3 clean-but-incomplete
(values right, units/ranges unreliable).** That's roughly a **50% chance
of an outright failure mode** (loop or garbled) on any single call, even
with the strengthened settings. This is now a large enough sample to
stop calling it "not enough data" — the honest conclusion is that
DeepSeek-OCR's reading step is not reliable enough to trust on a single
call in this setup, and a real deployment would need either automatic
retry-until-clean logic (expensive: each retry costs a fresh 50-275s
call) or mandatory human review of every page, not just the flagged
ones. Whether that's worth it compared to `paddleocr/`'s different
failure modes (context truncation, not reading unreliability) is a real
open question, not yet decided.

## Categorization confirmed as the real bottleneck, not reading (Sept 2026)

A side-by-side comparison was run by hand: the same `mrs.babita
khandelwal` 7-page document through both `deepseek-ocr/` and
`unlimited-ocr/`'s full pipelines. Both output files start with `===
TEXT LAYER (extracted directly, no OCR) ===` and contain **byte-for-byte
identical extracted text** — meaning both runs actually took the
**digital-PDF text-layer shortcut in `triage.js`**, not real OCR at all.
So this accidentally became a controlled test of just the
categorization step: same raw input text, same model
(`llama3.2:3b`, confirmed via each demo's `.env`/default), two different
hand-written prompts.

**Result: both categorizations failed, in different ways, and neither
failure is about reading quality.**

- **`deepseek-ocr/`'s run** captured only the **last 4 of ~13 real
  report sections** (Liver Function Extended Panel, HBA1C, Urine
  Routine, UCT) — every earlier section (HAEMATOLOGY/CBC, ESR,
  SEROLOGY/HIV, HBsAg, Glucose Fasting, Total Cholesterol,
  Triglycerides, HDL Cholesterol, Creatinine, BUN) was silently dropped,
  and one row (`"Cotinine Test Value"`) was fabricated that doesn't
  exist in the source. The values it did capture were themselves mostly
  correct.
- **`unlimited-ocr/`'s run** identified the same last 4 report sections
  by name, but returned `rows: []` for every single one — zero test
  values extracted at all, despite the source text being present and
  correct.

**Root causes, both concrete and fixable — not "the model is bad":**

1. **Context-window truncation (bug #3, above) — now confirmed by a
   second, independent data point.** Ollama's 2048-token default
   (never overridden in any `ollama.js` in this repo) truncates the
   *front* of long prompts. The sections that survived in the
   `deepseek-ocr` run are exactly the ones at the *end* of the
   document — direct confirmation of the truncation direction bug #3
   already hypothesized but never validated to completion. This affects
   `paddleocr/`, `deepseek-ocr/`, and `unlimited-ocr/` equally, since all
   three inherit the same unmodified `ollama.js` call shape.
2. **No categorization prompt exists for the text-layer-shortcut path
   itself.** Every demo's prompt is hand-written to match its own OCR
   model's specific output shape — `deepseek-ocr/`'s expects loose
   bullet/short-block markdown, `unlimited-ocr/`'s explicitly requires
   two matching HTML `<table>`s. But per this file's own notes (see
   "azure-llm/ and paddleocr/ both branch on triage" in `CLAUDE.md`),
   **the digital-PDF shortcut is what every real-report test so far has
   actually hit** — plain tab-separated text, not either OCR model's
   markup. `unlimited-ocr/`'s prompt, given instructions to find HTML
   tables that don't exist in this input, appears to fail outright
   rather than degrade gracefully — explaining the total `rows: []`
   result. `deepseek-ocr/`'s more generic "test-name-then-value" framing
   at least partially matched, explaining its partial (if incomplete)
   success.

**Conclusion:** the reading stage (whichever OCR model, or the
text-layer shortcut) has been consistently accurate in every real test
so far. The categorization step is the confirmed, reproducible failure
point across every demo that uses a local Ollama model — driven by (a)
an already-known but never-fully-validated context-window bug, and (b)
prompts that assume a markup shape the input doesn't actually have
whenever the digital-PDF shortcut is taken. Neither is a reason to
distrust OCR quality; both are reasons to fix the categorization layer
before drawing conclusions from any of the accuracy numbers elsewhere in
this file that went through it.

## Cost comparison across every approach (Sept 2026)

A full cost/accuracy/implementation-difficulty comparison across all four
demos — plus two rule-based-only hypotheticals never built here — lives
in `ocr_cost_accuracy_comparison.xlsx` in this folder (not tracked by
git; a spreadsheet deliverable, not source). It has a live calculator
tab (edit volume/pricing assumptions, costs recalculate) and a sources
tab citing every price used. Headline numbers, INR, at the current
~225 reports/month (~1,350 pages/month) scale: Gemini ~₹0.20-0.48/page,
Sarvam Extract ₹0.50/page flat, Azure OCR ₹0.96/page, in-house GPU
(PaddleOCR+Ollama) ~₹2.40-6.72/page. In-house only wins past
~5,000+ pages/month. Re-derive this file rather than trusting these
numbers blindly if it's been a while — Gemini's pricing in particular is
scheduled to double on Jan 1, 2027.

## `sarvam/` demo — two confirmed working modes (lab report + MER questionnaire)

A fourth demo, `sarvam/`, was scaffolded (not by request to build a demo
specifically — it came out of investigating Sarvam AI as a cheaper/
Indian alternative during the cost-comparison work above) to directly
compare against `real/` (Gemini). Confirmed via Sarvam's public docs
(not yet via a live call) that their **Extract** endpoint
(`POST /doc-ai/v1/job/extract`, distinct from their OCR-only **Digitise**
endpoint) takes a document + a JSON Schema and returns structured fields
in one flow — architecturally the same "one call does OCR + structuring"
shape as Gemini's `responseSchema`, not just an OCR stage needing a
separate LLM/rules step like Azure. Same price as Digitise (₹0.50/page),
plus it returns a per-field confidence score Gemini doesn't give you.

**What's confirmed (from public docs, not a live call):** the endpoint
contract — async job (submit → poll `/status` → fetch `/results`), auth
via `api-subscription-key` header, base URL `https://api.sarvam.ai`,
schema passed as a JSON string with `type`/`description` per field, max
10 pages/job, pricing.

**Bug found and fixed (first real test):** the initial schema only put a
`description` on leaf fields (`test`, `value`, etc.) and on the `reports`/
`rows` arrays themselves, not on their `items` objects (or the root
object) — Sarvam's API rejected it with `field "reports": array items:
each field requires a non-empty description`. **Confirmed rule, now
documented at the top of `sarvam/extractor.js`:** every node in the
schema needs a non-empty `description`, including `object`/`array`
container nodes, not just leaf string/number fields. Fixed by adding a
description to the root object and to both `items` objects
(`reports.items`, `rows.items`). Not yet re-tested after the fix — do
that next, before anything else below.

**Bug #2 found and fixed (second real test, same session):** confirmed
the schema depth concern flagged above was real — Sarvam rejected the
nested `reports[].rows[]` shape with `field "reports": array items:
field "rows": array items: field "test": schema nesting may not exceed
4 levels` (root→reports→reports.items→rows→rows.items = 5, before even
reaching a leaf field). **Fix applied:** `SCHEMA` in
`sarvam/extractor.js` now asks for a single flat `rows[]` array (root→
rows→rows.items→leaf = exactly 4), where every row repeats its own
report-level fields (`report_type`, `lab_name`, etc.). A new
`groupRowsIntoReports()` helper re-groups that flat list back into the
shared `{ patient, reports: [{ ..., rows }] }` contract inside
`callSarvam()`, so nothing outside `extractor.js` had to change. **Not
yet confirmed:** whether Sarvam actually repeats report-level fields
identically on every row of the same report — if it varies them
slightly run to run, the grouping will incorrectly split one report
into several. Check real output for this once jobs actually complete.

**False alarm, corrected:** two earlier jobs (`01a0c392-...`,
`01a0c396-...`) against the same PDF sat in `status: "pending"` with
`usage.pages_total: 0` for several minutes of polling and looked
genuinely stuck (this file originally recorded that as a likely
account/platform-side stall). **That conclusion was wrong** — a third
job (`01a0c3a6-f5db-759f-8109-75130b434855`) against the identical file
also sat in `pending` for 208s, then completed successfully. Sarvam
jobs just take longer to leave `pending` than the old 3-minute polling
ceiling in `extractor.js` assumed — not stuck, just slow (job-queue
latency, not per-page processing time, since `pages_processed` stayed
at 0 the whole time it was `pending`). **Fix applied:** removed the
poll-loop timeout entirely (`extractor.js` now polls indefinitely with
a heartbeat log every ~16s) rather than guessing a longer fixed ceiling.

**First successful end-to-end run, confirmed (Sept 2026):** same 7-page
`mrs.babita khandelwal` document used throughout this file's PaddleOCR
testing. Total time from job creation to `completed`: ~210s (~3.5 min,
all of it spent in `pending` before the job ever started processing).
Results:
- **All 9 of 9 report panels captured** — CBC, ESR, HIV & Hepatitis B
  Screening, Biochemistry Profile, Renal Function Test, Liver Function
  Extended Panel, HbA1c Report, Urine Routine & Examination, Urine
  Cotinine Test. This is the same document where `paddleocr/`
  (`llama3.2:3b`, default 2048-token context) only ever captured 4-5 of
  9 panels due to context-window truncation (see that section above) —
  Sarvam Extract hit zero panels missing on this one real run, with no
  context-window tuning needed since it isn't a local-LLM-context-limited
  pipeline.
- **`groupRowsIntoReports()`'s core assumption held on this run:**
  Sarvam did repeat each report's `report_type`/`lab_name`/etc.
  identically across every row of that report, so the flat-list-back-
  into-nested-reports grouping worked correctly and produced exactly 9
  distinct report groups, matching the 9 real panels. Still only
  confirmed on one run/one document — the risk noted when the fix was
  applied (inconsistent report-level fields causing incorrect splitting)
  has not been ruled out on a second run or a different document yet.
- **Patient fields:** name, sex, patient ID all correct;
  `contact_number` came back empty (plausibly genuinely not printed on
  this report — the Gemini POC left it empty too on unrelated tests);
  `age` came back as `"59Years"` (no space) — a minor formatting quirk,
  not a placeholder/hallucination like the `qwen3:4b` experiments above.
- **No malformed-value artifacts observed** (no `"Oh 0.51 0.2-1.2"`-style
  garbling like the `llama3.2:3b` bug above) and **no boilerplate
  misclassified as a fake report** (the issue seen on the Redcliffe
  document under `llama3.2:3b`) — though neither of those specific
  documents/bugs has been re-tested against Sarvam yet, so this is
  encouraging but not a controlled comparison.
- **Minor OCR-level quirks observed** (plausible misreads, not
  structural failures): Platelet Count unit read as `"lacks/cumm"`
  (likely "lakhs/cumm"); ESR unit read as `"mm 1st Houe"` (likely "mm
  1st Hour").

**Net assessment so far:** one real run, but a strong one — full panel
coverage that PaddleOCR+Ollama has never achieved on this document, no
garbling, no fabricated fields. Nowhere near enough to call it
"confirmed accurate" (see Suggested Next Steps — needs repeat runs on
this document and a second document, same rigor applied to the
`qwen3:4b` experiment above, before trusting it further). The
`ocr_cost_accuracy_comparison.xlsx` accuracy rating for Approach 1b
(Sarvam Extract) should stay "unverified" until that happens, not be
upgraded off a single run.

**MER questionnaire extraction — second schema, confirmed working, now
built into the real demo:** the lab-report schema above is the wrong
shape for a Medical Examination Report (MER) — an insurance
underwriting questionnaire (Yes/No + numeric/free-text answers to
standardized questions), not a table of test/value/unit/range rows.
Tested against a real, previously-unseen file (`Dileep Kumar mer+report
.pdf`, 9 pages, 3.8MB) — notably the **first genuinely scanned PDF (no
embedded text layer) tested anywhere in this project**, so this also
validated Sarvam's real OCR-from-image path, not just the digital-PDF
text extraction every other test here has hit.

- **First run** (a one-off throwaway script, not yet part of the demo):
  **66 question/answer pairs** extracted — full vitals (height, weight,
  pulse, BP), the complete A-T medical-history Yes/No checklist,
  surgical/investigation history, and examiner's assessment. Confidence
  scores nearly all above 0.999 (lowest 0.9757). Correctly caught the
  one genuinely non-trivial answer in the form ("14. Is there any other
  history...?" → "Yes", with follow-up detail "Polio Right leg By Birth
  - 70%") rather than defaulting everything to "No" — a good sign
  against lazy pattern-matching.
- **Folded into the real demo** (not left as a throwaway): `extractor.js`
  now exports `MODES` (`lab` and `mer`), each with its own schema and
  its own response normalizer, selected via a `mode` option on
  `callSarvam()`. `server.js` reads `mode` from the upload form (default
  `lab`); `test-extract.js` takes it as an optional second CLI arg
  (`node test-extract.js "<file>" mer`); `public/index.html` has a
  radio-button document-type selector that sends it and renders a
  question/answer table instead of the lab report/rows table when
  `payload.mode === 'mer'`. This is a real second document type this
  demo now supports end-to-end, not just a schema variant tested once
  and discarded.
- **Second run, same file, through the real `MODES.mer` plumbing (not
  the throwaway script)** confirms the feature works end-to-end, but
  surfaced a real run-to-run difference worth tracking: **56 Q&A pairs
  this time, not 66.** Spot-checked cause: the first run had three
  separate "Blood Pressure (i)/(ii)/(iii)" entries (all `"126/76"`);
  this run consolidated them into one `"126 / 76"` entry. A few question
  labels were also phrased slightly differently ("Weight change status"
  vs. "Weight change within 12 months", "Auscultatory Examinations" vs.
  the longer printed version) — abbreviated, not wrong, but not
  byte-identical either. Same shape of instability already documented
  for `qwen3:4b` above (see "Field-boundary confusion" / "Metadata-field
  fabrication"), on a different model/vendor.
- **Net assessment:** same as the lab-report result above — a strong,
  promising first (and second) real result, not yet a validated one.
  Two runs is enough to know the count/phrasing isn't perfectly stable,
  not enough to know whether that instability matters for real use
  (missing a genuinely different answer would be serious; consolidating
  duplicate BP readings into one is probably fine). Needs a third run
  and a second MER document before trusting this further — same
  standard applied throughout this file.

**New regression (Sept 24, 2026): every job now fails post-processing,
likely a credits/quota gate, not a code or document problem.** Starting
this session, every Extract job — across both documents used throughout
this section, both modes, different page counts — fails with the
identical shape:

- Job creation succeeds, all pages process and **succeed individually**
  (`pages_succeeded` == `pages_total`, `pages_failed: 0`).
- The job as a whole finishes with `status: "failed"` within ~12-18s of
  creation (much faster than a real ~210s successful run).
- `/status` never returns any error message/reason field — just the same
  bare `{status, usage, created_at, updated_at}` shown above.
- `/results` on the failed job returns `409 RESULTS_NOT_READY: results
  are available only after the job reaches a terminal status` — even
  though `"failed"` is itself a terminal status per `extractor.js`'s own
  handling (`callSarvam()` already treats `failed`/`rejected` as
  terminal-with-error). This is either a genuine inconsistency in
  Sarvam's own API, or their definition of "terminal" for `/results`
  purposes excludes `failed` for some other reason not documented
  publicly.

**Four confirmed reproductions, no exceptions:**

| Job ID | Document | Mode | Pages | Result |
|---|---|---|---|---|
| `01a0d25c-6040-...` | `mrs.babita khandelwal...pdf` | lab | 7 | failed, 7/7 pages succeeded |
| `01a0d25f-3292-...` | same (user resubmit) | lab | 7 | failed, 7/7 pages succeeded |
| `01a0d279-5dae-...` | same (re-run to investigate) | lab | 7 | failed, 7/7 pages succeeded |
| `01a0d279-e4b2-...` | `Dileep Kumar mer+report.pdf` | mer | 9 | failed, 9/9 pages succeeded |
| `01a0d27f-d7d6-...` | `babita_page1.png`, minimal 1-field schema, raw probe (no `extractor.js`) | n/a | 1 | failed, 1/1 pages succeeded |

Ran across two completely different documents, two different schemas
(`LAB_SCHEMA` and `MER_SCHEMA`), and two different page counts — both
documents had **previously succeeded** on this exact same code path
(lab: 9/9 panels; MER: 66 then 56 Q&A pairs — see above). Nothing in
`sarvam/extractor.js` or the schemas changed between the successful runs
and this regression.

**Credits ruled out** — checked the Sarvam dashboard directly, balance
is fine. **A 5th reproduction with a deliberately minimal, isolated
request (bypassing `extractor.js` entirely — a throwaway raw-`fetch`
probe script, deleted after use) also failed identically**: a single
1-page PNG (`unlimited-ocr/babita_page1.png`), a trivial one-field
schema, no `sarvam/extractor.js` code involved at all — still
`pages_succeeded: 1/1` then `status: "failed"` within ~8s. This rules
out document size, page count, and schema complexity/depth as the
cause — a request this trivial failing the same way as a 9-page/
multi-field one means the failure is **account- or API-key-level, not
input-dependent**.

**Checked and ruled out via research (Sept 24, 2026), not just
guesswork:**
- Sarvam's public status page (status.sarvam.ai) shows no incident,
  "fully operational," 99.97% uptime for Document Digitization over the
  reporting period.
- No public GitHub issue, docs page, or FAQ entry describes this exact
  failure shape (terminal `"failed"` + 100% pages succeeded + `/results`
  refusing with a self-contradictory `RESULTS_NOT_READY`, since `"failed"`
  is itself documented as a terminal status). The closest related issue
  (`sarvamai/sarvam-mcp#64`) is a different endpoint family
  (`doc-digitization`, not `doc-ai`) and a different symptom (missing
  `output_storage_path` on a *completed* job, not a failed one).
- Docs confirm inline per-request JSON schemas (what `extractor.js` uses)
  are still a supported, current way to call Extract — not a deprecated
  path requiring a pre-approved dashboard Config/template instead.

**Conclusion: this is very likely a bug or an account-specific issue on
Sarvam's backend, not something fixable from this codebase.** Next step
is contacting Sarvam support (support@sarvam.ai) with the job IDs below
— nothing further can be diagnosed from the client side. No code change
is warranted here until support responds; if they confirm a cause,
document it here before making any fix.

**Update, same day: self-resolved, confirmed transient.** A later run
against the same code (no code changes made anywhere in `sarvam/` during
the entire investigation — `extractor.js`/`server.js`/`test-extract.js`
all still show their Sept 21 creation timestamp) succeeded through the
real web UI, but took **~10 minutes** — roughly 3x the ~3.5 min a healthy
run took previously. This is consistent with the 5 failures above being
early aborts during a genuinely degraded window on Sarvam's backend
(consistent with the ~8-18s fast-fail pattern: the service was rejecting
work quickly rather than queuing it, until whatever was wrong cleared and
requests started taking longer-than-normal but succeeding). **Not yet
confirmed as fully stable** — this is one successful run after 5
failures, not proof the underlying issue won't recur. Worth keeping an
eye on response times for the next several real runs; if 8-10 minute
runs become the new normal (vs. the old ~3.5 min baseline) that's worth
asking Sarvam support about even though functionality has recovered.

**API key handling:** a Sarvam API key was shared in chat during this
session (not committed to any file) for the user to test with directly.
It was also briefly written into `sarvam/.env.example` (which, unlike
`.env`, is NOT gitignored) before being caught and reverted to a
placeholder in this same session — nothing was committed in that window
(`sarvam/` was untracked the whole time), but treat the key as exposed
regardless and regenerate it from the Sarvam dashboard once testing is
done, same as any key that's ever appeared in a chat transcript.

## Repo structure

This folder (`OCR/`) is its **own standalone git repo**
(`github.com/laliTS14/OCR`, private) — `git init` was run directly
inside `OCR/`, with `origin` pointing at that GitHub repo. This is the
**only** place OCR work is committed.

The parent `alphonsol-PIMS` repo initially also tracked a copy of
everything under `OCR/` (mirroring how `backend/`/`frontend/` are still
dual-tracked there today) — that's been deliberately undone:
`OCR/` was untracked from the root repo (`git rm -r --cached`, files
left on disk) and added to the root `.gitignore`. The root repo's git
*history* still has old snapshots of `OCR/` files from before this
change, but nothing new here will show up there going forward, and nothing
needs to be committed there — **only commit and push from inside `OCR/`
itself.**

## Open issues (not yet resolved)

1. Missing panels on digital PDFs (context-window truncation) — fix
   exists, not applied, trade-off not fully validated (see bug #3).
   **Now confirmed on `deepseek-ocr/` and `unlimited-ocr/` too** (both
   inherit the same un-overridden `ollama.js` default), via a real
   side-by-side run showing only the *last* few sections of a long
   digital-PDF report survive categorization — see "Categorization
   confirmed as the real bottleneck" above. `unlimited-ocr/`'s prompt
   also has a second, distinct failure on this same input: it assumes
   HTML `<table>` markup that doesn't exist on the text-layer shortcut
   path, and returns zero rows rather than degrading gracefully.
2. Malformed values (`"Oh 0.51 0.2-1.2"` style artifacts) — observed,
   cause not isolated.
3. Boilerplate/legal text getting misclassified as a fake report
   section — observed once, no fix attempted yet.
4. PaddleOCR's actual reading-stage output has still never been fed into
   Ollama end-to-end and checked for quality — every real-report test so
   far has hit the digital-text-layer shortcut. The scanned-page RAM
   crash (see `paddleocr/README.md`) also hasn't been re-tested since
   the RAM upgrade.
5. Not integrated with the main backend/frontend at all yet.
6. `sarvam/`: both modes have succeeded on a first real run (lab: 9/9
   panels, no garbling; MER: 66 then 56 Q&A pairs across two runs — see
   the sections above), but that's still only one or two runs per mode,
   both on the same one document per mode. Not yet confirmed:
   consistency across more repeat runs, behavior on a second document
   per mode (esp. one that exposed a `llama3.2:3b` bug above, e.g.
   Redcliffe's boilerplate misclassification, for lab mode), whether
   `groupRowsIntoReports()`'s report-level-fields-repeat-identically
   assumption holds under more testing, and whether MER mode's
   run-to-run question-count variance (66 vs. 56) ever drops a real
   answer rather than just consolidating duplicates. **Currently blocked
   (Sept 24, 2026): every job now fails post-processing (see "New
   regression" in the sarvam/ section above) — 4/4 reproductions across
   both documents/modes, likely a credits/quota gate, not yet confirmed
   against the Sarvam dashboard. No further sarvam/ validation is
   possible until this clears.**
7a. `regex-based/` has only ever been run against one document (the same
    `mrs.babita khandelwal` PDF used throughout this file) — not yet tested
    against a second document, a differently-formatted report from the same
    lab, or a genuinely scanned (non-digital) file. By design it will
    silently misparse anything that doesn't match the one template its
    regexes were written against — this is expected, not a bug to fix, but
    worth remembering before assuming its 14/14-panel result generalizes.
7. `deepseek-ocr/`'s reading stage (DeepSeek-OCR itself) gives
   inconsistent quality across identical repeated calls on the same
   image — confirmed across 3 real attempts: one clean/correct, one that
   fell into a repetition loop, one that completed normally but with
   concatenated words and misattributed values. The categorization
   prompt was already rewritten for DeepSeek-OCR's actual output shape
   (see "`deepseek-ocr/` demo" above) and a deterministic dedup safety
   net added for the repetition-loop case — both are real, verified
   improvements, but neither can fix a reading-stage result that's
   simply wrong. Not yet root-caused; needs more repeated samples of the
   same image to know the real failure rate before deciding if this
   approach is viable at all on this hardware.

## `unlimited-ocr/`: selective per-report categorization flow (Sept 25, 2026)

Built as a direct alternative to "just apply `num_ctx: 8192`" for fixing the
missing-panels/context-truncation bug (see "Categorization confirmed as the
real bottleneck" above) — instead of giving the model a bigger window and
paying ~3x the time, split the document into pages up front and only ever
categorize the page(s) behind whichever single report the user picks. Full
detail (architecture, prompt, confirmed test results) is in
`unlimited-ocr/README.md`'s new "Selective per-report categorization"
section — summary here:

- New `unlimited-ocr/sections.js`: `splitIntoPages()` (reuses the page
  markers both reading paths already emit — no new parsing dependency) +
  `identifyReports()` (one cheap per-page Ollama call, `identifySections()`
  in `ollama.js`, asking only "what report names are on this page") +
  `getTextForSection()` (rebuilds a reduced OCR dump for just the picked
  section's page(s)).
- New routes `POST /api/identify-reports` (triage+read+identify, returns a
  `sessionId` + section list) and `POST /api/categorize-report`
  (`{sessionId, sectionId}` → categorize+validate just that section).
  `/api/extract` (full-document, unchanged) still exists alongside these.
- Frontend gained a 5th pipeline stage ("Select report") between Reading and
  Categorize — a radio-button picker over the identified sections.
- **Confirmed on the same `mrs.babita khandelwal` document used throughout
  this file's truncation testing:** the identify step saw all 7 pages (vs.
  4-5 panels surviving under the old full-document flow), and categorizing
  the CBC panel (previously 0/24 rows under the full-document flow) came
  back with **22/22 real test rows correct** when scoped to just its own
  page. This is the first confirmed fix for the missing-panels bug on this
  document, for whichever section is selected — `num_ctx: 8192` (item 0a
  below) is still untried/unvalidated as an alternative fix.
- **Two real gaps found, not fixed by this change (pre-existing
  `llama3.2:3b` issues, not new ones):** unit/range field-boundary confusion
  on the categorized rows (same category as the `"Oh 0.51 0.2-1.2"`-style
  bug logged above — a value ended up in `unit`, `range` came back `"None"`
  instead of empty), and the identify step itself hallucinating section
  names onto pages that don't contain them, plus not deduping near-identical
  names for the same test appearing across pages (e.g. "CBC FEMALE (
  COMPLETE BLOOD COUNT )" and "Complete Blood Count" show up as two separate
  picker entries instead of one). Worth a fuzzy-name-merge pass before
  relying on the picker for a document with many near-duplicate section
  mentions.

## `regex-based/`: seventh demo, zero-LLM categorization (Sept 28, 2026)

Grew directly out of a real timing measurement taken while benchmarking
`unlimited-ocr/`'s selective flow (above) against the same
`mrs.babita khandelwal` document: extracting raw text took **0.1s**, while
organizing (per-page identify) and categorizing (Ollama) took **~140s** and
**~150-235s per section** respectively — the LLM calls, not reading, are
where all the time goes. User asked directly whether a plain regex approach
would be faster; the answer, confirmed, is dramatically yes — see the new
`regex-based/` folder (full architecture/trade-off writeup in its own
README.md section).

**What it is:** structurally a fork of `unlimited-ocr/` with only the
categorization stage swapped. `triage.js` and `unlimitedocr.js` are copied
unchanged and this demo's `.env` points `UNLIMITED_OCR_URL` at the **same
already-running** Python microservice `unlimited-ocr/` uses — no second copy
of the 6.67GB model. The one new file, `regexCategorize.js`, replaces
`ollama.js` entirely: report boundaries are found via this template's own
`"<name> Sample Tested In : <specimen>"` marker, and each row is parsed by
one of three shapes (numeric-with-known-unit, qualitative-trailing-phrase,
or embedded-numeric-in-one-cell — e.g. `"pH 6.0 4.7 -7.5"`). Fully
synchronous, no network call, no model.

**Explicit instruction, followed exactly:** no LLM fallback was built —
this is deliberately pure-regex-or-nothing, per the user's direct request,
not a hybrid.

**Confirmed via a real run (same document used throughout this file's
truncation testing):** total pipeline time **~130-140ms** end to end
(triage ~120ms — mostly `pdf-parse` overhead — reading ~2ms since this hit
the digital-text shortcut, categorize ~10ms, validate ~2ms). That is
**>1000x faster** than `unlimited-ocr/`'s equivalent categorization time.
**All 14 real report panels found, 57 rows total**, 41 validated as
numerically normal automatically — a small parsing gap found and fixed
during the same session (2-cell rows with an embedded numeric value like
`"pH 6.0 4.7 -7.5"` or `"Specific Gravity 1.015 1.003 -1.035"` were
initially falling through empty; added a second embedded-numeric pattern
alongside the qualitative-phrase one, confirmed fixed by re-running). Field
quality on numeric rows matched or beat the LLM approach's best runs on
this same document (CBC's `unit`/`range` came out correctly split on every
row, something `llama3.2:3b` got wrong on more than one run above).

**The trade-off, stated as plainly as everywhere else in this file:** none
of this generalizes. Every regex — the report-boundary marker, the known-
unit list, the qualitative-phrase list — is written against exactly one
lab's template (Helpline Pathology / MAX LIFE, the same document tested
throughout this project). A report from a different lab, or even a
differently-formatted report from the same lab, will silently return wrong
or empty output rather than an error, because nothing here is reading or
reasoning about the text — it is pure pattern matching. This is the precise
brittleness every other demo in this file chose an LLM to avoid. Not yet
tested against a second document or a scanned (non-digital) file at all —
only the one digital PDF used throughout this session.

## `llama.cpp` server experiment: does a different serving engine fix the context problem? (Sept 28, 2026)

Direct follow-up to "can we use a model with more context that categorizes
better than Ollama" — tested whether swapping Ollama for `llama.cpp`'s own
server (`llama-server.exe`), with an explicit large context window instead
of Ollama's silent 2048-token default, actually solves the missing-panels
problem. **Conclusion: no — it trades one failure mode for a worse one.**
Not adopted; no code in any demo folder was changed. Kept here as a real,
now-answered question so it doesn't get re-asked from scratch later.

**Setup (no new download of model weights needed):** Ollama caches its
models as plain GGUF files under `~/.ollama/models/blobs/` — confirmed by
reading the `llama3.2:3b` manifest and checking the corresponding blob's
magic bytes (`GGUF`, correct file size). Downloaded a prebuilt
`llama-server.exe` (llama.cpp release `b11227`, Windows CPU x64 build,
~19MB zipped) and pointed it directly at that same cached blob — same
model, same weights Ollama already had, zero duplication. Started with
`-c 16384` (8x Ollama's default) and confirmed via the server's own startup
log (`n_ctx_slot = 16384`) and its OpenAI-compatible
`/v1/chat/completions` endpoint's `response_format: json_schema` support
(tested working with a trivial schema first).

**Bug found and fixed immediately, same category already documented
multiple times in this file:** the first test script used Node's plain
global `fetch()`, which died with `UND_ERR_HEADERS_TIMEOUT` at ~5-6 minutes
— the identical undici-headers-timeout bug already fixed in `ollama.js`/
`unlimitedocr.js` elsewhere in this project, just freshly reintroduced in a
new script that didn't know to avoid it. Fixed the same way: `undici`'s own
`fetch` with a `{ headersTimeout: 0, bodyTimeout: 0 }` `Agent`.

**Real result, same document (`mrs.babita khandelwal`, the same
15,491-character digital-text dump used throughout this file's Ollama
testing), same `paddleocr/`-style prompt (chosen deliberately over
`unlimited-ocr/`'s HTML-table-specific prompt, since this is a plain-text
input — using the wrong prompt would make this an unfair test):**
- Prompt: 4,980 tokens — confirms the input alone is over 2x Ollama's
  default 2048-token cap, so this really is a case the default-context path
  would truncate (consistent with everything already found in this file).
- **Total time: 1,757,693ms ≈ 29.3 minutes.**
- **`completion_tokens` hit exactly 4096 — the `max_tokens` ceiling — before
  the model finished writing the JSON.** The result was an incomplete,
  unparseable JSON fragment (`SyntaxError` on `JSON.parse`), not a partial-
  but-valid categorization. Generation speed was measured directly from the
  server's own per-request log: a steady ~2.9 tokens/second throughout,
  confirmed consistent across two separate attempts (the killed one and the
  completed one, which reused the first one's cached prompt via the
  server's own prompt-cache similarity matching).

**The actual conclusion, and why this matters beyond just "it's slow":**
Ollama is itself built on `llama.cpp` — they share the same underlying
inference engine, not two different implementations with different speed
characteristics. Switching serving engines doesn't buy a faster CPU
inference path; it only changes which context-size default gets applied.
Raising the context to 16384 here did remove the *input* truncation (the
model saw the whole document, confirmed by the 4,980-token prompt count
matching the full text), but it did **not** produce a usable result anyway,
because `llama3.2:3b` at ~2.9 tok/s on this CPU-only machine simply cannot
generate a full ~14-panel, ~57-row structured JSON response inside a
reasonable token budget or time budget. This reframes something the
`num_ctx: 8192` Ollama experiment (documented earlier in this file) already
hinted at but never confirmed to completion: **the bottleneck on this
hardware is not really "the context window is too small," it's "this
model+hardware combination is too slow to produce the full output even
once it can see the full input."** A larger `max_tokens` budget would only
make this specific run take even longer, not fix it — the generation rate,
not the budget, is the constraint.

**What this does NOT rule out** (real, not-yet-tried alternatives, still
worth considering separately): a larger/more capable model that generates
more efficiently per test row (untested here — this experiment kept
`llama3.2:3b` fixed to isolate the serving-engine/context variable), a GPU
(would change the ~2.9 tok/s figure entirely — this machine has none), or
narrowing what's asked per call (exactly what `unlimited-ocr/`'s selective
per-report flow and `hybrid-ocr/`'s regex-first routing already do — both
sidestep this exact problem by never asking one LLM call to produce the
*entire* document's structured output at once).

## `hybrid-ocr/`: eighth demo, regex-first with confidence-scored LLM fallback (Sept 28, 2026)

Direct answer to "what can we try now that regex is fast but brittle" —
built as **approach #1** of three options discussed (confidence-scored
hybrid, template library, LLM-assisted regex authoring). Structurally a
fork combining `regex-based/` (the fast path) and `unlimited-ocr/` (the
general fallback path), plus one new file, `confidence.js`, that decides
between them per document.

**How it works:** triage + read (shared, same as every other demo) →
`regexCategorize.js` always runs first (a copy of `regex-based/`'s, with
one addition — it now also returns which tier matched, `A` or `B`) →
`confidence.js` scores that result → if the score is below 0.6, the
*same* Ollama `categorize()` from `unlimited-ocr/ollama.js` runs as a
fallback and its result is used instead → validate, same as always.
`regex-based/` itself was NOT changed — it remains the pure, no-fallback
proof of concept it was built as; this is a separate demo layered on top
of both existing approaches.

**Confidence scoring (`confidence.js`)** — calibrated directly against
the 3 real documents already used throughout this session's testing, not
guessed at:
- Starts at 1.0, docked 0.35 automatically for Tier B (the generic
  cross-template fallback, inherently less reliable than Tier A's exact
  template match).
- Further penalties: >35% of report sections generically named `"Report"`
  (-0.25), >60% of report sections empty (-0.2), fewer than 2 rows per
  non-empty report section on average (-0.25 — this one signal alone
  cleanly separated the real failure from the real success, see below),
  2+ of the 4 core patient fields empty (-0.2). Zero reports or zero rows
  at all short-circuits to a score of 0 immediately.
- Threshold: recommend the LLM fallback below 0.6.

**Confirmed on all 3 documents, exactly as calibrated:**
- **Helpline (Babita)** — Tier A, score **1.00** → stayed on the fast
  path. 14 reports, 57 rows, ~130ms total, no LLM call.
- **K Naresh Naidu** — Tier B but clean (29% generic, 57% empty but
  4.17 rows/section on the ones with data), score **0.65** → stayed on
  the fast path. 14 reports, 25 rows, no LLM call — the generic tier's
  output here was genuinely good, and the confidence check correctly
  recognized that rather than blindly escalating every Tier-B result.
- **Redcliffe** — Tier B and noisy (41% generic, 68% empty, only 1.43
  rows/section), score **0.00** → correctly escalated to the LLM
  fallback. The LLM path took ~122s and returned 2 reports / 3 rows
  (Vitamin D, TSH, Total Protein) — a *different* subset of the
  document's real data than the regex path had found (8 rows: RBC Count,
  Lymphocytes, Creatinine, Vitamin D, Hemoglobin, PCV, MCV, Mentzer
  Index), and with the LLM path's own already-documented quality issues
  reappearing (`age: "How old is Mr Lalit Pahadiya?"` — a nonsensical
  echoed question rather than a value; `patient_id` merged two different
  ID numbers together). The hybrid didn't fix the LLM's known flakiness,
  it only decided correctly that the regex path wasn't trustworthy enough
  to use as-is — a different, narrower promise than "give the best
  possible answer."

**One real bug found and fixed during this build:** `test-extract.js`
declared its LLM-timing variable (`const t5`) inside the
`if (confidence.recommendFallback)` block, then referenced it outside that
block's scope while computing the final timings summary — threw
`ReferenceError: t5 is not defined` after validation had already
succeeded (confirmed via the Redcliffe test run: `04_validated.json` was
written correctly, then `ERROR.json` appeared from the timing-calculation
crash). Fixed by deriving the validate-stage start time from `pathTaken`
instead of a variable that's out of scope on the fast-path branch.

**Net assessment:** confirms the hybrid design works as intended — fast
for genuinely-well-matched documents (including some Tier-B ones, not
just Tier A), and it correctly declines to trust a bad regex result
rather than returning it. It does NOT fix the LLM fallback's own known
accuracy issues (documented at length elsewhere in this file) — the
fallback is only as good as `unlimited-ocr/`'s existing categorization,
which still has real gaps. Only tested on 3 documents so far; the
threshold and penalty weights in `confidence.js` are a first calibration,
not proven — see that file's own header for the exact numbers and the
explicit note to re-calibrate against more real documents before trusting
it further.

## `num_ctx: 4096` + `qwen2.5:3b` vs `llama3.2:3b`, per-page (Sept 28, 2026)

**Code change (active):** `unlimited-ocr/ollama.js` now sends
`options: { num_ctx: NUM_CTX }` on both `categorize()` and
`identifySections()` (`NUM_CTX` = `OLLAMA_NUM_CTX` env, default **4096**),
and logs Ollama's own `prompt_eval_count`/`eval_count` on every call, with a
`⚠ PROMPT TRUNCATED` warning when the prompt fills the window. The token
counts are also attached to `categorize()`'s result as a non-enumerable
`tokenUsage` property (so it never leaks into the output JSON). Default
model is **unchanged** (`CATEGORIZE_MODEL`, still `llama3.2:3b`).
`hybrid-ocr/ollama.js` (a copy) and `paddleocr/`/`deepseek-ocr/` were NOT
changed.

**Why 4096 and not 2048, even per-page:** measured per-page prompts were
896-1622 tokens (fit in 2048), but prompt + output reached **2821 tokens**
on the CBC page — i.e. under the old default the model was running out of
window *while writing its answer* on the biggest pages. 4096 covers every
page with room to spare; no page came close to truncating.

**Test:** the Babita 7-page document's text-layer dump
(`unlimited-ocr/logs/2026-09-25T06-46-56…/02_extracted_text.txt`), split
with `splitIntoPages()`, one `categorize()` call per page, same prompt,
same `num_ctx`, run back-to-back (never concurrently). Scored against
`regex-based/`'s 57 non-empty rows for this document by test-name match +
value match (scorer is approximate — a few "wrong" entries are name
collisions, e.g. urine "Bilirubin" matching serum bilirubin; the reference
itself misses Glucose Fasting/TG/HDL values, so neither model was scored on
those). One run per model — sampling variance between identical runs is a
known issue here (see Accuracy section), so treat as indicative.

| | `llama3.2:3b` | `qwen2.5:3b` |
|---|---|---|
| Total time (7 pages) | 780s (~13.0 min) | 560s (**~9.3 min**) |
| Rows returned | 101 (lots of junk/duplicates) | 67 |
| Reference tests found | 45 / 57 | **52 / 57** |
| Values correct | 34 / 57 (~60%) | **45 / 57 (~79%)** |
| Empty values | 15 | 6 |
| Other quality | `"None"` in unit/range, `"*"` as values, `* ` prefixes on test names, 3 HIV duplicate sections, invented values (Albumin 4.2 vs real 3.8) | Clean unit/range split, real section names (HAEMATOLOGY/SEROLOGY/…); still some errors (MCHC took MCH's value, A/G ratio took Albumin's) |

Per-page time is dominated by **output** tokens (~6-7 tok/s generation on
this CPU): the CBC page cost ~170s on both models because both had to write
~900-1200 tokens of JSON; pages with short answers took 30-60s on qwen.

**Conclusion:** `qwen2.5:3b` is a clear win over `llama3.2:3b` on this
per-page setup — faster *and* more accurate, unlike the reverted `qwen3:4b`
experiment. It is still well below `regex-based/`'s result on this
document (~130ms, all numeric rows correct) and ~9 minutes is still slow,
so it fits as the *fallback* in the rules-first design, not the main path.
Not yet switched as the default; not yet run on Redcliffe / K Naresh Naidu.

## `unlimited-ocr/`: select-first flow — pick report types, extract only those (Sept 29, 2026)

User's idea: skip section detection entirely; the user ticks report types
(multi-select) first, and only those sections are located and categorized.
Built as `/select.html` + `GET /api/report-types` + `POST
/api/extract-selected` (architecture in `README.md`'s "Select-first flow").
New files: `reportCatalog.js` (14 types + heading synonyms + non-selectable
boundary headings), `selectReports.js` (pure string matching, no LLM).
The identify-first flow and `/api/extract` are unchanged.

**Section location (no LLM) — checked on all 3 real documents:** ~3-16ms
per document. Helpline/Babita: 11/14 types found, all correct, the 3
missing (Thyroid/Vitamin/HCV) genuinely absent. Redcliffe: correct
detailed-result sections chosen over its summary-page duplicates. K Naresh
Naidu (third template, never tuned for): every present type found and cut
cleanly. Tuning needed along the way: Redcliffe's patient block repeats on
only ~half its pages (repeated-line threshold lowered to 30%, min 3
pages); "Total Protein"/"Ferritin" etc. had to be added as headings/
boundaries or the previous section ran on into them.

**Serious bug found and fixed — data leaking from the prompt into another
patient's record.** First Redcliffe run returned `patient_id: "R-002301"`
and Hb `13.6` — both **Babita's** values, which `unlimited-ocr/ollama.js`'s
HTML-table prompt quoted as examples. The model copied them when the input
didn't match the prompt's expected shape. Fixes (all active):
1. New `buildSectionPrompt()` for this flow (plain-text sections, no real
   example values; `categorize(text, { sectionLabel })`).
2. The original prompt's example values replaced with placeholders
   (`<id>`, `<value>`) — no structural change to that prompt.
3. **Source check** in `server.js`'s merge: every returned value/patient
   field must literally appear in the text sent to that call, else it's
   blanked, tagged `source_check`, listed in `stages.sourceCheck.removed`,
   and shown as a warning in the UI. Unit-tested against the exact leaked
   values; would have caught both.
Also in the merge: rows repeated verbatim are dropped, and a range glued
into `value` (`"4.8 4.2 - 6.5"`) is split back out.

**End-to-end, `qwen2.5:3b`, `num_ctx` 4096, after the fixes (one run
each):**
- Babita, CBC+LFT+HbA1c+Thyroid → 227s. Thyroid "not found" (correct).
  LFT **12/12**, HbA1c 2/2 clean, patient name/age/sex correct. CBC 17/22 —
  dropped the 5 DLC % rows this run, although the run before the prompt
  change got 22/22 from the same text: model variance, not location.
- Redcliffe, CBC+Vitamin+Thyroid+HIV → 279s. HIV "not found" (correct).
  CBC 26 rows, all values correct (Hb 8.8); Vitamin B12/D and TSH correct.
  Patient ID first came back as the barcode — the patient block sits
  *below* the results in Redcliffe's text order, so it wasn't in the header
  sent. Fixed (patient-field lines from later on the page are included when
  none are above the section); re-run: name/age/sex/patient ID all correct.
- Source check removed nothing on these runs (nothing was invented).

**Remaining issues:** time is still dominated by output tokens (CBC alone
116-207s); the model paraphrases test names (adds "(Red Blood Cells)"
etc.) despite the "copy exactly" rule; row recall varies run to run
(CBC 17 vs 22). A rules/dictionary row parser for located sections, with
the LLM only as fallback, is the natural next step — sections are now
small and cleanly cut, which is exactly what such a parser needs.

## Design rule for the rules-based parser — read before changing it (Sept 29, 2026)

Explicit direction from the user: **the goal is maximum categorization
across many DCs and many report types, not 100% on any one report. ~80%
universal accuracy is fine.** Rules tuned to individual reports make the
parser fit the few files we've seen and get worse on the rest. So:
- Only add **universal** knowledge: standard units, qualitative results,
  test names/synonyms, generic layouts — things true of lab reports in
  general.
- **Never** add a rule, synonym or unit just to fix one report (a lab's
  typo, one template's quirk). Change something only when the same pattern
  shows up across multiple labs, and judge changes by results over a batch
  of reports, not one file.
- Accept imperfect rows on individual reports. Following this rule, the
  single-report typo entries added earlier the same day were removed
  (`triglyceridrs`, `mm 1st houe`, `urine continine test`, `nicotin
  cotinine`, and a typo-tolerant triglyceride heading regex). Row counts on
  all 4 reports stayed the same; the only visible cost is Babita's ESR row
  showing the lab's own typo `mm 1st Houe` as its name (value and range
  still correct).

## Faster OCR on CPU: quick-pass idea dropped, RapidOCR (ONNX) benchmarked (Oct 1, 2026)

**Why:** a 10-page scan with one report selected still took ~4-5 min — every
page needing OCR is OCR'd before page classification, and selection only
filters afterwards.

**Measured where the time goes** (PaddleOCR mobile, this CPU): finding text
boxes ~1 s/page; **reading them ~0.24-0.37 s per box = ~97% of the time**.
So shrinking the image doesn't help (800 px ≈ same time), and a cropped
"quick first pass" was rejected: top-40% missed 12 report types on 15 pages,
left-35% missed 6 and cut words in half (`CHOLESTERO`) because column
positions vary by lab. The crop options were removed from
`paddle_text_service.py` again.

**RapidOCR** (same PP-OCR model family on ONNX Runtime; `rapidocr-onnxruntime`
1.4.4 + `rapidocr` 3.9.2 in a **separate** venv `paddleocr/.venv-rapid` — it
needs a different OpenCV than the PaddleOCR venv), same skew correction +
line rebuilding, same 15 pages, compared with the same script:

| | PaddleOCR mobile (current) | RapidOCR, default Chinese rec | **RapidOCR + English PP-OCRv3 rec** |
|---|---|---|---|
| time / page | 31.6 s | 8.9 s | **7.5 s (~4.2× faster)** |
| rows (high) | 121 (109) | 121 (70) | **124 (111)** |
| same value as Unlimited-OCR | 99 | 58 | **99** |
| different value | 1 | 1 | 2 (both parser labelling, not OCR) |
- The default Chinese rec model drops spaces between English words
  (`SerumProteinTotal`) → names don't match the dictionary. The English
  model (`en_PP-OCRv3_rec_infer.onnx`, 8.97 MB, from huggingface.co/SWHL/RapidOCR
  into `paddleocr/onnx-models/`, gitignored) fixes that; detector = the
  ch_PP-OCRv4 det bundled with rapidocr-onnxruntime.
- The like-for-like model (`en_PP-OCRv5_rec_mobile`, what PaddleOCR uses)
  exists only on ModelScope, which **times out from this network**;
  converting our own model with `paddle2onnx` fails on this Windows/Paddle
  3.3.1 setup (DLL load error — plugin uninstalled again).
- The English charset has no `µ`, so `µ/L` reads as `/L` → added `/l` to
  the unit vocabulary (a legitimate per-litre count unit anyway).
- Every value disagreement checked against the page text: RapidOCR read
  them correctly; differences were dictionary labelling — fixed generically:
  `LDL Chol/HDL Chol Ratio` and `Total-C/HDL-C` synonyms (token-set matching
  had labelled them as the other cholesterol ratio / HDL).
**Switched (Oct 1):** `paddle_text_service.py` now takes `OCR_ENGINE=rapid`
(default, runs in `.venv-rapid`) or `paddle` (runs in `.venv`); each engine's
library is imported only when selected. OCR caches are per engine
(`ocr-cache/rapid/`, `ocr-cache/paddle/` — the earlier PaddleOCR pages were
moved there), so switching never mixes results.
**Whole sample folder re-run with RapidOCR:** 57 pages OCR'd in **375 s
(6.6 s/page)**, whole run ~7 min (was ~22 min of OCR with PaddleOCR);
**392 rows, confidence 359 high / 31 medium / 2 low** (PaddleOCR: 383 rows,
355/24/4). Dileep's patient now complete (name/age/sex). A smoke test then
showed a junk row `(document start) = 9001` — the leading block's placeholder
heading line was being parsed as a test name; `documentParser.js` and
`pageClassifier.js` now pass an empty heading line instead. After that fix:
**391 rows, 359 / 30 / 2** (unlimited-ocr batch: 323 rows, 306 / 15 / 2). Caveat: the English
rec model is PP-OCRv3 (older than PaddleOCR's v5) — equal on these files;
keep an eye on it as more labs are added (`batch-eval.js` with each engine).

## `paddleocr/` rebuilt as the default pipeline, PaddleOCR as its OCR engine (Sept 30, 2026)

User direction: integrate PaddleOCR as default, same approach as
`unlimited-ocr/`. Done:
- `paddleocr/` now holds a copy of `unlimited-ocr/`'s whole pipeline
  (per-page reading, page classification, whole-document rules parser,
  dictionary, catalog, header parser, text normalizer, source check,
  `/select.html`, `batch-eval.js`). The previous PP-Structure + full-document
  LLM version (with its uncommitted changes) was moved to
  `paddleocr/legacy/` — nothing deleted.
- New OCR engine `paddleocr/paddle_text_service.py` (port 8794): PP-OCRv5
  mobile text OCR, skew correction, line rebuilding with tabs for column
  gaps. Client `paddleText.js` (same exports as `unlimitedocr.js`).
  `ollama.js` here always uses the plain-text section prompt; the model name
  is read from `CATEGORIZE_MODEL` or this folder's existing `OLLAMA_MODEL`.
  `test-extract.js` rewritten to run the new pipeline (no LLM).
- The shared parser files are kept identical in both folders; fixes made
  during this work were applied to both.

**Full sample folder through `paddleocr/` (all 10 files, OCR only where
needed):** 55 pages OCR'd in 1326 s (**avg 24 s/page**); **383 rows,
confidence 355 high / 24 medium / 4 low**. AMOL (32 pages, never read
before) turned out to include real lab pages: CBC 15, LFT 7, Lipid 7, KFT 3,
Urine 13, HIV, Glucose — its TMT/ECG pages classify as other/MER.
General fixes found on this run (both copies): any label naming both age
and sex/gender is the combined field (OCR read `DOB/Age/Gender` as
`DOR/Age/Gender`, and age was being taken from "Age > 19 years" in notes);
a test name must contain a real word (3+ letters) or be a known short test
(pH, Hb) — drops OCR noise from graph pages (`22A192 2a0-1900272`).
Remaining low/medium rows: lab typos (kept under Other), lab-printed wrong
units, Prahlad's garbled last page, a few OCR misreads (`Cclour`).

## PaddleOCR vs Unlimited-OCR on the same 15 scanned pages (Sept 30, 2026)

Why: Unlimited-OCR is a vision-language model generating text token by
token — ~2.5-5 min/page on this laptop CPU (i5-1145G7, 4 cores, 16 GB, Intel
Iris Xe, no CUDA GPU). Tested classic PaddleOCR (PP-OCRv5 **mobile** det +
en rec, text only, `paddleocr/.venv`, paddleocr 3.7 / paddle 3.3.1) on the
15 pages Unlimited-OCR had already read (Dileep 3, VARINDER 2, RAMANBHAI 10),
rendered at the same 1600px. Lines are rebuilt from text boxes (same line =
close vertical centres; wide horizontal gap → tab), with **skew correction**
(median text-line angle from the boxes; these scans were tilted 0.2-2°,
enough to pair names with the next row's values without it). Script:
scratchpad `paddle_bench.py` (not in the repo yet). oneDNN must be disabled
(`FLAGS_use_mkldnn=false`, `enable_mkldnn=False`) — the same paddle bug the
PP-Structure service hit.

| | Unlimited-OCR | PaddleOCR mobile |
|---|---|---|
| 15 pages | ~50 min (~3.5 min/page) | **~8 min (~32 s/page)** |
| rows found (rules parser) | 112 (105 high) | **122 (109 high)** |
| same value | 99 | 99 |
| different value | 1 | 1 |
PaddleOCR found more rows mainly because Unlimited-OCR merged Dileep's
urine table into one cell. Patient fields equal except Paddle missing
Dileep's sex and reading VARINDER's age as "19 years" (from an interpretation
table). Every other disagreement turned out to be the parser, fixed
generically: a value cell starting with `:` ("⇥: 0.60"); `Test : value
unit` lines; `Result : NEGATIVE` under a single-test heading (was being
dropped as a column header); and a section heading may no longer supply a
dictionary match on its own ("Avg. Blood Glucose Level" under "Hb A1C -
Glycated Hb" had become Haemoglobin). **Conclusion: on these pages
PaddleOCR mobile gives the same results ~6-7× faster on CPU.** Not yet
integrated as the reading engine.

## Per-page reading — OCR only the pages that need it (Sept 30, 2026)

`unlimited-ocr/pageReader.js` (`readPages()`), now used by the server's
shared reading step for every flow and by `batch-eval.js`:
- every PDF page is triaged on its own (`triage.triagePages` /
  `pageTextUsable`): < 30 letters → needs OCR; word-quality < 0.80 judged
  on word-like tokens only (numbers/units no longer count — the old
  per-file measure made unit-heavy lab pages look garbled) → needs OCR;
- a page that looks like a lab page (lab vocabulary) but whose text layer
  gives no results → needs OCR;
- file-level: if the whole file fails triage's clean-word check (0.83,
  provisional), the embedded OCR layer is treated as unusable on every page
  (it comes from one scanner/engine) — catches VARINDER / RAMANBHAI;
- only needs-OCR pages are rendered (`pdf-parse getScreenshot({partial})`)
  and sent to Unlimited-OCR, one page at a time, cached per page in
  `ocr-cache/<file>.p<N>.txt` (gitignored) — never OCR'd twice;
- output uses one marker format (`--- Page N of M ---`) for all pages, so
  page classification + parsing don't care how a page was read.
On the sample folder: clean digital reports 0 OCR pages (incl. Prahlad's
digital MER); mixed `Suresh mergd.pdf` 8 of 12; overall 56 of 89 pages
need OCR. Known limit: a blank page can't be told from a scanned one
without rendering, so blank pages are OCR'd too.

OCR results so far (Unlimited-OCR, CPU, ~2.5-3 min/page on these):
**Dileep** (3 pages, 552s) → 40 rows incl. Lipid 4/4 (stacked columns, see
below), patient correct; **VARINDER** (2 pages, 441s) → HbA1c 2 + Vitamin
B12 1, patient correct. Needed a service fix: run the Python service with
`PYTHONIOENCODING=utf-8 PYTHONUTF8=1` — it crashed printing `∞` to the
Windows console. General parser/classifier fixes found on OCR output (all
universal, none per-report): stacked-columns layout (N names then N values
→ paired only when counts match and ≥ half are known tests); short
synonym allowed when it's a name's first word (`ESR (Wintrobe's)…`);
single-letter runs joined (`G.T.` → gt); unit `mm first hour`; `HBs
Antigen` synonym; label format hints ignored (`Age (Y-M-D)`); a trailing
`Method: …` merged into a name cell by OCR is stripped; a page with strong
lab vocabulary counts as lab even with 0 parsed rows (so misses reach the
fallback instead of being dropped as "other"). Batch now **254 rows,
confidence 243/11/0** (8 of 10 files readable; RAMANBHAI + the Suresh
scanned pages OCR in progress, AMOL's 32 FMR/TMT pages skipped).

## Page classification — lab / mer / other / no_text (Sept 30, 2026)

MER questionnaires are parked (user: "will do later"; approach discussed:
per-insurer templates + Yes/No tick detection — see conversation notes, not
built). What IS built: `unlimited-ocr/pageClassifier.js`, run per page by
`documentParser.js`, so **only lab pages reach the pathology parser**.
- **lab** — the rules parser finds ≥1 high-confidence row or ≥2 rows
  (plus lab vocabulary in the score)
- **mer** — questionnaire vocabulary (medical examination, life assured,
  examinee, declaration, family history…), numbered sub-questions, Yes/No
  pairs, question marks; wins only when its score ≥ 8 and beats the lab score
- **other** — neither (TPA emails, cover letters, TMT/ECG pages)
- **no_text** — < 30 letters: a scanned page inside a digital PDF, or blank
Every page's class is returned (`pageTypes` / `stages.pages`), nothing is
dropped silently. Batch result: every page of the clean lab reports → lab;
Prahlad → `MMMMMMML` (7 MER pages skipped, its last page — a urine report —
parsed); RAMANBHAI (raw layer) → lab / 4× other (emails) / mer / 4× lab.
Rows 212 → 211 (the lost one was MER question text read as a test).

**Found along the way — mixed PDFs:** `Suresh kumar sharma mergd.pdf` =
7 scanned pages with no text + 4 digital lab pages. Triage decides
digital/scan for the whole file, so the scanned pages were silently
skipped; they now show as `no_text`. **Not yet done:** per-page OCR of
`no_text` pages inside digital PDFs.

## Whole-document parsing — every test covered, selection is only a filter (Sept 30, 2026)

**Requirement (user):** cover ALL tests in pathology reports; a new/unknown
test must never be discarded.

**Problem measured first:** the select-first flow only parsed rows under
one of the 14 catalog headings. On the sample folder ~17 real tests were
silently lost — standalone tests on generic pages ("PATHOLOGY",
"BIOCHEMISTRY": Suresh's ESR/SGPT/Creatinine, Punamchadr's
Creatinine/BUN/RBS/HIV, SONIA's fasting sugar/HbA1c), and any panel
outside the 14 would have been lost entirely.

**Change (new `documentParser.js`, used by `/api/extract-selected`):**
1. The WHOLE document is split into blocks at every recognized heading
   (catalog type or generic boundary) plus the text before the first one;
   every block is cleaned (page markers, repeated letterhead/footer, prose,
   patient-header lines via `headerParser.isHeaderLine`) and parsed.
2. Each row gets a report type: the dictionary's panel for that test if the
   heading disagrees (labs' own summary groupings like "Anemia Studies"
   don't move Hb out of CBC), else the heading's type, else the
   dictionary's, else **OTHER** (grouped under its printed heading — kept,
   never dropped).
3. Duplicates (summary + detailed pages) collapse on same printed name +
   value OR same dictionary test + value, keeping the richer row.
4. The user's report-type selection is now a **filter on the output**;
   "All tests (whole report)" is the default in `/select.html`.
   Auto-mode LLM fallback only runs for a recognized, selected report-type
   block the rules got no rows from.
Also: reportCatalog grew from 14 to **28 report types** (+ Electrolytes,
Hormones, Iron, Coagulation, Cardiac, Pancreas, CRP/RA/ASO, Infection
serology, Immunology, Tumour markers, Blood group, Other haematology,
Urine microalbumin/24h, Stool, Semen) and `paramDictionary.js` from ~100
to **216 standard pathology tests**, each tagged with its panel. Short or
generic synonyms (`to`, `ct`, `count`, `volume`) only match short names;
words-only tests lose to unit-bearing ones when a row has a unit. A
summary-scorecard "N / M" is no longer read as a reference range.

**Results:** sample folder 197 → **212 rows**, confidence 190/7/0 →
**202/10/0**, every previously-missed test captured (labelled by panel, or
under Other for lab typos like `CHOLESTROL`, `GAMA GT`). Redcliffe 35 → 39
rows (adds Ferritin, all CBC rows correctly under CBC). Babita 62 / Naresh
59 / OCR page 22 unchanged or better. End-to-end ~90-160ms per document,
0 LLM calls.

`selectReports.extractSelectedSections` (the per-type section cutter) is
no longer used by the server; its helpers are reused by `documentParser.js`.

## First batch evaluation — 10 sample files (Sept 30, 2026)

New tool: `unlimited-ocr/batch-eval.js "<folder>" [--save out.json]` —
triage → locate all 14 types → rules parser, per file plus an aggregate.
No LLM, no OCR (scans are listed and skipped). Use it to judge changes
over many reports instead of one file.

Run on `D:\SampleReports (1)\PathologyTestReports` (10 PDFs): 9 "digital",
1 scan; 35 sections located, 6 would fall back to the LLM; **209 rows,
confidence high/medium/low = 181/28/0**. Clean lab reports (Babita,
Punamchadr, SONIA, Suresh ×2) parsed almost entirely at high confidence.

Failures grouped by **category** (per the design rule — not per file):
- **A. Empty text treated as digital** — AMOL (32 pages, 0 letters/page):
  triage counts page markers as text, so a pure scan skips OCR.
- **B. Scanned PDF with a garbage hidden OCR layer** — VARINDER
  (`Palr,:nl Nanre`), RAMANBHAI, Prahlad: triage trusts the bad text layer.
  20 of the 28 medium-confidence rows come from these.
- **C. Not a lab report** — MER questionnaires / forms / TPA emails
  (Prahlad, Dileep, AMOL FMR/TMT, RAMANBHAI): need a document-type check
  before this flow.
- **D. Heading line is itself the result** — reversed-layout single-test
  sections (`Non Reactive⇥HBSAG`): the parser always skips line 0 → 0 rows.
Real-report medium rows were mostly correct behaviour (lab printed an
enzyme in mg/dl) or universal vocabulary gaps seen across ≥2-3 labs
(`Quantity`, `Deposits`, `TOTAL CHOLESTEROL/HDL`). A text-quality measure
(share of clean alphabetic words) put clean reports at 0.87-0.93 and the
garbled layers at 0.73-0.79 — a thin margin on 9 files, so any threshold
is provisional.

**Fixes applied for A, B, D, E (user go-ahead, Sept 30) — C not yet:**
- A + B in `unlimited-ocr/triage.js`: a text layer counts as digital only
  with ≥50 letters/page (page markers excluded) and a clean-word ratio
  ≥ **0.83 (PROVISIONAL — picked on this 9-file batch, re-check on larger
  batches)**; otherwise the file is treated as a scan and goes to OCR.
  `triage()` now also returns `quality` { pages, lettersPerPage,
  cleanWordRatio }. Only `unlimited-ocr/`'s copy has this.
- D in `rowParser.js`: the section's heading line is also tried as a
  result row.
- E in `paramDictionary.js`: urine `Quantity` / `Deposits`, and
  `cholesterol hdl` as a Total Cholesterol/HDL ratio synonym.

Re-run: AMOL, VARINDER, RAMANBHAI now → OCR (plus Dileep, already a scan);
sections falling back to the LLM **6 → 1**; confidence high/medium/low
**181/28/0 → 190/7/0**; Punamchadr HBsAg + Cotinine 0 → 1 row each. The 7
medium rows: 4 from Prahlad's MER form (passes triage at 0.87 — only a
document-type check, category C, will catch it), 2 where the lab printed an
enzyme in mg/dl, 1 lab typo (`TRANSPRENCY`) left alone on purpose. No
regressions on Babita/Redcliffe/Naresh/OCR page (62/35/57/22 rows).
**Trade-off:** files now routed to OCR take ~4.5 min/page with
Unlimited-OCR on this CPU — the 4 rerouted files haven't been OCR'd yet.

## `unlimited-ocr/`: rules-based row parser for located sections (Sept 29, 2026)

Direct follow-up to the select-first flow above (whose remaining problems
were LLM speed and run-to-run variance). Explicit requirement from the
user: **must work for any lab's report, not just the documents we have** —
so nothing here is a per-lab template; it's built from what every lab
report shares (test name / value / unit / range, written with a common
vocabulary), with only the *layout* handled generically. Architecture in
`README.md`'s "Rules-based row parser". New files: `labVocabulary.js`,
`paramDictionary.js`, `rowParser.js`, `headerParser.js`, `textNormalize.js`.
`/api/extract-selected` gained `engine` = `auto` (default: rules, LLM only
for sections the rules can't parse) | `rules` | `llm`; the UI has a picker.

**Results (no LLM calls at all, every section parsed by rules):**

| Document | Rows | Notes |
|---|---|---|
| Helpline / Babita (text layer) | 62, all correct, all dictionary-matched | beats `regex-based/` (57 — it missed Glucose/TG/HDL) and every LLM run |
| Redcliffe (text layer) | 35, all correct | name → method → value layout; absolute counts told apart from % |
| K Naresh Naidu (text layer) | 57, all correct | `Method :` lines, multi-line ranges |
| **Suresh Kumar Sharma — unseen while building** | 31, all correct | first run: 1 row. Exposed that text layers can emit columns **reversed** (`range ⇥ value ⇥ name`) and print ranges *above* the value → fixed generically (cell classification by content + section column-order detection + pre-range buffer), not with a Suresh-specific rule |
| Babita page 1 **via OCR** (Unlimited-OCR HTML) | 22/22 CBC with units + ranges | the split "test\|value" + "unit\|range" tables — logged above as needing "a deterministic fix, not a prompt fix" — are now zipped by `textNormalize.js` when rows match one-to-one |

Patient fields (rules, `headerParser.js`): correct on all 5 documents,
including reversed `value ⇥ Label`, vertical `Label ⏎ value`, and an
unlabeled `MR. NAME` / `65 Years /M` header. Two traps found and fixed:
a pathologist's `REG. NO.` in the signature block read as the patient ID,
and the source check rejecting sex normalized `M` → `Male`.

**End-to-end via the server, all 14 types selected, `engine=auto`:**
Babita 169ms / 62 rows, Redcliffe 231ms / 35 rows — vs ~4-5 minutes with
the per-section LLM flow earlier the same day, and deterministic (same
input → same output). Source check removed nothing.

**Safety behaviour checked:** garbled OCR (`Haem0gl0bin l3.6`) and prose-only
sections → `needsFallback` (LLM or review), not wrong rows; `Hb 136 g/dL`
→ flagged implausible; a thyroid layout never seen before → parsed.

**Known gaps / not yet tested:**
- Only 4 real lab reports + 1 OCR page. Two other "unseen" files in
  `regex-based/logs/` (Prahlad Singh, Bhawana) turned out to be **MER
  questionnaires, not lab reports** — out of scope for this parser; on
  them the section locator makes false matches on question text, so a
  document-type check (lab report vs MER) is needed before this flow.
- `lab_name` is never filled by rules; report dates only when the header
  labels them.
- Reference-range text is kept verbatim (e.g. multi-band eGFR ranges) —
  `validate.js` can only judge simple ranges; complex ones are "unchecked".
- Real scans beyond one OCR'd page not tested; OCR misreads (`l` for `1`)
  go to the LLM fallback / review rather than being corrected.

## Suggested next steps, roughly in order

0. **Fix categorization before trusting any further accuracy numbers**
   (see "Categorization confirmed as the real bottleneck" above — this
   is now the highest-priority item, ahead of the `qwen3:4b` item below,
   since it affects every demo that uses a local Ollama model):
   a. **Partly done (Sept 28):** `unlimited-ocr/` now uses `num_ctx: 4096`
      per page, and `qwen2.5:3b` beat `llama3.2:3b` there (see "`num_ctx:
      4096` + `qwen2.5:3b`" above) — next: switch the default and re-run on
      Redcliffe/K Naresh Naidu. The whole-document variant below is still
      unvalidated. Actually apply `num_ctx: 8192` (or higher) and let a full run
      finish this time — bug #3 has existed since early in this project
      but has never been validated to completion. Confirm it recovers
      the missing early sections on the same `mrs.babita khandelwal`
      document.
   b. Write a categorization prompt variant for the plain-text-layer
      shortcut path specifically (most real documents hit this, not
      either OCR model's actual markup), or make each demo's existing
      prompt degrade gracefully (extract what it can from plain
      tab-separated text) instead of assuming its OCR model's markup is
      always present.
1. **Validate the `qwen3:4b` swap properly before committing to it:**
   re-run the same `mrs.babita khandelwal` document once more (check the
   clean-values result wasn't a fluke, the same way the old malformed-
   value bug was itself inconsistent between runs), and run the
   Redcliffe Vitamin D document too (check whether the boilerplate-
   misclassification bug from `llama3.2:3b` also happens with `qwen3:4b`).
   If it's not a clear win after that, revert `OLLAMA_MODEL` back to
   `llama3.2:3b` — being ~2 minutes slower with two new minor field-
   quality issues and no fix for the main missing-panels bug is not
   obviously worth it yet.
2. Add a prompt instruction (or a post-processing filter in
   `validate.js`) to stop legal/boilerplate text from being classified
   as a fake report section.
3. Once a model choice feels stable, revisit the `num_ctx` trade-off
   deliberately: re-apply `num_ctx: 8192`, let a full run actually
   finish, and check the real panel count before deciding if the time
   cost is worth it long-term (vs. waiting for GPU hardware).
4. Test a genuinely scanned (non-digital) report end-to-end through
   PaddleOCR + Ollama — this path has never actually been validated.
5. Once accuracy is trustworthy enough, start the backend integration
   (a new endpoint/BAL/DAL wired to `UploadReportDocument`'s flow) —
   not started yet.
6. **Independent of the paddleocr track above:** `sarvam/`'s first real
   runs succeeded on both modes — same validation discipline as item 1
   above applies before trusting either: re-run the same
   `mrs.babita khandelwal` document again in lab mode (check 9/9 panels
   and clean values weren't a fluke), then run the Redcliffe Vitamin D
   document (check whether it also avoids the boilerplate-
   misclassification bug seen under `llama3.2:3b`); re-run the MER
   document in `mer` mode a third time and diff against both prior runs
   to see if the 66-vs-56 question count settles or keeps moving, then
   try a second MER document from a different insurer/template. Also
   worth doing once volume matters: time several real runs of each mode
   to get an actual average job latency instead of one or two data
   points per mode.
