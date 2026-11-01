"""Validate static browser app shape, separate from live inference tests."""
from pathlib import Path
import re
root=Path("dist")
required=["index.html","app.js","inference-worker.js","PCMPlayerWorklet.js",
          "EventEmitter.js","main-thread-worker-shim.js","buffer-adaptation.js","style.css",
          "favicon.svg","sentencepiece.js",".nojekyll"]
for p in required:
    f=root/p
    assert f.exists(), f"Missing deployed file: {p}"
    if p!=".nojekyll": assert f.stat().st_size>0, f"Empty deployed file: {p}"
html=(root/"index.html").read_text()
app=(root/"app.js").read_text()
worker=(root/"inference-worker.js").read_text()
for component in ["stat-eta","stat-produced","streaming-state","streaming-progress",
                  "btn-generate","btn-upload","file-upload","btn-record"]:
    assert 'id="'+component+'"' in html, "Missing control "+component
for key in ["estimateSpeechDuration", "refreshGenerationEstimate", "minBufferBeforePlaybackMs: 160",
            "this.player.playAudio(pcm)", "voice_encoded", "generatedSeconds"]:
    assert key in app, "Missing feature "+key
for key in ["ensureCustomVoiceCached", "encode_voice", "stream_ended", "audio_chunk"]:
    assert key in worker, "Missing Pocket TTS inference capability "+key
for tag in re.findall(r'(?:src|href)="(\.?/?[^"?#]+)',html):
    if tag.startswith(("./","")) and tag.split(".")[-1] in ("css","js","svg") and not tag.startswith("/"):
        if not (root/tag).exists(): print("External or dynamic reference:",tag)
print("Static deployment checks passed; live inference requires separate browser verification.")
