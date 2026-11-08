import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {createApp} from '../src/app.mjs';

const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=','base64');
const old=new Date(Date.now()-40*86400000).toISOString();
async function setup(t,options={}){
 const dataDir=await mkdtemp(path.join(tmpdir(),'duallink-history-'));
 const service=await createApp({dataDir,secureCookies:false,startWorker:false,asrFactory:async()=>({write:async()=>{},finish:async()=>{},close(){}}),textRunner:async()=>({answer:'历史建议'}),runner:async()=>({answer:'截图答案'}),...options});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${service.server.address().port}`;
 for(const email of ['owner@test.example','other@test.example'])service.createUser({email,name:email,password:'OnlyForTest42!',role:email.startsWith('owner')?'admin':'user'});
 t.after(async()=>{await service.close();await rm(dataDir,{recursive:true,force:true});});
 const api=(route,auth,method='GET',body)=>fetch(url+'/api'+route,{method,headers:{...auth?.headers,...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body?body instanceof FormData?body:JSON.stringify(body):undefined});
 async function login(email='owner@test.example'){const response=await api('/auth/login',null,'POST',{email,password:'OnlyForTest42!'});assert.equal(response.status,200);const data=await response.json();return {...data,headers:{cookie:response.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':data.csrfToken}};}
 async function capture(auth,key=randomUUID()){const body=new FormData();body.set('captureId',key);body.set('analyze','false');body.set('image',new Blob([pixel],{type:'image/png'}),'history.png');const response=await api('/captures',auth,'POST',body);return {response,...await response.json()};}
 async function interview(auth,title='语音历史'){const response=await api('/interviews',auth,'POST',{title,autoAnswer:false});assert.equal(response.status,201);return (await response.json()).interview;}
 return {...service,dataDir,url,api,login,capture,interview};
}

test('history settings default to finite 30-day account-owned storage and validate all bounds',async t=>{
 const s=await setup(t),a=await s.login(),b=await s.login('other@test.example');
 const response=await s.api('/history/settings',a);assert.equal(response.status,200);const {settings,usage}=await response.json();
 assert.deepEqual(settings,{retentionDays:30,maxCaptures:1000,maxInterviews:200,maxStorageMiB:1024,autoCleanup:true});assert.equal(usage.captures,0);assert.equal(usage.totalBytes,0);
 assert.equal((await s.api('/history/settings',b,'PUT',{retentionDays:14,maxCaptures:5,maxInterviews:3,maxStorageMiB:16,autoCleanup:false})).status,200);
 assert.equal((await (await s.api('/history/settings',a)).json()).settings.retentionDays,30);
 for(const input of [{retentionDays:0},{retentionDays:3660},{maxCaptures:0},{maxInterviews:-1},{maxStorageMiB:0},{autoCleanup:'yes'},{extra:'unsupported'}])assert.equal((await s.api('/history/settings',a,'PUT',input)).status,400);
 assert.equal((await s.api('/history/settings',null)).status,401);
});

test('paginated searchable capture history preserves equal timestamps and never exposes another account',async t=>{
 const s=await setup(t),a=await s.login(),b=await s.login('other@test.example'),captures=[];
 for(let n=0;n<5;n++)captures.push((await s.capture(a)).capture);await s.capture(b);
 s.db.prepare('UPDATE captures SET created_at=? WHERE user_id=?').run(old,a.user.id);
 let cursor='',ids=[];do{const response=await s.api('/history/captures?limit=2'+(cursor?'&cursor='+encodeURIComponent(cursor):''),a);assert.equal(response.status,200);const page=await response.json();assert.equal(page.total,5);assert.ok(page.items.every(x=>typeof x.protected==='boolean'&&x.size===pixel.length));ids.push(...page.items.map(x=>x.id));cursor=page.nextCursor;if(!page.hasMore)assert.equal(cursor,null);}while(cursor);
 assert.equal(new Set(ids).size,5);assert.deepEqual(new Set(ids),new Set(captures.map(x=>x.id)));
 const c=captures[0],task=(await (await s.api(`/captures/${c.id}/analyze`,a,'POST',{question:'OnlySpecialKeyword'})).json()).task;
 const found=await (await s.api('/history/captures?search=OnlySpecialKeyword',a)).json();assert.equal(found.total,1);assert.equal(found.items[0].latestTask.id,task.id);
 assert.equal((await s.api('/history/captures?cursor=malformed',a)).status,400);
});

test('bulk screenshot deletion removes files and grouped answers, records tombstones and remains tenant-owned',async t=>{
 const s=await setup(t),a=await s.login(),b=await s.login('other@test.example'),one=(await s.capture(a)).capture,two=(await s.capture(a)).capture,foreign=(await s.capture(b)).capture;
 const task=(await (await s.api('/captures/analyze',a,'POST',{captureIds:[one.id,two.id],requestId:randomUUID()})).json()).task;await s.worker.tick();await s.worker.idle();
 assert.equal((await s.api('/history/delete',a,'POST',{kind:'captures',ids:[one.id,foreign.id]})).status,404);assert.equal(s.db.prepare('SELECT count(*) AS n FROM captures').get().n,3);
 const filepath=s.db.prepare('SELECT path FROM captures WHERE id=?').get(one.id).path;
 const response=await s.api('/history/delete',a,'POST',{kind:'captures',ids:[one.id]});assert.equal(response.status,200);const result=await response.json();assert.deepEqual(result.deletedIds,[one.id]);assert.deepEqual(result.deletedTaskIds,[task.id]);assert.equal(result.deletedCount,1);
 await assert.rejects(stat(path.join(s.dataDir,filepath)));assert.equal(s.db.prepare('SELECT id FROM tasks WHERE id=?').get(task.id),undefined);assert.ok(s.db.prepare('SELECT id FROM captures WHERE id=?').get(two.id));
 const reupload=await s.capture(a,one.captureId);assert.equal(reupload.response.status,410);assert.equal(reupload.code,'HISTORY_DELETED');
 const resubmit=await s.api('/captures/analyze',a,'POST',{captureIds:[one.id,two.id],requestId:randomUUID()});assert.equal(resubmit.status,410);assert.equal((await resubmit.json()).code,'HISTORY_DELETED');
 assert.equal((await s.api('/history/delete',a,'POST',{kind:'captures',ids:[]})).status,400);assert.equal((await s.api('/history/delete',a,'POST',{kind:'other',all:true})).status,400);
});

test('bulk clear protects active image tasks and unfinished interview sessions',async t=>{
 const s=await setup(t),a=await s.login(),one=(await s.capture(a)).capture,two=(await s.capture(a)).capture;
 await s.api(`/captures/${one.id}/analyze`,a,'POST',{});
 const screenshot=await (await s.api('/history/delete',a,'POST',{kind:'captures',all:true})).json();assert.deepEqual(screenshot.deletedIds,[two.id]);assert.deepEqual(screenshot.skippedIds,[one.id]);
 const live=await s.interview(a);await s.api(`/interviews/${live.id}/pause`,a,'POST',{});const ended=await s.interview(a);await s.api(`/interviews/${ended.id}/end`,a,'POST',{});
 const voices=await (await s.api('/history/delete',a,'POST',{kind:'interviews',all:true})).json();assert.deepEqual(voices.deletedIds,[ended.id]);assert.deepEqual(voices.skippedIds,[live.id]);
});

test('voice history deletion cascades transcripts, questions, answers, contexts and PCM storage usage',async t=>{
 const s=await setup(t),a=await s.login(),voice=await s.interview(a);await s.api(`/interviews/${voice.id}/questions`,a,'POST',{text:'介绍自己的项目'});await s.interviews.idle();await s.api(`/interviews/${voice.id}/end`,a,'POST',{});
 const dir=path.join(s.dataDir,'users',a.user.id,'interviews',voice.id);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'remote.pcm'),Buffer.alloc(32));
 s.db.prepare('INSERT INTO interview_audio_frames(session_id,track,seq,start_ms,sample_count,byte_offset,byte_count,hash,replay,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(voice.id,'remote',0,0,16,0,32,'fixture',0,new Date().toISOString());s.db.prepare('INSERT OR REPLACE INTO interview_audio_storage(user_id,bytes) VALUES(?,?)').run(a.user.id,32);
 const listing=await (await s.api('/history/interviews',a)).json();assert.equal(listing.items[0].audioBytes,32);assert.equal(listing.items[0].protected,false);
 const response=await s.api('/history/delete',a,'POST',{kind:'interviews',ids:[voice.id]});assert.equal(response.status,200);assert.equal((await response.json()).deletedCount,1);
 for(const table of ['interview_audio_frames','interview_questions','interview_answers','interview_contexts'])assert.equal(s.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id=?`).get(voice.id).n,0);
 await assert.rejects(stat(dir));assert.equal(s.db.prepare('SELECT bytes FROM interview_audio_storage WHERE user_id=?').get(a.user.id)?.bytes||0,0);
});

