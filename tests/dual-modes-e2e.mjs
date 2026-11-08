import {_electron as electron,chromium,expect} from '@playwright/test';
import {WebSocketServer} from 'ws';
import {createApp} from '../apps/server/src/app.mjs';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

// Production adapters and Electron/HTTP/SQLite/browser, with local external AI services.
const root=fileURLToPath(new URL('../',import.meta.url)),dataDir=await mkdtemp(path.join(tmpdir(),'dual-modes-e2e-'));
const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>upstream.once('listening',r));
let asrConnections=0;const omniCalls=[],textCalls=[],asrModels=[];
const phrases=new Map([[5000,'请说明缓存失效策略。'],[6000,'我实际使用的是本地缓存。']]);
upstream.on('connection',(ws,request)=>{
 assert.equal(request.headers.authorization,'Bearer fixture-model-key');
 if(request.url.startsWith('/omni')){
  const call={url:request.url,events:[],pcm:[],labels:[]};omniCalls.push(call);ws.send(JSON.stringify({type:'session.created',session:{id:randomUUID()}}));
  ws.on('message',raw=>{const event=JSON.parse(raw.toString());call.events.push(event);
   if(event.type==='session.update')ws.send(JSON.stringify({type:'session.updated',session:event.session}));
   if(event.type==='conversation.item.create')call.labels.push(event.item.content[0].text);
   if(event.type==='input_audio_buffer.append')call.pcm.push(Buffer.from(event.audio,'base64'));
   if(event.type==='input_audio_buffer.commit')ws.send(JSON.stringify({type:'input_audio_buffer.committed',item_id:randomUUID()}));
   if(event.type==='response.create'){
    ws.send(JSON.stringify({type:'response.created',response:{id:'native-answer'}}));
    ws.send(JSON.stringify({type:'response.text.delta',response_id:'native-answer',delta:'音频直答测试：'}));
    ws.send(JSON.stringify({type:'response.text.delta',response_id:'native-answer',delta:'结合双方实际声音回答当前提问。'}));
    ws.send(JSON.stringify({type:'response.done',response:{id:'native-answer',status:'completed'}}));
   }
  });return;
 }
 asrConnections++;let taskId,index=0,time=0;
 ws.on('message',(raw,binary)=>{
  if(binary){const pcm=Buffer.from(raw),text=phrases.get(pcm.readInt16LE(0));if(text)ws.send(JSON.stringify({header:{event:'result-generated',task_id:taskId},payload:{output:{sentence:{sentence_id:++index,text,begin_time:time,end_time:time+pcm.length/32,sentence_end:true}}}}));time+=pcm.length/32;return;}
   const event=JSON.parse(raw.toString());taskId=event.header.task_id;if(event.header.action==='run-task')asrModels.push(event.payload.model);ws.send(JSON.stringify({header:{event:event.header.action==='run-task'?'task-started':'task-finished',task_id:taskId},payload:{}}));
 });
});
const wireBase=`ws://127.0.0.1:${upstream.address().port}`;
const service=await createApp({dataDir:path.join(dataDir,'server'),secureCookies:false,
 asr:{apiKey:'fixture-model-key',wsUrl:wireBase+'/asr'},omni:{apiKey:'fixture-model-key',wsUrl:wireBase+'/omni'},
 textRunner:async input=>{textCalls.push(input);const answer='转写后回答测试：你说过使用本地缓存。';input.onDelta?.(answer);return {answer};},runner:async()=>({answer:'截图测试'})});
