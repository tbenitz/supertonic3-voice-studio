import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';

const chrome=process.env.CHROME_PATH||'/usr/bin/google-chrome';
if(!existsSync(chrome))throw Error('Missing Chrome: '+chrome);
const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
const sentence='This is a short demonstration of my synthesized voice.';
try {
  const page=await browser.newPage();
  const faults=[];
  page.on('pageerror',e=>faults.push(e.message));
  page.on('console',msg=>{if(msg.type()==='error')console.error('[browser]',msg.text());});
  await page.goto('http://127.0.0.1:4173/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('#generateBtn')?.disabled===false,null,{timeout:180000});
  console.log('TTS model loaded.');
  await page.locator('#text').fill(sentence);
  await page.locator('#totalStep').fill('5');
  await page.locator('#generateBtn').click();
  await page.waitForSelector('#results audio source',{timeout:180000});
  const b64=await page.evaluate(async()=>{
    const src=document.querySelector('#results audio source').src;
    const wav=new Uint8Array(await (await fetch(src)).arrayBuffer());
    let s='';for(const b of wav)s+=String.fromCharCode(b);
    return btoa(s);
  });
  assert.ok(b64.length>20000,'Expected WAV output');
  console.log('Initial voice synthesized.');
  await page.locator('#referenceAudioFile').setInputFiles({
    name:'reference.wav',mimeType:'audio/wav',buffer:Buffer.from(b64,'base64')
  });
  await page.locator('#referenceTranscript').fill(sentence);
  await page.locator('#cloneIterations').selectOption('2');
  await page.locator('#voiceConsent').check();
  await page.locator('#cloneBtn').click();
  await page.waitForFunction(()=>{
    const status=document.querySelector('#cloneStatus')?.textContent||'';
    return document.querySelector('#downloadClone')?.hidden===false ||
      status.includes('failed') || status.includes('model missing') || status.includes('backend found') || status.includes('Unsupported');
  },null,{timeout:300000});
  const ready=await page.locator('#downloadClone').evaluate(a=>!a.hidden);
  const status=await page.locator('#cloneStatus').textContent();
  if(!ready)throw Error('Cloning did not produce a voice: '+status);
  const profile=await page.locator('#downloadClone').evaluate(async a=>JSON.parse(await (await fetch(a.href)).text()));
  assert.deepEqual(profile.style_ttl.dims,[1,50,256]);
  assert.deepEqual(profile.style_dp.dims,[1,8,16]);
  assert.equal(profile.style_ttl.data.length,12800);
  assert.equal(profile.style_dp.data.length,128);
  assert.ok(profile.metadata.evaluations>=12);
  assert.ok(Number.isFinite(profile.metadata.speaker_similarity));
  console.log('Real cloning ran',profile.metadata.evaluations,'model comparisons; similarity',profile.metadata.speaker_similarity);
  assert.ok((await page.locator('#voiceStyleSelect').inputValue()).startsWith('blob:'));
  await page.locator('#text').fill('The generated voice profile is now active.');
  await page.locator('#generateBtn').click();
  await page.waitForSelector('#results audio source',{timeout:180000});
  assert.deepEqual(faults,[],'No browser JavaScript errors');
  console.log('Cloned JSON applied and used for speech. PASS');
} finally {await browser.close();}