test('automatic cleanup enforces age and count limits but protects live work and new unassigned images',async t=>{
 const s=await setup(t),a=await s.login(),one=(await s.capture(a)).capture,two=(await s.capture(a)).capture,fresh=(await s.capture(a)).capture;
 await s.api(`/captures/${two.id}/analyze`,a,'POST',{});
 const paused=await s.interview(a);await s.api(`/interviews/${paused.id}/pause`,a,'POST',{});const ended=await s.interview(a);await s.api(`/interviews/${ended.id}/end`,a,'POST',{});await s.history.cleanupUser(a.user.id);s.db.prepare('UPDATE captures SET created_at=? WHERE id IN (?,?)').run(old,one.id,two.id);s.db.prepare('UPDATE interviews SET created_at=?,updated_at=?,ended_at=CASE WHEN status=\'ended\' THEN ? ELSE NULL END').run(old,old,old);
 const response=await s.api('/history/cleanup',a,'POST',{});assert.equal(response.status,200);const result=await response.json();assert.equal(result.deletedCaptures,1);assert.equal(result.deletedInterviews,1);
 assert.ok(s.db.prepare('SELECT id FROM captures WHERE id=?').get(two.id));assert.ok(s.db.prepare('SELECT id FROM captures WHERE id=?').get(fresh.id));assert.ok(s.db.prepare('SELECT id FROM interviews WHERE id=?').get(paused.id));
 assert.equal((await s.api('/history/settings',a,'PUT',{maxCaptures:2})).status,200);
 const blocked=await s.capture(a);assert.equal(blocked.response.status,429);assert.equal(blocked.code,'HISTORY_STORAGE_LIMIT');
});

