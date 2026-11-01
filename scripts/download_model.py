"""Download the archived Supertonic 3 model for static GitHub Pages hosting."""
from pathlib import Path
from huggingface_hub import snapshot_download

root=Path(__file__).resolve().parent.parent/"public"/"assets"
root.mkdir(parents=True,exist_ok=True)
snapshot_download(
    repo_id="supertone-oss-archive/supertonic-3",
    revision="aafc6e32416a594460b32413efc49d7fe4ce6d46",
    local_dir=root,
    allow_patterns=["onnx/*","voice_styles/*","LICENSE"],
    max_workers=4,
)
required=["duration_predictor.onnx","text_encoder.onnx","vector_estimator.onnx","vocoder.onnx","tts.json","unicode_indexer.json"]
for name in required:
    f=root/"onnx"/name
    if not f.is_file() or f.stat().st_size==0:
        raise RuntimeError("Missing ONNX model file "+str(f))
for p in ("M","F"):
    for n in range(1,6):
        f=root/"voice_styles"/f"{p}{n}.json"
        if not f.is_file() or f.stat().st_size==0: raise RuntimeError("Missing voice style "+str(f))
if not (root/"LICENSE").is_file(): raise RuntimeError("Missing OpenRAIL-M model license")
print("Supertonic 3 model assets verified.")
