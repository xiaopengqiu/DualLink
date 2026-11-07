import {_electron as electron,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../..',import.meta.url));
const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'dual-link-voice-smoke-'));
const application=await electron.launch({...(process.env.DUALLINK_PACKAGED_EXE?{executablePath:process.env.DUALLINK_PACKAGED_EXE,args:[]}:{args:[path.join(root,'apps','desktop')]}),env:{...process.env,DUALLINK_TEST_MODE:'1',DUALLINK_TEST_USER_DATA:dataDir}});
try{
  const page=await application.firstWindow();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.getByRole('button',{name:'面试录音'}).click();
  await expect(page.getByRole('heading',{name:'把整场对话，留在你的工作空间'})).toBeVisible();
  await expect(page.getByRole('button',{name:'开始面试录音',exact:true})).toBeDisabled();
  assert.equal(await page.evaluate(()=>typeof window.dualLink.audioTestFrame),'function');
  const simulated=await page.evaluate(()=>window.dualLink.getState());simulated.paired=true;simulated.device={id:null};
  simulated.audio={phase:'idle',recoveries:[],interviews:[],config:{configured:false,audioConfigured:true,audioModels:['qwen-test'],defaults:{mode:'audio',provider:'claude',transcribe:false,audioModel:'qwen-test',audioWindowSeconds:75}}};
  await application.evaluate(({BrowserWindow},state)=>BrowserWindow.getAllWindows()[0].webContents.send('state',state),simulated);
  await expect(page.getByLabel('回答模式',{exact:true})).toHaveValue('audio');
  await expect(page.getByLabel('音频理解模型',{exact:true})).toHaveValue('qwen-test');
  await expect(page.locator('#voice-transcribe')).not.toBeChecked();
  await expect(page.getByRole('button',{name:'开始面试录音',exact:true})).toBeEnabled();
  await expect(page.locator('#voice-auto-answer')).not.toBeChecked();
  await page.getByLabel('回答模式',{exact:true}).selectOption('transcript');
  await expect(page.getByRole('button',{name:'开始面试录音',exact:true})).toBeDisabled();
  await page.getByLabel('回答模式',{exact:true}).selectOption('audio');

  const graph=await page.evaluate(async()=>{
    let flushEvents=0;const levels={remote:0,self:0},analysers=[],OriginalNode=window.AudioWorkletNode;
    window.AudioWorkletNode=class extends OriginalNode{constructor(context,...args){super(context,...args);const analyser=context.createAnalyser();this.connect(analyser);analysers.push(analyser);this.port.addEventListener('message',event=>{if(event.data?.type==='flushed'&&event.data.requestId)flushEvents++;});}};
    const result=await window.DualAudioMedia.start({token:'preflight-test',epochMs:Date.now()},{preflight:true,synthetic:true,onLevel:track=>levels[track]++});
    await new Promise(resolve=>setTimeout(resolve,500));
    await window.DualAudioMedia.flush();const activeAfterFlush=window.DualAudioMedia.isActive(),before=levels.remote;
    await new Promise(resolve=>setTimeout(resolve,250));const continuedAfterFlush=levels.remote>before;
    const maxima=analysers.map(analyser=>{const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);return Math.max(...samples.map(Math.abs));});
    await window.DualAudioMedia.stop();window.AudioWorkletNode=OriginalNode;
    return {...result,levels,maxima,flushEvents,activeAfterFlush,continuedAfterFlush,active:window.DualAudioMedia.isActive()};
  });
  assert.equal(graph.flushEvents,2,'both actual Worklets must acknowledge the non-stopping flush');assert.equal(graph.activeAfterFlush,true);assert.equal(graph.continuedAfterFlush,true);assert.equal(graph.active,false);assert.deepEqual(graph.tracks,['remote','self']);assert.ok(graph.levels.remote>0&&graph.levels.self>0,'actual AudioWorklet must process both sources');assert.deepEqual(graph.maxima,[0,0],'neither capture node may replay audio to the output');
  assert.deepEqual(errors,[]);
  await fs.mkdir(path.join(root,'.local'),{recursive:true});await page.screenshot({path:path.join(root,'.local','desktop-voice.png'),fullPage:true});
  console.log('Voice Electron smoke passed: actual AudioWorklet, dual synthetic sources, zero-output capture graph, local UI, strict preload.');
}finally{await application.close();await fs.rm(dataDir,{recursive:true,force:true});}
