import {_electron as electron,expect} from '@playwright/test';
import {createApp} from '../apps/server/src/app.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const root=fileURLToPath(new URL('../',import.meta.url)),temp=await mkdtemp(path.join(tmpdir(),'duallink-history-desktop-'));
assert.equal(path.dirname(temp),tmpdir());
const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=','base64');
const service=await createApp({dataDir:path.join(temp,'server'),secureCookies:false,startWorker:false,history:{startCleanup:false},runner:async()=>({answer:'Synthetic test answer'})});
service.createUser({email:'history-desktop@test.example',password:'OnlyTestHistory42!',name:'历史客户端测试',role:'admin'});
await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+service.server.address().port;
let application;
try{
 const login=await fetch(origin+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'history-desktop@test.example',password:'OnlyTestHistory42!'})}),identity=await login.json();
 const auth={cookie:login.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':identity.csrfToken};
 const api=(route,method='GET',body)=>fetch(origin+'/api'+route,{method,headers:{...auth,...(body instanceof FormData?{}:{'content-type':'application/json'})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
 const entry=path.join(temp,'main.cjs');
 await writeFile(entry,`const {desktopCapturer,nativeImage,screen}=require('electron');desktopCapturer.getSources=async()=>[{display_id:String(screen.getPrimaryDisplay().id),thumbnail:nativeImage.createFromBitmap(Buffer.from([32,80,120,255]),{width:1,height:1})}];require(${JSON.stringify(path.join(root,'apps/desktop/main.cjs'))});`);
 application=await electron.launch({...(process.env.DUALLINK_PACKAGED_EXE?{executablePath:process.env.DUALLINK_PACKAGED_EXE,args:[]}:{args:[entry]}),env:{...process.env,DUALLINK_TEST_MODE:'1',DUALLINK_TEST_USER_DATA:path.join(temp,'client')}});
 const desktop=await application.firstWindow();await desktop.waitForLoadState('domcontentloaded');
 if(process.env.DUALLINK_PACKAGED_EXE)await application.evaluate(({desktopCapturer,nativeImage,screen})=>{desktopCapturer.getSources=async()=>[{display_id:String(screen.getPrimaryDisplay().id),thumbnail:nativeImage.createFromBitmap(Buffer.from([32,80,120,255]),{width:1,height:1})}];});
 const errors=[];desktop.on('pageerror',error=>errors.push(error.message));
 const state=()=>desktop.evaluate(()=>window.dualLink.getState());
 const pairing=await desktop.evaluate(cloudUrl=>window.dualLink.startPairing({cloudUrl,deviceName:'历史清理测试电脑'}),origin);
 assert.equal((await api('/pairings/approve','POST',{code:pairing.pairing.code})).status,200);
 await expect.poll(async()=>(await state()).connected,{timeout:15000}).toBe(true);
 await desktop.evaluate(()=>window.dualLink.saveSettings({lanFirst:true,useAccountModels:false}));
 await desktop.evaluate(()=>{window.historyCaptureEvents=[];window.dualLink.onCapture(event=>window.historyCaptureEvents.push(event.metadata.captureId));window.dualLink.peerCount(1);});
 await desktop.evaluate(()=>window.dualLink.capture('full'));await desktop.evaluate(()=>window.dualLink.capture('full'));
 const pending=(await state()).screenshots.pending;assert.equal(pending.length,2);
 const form=new FormData();form.set('image',new Blob([pixel],{type:'image/png'}),'synthetic.png');form.set('captureId',pending[0].captureId);form.set('analyze','false');
 const uploaded=await api('/captures','POST',form);assert.equal(uploaded.status,201);const first=(await uploaded.json()).capture;
 await desktop.evaluate(()=>window.dualLink.submitScreenshots());
 await expect.poll(()=>desktop.evaluate(()=>window.historyCaptureEvents.length)).toBe(1);
 await desktop.evaluate(input=>window.dualLink.acknowledge(input),{captureId:pending[0].captureId,cloudCaptureId:first.id});
 await expect.poll(()=>desktop.evaluate(()=>window.historyCaptureEvents.length)).toBe(2);
 assert.equal((await api('/captures/'+first.id,'DELETE')).status,200);
 await expect.poll(async()=>(await state()).screenshots.batches.length).toBe(0);
 // A deleted first member cancels the whole local question. In particular its
 // other image must not fall back to a new cloud POST after the direct waiter
 // was released by cancellation.
 await expect.poll(()=>service.db.prepare('SELECT count(*) AS n FROM captures').get().n,{timeout:5000}).toBe(0);
 await new Promise(resolve=>setTimeout(resolve,250));
 assert.equal(service.db.prepare('SELECT count(*) AS n FROM captures WHERE capture_key=?').get(pending[1].captureId).n,0,'cancelled batch member must never be uploaded after its pending direct transfer is cancelled');
 assert.equal(service.db.prepare('SELECT count(*) AS n FROM tasks').get().n,0);
 console.log('PASS: deleting one batch member cancels a pending direct-transfer waiter without uploading another member');

 await desktop.evaluate(()=>window.dualLink.saveSettings({lanFirst:false}));await desktop.evaluate(()=>window.dualLink.peerCount(0));
 await desktop.evaluate(()=>window.dualLink.capture('full'));const blocked=(await state()).screenshots.pending[0];
 const removed=new FormData();removed.set('image',new Blob([pixel],{type:'image/png'}),'gone.png');removed.set('captureId',blocked.captureId);removed.set('analyze','false');
 const existing=(await(await api('/captures','POST',removed)).json()).capture;assert.equal((await api('/captures/'+existing.id,'DELETE')).status,200);
 await desktop.evaluate(()=>window.dualLink.submitScreenshots());
 await expect.poll(async()=>(await state()).screenshots.batches.length).toBe(0);
 await desktop.evaluate(()=>window.dualLink.capture('full'));await desktop.evaluate(()=>window.dualLink.submitScreenshots());
 await expect.poll(()=>service.db.prepare('SELECT count(*) AS n FROM tasks').get().n,{timeout:10000}).toBe(1);
 assert.equal(service.db.prepare('SELECT count(*) AS n FROM captures WHERE capture_key=?').get(blocked.captureId).n,0);
 assert.equal((await state()).screenshots.batches[0].status,'submitted');
 assert.deepEqual(errors,[]);console.log('PASS: a missed cloud deletion is fenced by HTTP410 and the next screenshot question still submits');
}finally{await application?.close();await service.close();await rm(temp,{recursive:true,force:true});}
