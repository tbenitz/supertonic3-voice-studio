# Pocket TTS Voice Studio

A **real**, locally executing browser voice-cloning + streaming speech application based on Kyutai's Pocket TTS. This replaces the previous Supertonic 3 implementation in the same repository and GitHub Pages URL.

**Website:** https://tbenitz.github.io/supertonic3-voice-studio/

## Features

- Upload a short WAV/MP3 sample or record microphone audio; browser Mimi encoder extracts a voice conditioning state **from your actual voice sample**, not a preset reranked with optimization.
- Generate speech using the cloned voice, or choose a built-in voice.
- Audio plays **while still generating**, using a Web Worker, PCM frames and an AudioWorklet ring buffer. An adaptive start buffer (650 ms on a fresh install) learns your device's generation speed and playback interruptions; if the model is slow, future runs start with more audio to prevent stuttering. When audio falls behind, playback pauses until enough PCM is buffered instead of inserting repeated tiny silences.
- Estimated **generation time remaining**, updated from measured audio-generation speed, with an explicitly approximate progress bar.
- WAV audio download; locally saved voice samples in browser IndexedDB.
- English (2026-04), German, Italian, Portuguese, and Spanish ONNX bundles, using the community ONNX Web port.

## Using the website

Open the site in Chrome or another modern browser. The first visit downloads Pocket TTS model components from Hugging Face and ONNX Runtime from jsDelivr. The tokenizer is served from GitHub Pages. These components are cached by the browser. Select a language and wait for the model to initialize; upload a **clean short recording of one authorized speaker** or use Record, then choose the cloned voice. Type text and click **Generate Audio**. It begins playing before generation completes, and updates a time-remaining estimate as chunks arrive. Stop interrupts playback and generation.

**Estimates are not guaranteed timings.** Before the first chunk, the site shows “Calibrating…”; after generation starts, it estimates audio duration from the text and generation speed from real chunks and optionally the previous local session. The display is explicitly marked approximate, and marks complete on stream end.

## Deployment

The repo is a static website. GitHub Actions deploys the site on each push to `main`; select **GitHub Actions** under **Settings → Pages** if needed.

Only the large ~4 MB SentencePiece runtime is copied from a **pinned upstream GitHub commit** during the build. The actual ONNX inference is performed client-side, but ONNX models and their assets are downloaded at runtime from the community's Hugging Face Space/CDN. No server accepts uploaded voices.

For local testing, fetch `sentencepiece.js` from the pinned upstream commit recorded in the Pages workflow, serve the repository on localhost (for example, `python3 -m http.server 8000`) and open localhost:8000.

## Licensing and attribution

This adaptation uses the [Pocket Voice](https://github.com/hemanth/pocket-voice) community browser implementation by Hemanth HM (MIT), the [Pocket TTS ONNX export](https://huggingface.co/KevinAHM/pocket-tts-onnx) from KevinAHM, and [Kyutai Pocket TTS](https://github.com/kyutai-labs/pocket-tts). The upstream models have their own Hugging Face terms and restrictions, including **explicit lawful consent for voice cloning**, and do not inherit the website's software license. The distributed web frontend includes code from the original third-party implementation: retain attribution. The original Supertonic code is no longer used.

**Do not use voices without permission or misrepresent generated audio as an authentic recording.**

## Troubleshooting

- If models do not load, check developer tools Network/Console for Hugging Face or jsDelivr failures; the static GitHub Pages workflow cannot fix external model CDN restrictions.
- Try Chrome desktop with sufficient memory for ONNX Runtime Web (WASM).
- A first run can involve substantial model downloads before generation becomes available.
- If speech stutters, a slower browser/CPU is generating below realtime speed. The ETA reflects the rate once chunks arrive. Playback learns a safer start buffer after underruns and also adapts after measuring generation speed. In very slow devices, smooth playback necessarily requires waiting longer before audio starts or occasionally pausing to refill; no buffering algorithm can make a slower-than-real-time generator render continuously without delay.

## Adaptive playback learning

The app detects real PCM buffer underruns inside its AudioWorklet. On a stall it pauses consumption, waits for a larger recovery buffer, and resumes without discarding samples. For each language it stores **only aggregate metrics** (audio-generation speed, last safe start/recovery thresholds, total interruptions) in localStorage; audio and text are never stored for the tuning feature. Each subsequent generation chooses a minimum start buffer based on measured audio-seconds generated per wall second and an estimated utterance length, so slower devices get additional headroom. If the first run already appears slow, it increases the prebuffer before that run begins. After repeated clean runs on a fast device it cautiously lowers startup latency. **Reset learning** forgets the selected language's tuning and returns to calibration.

This can't accelerate the ONNX model itself: a device producing 0.4 seconds of speech per second cannot continuously play 60 seconds of speech without generating much of it first. The app prioritizes smooth output while retaining streaming where possible.