service.createUser({email:'manual@test.example',password:'OnlyForTest42!',name:'双模式测试',role:'admin'});
await new Promise(r=>service.server.listen(0,process.env.DUALLINK_HTTP_HOST?'0.0.0.0':'127.0.0.1',r));
const origin=`http://${process.env.DUALLINK_HTTP_HOST||'127.0.0.1'}:${service.server.address().port}`;
let browser,application;
try{
 const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';browser=await chromium.launch(existsSync(edge)?{executablePath:edge}:{});
 const page=await browser.newPage({viewport:{width:1180,height:820}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);if(process.env.DUALLINK_HTTP_HOST)assert.equal(await page.evaluate(()=>isSecureContext),false);
 await page.getByLabel('邮箱地址').fill('manual@test.example');await page.getByLabel('登录密码').fill('OnlyForTest42!');await page.getByRole('button',{name:'进入工作空间'}).click();await expect(page.locator('.connection-pill')).toHaveText('已连接');
 const auth=await(await page.request.get(origin+'/api/auth/me')).json();
 const api=async(route,method='GET',body)=>{const r=await page.request.fetch(origin+'/api'+route,{method,headers:{'X-CSRF-Token':auth.csrfToken},...(body?{data:body}:{})});return r;};
 await page.getByRole('button',{name:'面试会话',exact:true}).click();
 await page.locator('.interview-preferences summary').click();
 await page.getByLabel('默认回答方式',{exact:true}).selectOption('audio');
 await page.getByLabel('默认Codex 文字模型 ID',{exact:true}).fill('interview-codex-flash');
 await page.getByLabel('默认Claude 文字模型 ID',{exact:true}).fill('interview-claude-flash');
 await page.getByLabel('默认语音识别模型 · 百炼 API',{exact:true}).fill('qwen-audio-3.0-asr-flash-streaming');
 await page.getByLabel('默认音频理解模型 · 百炼 API',{exact:true}).fill('qwen3.5-omni-flash-realtime');
 await page.getByLabel('默认后台转写',{exact:true}).uncheck();
 await page.getByRole('button',{name:'保存默认配置',exact:true}).click();
 await expect(page.getByText('默认配置已保存，新会话和电脑客户端可使用此配置',{exact:true})).toBeVisible();
 application=await electron.launch({...(process.env.DUALLINK_PACKAGED_EXE?{executablePath:process.env.DUALLINK_PACKAGED_EXE,args:[]}:{args:[path.join(root,'apps/desktop')]}),env:{...process.env,DUALLINK_TEST_MODE:'1',DUALLINK_TEST_USER_DATA:path.join(dataDir,'client')}});
 const desktop=await application.firstWindow();desktop.on('pageerror',e=>errors.push(e.message));
 await desktop.waitForLoadState('domcontentloaded');
 await desktop.getByLabel('云服务地址').fill(origin);await desktop.getByLabel('电脑名称').fill('双模式测试 PC');await desktop.getByRole('button',{name:'生成配对码',exact:false}).click();await expect(desktop.locator('#pair-code')).toHaveText(/^[A-Z2-9]{8}$/);
 await page.getByRole('button',{name:'连接设备',exact:true}).click();await page.getByLabel('电脑配对码').fill(await desktop.locator('#pair-code').textContent());await page.getByRole('button',{name:'确认配对'}).click();await expect(desktop.locator('#connection-badge')).toHaveText('● 已连接',{timeout:15000});
 await page.getByRole('button',{name:'面试会话',exact:true}).click();
 let control=await desktop.evaluate(()=>window.dualLink.audioStart({title:'双模式手动触发测试'}));await desktop.evaluate(t=>window.dualLink.audioCaptureStarted(t),control.token);
 const detail=async()=>{const r=await api('/interviews/'+control.sessionId);assert.equal(r.status(),200);return r.json();};
 assert.equal((await detail()).interview.mode,'audio');assert.equal((await detail()).interview.transcribe,false);
 const frame=(track,marker,startMs)=>desktop.evaluate(async({track,marker,startMs,token})=>{const pcm=new Int16Array(1600);pcm.fill(marker);await window.dualLink.audioTestFrame({track,startMs,token,samples:pcm.buffer});},{track,marker,startMs,token:control.token});
 await frame('self',2000,100);await frame('remote',1000,300);await new Promise(r=>setTimeout(r,150));assert.equal(omniCalls.length,0,'recording must not generate an answer');assert.equal(asrConnections,0,'direct mode with transcription off must not start ASR');
 const first=await desktop.evaluate(()=>window.dualLink.audioTrigger());assert(first.answer.id);await expect(page.getByText('音频直答测试：结合双方实际声音回答当前提问。',{exact:true})).toBeVisible();
 assert.equal(omniCalls.length,1);assert.equal(new URL(omniCalls[0].url,'http://localhost').searchParams.get('model'),'qwen3.5-omni-flash-realtime');assert.equal(omniCalls[0].events.find(e=>e.type==='session.update').session.input_audio_transcription,null);assert(omniCalls[0].labels.some(s=>s.includes('本人')));assert(omniCalls[0].labels.some(s=>s.includes('当前问题')));
 assert(Buffer.concat(omniCalls[0].pcm).includes(Buffer.from([0xe8,0x03])));
 await frame('remote',0,500);await new Promise(r=>setTimeout(r,700));
 const second=await desktop.evaluate(()=>window.dualLink.audioTrigger());assert.equal(second.question.id,first.question.id,'silence must regenerate the current question');await expect.poll(()=>omniCalls.length).toBe(2);
 assert.equal((await detail()).questions.length,1);assert.equal((await detail()).answers.length,2);
 console.log('PASS: account defaults -> direct audio mode; no ASR or automatic inference; explicit trigger -> real native protocol -> streamed browser answer; silence regenerates same question');

 const blocked=await api('/interviews/'+control.sessionId,'PATCH',{mode:'transcript'});assert.equal(blocked.status(),409);
 await desktop.evaluate(()=>window.dualLink.audioPause());const changed=await api('/interviews/'+control.sessionId,'PATCH',{mode:'transcript',provider:'codex',transcribe:true});assert.equal(changed.status(),200);
 control=await desktop.evaluate(()=>window.dualLink.audioResume({}));await desktop.evaluate(t=>window.dualLink.audioCaptureStarted(t),control.token);
 await frame('self',6000,900);await frame('remote',5000,1100);await expect.poll(async()=>(await detail()).segments.length).toBe(2);assert.equal(textCalls.length,0,'transcripts alone must not auto-generate');
 const third=await desktop.evaluate(()=>window.dualLink.audioTrigger());assert(third.answer.id);assert.equal(third.answer.mode,'transcript','mode changes must invalidate native trigger cooldown results');await expect(page.getByText('转写后回答测试：你说过使用本地缓存。',{exact:true})).toBeVisible();assert.equal(textCalls.length,1);assert.match(textCalls[0].prompt,/我实际使用的是本地缓存/);assert.doesNotMatch(textCalls[0].prompt,/音频直答测试/);
 assert.equal(omniCalls.length,2);assert(asrConnections>=2);assert(asrModels.every(model=>model==='qwen-audio-3.0-asr-flash-streaming'));assert.equal(textCalls[0].model,'interview-codex-flash');
 await desktop.evaluate(()=>window.dualLink.audioEnd());const done=await detail();assert.equal(done.interview.status,'ended');assert.equal(done.answers.filter(a=>a.status==='completed').length,3);
 const exported=await api('/interviews/'+control.sessionId+'/export?format=json');assert.equal(exported.status(),200);assert.match(await exported.text(),/audioRange|audio_range/);
 const audio=await api('/interviews/'+control.sessionId+'/audio/remote');assert.equal(audio.status(),200);assert.equal((await audio.body()).subarray(0,4).toString(),'RIFF');
 await page.reload();await page.getByRole('button',{name:'面试会话',exact:true}).click();await expect(page.getByRole('region',{name:'当前面试'}).getByText('双模式手动触发测试',{exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'远端录音'})).toBeVisible();
 await mkdir(path.join(root,'.local'),{recursive:true});await page.screenshot({path:path.join(root,'.local/dual-modes-integrated.png'),fullPage:true});assert.deepEqual(errors,[]);
 console.log('PASS: pause-only mode switch -> transcript manual trigger -> actual history prompt; all answers/audio export and reload persist, no browser runtime errors');
}finally{
 await application?.close();await browser?.close();await service.close();for(const ws of upstream.clients)ws.terminate();await new Promise(r=>upstream.close(r));await rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
