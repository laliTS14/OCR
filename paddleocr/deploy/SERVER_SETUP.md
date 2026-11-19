# OCR worker — server setup (Windows)

How to run the PIMS OCR worker on a Windows server so it starts at boot and
keeps running. The worker reads queued pathology reports from the UAT OCR
queue, extracts the tests, and saves them through the OCR API. With double
OCR on, it also reads flagged reports with Tesseract and saves that result
separately, for comparison.

Three processes run on the server, each as a boot-time scheduled task:

| Task | Runs | Port |
|---|---|---|
| Health360 OCR Text Service | `paddleocr\paddle_text_service.py` (RapidOCR) | 8794 (localhost) |
| Health360 OCR Tesseract Service | `tesseract-ocr\tesseract_text_service.py` | 8799 (localhost) |
| Health360 OCR Worker | `paddleocr\worker.js` | none (it calls out) |

Already in place on UAT (nothing to do here): the database changes
(`database/stored_procedures/ocr_double_ocr_uat_rollout.sql`) and the OCR API
at `http://192.168.40.45:8012/`.

---

## 1. Check the server can reach everything

From the server, in PowerShell:

```powershell
Invoke-WebRequest http://192.168.40.45:8012/swagger/index.html -UseBasicParsing | Select StatusCode   # 200
Invoke-WebRequest <REPORT_UPLOAD_BASE_URL>/ -UseBasicParsing | Select StatusCode                      # the report-upload site
```

`REPORT_UPLOAD_BASE_URL` is the same value as in the dev laptop's
`paddleocr\.env`. If the server *is* the file server, you can instead read the
files from disk (`REPORT_UPLOAD_BASE_FOLDER`, step 6).

Leave enough room: about 2 GB for the code, venvs and models, plus the logs.

## 2. Install the programs (once)

| Program | Version | Notes |
|---|---|---|
| Node.js | 20 LTS or newer (tested on 24) | add to PATH (installer default) |
| Python | **3.12** (64-bit) | tick "Add python.exe to PATH" and install the `py` launcher (python.org installer, not the Microsoft Store) |
| Microsoft Visual C++ Redistributable 2015–2022 (x64) | latest | https://aka.ms/vs/17/release/vc_redist.x64.exe — onnxruntime / OpenCV need it; without it Python exits **silently** when importing them (no error, nothing printed) |
| Tesseract OCR | 5.x, UB Mannheim Windows build | https://github.com/UB-Mannheim/tesseract/wiki — default folder `C:\Program Files\Tesseract-OCR` (English is included) |
| Git | any | optional — only if the server can reach GitHub (step 3) |

Check in a **new** PowerShell window:

```powershell
node -v
py -3.12 --version
& "C:\Program Files\Tesseract-OCR\tesseract.exe" --version
```

If Tesseract is installed somewhere else, set `TESSERACT_CMD` to its full path
as a system environment variable (System Properties → Environment Variables),
because the scheduled task runs as SYSTEM.

## 3. Get the code

Pick a folder that is not under a user profile, for example `D:\Health360`.

Do **not** use GitHub's "Download ZIP" (`OCR-main`): `main` is an old
version without the worker's current code, the Tesseract service or this
guide. Use the deploy zip, or clone the `ocr-pims-integration` branch.

**No GitHub on the server (usual case): the deploy zip.** On the dev laptop
it is built from a commit, e.g. `OCR\deploy-package\OCR-worker-<commit>.zip`
(only `paddleocr\` + `tesseract-ocr\` + the RapidOCR model; no `.env`,
logs, cache or patient data). Copy it to the server and unzip it into
`D:\Health360`:

```powershell
Expand-Archive .\OCR-worker-<commit>.zip -DestinationPath D:\Health360
# -> D:\Health360\OCR\paddleocr, D:\Health360\OCR\tesseract-ocr
```

The model is already in the zip, so in step 4 skip copying it. Without git
the worker can't read its version from a commit, so set it in `.env`
(step 6): `PIPELINE_VERSION=rules-<commit>` (the zip's commit).

To build a new zip on the dev laptop after new commits (from `OCR\`):

```powershell
$c = git rev-parse --short HEAD
git archive --format=zip --prefix=OCR/ -o deploy-package\OCR-worker-$c.zip HEAD paddleocr tesseract-ocr
# then add the model (it is gitignored):
python -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1],'a',zipfile.ZIP_DEFLATED).write('paddleocr/onnx-models/en_PP-OCRv3_rec_infer.onnx','OCR/paddleocr/onnx-models/en_PP-OCRv3_rec_infer.onnx')" deploy-package\OCR-worker-$c.zip
```

**With GitHub access:**

```powershell
cd D:\Health360
git clone -b ocr-pims-integration https://github.com/laliTS14/OCR.git OCR
```

You need `OCR\paddleocr` and `OCR\tesseract-ocr`, side by side. The other
folders are not used by the worker.

## 4. RapidOCR service (`paddleocr\.venv-rapid`)

```powershell
cd D:\Health360\OCR\paddleocr
py -3.12 -m venv .venv-rapid
.venv-rapid\Scripts\python -m pip install -r requirements-rapid.txt
mkdir onnx-models
```

Installed from the zip: the model is already in `paddleocr\onnx-models\`
(the `mkdir` above just says it exists) — go on to the test. Otherwise copy
the English recognition model into `paddleocr\onnx-models\`:
`en_PP-OCRv3_rec_infer.onnx` (8.97 MB). Take it from the dev laptop's
`OCR\paddleocr\onnx-models\`, or download it from
`huggingface.co/SWHL/RapidOCR`, folder `PP-OCRv3`. It is not in git.

Test it (leave it running for a moment, then Ctrl+C):

```powershell
$env:OCR_ENGINE = 'rapid'; .venv-rapid\Scripts\python paddle_text_service.py
# expect: "Running on http://127.0.0.1:8794"
```

## 5. Tesseract service (`tesseract-ocr\.venv`)

```powershell
cd D:\Health360\OCR\tesseract-ocr
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

