const test=require('node:test');const assert=require('node:assert/strict');const {WebSocketServer}=require('ws');const {createServer}=require('node:http');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const {randomUUID}=require('node:crypto');
let AudioController;try{({AudioController}=require('../lib/audio-main.cjs'));}catch{}
async function setup(t,{configured=true,audioConfigured=false,defaults,ackDelay=0}={}){
  assert.equal(typeof AudioController,'function','audio controller is implemented');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dual-audio-control-'));const server=createServer();const wss=new WebSocketServer({server});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const calls=[],frames=[];const sessionId=randomUUID();let owner={deviceId:'device-A',cloudUrl:`http://127.0.0.1:${server.address().port}`,secret:'not-rendered'};let creates=0;
  const interview={id:sessionId,title:'测试面试',status:'recording',createdAt:new Date().toISOString()};
  wss.on('connection',socket=>socket.on('message',(data,binary)=>{if(binary){frames.push(Buffer.from(data));setTimeout(()=>{if(socket.readyState===1)socket.send(JSON.stringify({type:'audio.ack',track:data[1]?'self':'remote',seq:data.readUInt32BE(4)}));},ackDelay);return;}const message=JSON.parse(data);if(message.type==='audio.start')socket.send(JSON.stringify({type:'audio.ready',sessionId,mode:'live'}));if(message.type==='audio.stop')socket.send(JSON.stringify({type:'audio.stopped'}));}));
  let stopCapture,flushCapture;const controller=new AudioController({root,getOwner:()=>owner,emit:(type,data)=>{if(type==='audio.capture.flush')queueMicrotask(()=>flushCapture?flushCapture(data):controller.markFlushed?.(data));if(type==='audio.capture.stop')queueMicrotask(()=>stopCapture?stopCapture(data.token):controller.markStopped?.(data.token));},api:async(_owner,route,opts={})=>{calls.push({route,body:opts.body});if(route==='/interviews/config')return {configured,audioConfigured,defaults,maxSessionMinutes:120};if(route==='/interviews'&&opts.method==='POST'){creates++;Object.assign(interview,opts.body);return {interview};}if(route.endsWith('/trigger'))return {question:{id:'question'},answer:{id:'answer',status:'queued'}};if(route.endsWith('/audio-ticket'))return {path:'/audio?ticket=test'};if(route.endsWith('/pause'))return {interview:{...interview,status:'paused'}};if(route.endsWith('/resume'))return {interview:{...interview,status:'recording'}};if(route.endsWith('/end'))return {interview:{...interview,status:'ended'}};if(route===`/interviews/${sessionId}`)return {interview};return {interviews:[]};}});
  t.after(async()=>{await controller.shutdown();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});});
  return {controller,calls,frames,interview,root,setFlushCapture:handler=>{flushCapture=handler;},setStopCapture:handler=>{stopCapture=handler;},setOwner:value=>{owner=value;},creates:()=>creates};
}
test('audio controller streams durable dual-track PCM and keeps sequence across pause/resume',async t=>{
  const {controller,frames}=await setup(t);const control=await controller.start({title:'测试面试'});controller.markStarted(control.token);
  await controller.ingest({token:control.token,track:'remote',startMs:100,samples:Buffer.alloc(3200)});await controller.ingest({token:control.token,track:'self',startMs:100,samples:Buffer.alloc(3200)});
  await controller.pause();const resumed=await controller.resume();controller.markStarted(resumed.token);await controller.ingest({token:resumed.token,track:'remote',startMs:900,samples:Buffer.alloc(3200)});await controller.end();
  assert.equal(frames.length,3);assert.equal(frames[2].readUInt32BE(4),1);assert.equal(frames[2].readUInt32BE(8),900);assert.equal(controller.view().phase,'ended');
});
test('missing ASR configuration fails before creating a recording or claiming success',async t=>{const {controller,creates}=await setup(t,{configured:false});await assert.rejects(controller.start({}),/未配置|密钥/);assert.equal(creates(),0);});

