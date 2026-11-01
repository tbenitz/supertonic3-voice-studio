import {
    loadTextToSpeech,
    loadVoiceStyle,
    writeWavFile
} from './helper.js';
import {wireVoiceCloning} from './voice-clone.js';

// Configuration
const DEFAULT_VOICE_STYLE_PATH = 'assets/voice_styles/M1.json';

// Helper function to extract filename from path
function getFilenameFromPath(path) {
    return path.split('/').pop();
}

// Global state
let textToSpeech = null;
let cfgs = null;

// Pre-computed style
let currentStyle = null;
let currentStylePath = DEFAULT_VOICE_STYLE_PATH;
let customVoiceUrl = null;
let referenceAudioUrl = null;
let lastGeneratedUrl = null;
let cloningBusy = false;

// UI Elements
const textInput = document.getElementById('text');
const voiceStyleSelect = document.getElementById('voiceStyleSelect');
const voiceStyleInfo = document.getElementById('voiceStyleInfo');
const langSelect = document.getElementById('langSelect');
const totalStepInput = document.getElementById('totalStep');
const speedInput = document.getElementById('speed');
const generateBtn = document.getElementById('generateBtn');
const statusBox = document.getElementById('statusBox');
const statusText = document.getElementById('statusText');
const backendBadge = document.getElementById('backendBadge');
const resultsContainer = document.getElementById('results');
const errorBox = document.getElementById('error');

function showStatus(message, type = 'info') {
    statusText.textContent = message.replace(/<[^>]*>/g, '');
    statusBox.className = 'status-box';
    if (type === 'success') {
        statusBox.classList.add('success');
    } else if (type === 'error') {
        statusBox.classList.add('error');
    }
}

function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.add('active');
}

function hideError() {
    errorBox.classList.remove('active');
}

function showBackendBadge() {
    backendBadge.classList.add('visible');
}

// Load voice style from JSON
async function loadStyleFromJSON(stylePath) {
    try {
        const style = await loadVoiceStyle([stylePath], true);
        return style;
    } catch (error) {
        console.error('Error loading voice style:', error);
        throw error;
    }
}

// Load models on page load
async function initializeModels() {
    try {
        showStatus('ℹ️ <strong>Loading configuration...</strong>');
        
        const basePath = 'assets/onnx';
        
        // Try WebGPU first, fallback to WASM
        let executionProvider = 'wasm';
        try {
            const result = await loadTextToSpeech(basePath, {
                executionProviders: ['webgpu'],
                graphOptimizationLevel: 'all'
            }, (modelName, current, total) => {
                showStatus(`ℹ️ <strong>Loading ONNX models (${current}/${total}):</strong> ${modelName}...`);
            });
            
            textToSpeech = result.textToSpeech;
            cfgs = result.cfgs;
            
            executionProvider = 'webgpu';
            backendBadge.textContent = 'WebGPU';
            backendBadge.style.background = '#4caf50';
        } catch (webgpuError) {
            console.log('WebGPU not available, falling back to WebAssembly');
            
            const result = await loadTextToSpeech(basePath, {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'all'
            }, (modelName, current, total) => {
                showStatus(`ℹ️ <strong>Loading ONNX models (${current}/${total}):</strong> ${modelName}...`);
            });
            
            textToSpeech = result.textToSpeech;
            cfgs = result.cfgs;
        }
        
        showStatus('ℹ️ <strong>Loading default voice style...</strong>');
        
        // Load default voice style
        currentStyle = await loadStyleFromJSON(currentStylePath);
        voiceStyleInfo.textContent = `${getFilenameFromPath(currentStylePath)} (default)`;
        
        showStatus(`✅ <strong>Models loaded!</strong> Using ${executionProvider.toUpperCase()}. You can now generate speech.`, 'success');
        showBackendBadge();
        
        generateBtn.disabled = false;
        
    } catch (error) {
        console.error('Error loading models:', error);
        showStatus(`❌ <strong>Error loading models:</strong> ${error.message}`, 'error');
    }
}

