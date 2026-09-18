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

## Timing — the real, confirmed numbers

| Scenario | Time |
|---|---|
| Current config (default 2048 context, `llama3.2:3b`) | ~4-7 minutes per report |
| With context bug fixed (`num_ctx: 8192`, sees whole document) | 12-20+ minutes — confirmed via a completed 12-min free-form (no schema) test; the real schema-constrained version was still running past 13 min when manually stopped, never confirmed to finish |
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

Not yet tried, worth testing given the malformed-value issue:

- **`qwen2.5:3b`** — top candidate to try next. Same size class as
  current `llama3.2:3b`, reputationally much cleaner at structured/JSON
  extraction. Direct like-for-like speed comparison.
- **`qwen2.5:7b`** — larger, likely stronger, still CPU-runnable.
- `llama3.1:8b`, `phi3.5`, `mistral:7b` — other candidates, lower
  priority than the Qwen family for this specific task.

Longer-term architecture idea (once GPU is available): a **vision-
language model** (e.g. `qwen2.5vl:7b`) could replace PaddleOCR +
Ollama entirely — one local model reads the page image and outputs
structured JSON directly, same shape as the `real/` (Gemini) POC's
architecture but free/self-hosted. Not attempted — would likely be
even slower than the current setup on CPU-only hardware, so this is a
GPU-era idea, not a near-term one.

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

## Suggested next steps, roughly in order

1. Try `qwen2.5:3b` as a drop-in replacement for `llama3.2:3b` — same
   speed class, real chance of fixing the malformed-value problem
   without an architecture change or a speed cost.
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
