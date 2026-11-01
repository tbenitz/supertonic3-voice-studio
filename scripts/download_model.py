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

# A separate speaker identity ONNX model makes cloning compare real voices,
# rather than just picking a preset. Apache-2.0 licensed upstream model.
from urllib.request import Request, urlopen
import time
speaker=root/"speaker_encoder.onnx"
speaker_url="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx"
if not speaker.exists() or speaker.stat().st_size < 1000000:
    for attempt in range(3):
        try:
            print(f"Downloading voice identity model (attempt {attempt+1}/3)", flush=True)
            with urlopen(Request(speaker_url,headers={"User-Agent":"VoiceStudioGithubActions/1.0"}),timeout=120) as response:
                with open(speaker.with_suffix(".part"),"wb") as out:
                    while block:=response.read(1024*1024):
                        out.write(block)
            speaker.with_suffix(".part").replace(speaker)
            break
        except Exception:
            speaker.with_suffix(".part").unlink(missing_ok=True)
            if attempt==2: raise
            time.sleep(3*(attempt+1))
if speaker.stat().st_size < 1000000:
    raise RuntimeError("Speaker ONNX model download was incomplete")
print("Speaker identity model ready:",speaker.stat().st_size,"bytes")
