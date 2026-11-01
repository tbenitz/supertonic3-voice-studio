import { EventEmitter, CustomEvent } from './EventEmitter.js';

/**
 * PCMPlayerWorklet - AudioWorklet-based streaming PCM player
 * Uses dynamic buffer management with backpressure for smooth playback
 */
export class PCMPlayerWorklet extends EventEmitter {
  constructor(audioContext, options = {}) {
    super();
    this.audioContext = audioContext;
    this.options = options;
    this.workletNode = null;
    this.isInitialized = false;
    this.playbackTime = 0;

    this.gainNode = this.audioContext.createGain();
    this.gainNode.connect(this.audioContext.destination);
    this.analyser = this.audioContext.createAnalyser();
    this.gainNode.connect(this.analyser);

    this.pendingChunks = [];
    this.availableCapacity = 0;
    this.isWorkletReady = false;
    this.hasReceivedInitialCapacity = false;

    this.metrics = {
      chunksPlayed: 0,
      underruns: 0,
      bufferLevel: 0,
      samplesPlayed: 0
    };

    this.initPromise = this.initialize();
  }

  async initialize() {
    if (this.isInitialized) return;

    try {
      const sampleRate = this.audioContext.sampleRate;
      const minBufferMs = this.options.minBufferBeforePlaybackMs ?? 650;
      const resumeBufferMs = this.options.resumeBufferMs ?? 1400;
      const minBufferSamples = Math.floor(minBufferMs * sampleRate / 1000);
      const resumeBufferSamples = Math.floor(resumeBufferMs * sampleRate / 1000);
      const bufferSizeSamples = sampleRate * 60;

      const processorCode = `
        class PCMProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            this.bufferSize = ${bufferSizeSamples};
            this.ringBuffer = new Float32Array(this.bufferSize);
            this.readPos = 0;
            this.writePos = 0;
            this.isPlaying = false;
            this.minBufferSamples = ${minBufferSamples};
            this.resumeBufferSamples = ${resumeBufferSamples};
            this.targetBufferSamples = Math.min(this.bufferSize - 128, Math.max(this.minBufferSamples, this.resumeBufferSamples) * 2);
            this.hasStarted = false;
            this.isRebuffering = false;
            this.streamEnded = false;
            this.playbackCompleteReported = false;
            this.frameCount = 0;
            this.reportInterval = 256;

            this.port.onmessage = (e) => {
              switch(e.data.type) {
                case 'audio': this.addAudio(e.data.data); break;
                case 'reset': this.reset(); break;
                case 'stream-ended':
                  this.streamEnded = true;
                  this.tryStartPlayback();
                  break;
                case 'set-buffer-policy':
                  this.minBufferSamples = Math.max(0, Math.min(this.bufferSize - 1024, e.data.startupSamples));
                  this.resumeBufferSamples = Math.max(128, Math.min(this.bufferSize - 1024, e.data.resumeSamples));
                  this.targetBufferSamples = Math.min(this.bufferSize - 128, Math.max(this.minBufferSamples, this.resumeBufferSamples) * 2);
                  this.tryStartPlayback();
                  break;
                case 'request-capacity': this.sendCapacityUpdate(); break;
              }
            };
            this.sendCapacityUpdate();
          }

          addAudio(float32Data) {
            const samples = float32Data.length;
            const available = this.getAvailableSpace();
            if (samples > available) {
              const overflow = samples - available;
              this.readPos = (this.readPos + overflow) % this.bufferSize;
            }
            if (this.writePos + samples <= this.bufferSize) {
              this.ringBuffer.set(float32Data, this.writePos);
              this.writePos += samples;
              if (this.writePos >= this.bufferSize) this.writePos = 0;
            } else {
              const firstPart = this.bufferSize - this.writePos;
              const secondPart = samples - firstPart;
              this.ringBuffer.set(float32Data.slice(0, firstPart), this.writePos);
              this.ringBuffer.set(float32Data.slice(firstPart), 0);
              this.writePos = secondPart;
            }
            this.tryStartPlayback();
            this.sendCapacityUpdate();
          }

          tryStartPlayback() {
            if (this.isPlaying) return;
            const buffered = this.getBufferedSamples();
            const threshold = this.hasStarted ? this.resumeBufferSamples : this.minBufferSamples;
            if (buffered >= threshold || (this.streamEnded && buffered > 0)) {
              this.isPlaying = true;
              const type = this.hasStarted ? 'rebuffer-complete' : 'playback-started';
              this.port.postMessage({ type, buffered, audioTime: currentTime });
              this.hasStarted = true;
              this.isRebuffering = false;
            }
          }

          getAvailableSpace() {
            return this.bufferSize - this.getBufferedSamples() - 128;
          }

          getBufferedSamples() {
            return this.writePos >= this.readPos
              ? this.writePos - this.readPos
              : this.bufferSize - this.readPos + this.writePos;
          }

          sendCapacityUpdate() {
            const buffered = this.getBufferedSamples();
            const capacity = this.getAvailableSpace();
            let requestSamples = 0;
            if (buffered < this.targetBufferSamples) {
              requestSamples = Math.min(capacity, this.targetBufferSamples - buffered);
            }
            this.port.postMessage({ type: 'capacity', buffered, capacity, requestSamples, isPlaying: this.isPlaying });
          }

          process(inputs, outputs) {
            const output = outputs[0];
            if (!output || !output[0]) return true;
            const outputChannel = output[0];
            const numSamples = outputChannel.length;
            if (++this.frameCount % this.reportInterval === 0) this.sendCapacityUpdate();
            if (!this.isPlaying) {
              outputChannel.fill(0);
              // A complete generation may be shorter than the startup buffer,
              // or have ended during rebuffering. Always drain its final audio.
              this.tryStartPlayback();
              if (this.streamEnded && this.getBufferedSamples() === 0 && !this.playbackCompleteReported) {
                this.port.postMessage({ type: 'playback-complete' });
                this.playbackCompleteReported = true;
              }
              return true;
            }
            const buffered = this.getBufferedSamples();
            if (buffered < numSamples && !this.streamEnded) {
              // Don't consume partial samples and inject hundreds of little
              // silences. Suspend the stream until sufficient PCM has arrived.
              outputChannel.fill(0);
              this.isPlaying = false;
              this.isRebuffering = true;
              this.port.postMessage({type:'underrun', buffered, needed:numSamples});
              this.sendCapacityUpdate();
              return true;
            }
            if (buffered < numSamples) {
              let samplesRead = 0;
              if (buffered > 0) {
                if (this.readPos + buffered <= this.bufferSize) {
                  for (let i = 0; i < buffered; i++) outputChannel[i] = this.ringBuffer[this.readPos + i];
                  this.readPos += buffered;
                  if (this.readPos >= this.bufferSize) this.readPos = 0;
                } else {
                  const fp = this.bufferSize - this.readPos;
                  const sp = buffered - fp;
                  for (let i = 0; i < fp; i++) outputChannel[i] = this.ringBuffer[this.readPos + i];
                  for (let i = 0; i < sp; i++) outputChannel[fp + i] = this.ringBuffer[i];
                  this.readPos = sp;
                }
                samplesRead = buffered;
              }
              for (let i = samplesRead; i < numSamples; i++) outputChannel[i] = 0;
              if (this.streamEnded && buffered === 0) {
                if (!this.playbackCompleteReported) {
                  this.port.postMessage({ type: 'playback-complete' });
                  this.playbackCompleteReported = true;
                }
                this.isPlaying = false;
                this.streamEnded = false;
              }
            } else {
              if (this.readPos + numSamples <= this.bufferSize) {
                for (let i = 0; i < numSamples; i++) outputChannel[i] = this.ringBuffer[this.readPos + i];
                this.readPos += numSamples;
                if (this.readPos >= this.bufferSize) this.readPos = 0;
              } else {
                const fp = this.bufferSize - this.readPos;
                const sp = numSamples - fp;
                for (let i = 0; i < fp; i++) outputChannel[i] = this.ringBuffer[this.readPos + i];
                for (let i = 0; i < sp; i++) outputChannel[fp + i] = this.ringBuffer[i];
                this.readPos = sp;
              }
            }
            return true;
          }

          reset() {
            this.readPos = 0;
            this.writePos = 0;
            this.ringBuffer.fill(0);
            this.isPlaying = false;
            this.hasStarted = false;
            this.isRebuffering = false;
            this.streamEnded = false;
            this.playbackCompleteReported = false;
            this.sendCapacityUpdate();
          }
        }
        registerProcessor('pcm-processor', PCMProcessor);
      `;

      const blob = new Blob([processorCode], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      await this.audioContext.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-processor');
      this.workletNode.connect(this.gainNode);

      this.workletNode.port.onmessage = (e) => {
        switch (e.data.type) {
          case 'capacity': this.handleCapacityUpdate(e.data); break;
          case 'underrun':
            this.metrics.underruns++;
            this.metrics.isBuffering = true;
            this.emit('bufferUnderrun', {
              episodes: this.metrics.underruns,
              bufferedMs: e.data.buffered / this.audioContext.sampleRate * 1000
            });
            this.processPendingChunks();
            break;
          case 'rebuffer-complete':
            this.metrics.isBuffering = false;
            this.emit('bufferResumed', {
              bufferedMs: e.data.buffered / this.audioContext.sampleRate * 1000
            });
            break;
          case 'playback-started':
            this.metrics.isBuffering = false;
            this.emit('firstPlayback', { startTime: this.audioContext.currentTime, bufferedSamples: e.data.buffered });
            break;
          case 'playback-complete':
            this.emit('audioEnded', { endTime: this.audioContext.currentTime });
            break;
        }
      };

      // The processor constructor sends an initial capacity message, but it arrives
      // before port.onmessage is set above — so it's lost. Request a fresh one,
      // and bootstrap capacity so playAudio() works immediately without waiting
      // for the round-trip response.
      this.workletNode.port.postMessage({ type: 'request-capacity' });
      this.hasReceivedInitialCapacity = true;
      this.availableCapacity = bufferSizeSamples - 128;

      this.isInitialized = true;
      this.isWorkletReady = true;
    } catch (error) {
      console.error('Failed to initialize PCMPlayerWorklet:', error);
      throw error;
    }
  }

  handleCapacityUpdate(data) {
    this.availableCapacity = data.capacity;
    this.metrics.bufferLevel = data.buffered;
    if (!this.hasReceivedInitialCapacity) {
      this.hasReceivedInitialCapacity = true;
      if (this.pendingChunks.length > 0) this.processPendingChunks();
    }
    if (data.requestSamples > 0 && this.pendingChunks.length > 0) this.processPendingChunks();
  }

  processPendingChunks() {
    if (!this.isWorkletReady || this.pendingChunks.length === 0 || this.availableCapacity <= 0) return;
    // Drain as many pending chunks as capacity allows. This is critical on
    // iOS where inference blocks the main thread — we can't wait for
    // round-trip capacity updates from the audio thread between chunks.
    while (this.pendingChunks.length > 0 && this.availableCapacity > 0) {
      const chunk = this.pendingChunks[0];
      if (chunk.length <= this.availableCapacity) {
        this.pendingChunks.shift();
        this.workletNode.port.postMessage({ type: 'audio', data: chunk });
        this.availableCapacity -= chunk.length;
      } else if (this.availableCapacity > 4096) {
        const partial = chunk.slice(0, this.availableCapacity);
        this.pendingChunks[0] = chunk.slice(this.availableCapacity);
        this.workletNode.port.postMessage({ type: 'audio', data: partial });
        this.availableCapacity = 0;
      } else {
        break;
      }
    }
    if (this.pendingChunks.length === 0 && this.pendingStreamEnd) {
      this.workletNode.port.postMessage({ type: 'stream-ended' });
      this.pendingStreamEnd = false;
    }
  }

  playAudio(data) {
    if (!this.isInitialized) {
      if (!this.initPendingQueue) {
        this.initPendingQueue = [];
        this.initPromise.then(() => {
          const queue = this.initPendingQueue;
          this.initPendingQueue = null;
          for (const queuedData of queue) this.playAudio(queuedData);
        });
      }
      this.initPendingQueue.push(data);
      return;
    }
    if (this.audioContext.state !== 'running') return;
    const float32Array = data instanceof Int16Array ? this.pcm16ToFloat32(data) : data;
    this.pendingChunks.push(float32Array);
    if (this.hasReceivedInitialCapacity && this.availableCapacity > 0) this.processPendingChunks();
    this.metrics.chunksPlayed++;
    const duration = float32Array.length / this.audioContext.sampleRate;
    this.playbackTime = this.audioContext.currentTime + duration;
    this.emit('audioStarted', { startTime: this.audioContext.currentTime, duration, samples: float32Array.length });
  }

  notifyStreamEnded() {
    if (this.pendingChunks.length > 0) {
      this.pendingStreamEnd = true;
    } else if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'stream-ended' });
    }
  }

  setBufferPolicy({startupMs=650,resumeMs=1400}={}) {
    this.options.minBufferBeforePlaybackMs = startupMs;
    this.options.resumeBufferMs = resumeMs;
    if (this.workletNode) {
      const rate=this.audioContext.sampleRate;
      this.workletNode.port.postMessage({
        type:'set-buffer-policy',
        startupSamples: Math.round(startupMs * rate / 1000),
        resumeSamples: Math.round(resumeMs * rate / 1000)
      });
    }
  }

  pcm16ToFloat32(pcm16) {
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;
    return float32;
  }

  reset() {
    this.playbackTime = 0;
    this.pendingChunks = [];
    this.pendingStreamEnd = false;
    this.metrics.underruns = 0;
    this.metrics.bufferLevel = 0;
    this.metrics.isBuffering = false;
    this.metrics.chunksPlayed = 0;
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'reset' });
      this.workletNode.port.postMessage({ type: 'request-capacity' });
    }
    // After reset the worklet buffer is empty — bootstrap capacity so
    // playAudio() can send chunks immediately without waiting for the
    // round-trip capacity response.
    this.availableCapacity = this.audioContext.sampleRate * 60 - 128;
    if (this.gainNode) {
      const now = this.audioContext.currentTime;
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
      this.gainNode.gain.linearRampToValueAtTime(0, now + 0.05);
      setTimeout(() => { this.gainNode.gain.value = 1; }, 100);
    }
  }

  stopAllSources() { this.reset(); }

  async resume() {
    if (this.audioContext.state === 'suspended') await this.audioContext.resume();
  }

  get volume() { return this.gainNode.gain.value; }
  set volume(value) {
    const v = Math.max(0, Math.min(1, value));
    this.gainNode.gain.value = v;
    this.emit('volumeChange', { volume: v });
  }

  getAnalyserData() {
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.analyser.getByteFrequencyData(dataArray);
    return dataArray;
  }

  getTimeDomainData() {
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.analyser.getByteTimeDomainData(dataArray);
    return dataArray;
  }

  getPlaybackStatus() {
    const bufferMs = this.metrics.bufferLevel ? (this.metrics.bufferLevel / this.audioContext.sampleRate) * 1000 : 0;
    return {
      currentTime: this.audioContext.currentTime,
      scheduledTime: this.playbackTime,
      bufferedDuration: bufferMs / 1000,
      state: this.audioContext.state,
      worklet: {
        bufferLevelSamples: this.metrics.bufferLevel,
        bufferLevelMs: bufferMs,
        underruns: this.metrics.underruns,
        isBuffering: !!this.metrics.isBuffering,
        startupBufferMs: this.options.minBufferBeforePlaybackMs,
        resumeBufferMs: this.options.resumeBufferMs,
        chunksPlayed: this.metrics.chunksPlayed,
        pendingChunks: this.pendingChunks.length
      }
    };
  }
}