test('new desktop interviews pass per-provider text models and independent ASR model',async t=>{
 const {controller,calls}=await setup(t,{defaults:{textModels:{codex:'default-codex',claude:'default-claude'},asrModel:'default-asr'}});
 await controller.start({provider:'claude',textModels:{codex:'quality',claude:'flash'},asrModel:'custom-asr'});
 const body=calls.find(c=>c.route==='/interviews').body;
 assert.deepEqual(body.textModels,{codex:'quality',claude:'flash'});assert.equal(body.asrModel,'custom-asr');
});
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


test('native mode can record without ASR and account defaults are sent with manual answers',async t=>{
 const {controller,calls}=await setup(t,{configured:false,audioConfigured:true,defaults:{mode:'audio',provider:'claude',audioModel:'qwen-test',transcribe:false,audioWindowSeconds:75}});
 await controller.start({});const body=calls.find(c=>c.route==='/interviews').body;
 assert.equal(body.mode,'audio');assert.equal(body.provider,'claude');assert.equal(body.transcribe,false);assert.equal(body.audioWindowSeconds,75);assert.equal(body.autoAnswer,false);
});

test('manual trigger flushes without stopping capture and waits for complete send and durable ACK',async t=>{
 const {controller,calls,setFlushCapture}=await setup(t,{ackDelay:70});const control=await controller.start({});controller.markStarted(control.token);
 const read=controller.spool.read.bind(controller.spool);controller.spool.read=async(...args)=>{await new Promise(r=>setTimeout(r,25));return read(...args);};
 setFlushCapture(input=>{void controller.ingest({token:input.token,track:'remote',startMs:60,samples:Buffer.alloc(480)});controller.markFlushed(input);});
 let settled=false;const triggering=controller.trigger().then(result=>{settled=true;return result;});await new Promise(r=>setTimeout(r,45));
 assert.equal(settled,false);assert.equal(calls.some(c=>c.route.endsWith('/trigger')),false);
 const result=await triggering;assert.equal(result.answer.id,'answer');assert.equal(controller.view().phase,'recording');assert.equal(controller.view().connected,true);
 assert.equal(calls.filter(c=>c.route.endsWith('/trigger')).length,1);assert.match(calls.find(c=>c.route.endsWith('/trigger')).body.requestId,/^[a-f0-9-]{36}$/);
});

test('manual trigger refuses offline audio instead of answering an older accepted snapshot',async t=>{
 const {controller,calls}=await setup(t);const control=await controller.start({});controller.markStarted(control.token);controller.state.connected=false;
 await assert.rejects(controller.trigger(),/连接|同步/);assert.equal(calls.some(c=>c.route.endsWith('/trigger')),false);
});


test('an answer completing before the trigger HTTP response remains completed in desktop status',async t=>{
 const {controller}=await setup(t);const control=await controller.start({});controller.markStarted(control.token);const original=controller.api;
 controller.api=async(owner,route,options)=>{if(route.endsWith('/trigger')){controller.receive({type:'interview.answer',sessionId:control.sessionId,answer:{id:'answer',status:'completed',text:'done'}});return {question:{id:'q'},answer:{id:'answer',status:'queued'}};}return original(owner,route,options);};
 await controller.trigger();assert.equal(controller.view().triggerStatus,'completed');
});

test('repeated manual keypresses while syncing reuse one request',async t=>{
 const {controller,calls}=await setup(t);const control=await controller.start({});controller.markStarted(control.token);
 const first=controller.trigger(),second=controller.trigger();assert.equal(first,second);await first;await controller.trigger();assert.equal(calls.filter(call=>call.route.endsWith('/trigger')).length,1);
});

test('manual trigger after pause and resume submits a fresh request within the key-repeat window',async t=>{
 const {controller,calls}=await setup(t,{audioConfigured:true});const control=await controller.start({mode:'audio'});controller.markStarted(control.token);
 await controller.trigger();await controller.pause();const resumed=await controller.resume();controller.markStarted(resumed.token);
 await controller.trigger();assert.equal(calls.filter(call=>call.route.endsWith('/trigger')).length,2,'resuming cannot return an answer from before pause');
});