// Handle voice style selection
voiceStyleSelect.addEventListener('change', async (e) => {
    const selectedValue = e.target.value;
    
    if (!selectedValue) return;
    
    try {
        generateBtn.disabled = true;
        showStatus(`ℹ️ <strong>Loading voice style...</strong>`, 'info');
        
        currentStylePath = selectedValue;
        currentStyle = await loadStyleFromJSON(currentStylePath);
        voiceStyleInfo.textContent = getFilenameFromPath(currentStylePath);
        
        showStatus(`✅ <strong>Voice style loaded:</strong> ${getFilenameFromPath(currentStylePath)}`, 'success');
        generateBtn.disabled = false;
    } catch (error) {
        showError(`Error loading voice style: ${error.message}`);
        
        // Restore default style
        currentStylePath = DEFAULT_VOICE_STYLE_PATH;
        voiceStyleSelect.value = currentStylePath;
        try {
            currentStyle = await loadStyleFromJSON(currentStylePath);
            voiceStyleInfo.textContent = `${getFilenameFromPath(currentStylePath)} (default)`;
        } catch (styleError) {
            console.error('Error restoring default style:', styleError);
        }
        
        generateBtn.disabled = false;
    }
});


function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch]));
}
function validateStyle(profile) {
    const shapes = [['style_ttl',[1,50,256]],['style_dp',[1,8,16]]];
    for (const [key, dims] of shapes) {
        const v=profile?.[key];
        if (!v || !Array.isArray(v.dims) || v.dims.length!==dims.length || v.dims.some((n,i)=>n!==dims[i]) || !Array.isArray(v.data)) {
            throw new Error('Not a compatible Supertonic 3 voice style: invalid '+key+' shape.');
        }
        const numbers=v.data.flat(Infinity);
        if (numbers.length!==dims.reduce((a,b)=>a*b,1) || !numbers.every(n=>typeof n==='number' && Number.isFinite(n))) {
            throw new Error('Invalid '+key+' voice-style tensor data.');
        }
    }
}
document.getElementById('customVoiceFile').addEventListener('change',async event=>{
    const file=event.target.files?.[0];
    if (!file) return;
    let nextUrl=null;
    hideError();
    try {
        if(file.size>3000000)throw new Error('JSON profile exceeds 3 MB.');
        const profile=JSON.parse(await file.text());
        validateStyle(profile);
        nextUrl=URL.createObjectURL(new Blob([JSON.stringify(profile)],{type:'application/json'}));
        const style=await loadVoiceStyle([nextUrl]);
        const select=document.getElementById('voiceStyleSelect');
        const oldUrl=customVoiceUrl;
        customVoiceUrl=nextUrl;
        currentStyle=style;
        currentStylePath=customVoiceUrl;
        let option=select.querySelector('option[data-custom="yes"]');
        if(!option){option=document.createElement('option');option.dataset.custom='yes';select.add(option);}
        option.value=customVoiceUrl;
        option.textContent='Custom: '+file.name.slice(0,50);
        select.value=customVoiceUrl;
        if(oldUrl)URL.revokeObjectURL(oldUrl);
        voiceStyleInfo.textContent='Imported: '+file.name;
        document.getElementById('customVoiceStatus').textContent='Custom voice ready locally: '+file.name;
        generateBtn.disabled=!textToSpeech;
        showStatus('✅ Imported custom voice style successfully.','success');
    }catch(e){
        if(nextUrl&&nextUrl!==customVoiceUrl)URL.revokeObjectURL(nextUrl);
        showError('Custom voice import failed: '+e.message);
    }finally{event.target.value='';}
});
document.getElementById('referenceAudioFile').addEventListener('change',event=>{
    const file=event.target.files?.[0];
    if(!file)return;
    hideError();
    if(file.size>100000000){showError('Please select a reference recording smaller than 100 MB.');return;}
    if(referenceAudioUrl)URL.revokeObjectURL(referenceAudioUrl);
    referenceAudioUrl=URL.createObjectURL(file);
    document.getElementById('referenceAudioPlayer').src=referenceAudioUrl;
    document.getElementById('referenceAudioName').textContent='Reference audio: '+file.name;
    document.getElementById('referencePreview').hidden=false;
    showStatus('Reference loaded locally. Add the transcript and click Create voice from recording.','info');
});

