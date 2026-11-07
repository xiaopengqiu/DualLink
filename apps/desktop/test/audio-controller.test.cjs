const test=require('node:test');const assert=require('node:assert/strict');const {WebSocketServer}=require('ws');const {createServer}=require('node:http');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const {randomUUID}=require('node:crypto');
let AudioController;try{({AudioController}=require('../lib/audio-main.cjs'));}catch{}
async function setup(t,{configured=true}={}){
  assert.equal(typeof AudioController,'function','audio controller is implemented');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dual-audio-control-'));const server=createServer();const wss=new WebSocketServer({server});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const frames=[];const sessionId=randomUUID();let owner={deviceId:'device-A',cloudUrl:`http://127.0.0.1:${server.address().port}`,secret:'not-rendered'};let creates=0;
  const interview={id:sessionId,title:'测试面试',status:'recording',createdAt:new Date().toISOString()};
  wss.on('connection',socket=>socket.on('message',(data,binary)=>{if(binary){frames.push(Buffer.from(data));socket.send(JSON.stringify({type:'audio.ack',track:data[1]?'self':'remote',seq:data.readUInt32BE(4)}));return;}const message=JSON.parse(data);if(message.type==='audio.start')socket.send(JSON.stringify({type:'audio.ready',sessionId,mode:'live'}));if(message.type==='audio.stop')socket.send(JSON.stringify({type:'audio.stopped'}));}));
  let stopCapture;const controller=new AudioController({root,getOwner:()=>owner,emit:(type,data)=>{if(type==='audio.capture.stop')queueMicrotask(()=>stopCapture?stopCapture(data.token):controller.markStopped?.(data.token));},api:async(_owner,route,opts={})=>{if(route==='/interviews/config')return {configured,maxSessionMinutes:120};if(route==='/interviews'&&opts.method==='POST'){creates++;return {interview};}if(route.endsWith('/audio-ticket'))return {path:'/audio?ticket=test'};if(route.endsWith('/pause'))return {interview:{...interview,status:'paused'}};if(route.endsWith('/resume'))return {interview:{...interview,status:'recording'}};if(route.endsWith('/end'))return {interview:{...interview,status:'ended'}};if(route===`/interviews/${sessionId}`)return {interview};return {interviews:[]};}});
  t.after(async()=>{await controller.shutdown();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});});
  return {controller,frames,interview,root,setStopCapture:handler=>{stopCapture=handler;},setOwner:value=>{owner=value;},creates:()=>creates};
}
test('audio controller streams durable dual-track PCM and keeps sequence across pause/resume',async t=>{
  const {controller,frames}=await setup(t);const control=await controller.start({title:'测试面试'});controller.markStarted(control.token);
  await controller.ingest({token:control.token,track:'remote',startMs:100,samples:Buffer.alloc(3200)});await controller.ingest({token:control.token,track:'self',startMs:100,samples:Buffer.alloc(3200)});
  await controller.pause();const resumed=await controller.resume();controller.markStarted(resumed.token);await controller.ingest({token:resumed.token,track:'remote',startMs:900,samples:Buffer.alloc(3200)});await controller.end();
  assert.equal(frames.length,3);assert.equal(frames[2].readUInt32BE(4),1);assert.equal(frames[2].readUInt32BE(8),900);assert.equal(controller.view().phase,'ended');
});
test('missing ASR configuration fails before creating a recording or claiming success',async t=>{const {controller,creates}=await setup(t,{configured:false});await assert.rejects(controller.start({}),/未配置|密钥/);assert.equal(creates(),0);});
test('revocation stops recording and a stale frame cannot cross into a different pairing',async t=>{
  const {controller,frames,setOwner}=await setup(t);const control=await controller.start({});controller.markStarted(control.token);await controller.ingest({token:control.token,track:'remote',startMs:0,samples:Buffer.alloc(3200)});
  await controller.reset({removeLocal:true});setOwner({deviceId:'device-B',cloudUrl:'https://other.example',secret:'other'});await controller.ingest({token:control.token,track:'self',startMs:100,samples:Buffer.alloc(3200)});
  assert.equal(frames.length,1);assert.equal(controller.view().interview,null);assert.equal(controller.view().phase,'idle');
});