test('an interview model configuration change invalidates the recent manual answer',async t=>{
 const {controller,calls}=await setup(t,{audioConfigured:true});const control=await controller.start({mode:'audio'});controller.markStarted(control.token);
 await controller.trigger();controller.receive({type:'interview.updated',interview:{...controller.view().interview,mode:'transcript',provider:'claude',transcribe:true}});
 await controller.trigger();assert.equal(calls.filter(call=>call.route.endsWith('/trigger')).length,2,'changing answer mode cannot return the old native result');
});

test('a mode change while a trigger is in flight cannot restore the old cached result',async t=>{
 const {controller}=await setup(t,{audioConfigured:true});const control=await controller.start({mode:'audio'});controller.markStarted(control.token);const original=controller.api;
 let release,submitted;const gate=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{submitted=resolve;});let triggers=0;
 controller.api=async(owner,route,options)=>{if(route.endsWith('/trigger')){triggers++;if(triggers===1){submitted();await gate;}return {question:{id:`q${triggers}`},answer:{id:`answer${triggers}`,status:'queued'}};}return original(owner,route,options);};
 const old=controller.trigger();await started;controller.receive({type:'interview.updated',interview:{...controller.view().interview,mode:'transcript'}});release();await assert.rejects(old,/配置|变化|取消/);
 const fresh=await controller.trigger();assert.equal(triggers,2);assert.equal(fresh.answer.id,'answer2');
});

test('cloud deletion stops the matching local recording and removes its recoverable files without restarting it',async t=>{
 const {controller,root,frames}=await setup(t);const control=await controller.start({});controller.markStarted(control.token);
 await controller.ingest({token:control.token,track:'remote',startMs:10,samples:Buffer.alloc(320)});
 await controller.receive({type:'interview.deleted',sessionId:control.sessionId});
 assert.equal(controller.view().phase,'idle');assert.equal(controller.view().interview,null);assert.equal(controller.view().token,null);
 await assert.rejects(fs.access(path.join(root,control.sessionId)));const count=frames.length;
 await controller.ingest({token:control.token,track:'self',startMs:20,samples:Buffer.alloc(320)});assert.equal(frames.length,count);
 await assert.rejects(controller.recover(control.sessionId),/删除/);
});

test('bulk voice deletion removes only matching-owner local caches and keeps an unrelated active recording',async t=>{
 const {AudioSpool}=require('../lib/audio-spool.cjs');const {controller,root}=await setup(t);const control=await controller.start({});controller.markStarted(control.token);
 const owner=controller.getOwner(),id=randomUUID(),foreignId=randomUUID();
 const old=await AudioSpool.create(root,{sessionId:id,...owner,startedAt:Date.now()});await old.append({track:'remote',startMs:0,samples:Buffer.alloc(32)});
 const foreign=await AudioSpool.create(root,{sessionId:foreignId,deviceId:'foreign',cloudUrl:'https://elsewhere.example',startedAt:Date.now()});await foreign.append({track:'remote',startMs:0,samples:Buffer.alloc(32)});
 await controller.receive({type:'history.deleted',kind:'interviews',deletedIds:[id,foreignId]});
 await assert.rejects(fs.access(old.dir));await fs.access(foreign.dir);await fs.access(path.join(root,control.sessionId));assert.equal(controller.view().phase,'recording');
});

test('deletion waits for in-flight local reads but cannot upload their frames or revive a late answer',async t=>{
 const {controller,frames,root}=await setup(t);const control=await controller.start({});controller.markStarted(control.token);
 const read=controller.spool.read.bind(controller.spool);let release,entered;const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
 controller.spool.read=async(...args)=>{entered();await gate;return read(...args);};
 const writing=controller.ingest({token:control.token,track:'remote',startMs:30,samples:Buffer.alloc(320)});await started;
 const deleting=controller.receive({type:'interview.deleted',sessionId:control.sessionId});let finished=false;Promise.resolve(deleting).then(()=>{finished=true;});try{await new Promise(r=>setTimeout(r,10));assert.equal(finished,false);}finally{release();}
 await writing;await deleting;assert.equal(frames.length,0);await assert.rejects(fs.access(path.join(root,control.sessionId)));assert.equal(controller.view().interview,null);
});

