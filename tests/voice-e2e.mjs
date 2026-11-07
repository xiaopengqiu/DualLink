import { _electron as electron, chromium, expect } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { createApp } from '../apps/server/src/app.mjs';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Real Electron -> real HTTP/WSS -> real ASR wire adapter -> SQLite -> browser.
// Only the external recognition/model services are deterministic fixtures.
const root=fileURLToPath(new URL('../',import.meta.url));
const dataDir=await mkdtemp(path.join(tmpdir(),'dual-link-voice-e2e-'));
const upstream=new WebSocketServer({host:'127.0.0.1',port:0});
await new Promise(resolve=>upstream.once('listening',resolve));
const wire=[];
const phrases=new Map([
  [1000,'请介绍一下你的缓存设计。'],
  [2000,'我没有使用 Redis，项目使用本地缓存。'],
  [3000,'刚才为什么没有使用 Redis？'],
  [4000,'补传历史问题：当时为什么选择缓存？'],
  [5000,'请说明缓存失效策略。']
]);
upstream.on('connection',(ws,request)=>{
  assert.equal(request.headers.authorization,'Bearer fixture-not-a-real-key');
  let taskId,sentence=0,time=0;
  ws.on('message',(bytes,binary)=>{
    if(binary){
      const pcm=Buffer.from(bytes),marker=pcm.readInt16LE(0),text=phrases.get(marker);wire.push(marker);
      if(text){
        const id=++sentence;
        for(const final of [false,true])ws.send(JSON.stringify({header:{event:'result-generated',task_id:taskId},payload:{output:{sentence:{sentence_id:id,text:final?text:text.slice(0,6),begin_time:time,end_time:final?time+100:null,sentence_end:final}}}}));
      }
      time+=pcm.length/32;return;
    }
    const event=JSON.parse(bytes.toString());taskId=event.header.task_id;
    const name=event.header.action==='run-task'?'task-started':'task-finished';
    ws.send(JSON.stringify({header:{event:name,task_id:taskId},payload:{}}));
  });
});
const inputs=[];
const service=await createApp({dataDir:path.join(dataDir,'server'),secureCookies:false,
  asr:{apiKey:'fixture-not-a-real-key',wsUrl:`ws://127.0.0.1:${upstream.address().port}`},
  interviews:{autoDebounceMs:40},
  textRunner:async input=>{inputs.push(input.prompt);const answer=inputs.length===1?'测试建议：可以考虑 Redis。':'测试建议：根据你实际说过的本地缓存方案，说明取舍。';input.onDelta?.(answer.slice(0,5));input.onDelta?.(answer.slice(5));return {answer};},
  runner:async()=>({answer:'截图回归测试'})});
