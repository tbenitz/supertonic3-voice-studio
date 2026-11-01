# Supertonic 3 Voice Studio

A privacy-first multilingual text-to-speech website for GitHub Pages built on the archived [Supertonic 3](https://huggingface.co/supertone-oss-archive/supertonic-3) ONNX model.

**Features:** 31 languages, 10 preset voices, custom Supertonic 3 style JSON import, local reference-audio preview, WAV export, reading-speed and quality settings, WebGPU with WebAssembly fallback.

**Limitation:** uploading an audio recording does not create a voice clone. The public model does not include a reference-audio-to-style encoder. For a new voice, first create a compatible style JSON with a separate tool; an experimental community option is [supertonic3-tts](https://github.com/DavidValin/supertonic3-tts).

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
