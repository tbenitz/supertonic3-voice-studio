import {existsSync,statSync,readdirSync} from 'node:fs';
import {join, basename} from 'node:path';

const required=[
  'index.html',
  'assets/onnx/duration_predictor.onnx',
  'assets/onnx/text_encoder.onnx',
  'assets/onnx/vector_estimator.onnx',
  'assets/onnx/vocoder.onnx',
  'assets/onnx/tts.json',
  'assets/onnx/unicode_indexer.json',
  'assets/voice_styles/M1.json',
  'assets/voice_styles/F5.json',
  'assets/LICENSE',
  // ONNX Runtime's WebGPU-enabled build dynamically imports this script.
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
];

for(const name of required) {
  const file=join('dist',name);
  if(!existsSync(file)||!statSync(file).size) {
    throw new Error('Missing deployment asset: '+file);
  }
}

// Runtime .mjs and .wasm files must come from the SAME installed
// onnxruntime-web package version as the JS bundle.
const runtimeDir='node_modules/onnxruntime-web/dist';
const runtimeFiles=readdirSync(runtimeDir).filter(x=>/^ort-wasm.*\.(mjs|wasm)$/.test(x));
if(!runtimeFiles.some(x=>x.endsWith('.mjs'))||!runtimeFiles.some(x=>x.endsWith('.wasm'))) {
  throw new Error('Installed onnxruntime-web is missing runtime modules/binaries');
}
for (const file of runtimeFiles) {
  const src=join(runtimeDir,file);
  const dest=join('dist',basename(file));
  if(!existsSync(dest)||statSync(dest).size!==statSync(src).size) {
    throw new Error('ONNX runtime missing or mismatched: '+file);
  }
}
console.log('Verified '+required.length+' essential assets and '+runtimeFiles.length+' matching ONNX runtime files.');