test('manual-only mode keeps finite admission limits and never silently evicts old history',async t=>{
 const s=await setup(t),a=await s.login();assert.equal((await s.api('/history/settings',a,'PUT',{autoCleanup:false,maxCaptures:1})).status,200);const first=await s.capture(a);s.db.prepare('UPDATE captures SET created_at=?').run(old);
 assert.equal((await s.capture(a)).response.status,429);assert.ok(s.db.prepare('SELECT id FROM captures WHERE id=?').get(first.capture.id));
 assert.equal((await s.api('/history/cleanup',a,'POST',{})).status,200);assert.equal(s.db.prepare('SELECT count(*) AS n FROM captures').get().n,0);
});

test('failed physical file deletions stay in a persistent cleanup ledger and storage accounting until retried',async t=>{
 const s=await setup(t),a=await s.login(),capture=(await s.capture(a)).capture,row=s.db.prepare('SELECT path FROM captures WHERE id=?').get(capture.id),filename=path.join(s.dataDir,row.path);await rm(filename);await mkdir(filename);
 const response=await s.api('/history/delete',a,'POST',{kind:'captures',ids:[capture.id]});assert.equal(response.status,200);assert.equal(s.db.prepare('SELECT count(*) AS n FROM history_file_gc').get().n,1);
 let stats=(await (await s.api('/history/settings',a)).json()).usage;assert.equal(stats.pendingFileDeletes,1);assert.equal(stats.pendingFileBytes,pixel.length);assert.equal(stats.totalBytes,pixel.length);
 await rm(filename,{recursive:true});await writeFile(filename,pixel);await s.api('/history/cleanup',a,'POST',{});stats=(await (await s.api('/history/settings',a)).json()).usage;assert.equal(stats.pendingFileDeletes,0);assert.equal(stats.totalBytes,0);await assert.rejects(stat(filename));
});

