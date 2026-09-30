"""One-off probe: does the CPU-patched Unlimited-OCR actually load and run
on this CPU-only machine? Not part of a real demo yet — see PROGRESS.md.
Patches applied to the downloaded model/modeling_unlimitedocr.py: every
.cuda() call replaced with .to(self.device) (the original had them
hardcoded, which crashes immediately on a machine with no CUDA GPU at
all — see PROGRESS.md "Unlimited-OCR" section for the exact lines).
"""
import sys
import time
import torch
from transformers import AutoModel, AutoTokenizer

MODEL_DIR = "./model"
IMAGE_PATH = sys.argv[1] if len(sys.argv) > 1 else "babita_page1.png"

print(f"torch {torch.__version__}, cuda available: {torch.cuda.is_available()}")
print("Loading tokenizer...")
t0 = time.time()
tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR, trust_remote_code=True)
print(f"Tokenizer loaded in {time.time()-t0:.1f}s")

print("Loading model (bfloat16, CPU, low_cpu_mem_usage=True)... this is the risky step.")
t0 = time.time()
model = AutoModel.from_pretrained(
    MODEL_DIR,
    trust_remote_code=True,
    use_safetensors=True,
    torch_dtype=torch.bfloat16,
    low_cpu_mem_usage=True,
)
model = model.eval()
print(f"Model loaded in {time.time()-t0:.1f}s, device={next(model.parameters()).device}")

print(f"Running inference on {IMAGE_PATH}...")
t0 = time.time()
result = model.infer(
    tokenizer,
    prompt='<image>document parsing.',
    image_file=IMAGE_PATH,
    output_path='./output',
    base_size=1024,
    image_size=640,
    crop_mode=True,
    max_length=8192,
    no_repeat_ngram_size=35,
    ngram_window=128,
    save_results=True,
)
print(f"Inference took {time.time()-t0:.1f}s")
print("--- RESULT ---")
print(result)
