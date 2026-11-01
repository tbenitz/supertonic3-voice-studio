/*
 * Adaptive Pocket TTS buffering.
 * A generation-speed observation is audio seconds produced per wall-clock
 * second. When that is < 1, streaming must pre-buffer enough audio to cover
 * the expected production deficit; no algorithm can make a slower-than-real-
 * time generator play a long clip continuously without waiting or buffering.
 *
 * All functions here are pure and tested in Node. The app persists only small
 * aggregates to localStorage, never audio, text or voice samples.
 */
export const BUFFER_PROFILE_VERSION=2;
export const DEFAULT_STARTUP_MS=650;
export const MAX_STARTUP_MS=48000;
export const MAX_RESUME_MS=24000;
const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
const finite=(x,fallback)=>Number.isFinite(Number(x))?Number(x):fallback;

export function chooseBufferPolicy(profile={},durationSec=10){
  const duration=clamp(finite(durationSec,10),1,240);
  const speed=finite(profile.speed,0);
  const minStart=clamp(finite(profile.startupMs,DEFAULT_STARTUP_MS),
    DEFAULT_STARTUP_MS,MAX_STARTUP_MS);
  // Under-realtime synthesis requires advance audio, not only a 160ms buffer.
  // Include 15% safety margin and compensate for inference rate variability.
  const deficit=speed>0 && speed<1.05
    ? (duration*1000*Math.max(0,1-speed)+650)*1.15
    : 0;
  const startupMs=Math.round(clamp(Math.max(minStart,deficit),DEFAULT_STARTUP_MS,MAX_STARTUP_MS));
  const resumeMs=Math.round(clamp(Math.max(
    finite(profile.resumeMs,1400),Math.min(startupMs*.40,MAX_RESUME_MS)),
    850,MAX_RESUME_MS));
  return {startupMs,resumeMs,speed,estimatedAudioSec:duration};
}

export function learnPlaybackProfile(previous={},run={}){
  const generated=finite(run.audioSeconds,0);
  const episodes=Math.max(0,Math.round(finite(run.underruns,0)));
  if(generated<.5)return {...previous};
  const speed=clamp(finite(run.speed,0),0,20);
  const priorSpeed=clamp(finite(previous.speed,0),0,20);
  const startupUsed=clamp(finite(run.startupMs,DEFAULT_STARTUP_MS),DEFAULT_STARTUP_MS,MAX_STARTUP_MS);
  const previousStart=clamp(finite(previous.startupMs,DEFAULT_STARTUP_MS),DEFAULT_STARTUP_MS,MAX_STARTUP_MS);
  const previousResume=clamp(finite(previous.resumeMs,1400),850,MAX_RESUME_MS);
  const cleanRuns=episodes?0:Math.min(100,Math.max(0,finite(previous.cleanRuns,0))+1);
  // Conservative learning; retain slower observations to resist transient
  // optimistic speeds that otherwise shrink the buffer prematurely.
  const learnedSpeed=speed>0
    ? (priorSpeed>0
      ? (episodes?Math.min(speed,priorSpeed):priorSpeed*.65+speed*.35)
      : speed)
    : priorSpeed;
  let startupMs=Math.max(previousStart,startupUsed);
  let resumeMs=previousResume;
  if(episodes>0){
    startupMs=Math.max(startupMs,Math.ceil(startupUsed*(1.5+Math.min(episodes,3)*.2)+600));
    resumeMs=Math.max(resumeMs,Math.ceil(previousResume*(1.4+Math.min(episodes,3)*.2)+500));
  }else if(cleanRuns>=4 && learnedSpeed>=.95){
    startupMs=Math.max(DEFAULT_STARTUP_MS,Math.round(startupMs*.9));
    resumeMs=Math.max(850,Math.round(resumeMs*.93));
  }
  return {
    version:BUFFER_PROFILE_VERSION,
    speed:Number(learnedSpeed.toFixed(3)),
    startupMs:Math.round(clamp(startupMs,DEFAULT_STARTUP_MS,MAX_STARTUP_MS)),
    resumeMs:Math.round(clamp(resumeMs,850,MAX_RESUME_MS)),
    cleanRuns,
    runs:Math.min(10000,Math.max(0,finite(previous.runs,0))+1),
    totalUnderruns:Math.min(100000,Math.max(0,finite(previous.totalUnderruns,0))+episodes),
  };
}

export function estimateEmergencyResumeMs({remainingAudioSec=0,speed=0,baseResumeMs=1400}={}){
  // Recover only when there is sufficient audio to avoid another immediate
  // dropout. Long slow clips still need periodic rebuffering, capped at 24s.
  const remaining=clamp(finite(remainingAudioSec,0),0,240);
  const rate=clamp(finite(speed,0),0,20);
  const needed=rate>0?remaining*1000*Math.max(0,1-rate)*.8:0;
  return Math.round(clamp(Math.max(finite(baseResumeMs,1400),needed,1200),850,MAX_RESUME_MS));
}