test('history deletion events reach only the owner and legacy individual deletion uses the same event',async t=>{
 const s=await setup(t),a=await s.login(),b=await s.login('other@test.example'),capture=(await s.capture(a)).capture,sockets=[];
 async function connect(auth){const {ticket}=await(await s.api('/ws-ticket',auth,'POST',{kind:'web'})).json();const socket=new WebSocket(s.url.replace('http:','ws:')+'/ws?ticket='+ticket),events=[];socket.on('message',raw=>events.push(JSON.parse(raw.toString())));await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});sockets.push(socket);return events;}
 t.after(()=>{for(const socket of sockets)socket.terminate();});const own=await connect(a),other=await connect(b);
 assert.equal((await s.api('/captures/'+capture.id,a,'DELETE')).status,200);await new Promise(resolve=>setTimeout(resolve,40));
 const event=own.find(e=>e.type==='history.deleted');assert.ok(event);assert.equal(event.kind,'captures');assert.deepEqual(event.deletedIds,[capture.id]);assert.deepEqual(event.captureKeys,[capture.captureId]);assert.equal(other.some(e=>e.type==='history.deleted'),false);
});

test('capture deletion fences new grouped analysis while an aborted runner is still draining',async t=>{
 let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});const s=await setup(t,{runner:async()=>{entered();await gate;return {answer:'迟到回答'};}}),a=await s.login(),one=(await s.capture(a)).capture,two=(await s.capture(a)).capture;
 const task=(await(await s.api('/captures/analyze',a,'POST',{captureIds:[one.id,two.id],requestId:randomUUID()})).json()).task;await s.worker.tick();await started;
 const deletion=s.api('/captures/'+two.id,a,'DELETE');
 while(s.db.prepare('SELECT status FROM tasks WHERE id=?').get(task.id)?.status!=='cancelled')await new Promise(resolve=>setTimeout(resolve,5));
 let response;try{response=await s.api('/captures/analyze',a,'POST',{captureIds:[one.id,two.id],requestId:randomUUID()});}finally{release();await deletion;}
 assert.equal(response.status,410);assert.equal((await response.json()).code,'HISTORY_DELETED');assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n,0);
});

test('a queued legacy deletion revalidates login before it cancels another screenshot task',async t=>{
 let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});const s=await setup(t,{runner:async()=>{entered();await gate;return {answer:'旧回答'};}}),a=await s.login(),one=(await s.capture(a)).capture,two=(await s.capture(a)).capture;
 const first=(await(await s.api(`/captures/${one.id}/analyze`,a,'POST',{})).json()).task;await s.worker.tick();await started;const second=(await(await s.api(`/captures/${two.id}/analyze`,a,'POST',{})).json()).task;
 const deleting=s.api(`/captures/${one.id}`,a,'DELETE');while(s.db.prepare('SELECT status FROM tasks WHERE id=?').get(first.id)?.status!=='cancelled')await new Promise(resolve=>setTimeout(resolve,5));
 let observed;const queued=new Promise(resolve=>{observed=req=>{if(req.method==='DELETE'&&req.url===`/api/captures/${two.id}`)resolve();};s.server.prependListener('request',observed);});const stale=s.api(`/captures/${two.id}`,a,'DELETE');await queued;s.server.removeListener('request',observed);
 try{assert.equal((await s.api('/auth/logout',a,'POST',{})).status,200);}finally{release();}
 assert.equal((await deleting).status,401);assert.equal((await stale).status,401);assert.equal(s.db.prepare('SELECT status FROM tasks WHERE id=?').get(second.id).status,'queued');
});