service.createUser({email:'voice@test.example',name:'语音联调',password:'OnlyForTest42!',role:'admin'});
await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
const audioSockets=new Set();
service.server.on('upgrade',(request,socket)=>{if(new URL(request.url,'http://localhost').pathname==='/audio'){audioSockets.add(socket);socket.once('close',()=>audioSockets.delete(socket));}});
const origin=`http://127.0.0.1:${service.server.address().port}`;
const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
let browser,application;
try{
  browser=await chromium.launch(existsSync(edge)?{executablePath:edge}:{});
  const page=await browser.newPage({viewport:{width:1180,height:820}});
  await page.goto(origin);
  await page.getByLabel('邮箱地址').fill('voice@test.example');
  await page.getByLabel('登录密码').fill('OnlyForTest42!');
  await page.getByRole('button',{name:'进入工作空间'}).click();
  await expect(page.locator('.connection-pill')).toHaveText('已连接');
  application=await electron.launch({...(process.env.DUALLINK_PACKAGED_EXE?{executablePath:process.env.DUALLINK_PACKAGED_EXE,args:[]}:{args:[path.join(root,'apps/desktop')]}),env:{...process.env,DUALLINK_TEST_MODE:'1',DUALLINK_TEST_USER_DATA:path.join(dataDir,'client')}});
  const desktop=await application.firstWindow();const errors=[];
  desktop.on('pageerror',error=>errors.push(error.message));page.on('pageerror',error=>errors.push(error.message));
  await desktop.getByLabel('云服务地址').fill(origin);
  await desktop.getByLabel('电脑名称').fill('语音测试 Windows');
  await desktop.getByRole('button',{name:'生成配对码',exact:false}).click();
  await expect(desktop.locator('#pair-code')).toHaveText(/^[A-Z2-9]{8}$/);
  const code=await desktop.locator('#pair-code').textContent();
  await page.getByRole('button',{name:'连接设备',exact:true}).click();
  await page.getByLabel('电脑配对码').fill(code);
  await page.getByRole('button',{name:'确认配对'}).click();
  await expect(desktop.locator('#connection-badge')).toHaveText('● 已连接',{timeout:15000});
  await page.getByRole('button',{name:'面试会话',exact:true}).click();
  let control=await desktop.evaluate(()=>window.dualLink.audioStart({title:'双轨联调记录',provider:'codex',autoAnswer:true}));
  await desktop.evaluate(token=>window.dualLink.audioCaptureStarted(token),control.token);
  const inject=async(track,marker,startMs)=>desktop.evaluate(async({track,marker,startMs,token})=>{
    const samples=new Int16Array(1600);samples.fill(marker);
    await window.dualLink.audioTestFrame({token,track,startMs,samples:samples.buffer});
  },{track,marker,startMs,token:control.token});
  const detail=async()=>{const response=await page.request.get(`${origin}/api/interviews/${control.sessionId}`);assert.equal(response.status(),200);return response.json();};
  await inject('remote',1000,100);
  await expect.poll(()=>inputs.length,{timeout:15000}).toBe(1);
  await expect(page.getByText('测试建议：可以考虑 Redis。',{exact:true})).toBeVisible();
  await inject('self',2000,300);
  await expect.poll(async()=>(await detail()).segments.filter(s=>s.final).length).toBe(2);
  await inject('remote',3000,500);
  await expect.poll(()=>inputs.length,{timeout:15000}).toBe(2);
  assert.match(inputs[1],/我没有使用 Redis，项目使用本地缓存/);
  assert.doesNotMatch(inputs[1],/测试建议：可以考虑 Redis/,'unspoken AI suggestion must not become candidate history');
  await expect(page.getByText('测试建议：根据你实际说过的本地缓存方案，说明取舍。',{exact:true})).toBeVisible();
  const first=await detail();assert.equal(first.segments.length,3,'partial revisions should update the same rows');
  assert.deepEqual(first.segments.map(s=>s.track),['remote','self','remote']);
  assert.equal(first.answers.filter(a=>a.status==='completed').length,2);
  console.log('PASS: dual-track PCM -> real ASR protocol -> revisions -> automatic answers; actual prior speech included, unspoken suggestions excluded');

  for(const socket of audioSockets)socket.destroy();
  await expect.poll(async()=>(await desktop.evaluate(()=>window.dualLink.getState())).audio.connected).toBe(false);
  await inject('remote',4000,700);
  await expect.poll(async()=>(await detail()).segments.some(s=>s.text===phrases.get(4000)),{timeout:30000}).toBe(true);
  await expect.poll(async()=>(await desktop.evaluate(()=>window.dualLink.getState())).audio.pending,{timeout:20000}).toBe(0);
  assert.equal(inputs.length,2,'replayed historical question must not auto-answer');
  console.log('PASS: live audio disconnect -> local durable spool -> reconnection -> separate historical replay without stale answers');

  await desktop.evaluate(()=>window.dualLink.audioPause());
  assert.equal((await detail()).interview.status,'paused');
  control=await desktop.evaluate(()=>window.dualLink.audioResume({}));
  await desktop.evaluate(token=>window.dualLink.audioCaptureStarted(token),control.token);
  await inject('remote',5000,900);
  await expect.poll(()=>inputs.length,{timeout:15000}).toBe(3);
  await desktop.evaluate(()=>window.dualLink.audioEnd());
  const ended=await detail();assert.equal(ended.interview.status,'ended');
  assert.equal(ended.segments.filter(s=>s.final).length,5);
  const exported=await page.request.get(`${origin}/api/interviews/${control.sessionId}/export?format=json`);
  assert.equal(exported.status(),200);assert.match(await exported.text(),/我没有使用 Redis/);
  const markdown=await page.request.get(`${origin}/api/interviews/${control.sessionId}/export?format=md`);
  assert.equal(markdown.status(),200);assert.match(await markdown.text(),/缓存失效策略/);
  await page.reload();await page.getByRole('button',{name:'面试会话',exact:true}).click();
  await expect(page.getByRole('region',{name:'当前面试'}).getByText('双轨联调记录',{exact:true})).toBeVisible();
  await mkdir(path.join(root,'.local'),{recursive:true});
  await page.screenshot({path:path.join(root,'.local/voice-integrated.png'),fullPage:true});
  assert.equal(errors.length,0,errors.join('\n'));
  assert(wire.includes(1000)&&wire.includes(2000));
  console.log('PASS: pause/resume/end, complete JSON/Markdown history and page reload recovery; no browser runtime errors');
}finally{
  await application?.close();await browser?.close();await service.close();
  for(const ws of upstream.clients)ws.terminate();await new Promise(resolve=>upstream.close(resolve));
  await rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