async function applyClonedProfile(profile,title) {
    const url=URL.createObjectURL(new Blob([JSON.stringify(profile)],{type:'application/json'}));
    try {
        const style=await loadVoiceStyle([url]);
        const select=document.getElementById('voiceStyleSelect');
        const previous=customVoiceUrl;
        customVoiceUrl=url;
        currentStyle=style;
        currentStylePath=url;
        let option=select.querySelector('option[data-custom="yes"]');
        if(!option){option=document.createElement('option');option.dataset.custom='yes';select.add(option);}
        option.value=url;option.textContent='Cloned: '+title;
        select.value=url;
        voiceStyleInfo.textContent='Cloned voice: '+title;
        document.getElementById('customVoiceStatus').textContent='Cloned profile applied. You can also download the JSON to reuse later.';
        if(previous)URL.revokeObjectURL(previous);
    }catch(e){URL.revokeObjectURL(url);throw e;}
}
wireVoiceCloning({
    getTTS:()=>cloningBusy||!generateBtn.disabled?textToSpeech:textToSpeech,
    loadStyle:loadVoiceStyle,
    selectVoice:applyClonedProfile,
    showStatus,
    showError:(message)=>{if(message)showError(message);else hideError();},
    onBusy:(busy)=>{cloningBusy=busy;generateBtn.disabled=busy||!textToSpeech;}
});
// Main synthesis function
async function generateSpeech() {
    if (cloningBusy) {showError('Finish or stop voice cloning before generating speech.');return;}
    const text = textInput.value.trim();
    if (!text) {
        showError('Please enter some text to synthesize.');
        return;
    }
    
    if (!textToSpeech || !cfgs) {
        showError('Models are still loading. Please wait.');
        return;
    }
    
    if (!currentStyle) {
        showError('Voice style is not ready. Please wait.');
        return;
    }
    
    const startTime = Date.now();
    
    try {
        generateBtn.disabled = true;
        hideError();
        
        // Clear results and show placeholder
        resultsContainer.innerHTML = `
            <div class="results-placeholder generating">
                <div class="results-placeholder-icon">⏳</div>
                <p>Generating speech...</p>
            </div>
        `;
        
        const totalStep = parseInt(totalStepInput.value);
        const speed = parseFloat(speedInput.value);
        const lang = langSelect.value;
        
        showStatus('ℹ️ <strong>Generating speech from text...</strong>');
        const tic = Date.now();
        
        const { wav, duration } = await textToSpeech.call(
            text,
            lang,
            currentStyle, 
            totalStep,
            speed,
            0.3,
            (step, total) => {
                showStatus(`ℹ️ <strong>Denoising (${step}/${total})...</strong>`);
            }
        );
        
        const toc = Date.now();
        console.log(`Text-to-speech synthesis: ${((toc - tic) / 1000).toFixed(2)}s`);
        
        showStatus('ℹ️ <strong>Creating audio file...</strong>');
        const wavLen = Math.floor(textToSpeech.sampleRate * duration[0]);
        const wavOut = wav.slice(0, wavLen);
        
        // Create WAV file
        const wavBuffer = writeWavFile(wavOut, textToSpeech.sampleRate);
        const blob = new Blob([wavBuffer], { type: 'audio/wav' });
        if (lastGeneratedUrl) URL.revokeObjectURL(lastGeneratedUrl);
        const url = URL.createObjectURL(blob);
        lastGeneratedUrl = url;
        
        // Calculate total time and audio duration
        const endTime = Date.now();
        const totalTimeSec = ((endTime - startTime) / 1000).toFixed(2);
        const audioDurationSec = duration[0].toFixed(2);
        
        // Display result with full text
        resultsContainer.innerHTML = `
            <div class="result-item">
                <div class="result-text-container">
                    <div class="result-text-label">Input Text</div>
                    <div class="result-text">${escapeHTML(text)}</div>
                </div>
                <div class="result-info">
                    <div class="info-item">
                        <span>📊 Audio Length</span>
                        <strong>${audioDurationSec}s</strong>
                    </div>
                    <div class="info-item">
                        <span>⏱️ Generation Time</span>
                        <strong>${totalTimeSec}s</strong>
                    </div>
                </div>
                <div class="result-player">
                    <audio controls>
                        <source src="${url}" type="audio/wav">
                    </audio>
                </div>
                <div class="result-actions">
                    <button onclick="downloadAudio('${url}', 'synthesized_speech.wav')">
                        <span>⬇️</span>
                        <span>Download WAV</span>
                    </button>
                </div>
            </div>
        `;
        
        showStatus('✅ <strong>Speech synthesis completed successfully!</strong>', 'success');
        
    } catch (error) {
        console.error('Error during synthesis:', error);
        showStatus(`❌ <strong>Error during synthesis:</strong> ${error.message}`, 'error');
        showError(`Error during synthesis: ${error.message}`);
        
        // Restore placeholder
        resultsContainer.innerHTML = `
            <div class="results-placeholder">
                <div class="results-placeholder-icon">🎤</div>
                <p>Generated speech will appear here</p>
            </div>
        `;
    } finally {
        generateBtn.disabled = false;
    }
}

// Download handler (make it global so it can be called from onclick)
window.downloadAudio = function(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
};

// Attach generate function to button
generateBtn.addEventListener('click', generateSpeech);

// Initialize on load
window.addEventListener('load', async () => {
    generateBtn.disabled = true;
    await initializeModels();
});