test('refresh prunes only expired ended fully-uploaded local caches and protects pending, active, recent and foreign recordings',async t=>{
 const {AudioSpool}=require('../lib/audio-spool.cjs');const {controller,root}=await setup(t);const control=await controller.start({});controller.markStarted(control.token);
 const owner=controller.getOwner(),old=Date.now()-31*86400000,caches={};
 for(const [name,status,pending,startedAt,deviceId]of [['old','ended',false,old,owner.deviceId],['pending','ended',true,old,owner.deviceId],['paused','paused',false,old,owner.deviceId],['recent','ended',false,Date.now(),owner.deviceId],['foreign','ended',false,old,'foreign']]){
  const spool=await AudioSpool.create(root,{sessionId:randomUUID(),deviceId,cloudUrl:owner.cloudUrl,startedAt});await spool.append({track:'remote',startMs:0,samples:Buffer.alloc(32)});if(!pending)await spool.ack('remote',0);await spool.status(status);if(status==='ended'){spool.meta.endedAt=startedAt;await spool.saveMeta();}caches[name]=spool;
 }
 await controller.refresh();await assert.rejects(fs.access(caches.old.dir));for(const name of ['pending','paused','recent','foreign'])await fs.access(caches[name].dir);await fs.access(path.join(root,control.sessionId));
});

test('deleting a replay while its audio ticket is pending leaves another recording running',async t=>{
 const {AudioSpool}=require('../lib/audio-spool.cjs');const {controller,root}=await setup(t);const control=await controller.start({});controller.markStarted(control.token);
 const old=await AudioSpool.create(root,{sessionId:randomUUID(),...controller.getOwner(),startedAt:Date.now()});await old.append({track:'remote',startMs:0,samples:Buffer.alloc(32)});await old.status('ended');
 const api=controller.api;let entered,release;const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
 controller.api=async(owner,route,options)=>{if(route===`/interviews/${old.id}/audio-ticket`){entered();await gate;}return api(owner,route,options);};
 const replay=controller.recover(old.id);void replay.catch(()=>{});await started;const deleting=controller.receive({type:'history.deleted',kind:'interviews',deletedIds:[old.id]});release();
 await assert.rejects(replay,/删除/);await deleting;await assert.rejects(fs.access(old.dir));assert.equal(controller.view().phase,'recording');assert.equal(controller.view().interview.id,control.sessionId);
});

test('a trigger response arriving after cloud deletion cannot restore an old answer or session',async t=>{
 const {controller}=await setup(t);const control=await controller.start({});controller.markStarted(control.token);const api=controller.api;let entered,release;const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
 controller.api=async(owner,route,options)=>{if(route.endsWith('/trigger')){entered();await gate;}return api(owner,route,options);};
 const answer=controller.trigger();void answer.catch(()=>{});await started;await controller.receive({type:'interview.deleted',sessionId:control.sessionId});release();await assert.rejects(answer,/删除|变化|取消/);
 assert.equal(controller.view().phase,'idle');assert.equal(controller.view().interview,null);assert.equal(controller.view().triggerAnswerId,null);
});

test('deletion while a local session directory is being created cannot leave it behind or revive the session',async t=>{
 const {AudioSpool}=require('../lib/audio-spool.cjs');const {controller,root}=await setup(t);const create=AudioSpool.create;let entered,release;const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
 AudioSpool.create=async(...args)=>{entered(args[1].sessionId);await gate;return create(...args);};
 try{const starting=controller.start({});void starting.catch(()=>{});const id=await started;await controller.receive({type:'interview.deleted',sessionId:id});release();await assert.rejects(starting,/删除/);await assert.rejects(fs.access(path.join(root,id)));assert.equal(controller.view().phase,'idle');assert.equal(controller.view().interview,null);}finally{release();AudioSpool.create=create;}
});

test('a locked deleted cache reports an error without trapping the client in a stopping recording',async t=>{
 const {controller}=await setup(t);const control=await controller.start({});controller.markStarted(control.token);const spool=controller.spool,remove=spool.remove.bind(spool);spool.remove=async()=>{throw new Error('缓存文件正在使用');};
 try{await assert.rejects(controller.receive({type:'interview.deleted',sessionId:control.sessionId}),/使用/);assert.equal(controller.view().phase,'idle');assert.equal(controller.view().token,null);assert.equal(controller.view().interview,null);assert.match(controller.view().error,/清理失败/);}finally{spool.remove=remove;await remove();}
});

