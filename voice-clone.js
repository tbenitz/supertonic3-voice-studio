// Browser-side voice-style optimisation for Supertonic 3.
// Original browser adaptation of the staged gradient-free approach described by
// DavidValin/supertonic3-tts. Never uploads the reference recording.
import * as ort from 'onnxruntime-web/webgpu';
import FFT from 'fft.js';
import { Style } from './helper.js';

const PRESETS=['M1','M2','M3','M4','M5','F1','F2','F3','F4','F5'];
const TTL_ROWS=50, TTL_COLS=256, DP_ROWS=8, DP_COLS=16;
const TTL_N=TTL_ROWS*TTL_COLS, DP_N=DP_ROWS*DP_COLS, FULL_N=TTL_N+DP_N;
const clip=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const gaussian=()=>{
  const x=Math.max(1e-9,Math.random()),y=Math.random();
  return Math.sqrt(-2*Math.log(x))*Math.cos(2*Math.PI*y);
};
const rms=a=>Math.sqrt(a.reduce((sum,v)=>sum+v*v,0)/Math.max(a.length,1));
function resample(input,from,to) {
  if(from===to)return Float32Array.from(input);
  const len=Math.max(1,Math.floor(input.length*to/from)),out=new Float32Array(len),ratio=from/to;
  for(let i=0;i<len;i++){const x=i*ratio,j=Math.floor(x),a=x-j;out[i]=input[j]*(1-a)+(input[Math.min(input.length-1,j+1)]||0)*a;}
  return out;
}
async function decodeAudio(file) {
  const ctx=new (window.AudioContext||window.webkitAudioContext)();
  try {
    const buffer=await ctx.decodeAudioData(await file.arrayBuffer());
    if(buffer.duration<1 || buffer.duration>120)throw Error('Use 1–120 seconds of clear speech from one speaker.');
    const channels=buffer.numberOfChannels,sr=buffer.sampleRate,n=buffer.length,mono=new Float32Array(n);
    for(let c=0;c<channels;c++){const a=buffer.getChannelData(c);for(let i=0;i<n;i++)mono[i]+=a[i]/channels;}
    return {data:mono,rate:sr};
  }finally{await ctx.close();}
}
function trimSpeech(data,rate) {
  const block=Math.max(1,Math.round(rate*.05));let max=0;
  for(let i=0;i<data.length;i+=block){let e=0;for(let j=i;j<Math.min(i+block,data.length);j++)e+=data[j]*data[j];max=Math.max(max,Math.sqrt(e/Math.min(block,data.length-i)));}
  if(max<.0001)throw Error('No speech detected. Use a recording with audible speech.');
  const threshold=Math.max(.002,max*.075);
  let first=0,last=data.length;
  for(let i=0;i<data.length;i+=block){let e=0;for(let j=i;j<Math.min(i+block,data.length);j++)e+=data[j]*data[j];if(Math.sqrt(e/Math.min(block,data.length-i))>threshold){first=Math.max(0,i-block);break;}}
  for(let i=data.length-block;i>=0;i-=block){let e=0;for(let j=i;j<Math.min(i+block,data.length);j++)e+=data[j]*data[j];if(Math.sqrt(e/Math.min(block,data.length-i))>threshold){last=Math.min(data.length,i+2*block);break;}}
  return data.subarray(first,last);
}
function fbank(audio,sampleRate,melBins=80){
  // Kaldi-style log-mel frontend: 25ms Povey windows, 10ms shift, 512-point FFT.
  const input=resample(audio,sampleRate,16000);
  if(input.length<1600)throw Error('Recording is too short for speaker identity analysis.');
  const fft=new FFT(512),frame=new Float64Array(512),spectrum=fft.createComplexArray();
  const window=new Float64Array(400);
  for(let i=0;i<400;i++)window[i]=Math.pow(.5-.5*Math.cos(2*Math.PI*i/399),.85);
  const mel=f=>1127*Math.log(1+f/700),low=mel(20),step=(mel(7600)-low)/(melBins+1);
  const filters=Array.from({length:melBins},(_,b)=>{
    const left=low+b*step,mid=left+step,right=mid+step,bins=[];
    for(let k=0;k<=256;k++){const m=mel(k*16000/512);
      const w=m>left&&m<right?(m<=mid?(m-left)/step:(right-m)/step):0;
      if(w>0)bins.push([k,w]);
    }
    return bins;
  });
  const nf=Math.floor((input.length+80)/160),flat=new Float32Array(nf*melBins);
  const means=new Float64Array(melBins);
  for(let t=0;t<nf;t++){
    const start=t*160-120;let avg=0;
    for(let j=0;j<400;j++){
      let pos=start+j;
      if(pos<0)pos=-pos-1;
      if(pos>=input.length)pos=2*input.length-1-pos;
      pos=clip(pos,0,input.length-1);
      frame[j]=input[pos];avg+=frame[j];
    }
    avg/=400;
    for(let j=399;j>=1;j--)frame[j]=frame[j]-avg-.97*(frame[j-1]-avg);
    frame[0]=.03*(frame[0]-avg);
    for(let j=0;j<400;j++)frame[j]*=window[j];
    frame.fill(0,400);
    fft.realTransform(spectrum,frame);
    const offset=t*melBins;
    for(let b=0;b<melBins;b++){
      let energy=0;
      for(const [k,w] of filters[b]){const re=spectrum[2*k],im=spectrum[2*k+1];energy+=(re*re+im*im)*w;}
      const v=Math.log(Math.max(1.192e-7,energy));flat[offset+b]=v;means[b]+=v;
    }
  }
  for(let b=0;b<melBins;b++)means[b]/=nf;
  return {flat,frames:nf,means};
}
function pitchStats(audio,sampleRate) {
  const a=resample(audio,sampleRate,8000),len=320,hop=160;
  const pitches=[];
  for(let i=0;i+len<a.length;i+=hop){
    let energy=0;for(let j=0;j<len;j++)energy+=a[i+j]*a[i+j];
    if(energy/len<.000035)continue;
    let best=-1,bestLag=0;
    for(let lag=16;lag<=133;lag++){
      let dot=0,x2=0,y2=0;
      for(let j=0;j<len-lag;j++){const x=a[i+j],y=a[i+j+lag];dot+=x*y;x2+=x*x;y2+=y*y;}
      const score=dot/Math.sqrt(x2*y2+1e-12);
      if(score>best){best=score;bestLag=lag;}
    }
    if(best>.58&&bestLag)pitches.push(Math.log2(8000/bestLag));
  }
  if(!pitches.length)return null;
  const mean=pitches.reduce((a,b)=>a+b,0)/pitches.length;
  const std=Math.sqrt(pitches.reduce((a,b)=>a+(b-mean)**2,0)/pitches.length);
  return {mean,std};
}
function normalizeRows(ttl,dp){
  for(const [values,cols] of [[ttl,TTL_COLS],[dp,DP_COLS]]){
    for(let start=0;start<values.length;start+=cols){
      let n=0;for(let j=0;j<cols;j++)n+=values[start+j]**2;
      n=Math.sqrt(n);
      if(n>1e-9)for(let j=0;j<cols;j++)values[start+j]/=n;
    }
  }
}
function fromJSON(obj){
  for(const [key,shape] of [['style_ttl',[1,TTL_ROWS,TTL_COLS]],['style_dp',[1,DP_ROWS,DP_COLS]]]){
    const node=obj?.[key];
    if(!node||!Array.isArray(node.dims)||node.dims.some((v,i)=>v!==shape[i])||!Array.isArray(node.data))throw Error('Voice preset has invalid '+key);
  }
  const ttl=Float32Array.from(obj.style_ttl.data.flat(Infinity));
  const dp=Float32Array.from(obj.style_dp.data.flat(Infinity));
  if(ttl.length!==TTL_N||dp.length!==DP_N)throw Error('Incorrect voice tensor length');
  return {ttl,dp};
}
function toOrtStyle(s){
  return new Style(new ort.Tensor('float32',s.ttl,[1,TTL_ROWS,TTL_COLS]),
                   new ort.Tensor('float32',s.dp,[1,DP_ROWS,DP_COLS]));
}
function toJSON(s,source,cos,steps) {
  return {
    style_ttl:{dims:[1,TTL_ROWS,TTL_COLS],data:Array.from(s.ttl)},
    style_dp:{dims:[1,DP_ROWS,DP_COLS],data:Array.from(s.dp)},
    metadata:{source:'Browser voice-style optimization',method:'speaker-embedding-guided gradient-free search',
      reference_name:source, speaker_similarity:cos, evaluations:steps, created_at:new Date().toISOString(),
      note:'Experimental; similarity is not guaranteed. Do not use without speaker consent.'}
  };
}
function mixGlobal(basis,p){
  const k=basis.length,ttl=new Float32Array(TTL_N),dp=new Float32Array(DP_N);
  for(let b=0;b<k;b++){
    const wt=p[b],wd=p[k+b],s=basis[b];
    for(let i=0;i<TTL_N;i++)ttl[i]+=wt*s.ttl[i];
    for(let i=0;i<DP_N;i++)dp[i]+=wd*s.dp[i];
  }
  normalizeRows(ttl,dp);return {ttl,dp};
}
function mixRows(basis,p){
  const k=basis.length,ttl=new Float32Array(TTL_N),dp=new Float32Array(DP_N);
  for(let row=0;row<TTL_ROWS;row++)for(let b=0;b<k;b++){
    const weight=p[row*k+b],start=row*TTL_COLS;
    for(let j=0;j<TTL_COLS;j++)ttl[start+j]+=weight*basis[b].ttl[start+j];
  }
  for(let row=0;row<DP_ROWS;row++)for(let b=0;b<k;b++){
    const weight=p[TTL_ROWS*k+row*k+b],start=row*DP_COLS;
    for(let j=0;j<DP_COLS;j++)dp[start+j]+=weight*basis[b].dp[start+j];
  }
  normalizeRows(ttl,dp);return {ttl,dp};
}
function refine(init,p){
  const ttl=init.ttl.slice(),dp=init.dp.slice();
  for(let i=0;i<TTL_N;i++)ttl[i]+=p[i];
  for(let i=0;i<DP_N;i++)dp[i]+=p[TTL_N+i];
  normalizeRows(ttl,dp);return {ttl,dp};
}
function cosine(a,b){let d=0,x=0,y=0;for(let i=0;i<a.length;i++){d+=a[i]*b[i];x+=a[i]*a[i];y+=b[i]*b[i];}return d/Math.sqrt(x*y+1e-16);}
class SpeakerEncoder {
  constructor(session){this.session=session;this.inputName=session.inputNames[0];this.outputName=session.outputNames[0];}
  static async load(progress){
    progress('Loading the speaker identity model…');
    const url=new URL('assets/speaker_encoder.onnx',document.baseURI).href;
    const response=await fetch(url);
    if(!response.ok)throw Error('Speaker identity model missing ('+response.status+'). Deployment needs assets/speaker_encoder.onnx.');
    const array=await response.arrayBuffer();
    const session=await ort.InferenceSession.create(array,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
    return new SpeakerEncoder(session);
  }
  async embed(samples,sampleRate){
    const feat=fbank(samples,sampleRate);
    if(feat.frames<10)throw Error('Not enough speech frames for speaker identity model');
    const metadata=this.session.inputMetadata?.[this.inputName];
    const d=metadata?.dimensions?.at(-1)||80;
    if(d!==80)throw Error('Unexpected speaker model feature dimension '+d);
    const x=new ort.Tensor('float32',feat.flat,[1,feat.frames,80]);
    const output=await this.session.run({[this.inputName]:x});
    const values=output[this.outputName]?.data;
    if(!values||!values.length)throw Error('Speaker model did not return an embedding');
    const result=Float32Array.from(values);
    let n=0;for(const v of result)n+=v*v;
    n=Math.sqrt(n);if(n<1e-8)throw Error('Speaker embedding was empty');
    result.forEach((v,i)=>result[i]=v/n);
    return {embedding:result,means:feat.means};
  }
}
function makeAbort(){return {stopped:false,check(){if(this.stopped)throw Error('Cloning was stopped.');}};}
export function wireVoiceCloning({getTTS,selectVoice,showStatus,showError,onBusy=()=>{}}){
  const btn=document.getElementById('cloneBtn'),stop=document.getElementById('stopCloneBtn');
  const transcript=document.getElementById('referenceTranscript'),name=document.getElementById('cloneName');
  const progress=document.getElementById('cloneProgress'),status=document.getElementById('cloneStatus');
  const download=document.getElementById('downloadClone'),stepsEl=document.getElementById('cloneIterations');
  const windowStart=document.getElementById('referenceStart'),windowEnd=document.getElementById('referenceEnd');
  let currentAbort=null,downloadUrl=null;
  stop.addEventListener('click',()=>{if(currentAbort){currentAbort.stopped=true;status.textContent='Stopping after the current inference step…';stop.disabled=true;}});
  btn.addEventListener('click',async()=>{
    const file=document.getElementById('referenceAudioFile').files?.[0],text=transcript.value.trim();
    if(!file){showError('Choose a reference audio recording first.');return;}
    if(text.length<8||text.length>300){showError('Enter the exact words spoken in the recording (8–300 characters).');return;}
    if(!getTTS()){showError('Text-to-speech models must finish loading before cloning.');return;}
    const consent=document.getElementById('voiceConsent');
    if(!consent.checked){showError('Confirm that you own this recording or have permission to clone the voice.');return;}
    const budget=clip(Number(stepsEl.value)||12,2,100);
    const mix=Math.max(1,Math.round(budget*.25)),rows=Math.max(0,Math.round(budget*.3)),fine=budget-mix-rows;
    const abort=makeAbort();currentAbort=abort;
    onBusy(true);
    btn.disabled=true;stop.disabled=false;download.hidden=true;progress.value=0;progress.max=10+2*(mix+rows+fine);
    const log=msg=>{status.textContent=msg;showStatus(msg);};
    let evaluated=0;
    let best=null,bestLoss=Infinity,bestCos=-1,baseVoice='M1';
    let encoder=null;
    try {
      showError('');
      log('Decoding your recording locally…');
      const decoded=await decodeAudio(file);abort.check();
      const speech=trimSpeech(decoded.data,decoded.rate);
      if(speech.length/decoded.rate<1)throw Error('Need at least 1 second of audible speech.');
      const a=Number(windowStart.value),b=Number(windowEnd.value);
      const hasWindow=windowStart.value!==''||windowEnd.value!=='';
      if(hasWindow&&(!(b>a)||a<0||b>decoded.data.length/decoded.rate))throw Error('Reference transcript window must be valid start and end seconds.');
      const excerpt=hasWindow?decoded.data.subarray(Math.floor(a*decoded.rate),Math.floor(b*decoded.rate)):speech;
      if(excerpt.length/decoded.rate>20)throw Error('The transcript window should be 20 seconds or less. Set a matching start and end range.');
      encoder=await SpeakerEncoder.load(log);abort.check();
      log('Analyzing speaker identity, pitch and spectral signature…');
      const target=await encoder.embed(speech,decoded.rate);
      const targetPitch=pitchStats(speech,decoded.rate);
      const durationTarget=excerpt.length/decoded.rate;
      const basis=[];
      for(const preset of PRESETS){
        const response=await fetch(new URL('assets/voice_styles/'+preset+'.json',document.baseURI));
        if(!response.ok)throw Error('Cannot load voice preset '+preset);
        basis.push(fromJSON(await response.json()));
      }
      const language=document.getElementById('langSelect').value;
      const tts=getTTS();
      async function evaluate(candidate,stage){
        abort.check();
        const result=await tts._infer([text],[language],toOrtStyle(candidate),5,1.0);
        abort.check();
        const audio=Float32Array.from(result.wav.slice(0,Math.floor(result.duration[0]*tts.sampleRate)));
        const emb=await encoder.embed(audio,tts.sampleRate);
        const sim=cosine(target.embedding,emb.embedding);
        const genPitch=pitchStats(audio,tts.sampleRate);
        const pitch=(targetPitch&&genPitch)?((targetPitch.mean-genPitch.mean)**2+(targetPitch.std-genPitch.std)**2):0.6;
        const duration=(result.duration[0]/Math.max(1,durationTarget)-1)**2;
        let spectral=0;for(let j=0;j<80;j++)spectral+=Math.abs(target.means[j]-emb.means[j])/80;
        const loss=4*(1-sim)+1.2*pitch+0.25*duration+0.03*spectral;
        evaluated++;progress.value=evaluated;
        if(loss<bestLoss){bestLoss=loss;bestCos=sim;best=candidate;}
        status.textContent=stage+' · '+evaluated+'/'+progress.max+' comparisons · speaker cosine '+sim.toFixed(3)+' · best '+bestCos.toFixed(3);
        await tick();
        return loss;
      }
      let baseIndex=0,stageLoss=Infinity;
      for(let i=0;i<basis.length;i++){
        const val=await evaluate(basis[i],'Selecting closest preset');
        if(val<stageLoss){stageLoss=val;baseIndex=i;}
      }
      baseVoice=PRESETS[baseIndex];
      const k=basis.length,global=new Float32Array(k*2);
      global[baseIndex]=1;global[k+baseIndex]=1;
      async function optimize(stage,params,iterations,sigma,lr,build){
        if(iterations<1)return {params,style:build(params)};
        const n=params.length,m=new Float32Array(n),v=new Float32Array(n);
        let bestParams=params.slice(),stageBestLoss=Infinity;
        for(let it=1;it<=iterations;it++){
          abort.check();
          const eps=Float32Array.from({length:n},gaussian);
          const plus=new Float32Array(n),minus=new Float32Array(n);
          for(let j=0;j<n;j++){plus[j]=params[j]+sigma*eps[j];minus[j]=params[j]-sigma*eps[j];}
          const lossPlus=await evaluate(build(plus),stage+' '+it+'/'+iterations+' (+)');
          const lossMinus=await evaluate(build(minus),stage+' '+it+'/'+iterations+' (-)');
          const betterLoss=Math.min(lossPlus,lossMinus);
          if(betterLoss<stageBestLoss){stageBestLoss=betterLoss;bestParams=(lossPlus<=lossMinus?plus:minus).slice();}
          const scale=(lossPlus-lossMinus)/(2*sigma),b1=.8,b2=.99,c1=1-b1**it,c2=1-b2**it;
          for(let j=0;j<n;j++){
            const g=eps[j]*scale;
            m[j]=b1*m[j]+(1-b1)*g;v[j]=b2*v[j]+(1-b2)*g*g;
            params[j]-=lr*(m[j]/c1)/(Math.sqrt(v[j]/c2)+1e-8);
          }
          await tick();
        }
        return {params:bestParams,style:build(bestParams)};
      }
      log('Closest voice: '+baseVoice+'. Optimizing mixtures…');
      const gl=await optimize('Global voice mix',global,mix,.1,.035,p=>mixGlobal(basis,p));
      const rowParams=new Float32Array((TTL_ROWS+DP_ROWS)*k);
      for(let row=0;row<TTL_ROWS;row++)for(let j=0;j<k;j++)rowParams[row*k+j]=gl.params[j];
      for(let row=0;row<DP_ROWS;row++)for(let j=0;j<k;j++)rowParams[TTL_ROWS*k+row*k+j]=gl.params[k+j];
      const rl=await optimize('Voice texture mix',rowParams,rows,.08,.03,p=>mixRows(basis,p));
      await optimize('Voice tensor refinement',new Float32Array(FULL_N),fine,.006,.0006,p=>refine(rl.style,p));
      progress.value=progress.max;
      log('Voice profile created. Similarity: '+bestCos.toFixed(3)+'. Test and download your JSON.');
      showStatus('New voice profile generated locally.','success');
    }catch(error){
      log(error.message);
      if(!abort.stopped){showError('Voice cloning failed: '+error.message);console.error('Clone error',error);}
    }finally{
      if(best&&evaluated>0){
        const title=(name.value.trim()||'my-voice').replace(/[^a-z0-9_-]/gi,'_').slice(0,40);
        const profile=toJSON(best,file?.name||'audio',bestCos,evaluated);
        const json=JSON.stringify(profile);
        if(downloadUrl)URL.revokeObjectURL(downloadUrl);
        downloadUrl=URL.createObjectURL(new Blob([json],{type:'application/json'}));
        download.hidden=false;download.href=downloadUrl;download.download=title+'.json';
        try {
          await selectVoice(profile,title);
          status.textContent+=(abort.stopped?' Best profile so far saved.':'')+' Applied as active voice. You can test it with Generate Speech.';
        } catch(error) {
          showError('The voice JSON was created, but applying it failed: '+error.message+' — download the JSON and try Import.');
        }
      }
      if(encoder)await encoder.session.release().catch(()=>{});
      currentAbort=null;btn.disabled=false;stop.disabled=true;onBusy(false);
    }
  });
}
