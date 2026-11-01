import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';

const chrome=process.env.CHROME_PATH||'/usr/bin/google-chrome';
const browser=await chromium.launch({executablePath:chrome,headless:true,
  args:['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required']});
try {
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 const errs=[];
 page.on('pageerror',e=>errs.push(e.message));
 page.on('console',m=>{if(m.type()==='error')console.error('[browser]',m.text());});
 page.on('requestfailed',r=>console.error('[request failed]',r.url(),r.failure()?.errorText));
 await page.goto('http://127.0.0.1:4173/',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>!document.getElementById('btn-generate').disabled,null,{timeout:240000});
 console.log('Pocket TTS browser models loaded.');
 await page.locator('#text-input').fill('The first sound should play before the rest of this full recording has been generated. This is a demonstration of streaming audio with Kyutai Pocket TTS, and it is being tested in an actual browser.');
 await page.locator('#btn-generate').click();
 await page.waitForFunction(()=>document.getElementById('stat-ttfb').textContent!=='—',null,{timeout:240000});
 const playbackObserved=await page.waitForFunction(()=>document.getElementById('streaming-state').textContent.includes('Playing now'),null,{timeout:120000}).then(()=>true,()=>false);
 console.log('First chunk arrived; playback observed:',playbackObserved);
 const maybeETA=await page.locator('#stat-eta').textContent();
 console.log('Live generation ETA:',maybeETA);
 await page.waitForFunction(()=>!document.getElementById('btn-download').disabled,null,{timeout:240000});
 const status=await page.locator('#streaming-state').textContent();
 console.log('Streaming complete:',status);
 assert.ok((await page.locator('#stat-produced').textContent()).includes('s'));
 assert.ok((await page.locator('#streaming-percent').textContent()).includes('100%'));
 if(!playbackObserved)throw Error('Never observed progressive playback');
 if(errs.length)throw Error('Page errors: '+errs.join(' | '));
 console.log('Pocket TTS streaming, ETA, and WAV export smoke test PASS.');
}finally{await browser.close();}