test('local WAV export preserves both track timing and rejects a changed pairing',async t=>{
  const {controller,root,setOwner}=await setup(t);const control=await controller.start({});controller.markStarted(control.token);
  await controller.ingest({token:control.token,track:'remote',startMs:100,samples:Buffer.from([1,2,3,4])});
  await controller.ingest({token:control.token,track:'self',startMs:200,samples:Buffer.from([5,6])});await controller.pause();
  const destination=path.join(root,'exports');await fs.mkdir(destination);const result=await controller.exportWav(control.sessionId,destination);
  assert.equal(result.files.length,3);const remote=await fs.readFile(result.files.find(file=>file.endsWith('-remote.wav')));
  assert.equal(remote.toString('ascii',0,4),'RIFF');assert.equal(remote.readUInt32LE(24),16000);assert.equal(remote.length,44+3200+4);assert.equal(remote[44+3200],1);
  const index=JSON.parse(await fs.readFile(result.files.find(file=>file.endsWith('.json')),'utf8'));assert.equal(index.frames.length,2);assert.equal(index.sampleRate,16000);assert.equal(JSON.stringify(index).includes('secret'),false);
  setOwner({deviceId:'foreign',cloudUrl:'https://other.example'});await assert.rejects(controller.exportWav(control.sessionId,destination),/不属于/);
});

test('pause waits for the renderer final PCM and stopped handshake before draining ASR',async t=>{
  const {controller,frames,setStopCapture}=await setup(t);const control=await controller.start({});controller.markStarted(control.token);
  setStopCapture(token=>setTimeout(async()=>{await controller.ingest({token,track:'self',startMs:75,samples:Buffer.alloc(480)});controller.markStopped(token);},15));
  await controller.pause();assert.equal(frames.length,1);assert.equal(frames[0].readUInt32BE(12),240);assert.equal(controller.view().phase,'paused');
  await controller.ingest({token:control.token,track:'self',startMs:100,samples:Buffer.alloc(3200)});assert.equal(frames.length,1,'late frames after stopped ack are rejected');
});

test('failed ASR startup pauses the cloud session and offers recovery instead of orphaning a recording',async t=>{
  const {controller}=await setup(t);const api=controller.api;let pauses=0;
  controller.api=(owner,route,options)=>{if(route.endsWith('/pause'))pauses++;return api(owner,route,options);};
  controller.openSocket=async()=>{throw new Error('测试连接失败');};
  await assert.rejects(controller.start({}),/连接失败/);
  assert.equal(controller.view().phase,'error');assert.equal(controller.view().interview.status,'paused');assert.equal(pauses,1);
});

test('failed resume returns to paused state so retry and end remain available',async t=>{
  const {controller}=await setup(t);const control=await controller.start({});controller.markStarted(control.token);await controller.pause();
  controller.openSocket=async()=>{throw new Error('测试网络中断');};
  await assert.rejects(controller.resume({}),/网络中断/);
  assert.equal(controller.view().phase,'paused');assert.equal(controller.view().connected,false);assert.match(controller.view().error,/网络中断/);
  await controller.end();assert.equal(controller.view().phase,'ended');
});

test('stop waits for fire-and-forget PCM sends after append has already completed',async t=>{
  const {controller,frames,setStopCapture}=await setup(t);const control=await controller.start({});controller.markStarted(control.token);
  const read=controller.spool.read.bind(controller.spool);let releaseRead,readStarted;
  const started=new Promise(resolve=>{readStarted=resolve;});const gate=new Promise(resolve=>{releaseRead=resolve;});
  controller.spool.read=async(...args)=>{readStarted();await gate;return read(...args);};
  let inFlight;setStopCapture(token=>{inFlight=controller.ingest({token,track:'remote',startMs:80,samples:Buffer.alloc(320)});controller.markStopped(token);});
  const pausing=controller.pause();await started;let settled=false;void pausing.then(()=>{settled=true;});
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(settled,false,'ASR cannot stop while final IPC frame is still being read/sent');
  releaseRead();await inFlight;await pausing;assert.equal(frames.length,1);
});
