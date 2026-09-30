"""
PaddleOCR text-OCR microservice — the default OCR engine for this demo.

Classic PaddleOCR (PP-OCRv5 mobile text detection + English recognition),
text only: no layout/table models, no LLM. On this laptop CPU (i5-1145G7,
no CUDA GPU) it reads a 1600px report page in ~30 s — ~6-7x faster than
Unlimited-OCR (../unlimited-ocr), with the same parsed results on the 15
pages both were tested on (see PROGRESS.md "PaddleOCR vs Unlimited-OCR").

What it returns per page image is PLAIN TEXT IN READING ORDER, shaped like a
PDF text layer, so the Node pipeline treats OCR'd and digital pages alike:
  - skew correction: the median text-line angle is measured from the text
    boxes and the page coordinates are rotated level first — scans tilted by
    even ~1-2 degrees otherwise pair a test name with the NEXT row's value;
  - lines: boxes whose vertical centres are close form one line;
  - columns: a horizontal gap wider than ~2.5 character widths becomes a tab.

Run:   PYTHONIOENCODING=utf-8 PYTHONUTF8=1 python paddle_text_service.py
Port:  PADDLE_TEXT_PORT (default 8794)
API:   POST /ocr  (multipart "file" = one page image, PNG/JPG)
       → { markdown, text, skewDeg, boxes, elapsedSeconds }
       ("markdown" mirrors the Unlimited-OCR service's field name.)
"""

import io
import math
import os
import time

# paddlepaddle 3.3.x + oneDNN crashes on this machine with
# "ConvertPirAttribute2RuntimeAttribute not support" (same bug as
# paddle_service.py) — must be disabled before paddle is imported.
os.environ.setdefault("FLAGS_use_mkldnn", "false")

import numpy as np
from flask import Flask, jsonify, request
from PIL import Image
from paddleocr import PaddleOCR

PORT = int(os.environ.get("PADDLE_TEXT_PORT", "8794"))
app = Flask(__name__)

_t0 = time.time()
_engine = PaddleOCR(
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_textline_orientation=False,
    text_detection_model_name="PP-OCRv5_mobile_det",
    text_recognition_model_name="en_PP-OCRv5_mobile_rec",
    enable_mkldnn=False,
)
print(f"PaddleOCR text engine loaded in {time.time() - _t0:.1f}s", flush=True)


def skew_angle(polys):
    """Median text-line angle (radians) from each wide box's top edge."""
    angs = []
    for p in polys:
        (x0, y0), (x1, y1) = p[0], p[1]
        if x1 - x0 > 60:
            angs.append(math.atan2(y1 - y0, x1 - x0))
    angs.sort()
    return angs[len(angs) // 2] if angs else 0.0


def lines_from(texts, polys):
    a = skew_angle(polys)
    ca, sa = math.cos(-a), math.sin(-a)
    items = []
    for t, p in zip(texts, polys):
        t = (t or "").strip()
        if not t:
            continue
        pts = [(x * ca - y * sa, x * sa + y * ca) for x, y in p]
        xs = [q[0] for q in pts]
        ys = [q[1] for q in pts]
        items.append({"t": t, "x1": min(xs), "x2": max(xs), "yc": (min(ys) + max(ys)) / 2, "h": max(1.0, max(ys) - min(ys))})
    if not items:
        return "", a
    hs = sorted(i["h"] for i in items)
    med_h = hs[len(hs) // 2]
    items.sort(key=lambda i: i["yc"])
    rows, cur = [], [items[0]]
    for it in items[1:]:
        if abs(it["yc"] - sum(c["yc"] for c in cur) / len(cur)) <= med_h * 0.5:
            cur.append(it)
        else:
            rows.append(cur)
            cur = [it]
    rows.append(cur)
    out = []
    for r in rows:
        r.sort(key=lambda i: i["x1"])
        s = r[0]["t"]
        for prev, nxt in zip(r, r[1:]):
            char_w = (prev["x2"] - prev["x1"]) / max(1, len(prev["t"]))
            gap = nxt["x1"] - prev["x2"]
            s += ("\t" if gap > max(2.5 * char_w, med_h * 1.2) else " ") + nxt["t"]
        out.append(s)
    return "\n".join(out), a


@app.route("/ocr", methods=["POST"])
def ocr():
    f = request.files.get("file")
    if f is None:
        return jsonify({"error": "No file uploaded."}), 400
    try:
        image = Image.open(io.BytesIO(f.read())).convert("RGB")
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Could not read the uploaded image: {exc}"}), 400
    t0 = time.time()
    try:
        res = list(_engine.predict(np.array(image)))[0]
        texts = list(res["rec_texts"])
        polys = [[[float(v) for v in pt] for pt in poly] for poly in res["rec_polys"]]
        text, angle = lines_from(texts, polys)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"PaddleOCR failed: {exc}"}), 500
    return jsonify({
        "markdown": text,
        "text": text,
        "skewDeg": round(math.degrees(angle), 2),
        "boxes": len(texts),
        "elapsedSeconds": round(time.time() - t0, 2),
    })


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=PORT)