Test it:

```powershell
.venv\Scripts\python tesseract_text_service.py
# in a second window:
Invoke-WebRequest http://localhost:8799/health -UseBasicParsing | Select StatusCode   # 200
```

Ctrl+C when done. If `/health` fails, the service log says whether it found
`tesseract.exe` (see `TESSERACT_CMD` in step 2).

## 6. Worker (`paddleocr`)

```powershell
cd D:\Health360\OCR\paddleocr
npm install
copy .env.example .env
notepad .env
```

Set at least these in `.env` (every other line can stay as it is):

```ini
OCR_API_URL=http://192.168.40.45:8012
OCR_API_KEY=<the OcrApi:ApiKey from the live API's appsettings.json>
OCR_API_INSECURE_TLS=0

# one of the two:
REPORT_UPLOAD_BASE_URL=<same as on the dev laptop>
REPORT_UPLOAD_BASE_FOLDER=

OCR_PRIMARY_ENGINE=paddle
OCR_DOUBLE_ENABLED=true
PADDLE_TEXT_URL=http://localhost:8794
TESSERACT_TEXT_URL=http://localhost:8799

OCR_WORKER_ENGINE=rules
OCR_WORKER_CONCURRENCY=1

# installed from the zip (no git): the zip's commit
PIPELINE_VERSION=rules-<commit>
```

`OCR_DOUBLE_ENABLED=true` only allows double OCR. A report is read by
Tesseract only if its `tbl_ocr_report_details.double_ocr = 1` (step 9).

## 7. Try one file by hand (optional, recommended)

With both services from steps 4 and 5 running in their own windows:

```powershell
cd D:\Health360\OCR\paddleocr
node worker.js --file "C:\path\to\some-report.pdf" --double
```

This is a **dry run**: it prints what it would save (the RapidOCR result,
then the Tesseract result) and saves nothing. Then close both service windows.

## 8. Register the boot tasks

Stop the services you started by hand in steps 4 and 5 first (Ctrl+C) — the
tasks start their own copies on the same ports.

In an **elevated** PowerShell (Run as Administrator):

```powershell
cd D:\Health360\OCR\paddleocr
Get-ChildItem .\deploy | Unblock-File   # files from a downloaded zip are blocked
.\deploy\install-tasks.ps1
```

Without `Unblock-File` a zip-installed copy fails with "install-tasks.ps1 is
not digitally signed. You cannot run this script on the current system."
(Alternative, for this one run only:
`powershell -ExecutionPolicy Bypass -File .\deploy\install-tasks.ps1`.)

Expected output:

```
Registered: Health360 OCR Text Service
  started
Registered: Health360 OCR Tesseract Service
  started
Registered: Health360 OCR Worker
  started
```

If it says `Skipped: Health360 OCR Tesseract Service - missing ...`, step 5
was not done; the worker still runs, but double-OCR reports get a FAILED
Tesseract result (their RapidOCR result is saved normally).

Check:

```powershell
Get-ScheduledTask -TaskName 'Health360 OCR*' | Select TaskName, State      # all Running
Get-Content .\logs\service\worker.log -Tail 20 -Wait
```

The worker log should start with its settings (`api=http://192.168.40.45:8012`
and `double OCR=on for reports with double_ocr = 1 (second: tesseract)`),
then show `saved report ...` lines as it works through the queue. Filling
the queue is the database's job: report QC queues each case's pathology
files, and the MySQL event `ev_queue_ocr_reports` (every 10 min) queues
anything QC missed and re-queues reports stuck in PROCESSING.