test('parallel uploads reserve capacity atomically rather than exceeding a manual account limit',async t=>{
 const s=await setup(t),a=await s.login();await s.api('/history/settings',a,'PUT',{autoCleanup:false,maxCaptures:1});const results=await Promise.all([s.capture(a),s.capture(a),s.capture(a)]);
 assert.deepEqual(results.map(x=>x.response.status).sort(),[201,429,429]);assert.equal(s.db.prepare('SELECT count(*) AS n FROM captures').get().n,1);
});

test('an in-flight raw audio frame shares its media reservation with screenshot upload admission',async t=>{
 const s=await setup(t),a=await s.login();await s.api('/history/settings',a,'PUT',{autoCleanup:false,maxStorageMiB:1});const release=s.history.reserveAudio(a.user.id,1024*1024);
 try{const response=await s.capture(a);assert.equal(response.response.status,429);}finally{release();}
 assert.equal((await s.capture(a)).response.status,201);
});

test('count and media limits evict eligible oldest records; failed deletes continue consuming the media budget',async t=>{
 const s=await setup(t),a=await s.login(),one=(await s.capture(a)).capture;await s.api('/history/settings',a,'PUT',{maxCaptures:1});s.db.prepare('UPDATE captures SET created_at=? WHERE id=?').run(new Date(Date.now()-700000).toISOString(),one.id);
 const replacement=await s.capture(a);assert.equal(replacement.response.status,201);assert.equal(s.db.prepare('SELECT id FROM captures WHERE id=?').get(one.id),undefined);
 const row=s.db.prepare('SELECT * FROM captures WHERE id=?').get(replacement.capture.id),filename=path.join(s.dataDir,row.path);await rm(filename);await mkdir(filename);s.db.prepare('UPDATE captures SET size=? WHERE id=?').run(2*1024*1024,row.id);
 await s.api('/history/delete',a,'POST',{kind:'captures',all:true});await s.api('/history/settings',a,'PUT',{maxStorageMiB:1});const refused=await s.capture(a);assert.equal(refused.response.status,429);assert.equal(refused.code,'HISTORY_STORAGE_LIMIT');assert.equal(s.history.usage(a.user.id).pendingFileBytes,2*1024*1024);
});

test('completed screenshot task history stays bounded even when the same capture is reanalyzed repeatedly',async t=>{
 const s=await setup(t),a=await s.login(),image=(await s.capture(a)).capture;
 const initial=(await(await s.api(`/captures/${image.id}/analyze`,a,'POST',{})).json()).task;s.db.prepare("UPDATE tasks SET status='completed'").run();
 const insert=s.db.prepare("INSERT INTO tasks(id,user_id,capture_id,provider,status,prompt_name,prompt_snapshot,created_at,updated_at) VALUES(?,?,?,'codex','completed','风格','p',?,?)");
 s.db.transaction(()=>{for(let n=0;n<4999;n++)insert.run(randomUUID(),a.user.id,image.id,new Date(Date.now()-1000-n).toISOString(),new Date(Date.now()-1000-n).toISOString());})();
 const response=await s.api(`/captures/${image.id}/analyze`,a,'POST',{});assert.equal(response.status,201);assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks WHERE user_id=?').get(a.user.id).n,5000);assert.ok(s.db.prepare('SELECT id FROM tasks WHERE id=?').get(initial.id));
 await s.api('/history/settings',a,'PUT',{autoCleanup:false});s.db.prepare("UPDATE tasks SET status='completed'").run();const blocked=await s.api(`/captures/${image.id}/analyze`,a,'POST',{});assert.equal(blocked.status,429);assert.equal((await blocked.json()).code,'HISTORY_STORAGE_LIMIT');
 insert.run(randomUUID(),a.user.id,image.id,new Date().toISOString(),new Date().toISOString());assert.equal((await s.api('/history/cleanup',a,'POST',{})).status,200);assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks WHERE user_id=?').get(a.user.id).n,5000);
});