test('deletion during a pending resume response cannot regress the cleared session back to paused',async t=>{
 const {controller}=await setup(t);const control=await controller.start({});controller.markStarted(control.token);await controller.pause();const api=controller.api;let entered,release;const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
 controller.api=async(owner,route,options)=>{if(route.endsWith('/resume')){entered();await gate;}return api(owner,route,options);};
 const resuming=controller.resume();void resuming.catch(()=>{});await started;await controller.receive({type:'interview.deleted',sessionId:control.sessionId});release();await assert.rejects(resuming,/删除/);assert.equal(controller.view().phase,'idle');assert.equal(controller.view().interview,null);
});

test('a deleted newly-created session HTTP response leaves no connecting state or new local directory',async t=>{
 const {controller,root,interview}=await setup(t);const api=controller.api;let entered,release;const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
 controller.api=async(owner,route,options)=>{const result=await api(owner,route,options);if(route==='/interviews'&&options?.method==='POST'){entered();await gate;}return result;};
 const starting=controller.start({});void starting.catch(()=>{});await started;await controller.receive({type:'interview.deleted',sessionId:interview.id});release();await assert.rejects(starting,/删除/);assert.equal(controller.view().phase,'idle');assert.equal(controller.view().interview,null);await assert.rejects(fs.access(path.join(root,interview.id)));
});

test('offline deletion confirmed by the session404 removes only its own pending local recovery cache',async t=>{
 const {AudioSpool}=require('../lib/audio-spool.cjs');const {controller,root}=await setup(t);const spool=await AudioSpool.create(root,{sessionId:randomUUID(),...controller.getOwner(),startedAt:Date.now()});await spool.append({track:'remote',startMs:0,samples:Buffer.alloc(32)});
 const api=controller.api;controller.api=async(owner,route,options)=>{if(route.startsWith('/interviews/'+spool.id))throw Object.assign(new Error('记录不存在'),{status:404});return api(owner,route,options);};
 await assert.rejects(controller.recover(spool.id),/删除/);await assert.rejects(fs.access(spool.dir));assert.equal(controller.view().recoveries.some(row=>row.id===spool.id),false);
});

test('an audio-ticket404 alone cannot delete local audio when the authoritative session still exists',async t=>{
 const {AudioSpool}=require('../lib/audio-spool.cjs');const {controller,root}=await setup(t);const spool=await AudioSpool.create(root,{sessionId:randomUUID(),...controller.getOwner(),startedAt:Date.now()});await spool.append({track:'remote',startMs:0,samples:Buffer.alloc(32)});
 const api=controller.api;controller.api=async(owner,route,options)=>{if(route===`/interviews/${spool.id}/audio-ticket`)throw Object.assign(new Error('接口不存在'),{status:404});if(route===`/interviews/${spool.id}`)return {interview:{id:spool.id,status:'paused'}};return api(owner,route,options);};
 await assert.rejects(controller.recover(spool.id),/接口/);await fs.access(spool.dir);assert.equal((await AudioSpool.open(root,spool.id)).pendingCount,1);
});

test('starting a retained local session deleted while offline cleans its404-confirmed cache',async t=>{
 const {AudioSpool}=require('../lib/audio-spool.cjs');const {controller,root}=await setup(t);const spool=await AudioSpool.create(root,{sessionId:randomUUID(),...controller.getOwner(),startedAt:Date.now()});await spool.append({track:'remote',startMs:0,samples:Buffer.alloc(32)});
 const api=controller.api;controller.api=async(owner,route,options)=>{if(route===`/interviews/${spool.id}`)throw Object.assign(new Error('记录不存在'),{status:404});return api(owner,route,options);};
 await assert.rejects(controller.start({sessionId:spool.id}),/删除/);await assert.rejects(fs.access(spool.dir));assert.equal(controller.view().phase,'idle');
});