Logs (append-only, in `paddleocr\logs\service\`): `ocr-service.log`,
`tesseract-service.log`, `worker.log`.

**Run only one worker against UAT.** If a worker is still running on the dev
laptop with the UAT API, stop it.

## 9. Test double OCR

Nothing sets `double_ocr` automatically yet. To test, flag a few reports in
`health360_uat` and put them back in the queue (108 = QUEUED):

```sql
UPDATE tbl_ocr_report_details
SET double_ocr = 1, ocr_status_id = 108, attempt_count = 0,
    locked_by = NULL, error_message = NULL
WHERE ocr_report_id IN (/* report ids */);
```

A re-run replaces the report's earlier rows in `tbl_ocr_data`.

After the worker has processed them:

```sql
-- one row per report: DONE / FAILED (110 / 111), error, remark
SELECT ocr_report_id, ocr_status_id, error_message, ocr_remark, ocr_page_count
FROM tbl_ocr_tesseract_report WHERE is_active = 1 ORDER BY ocr_report_id DESC;

-- per test: RapidOCR vs Tesseract
SELECT r.ocr_report_id, r.param_code, r.value AS rapidocr, t.value AS tesseract
FROM tbl_ocr_data r
LEFT JOIN tbl_ocr_data_tesseract t
  ON t.ocr_report_id = r.ocr_report_id AND t.param_code = r.param_code AND t.is_active = 1
WHERE r.is_active = 1 AND r.ocr_report_id IN (/* report ids */)
ORDER BY r.ocr_report_id, r.page_no;
```

`tbl_ocr_report_details.second_ocr_engine_id` = TESSERACT (122) means
Tesseract read at least one page; a digital PDF has nothing for it to read
(DONE, 0 rows, with a remark).

## Updating, stopping, removing

- **New code:** build a new zip (step 3), stop the tasks
  (`Get-ScheduledTask 'Health360 OCR*' | Stop-ScheduledTask`), unzip it over
  `D:\Health360` (your `.env`, venvs and `node_modules` are not in the zip,
  so they stay), update `PIPELINE_VERSION`, then start the tasks again
  (`Get-ScheduledTask 'Health360 OCR*' | Start-ScheduledTask`). With git:
  `git pull`. Run `npm install` in `paddleocr` if `package.json` changed.
  To restart just the worker:
  `Stop-ScheduledTask 'Health360 OCR Worker'; Start-ScheduledTask 'Health360 OCR Worker'`
  (do the same for a service whose `.py` changed).
- **Turn double OCR off:** `OCR_DOUBLE_ENABLED=false` in `.env`, restart the
  worker. Flagged reports are then read by RapidOCR only.
- **Remove everything:** `.\deploy\uninstall-tasks.ps1` (elevated). A report
  the worker was in the middle of is re-queued automatically after 30 min.

## Troubleshooting

| Symptom in `worker.log` | Cause |
|---|---|
| `fetch failed` on every poll | the API URL is wrong or unreachable from the server (step 1) |
| `401` | `OCR_API_KEY` doesn't match the live API's `OcrApi:ApiKey` |
| `Could not reach the ... OCR service at http://localhost:8794` | RapidOCR service not running — check `ocr-service.log` (`English recognition model not found`? step 4) |
| Tesseract result FAILED with `http://localhost:8799` in the error | Tesseract service not running — check `tesseract-service.log` (`tesseract.exe` not found? step 2) |
| `Report is not claimed by this worker` | the report sat in PROCESSING too long (machine slept / worker stopped) and was re-queued; it will be done again |
| `Set REPORT_UPLOAD_BASE_URL or REPORT_UPLOAD_BASE_FOLDER` | step 6 |

**A Python command prints nothing at all and just returns** (even
`python -c "print('hi')"` after an import): a native library crashed while
loading. Find which one, and the exit code:

```powershell
.\.venv-rapid\Scripts\python -c "print('python ok')"; "exit $LASTEXITCODE"
foreach ($m in 'numpy', 'cv2', 'onnxruntime', 'rapidocr_onnxruntime') {
  .\.venv-rapid\Scripts\python -c "import $m; print('$m ok')"; "$m -> exit $LASTEXITCODE"
}
```

| Exit code | Meaning | Fix |
|---|---|---|
| `-1073741515` (0xC0000135) | a DLL is missing | install the Visual C++ Redistributable x64 (step 2), open a new PowerShell, retry |
| `-1073741795` (0xC000001D) | the CPU (often a VM's virtual CPU) lacks AVX instructions the wheels need | ask for the VM's CPU type to be set to "host" / expose AVX; otherwise older library versions are needed |
| `9009` or `103` on `print('python ok')` | the venv points at the Microsoft Store Python stub | install Python 3.12 from python.org, delete `.venv-rapid`, recreate it (step 4) |
