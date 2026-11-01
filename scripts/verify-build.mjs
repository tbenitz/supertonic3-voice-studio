import {existsSync,statSync} from 'node:fs';
import {join} from 'node:path';
const required=['index.html','assets/onnx/duration_predictor.onnx','assets/onnx/text_encoder.onnx','assets/onnx/vector_estimator.onnx','assets/onnx/vocoder.onnx','assets/onnx/tts.json','assets/onnx/unicode_indexer.json','assets/voice_styles/M1.json','assets/voice_styles/F5.json','assets/LICENSE'];
for(const name of required){const file=join('dist',name);if(!existsSync(file)||!statSync(file).size)throw new Error('Missing deployment asset: '+file);}
console.log('All required static and model assets found.');
