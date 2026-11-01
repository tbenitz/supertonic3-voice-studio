# Supertonic 3 Voice Studio

A privacy-first multilingual text-to-speech website for GitHub Pages built on the archived [Supertonic 3](https://huggingface.co/supertone-oss-archive/supertonic-3) ONNX model.

**Features:** 31 languages, 10 preset voices, custom Supertonic 3 style JSON import, experimental browser-side voice cloning from recordings (speaker-embedding-guided, iterative), WAV export, reading-speed and quality settings, WebGPU with WebAssembly fallback.

## Clone a voice from audio (experimental)

1. Upload an audio clip with **one person's clean speech**. Aim for 10–30 seconds.
2. Type **the exact words spoken** for a 3–15-second portion. For longer files, enter start/end seconds to mark the corresponding sentence.
3. Check the permission confirmation, pick a cloning effort (12 / 40 / 100 steps), and select **Create voice from recording**.
4. Watch real model-comparison progress. The browser evaluates the 10 presets and optimizes global mixture, per-row mixture, and individual style tensors to match the recording. This can take **minutes to tens of minutes or more** depending on your CPU/WebGPU and iteration count.
5. Once done, the new voice is automatically selected for TTS and you can download its **real generated Supertonic 3 voice-style JSON** for future reuse. Stop saves the best profile computed so far.

Unlike the previous audio preview-only interface, this page actually runs synthesis and compares speaker identity from a separate ONNX speaker encoder to guide the optimization. It also uses pitch, spectral and utterance duration differences. The source project for the staged optimizer approach is [DavidValin/supertonic3-tts](https://github.com/DavidValin/supertonic3-tts) (this is a separate JavaScript browser adaptation, not the Rust implementation). **This is experimental. Voice fidelity varies and a few iterations may sound similar to the nearest preset.** The site does not train weights or include an instant zero-shot encoder. Neither audio nor text is transmitted to a server.

The speaker encoder is fetched during GitHub Actions from sherpa-onnx's publicly released ERes2Net 3D-Speaker model (Apache-2.0), and is deployed as `assets/speaker_encoder.onnx` alongside the Supertonic model. It adds about 26 MB to the initial cloning download; it is loaded only if the user clicks Create voice.

## Safety

Only clone voices with the subject's explicit permission, and clearly identify synthetic speech as such. Do not use impersonation to deceive others.

## Publish

1. Open **Settings → Pages** in this repository.
2. Set **Build and deployment → Source → GitHub Actions**.
3. Open **Actions → Publish Voice Studio to GitHub Pages** and run the workflow if it has not started automatically.
4. Visit `https://tbenitz.github.io/supertonic3-voice-studio/` after the deployment succeeds.

GitHub Actions downloads the archived model from Hugging Face at build time (~400 MB). The model is **not** stored in Git. Inference happens in each visitor's browser, not on a server, with no API key. A first-time visitor must download the model.

## Local development

Requires Node.js 22+ and Python 3.12+.

```bash
npm install
npm run fetch:helper
python -m pip install "huggingface_hub>=0.33,<2"
python scripts/download_model.py
npm run dev
```

## Licenses and privacy

- The model, presets, and weights are licensed separately under **OpenRAIL-M** (their license is bundled with the site). Respect the model usage conditions.
- The original archived browser inference helper is under **MIT**.
- Website-specific code is under **MIT**; see LICENSE.
- Custom JSON and audio previews remain local to the browser. Never use a third party's voice without permission, and disclose AI-generated speech when appropriate.
- The site uses a static build and has no upload server.

Upstream code: https://github.com/supertone-oss-archive/supertonic
