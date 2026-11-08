import express from 'express';
import path from 'node:path';
import {stat,unlink,rm,realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fail,now} from './auth.mjs';

const MiB=1024*1024,DAY=86400000,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULTS=Object.freeze({retentionDays:30,maxCaptures:1000,maxInterviews:200,maxStorageMiB:1024,autoCleanup:true});
const ranges={retentionDays:[1,3650],maxCaptures:[1,5000],maxInterviews:[1,2000],maxStorageMiB:[1,102400]};
const route=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
const parse=(value,fallback)=>{try{return JSON.parse(value);}catch{return fallback;}};
const inside=(root,target)=>{const relative=path.relative(root,target);return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);};

/** Account-owned history, physical deletion journal, and finite admission budgets. */
export async function createHistoryService({db,dataDir,worker,interviews,publish,captureView,taskView,liveIdentity,options={}}){
 const router=express.Router(),root=await realpath(dataDir),chains=new Map(),reservations=new Map(),captureByteCache=new Map(),deletingCaptures=new Set(),deletingKeys=new Set();let closed=false,timer;
 function settings(uid){return {...DEFAULTS,...parse(db.prepare('SELECT value FROM history_settings WHERE user_id=?').get(uid)?.value,{})};}
 function validate(input,current){if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'历史保留设置无效');const value={...current};for(const [key,entry] of Object.entries(input)){if(key==='autoCleanup'){if(typeof entry!=='boolean')fail(400,'自动清理设置需为布尔值');}else if(!ranges[key]||!Number.isSafeInteger(entry)||entry<ranges[key][0]||entry>ranges[key][1])fail(400,'历史保留设置超出允许范围');value[key]=entry;}return value;}
 function serial(uid,fn){const prior=chains.get(uid)||Promise.resolve(),next=prior.catch(()=>{}).then(fn);chains.set(uid,next);void next.finally(()=>{if(chains.get(uid)===next)chains.delete(uid);}).catch(()=>{});return next;}
 function captureProtected(id,{automatic=false}={}){if(db.prepare("SELECT t.id FROM tasks t LEFT JOIN task_captures tc ON tc.task_id=t.id WHERE (t.capture_id=? OR tc.capture_id=?) AND t.status IN ('queued','running') LIMIT 1").get(id,id))return '截图回答正在排队或生成';if(automatic){const row=db.prepare('SELECT created_at FROM captures WHERE id=?').get(id);if(row&&Date.parse(row.created_at)>Date.now()-600000&&!db.prepare('SELECT task_id FROM task_captures WHERE capture_id=? LIMIT 1').get(id))return '截图刚上传，正在等待整题提交';}return null;}
 function interviewProtected(id){const row=db.prepare('SELECT status FROM interviews WHERE id=?').get(id);if(row&&row.status!=='ended')return '录音会话尚未结束';if(db.prepare("SELECT id FROM interview_answers WHERE session_id=? AND status IN ('queued','running') LIMIT 1").get(id))return '语音回答正在排队或生成';return null;}
 function usage(uid){
  const captures=db.prepare('SELECT count(*) AS n,COALESCE(sum(size),0) AS bytes FROM captures WHERE user_id=?').get(uid),voices=db.prepare('SELECT count(*) AS n FROM interviews WHERE user_id=?').get(uid),audio=db.prepare('SELECT COALESCE(sum(f.byte_count),0) AS n FROM interview_audio_frames f JOIN interviews i ON i.id=f.session_id WHERE i.user_id=? AND f.byte_offset IS NOT NULL').get(uid).n,gc=db.prepare('SELECT count(*) AS n,COALESCE(sum(bytes),0) AS bytes FROM history_file_gc WHERE user_id=?').get(uid);
  captureByteCache.set(uid,captures.bytes+gc.bytes);
  return {captures:captures.n,interviews:voices.n,tasks:db.prepare('SELECT count(*) AS n FROM tasks WHERE user_id=?').get(uid).n,captureBytes:captures.bytes,audioBytes:audio,totalBytes:captures.bytes+audio+gc.bytes,pendingFileDeletes:gc.n,pendingFileBytes:gc.bytes,protectedCaptures:db.prepare('SELECT id FROM captures WHERE user_id=?').all(uid).filter(x=>captureProtected(x.id)).length,protectedInterviews:db.prepare('SELECT id FROM interviews WHERE user_id=?').all(uid).filter(x=>interviewProtected(x.id)).length};
 }
 function assertNotDeletedKey(uid,key){if(deletingKeys.has(uid+':'+key)||db.prepare('SELECT capture_id FROM history_capture_deletions WHERE user_id=? AND capture_key=?').get(uid,key))fail(410,'截图历史已被主动删除，不会重新上传或回答','HISTORY_DELETED');}
 function assertNotDeletedId(uid,id){if(deletingCaptures.has(uid+':'+id)||db.prepare('SELECT capture_id FROM history_capture_deletions WHERE user_id=? AND capture_id=?').get(uid,id))fail(410,'截图历史已被主动删除，不会重新提交回答','HISTORY_DELETED');}
 function tombstone(row){db.prepare('INSERT INTO history_capture_deletions(user_id,capture_key,capture_id,deleted_at) VALUES(?,?,?,?) ON CONFLICT(user_id,capture_key) DO UPDATE SET capture_id=excluded.capture_id,deleted_at=excluded.deleted_at').run(row.user_id,row.capture_key,row.id,now());}
 function pruneTombstones(uid){db.prepare('DELETE FROM history_capture_deletions WHERE deleted_at<?').run(new Date(Date.now()-30*DAY).toISOString());db.prepare('DELETE FROM history_capture_deletions WHERE user_id=? AND capture_key IN (SELECT capture_key FROM history_capture_deletions WHERE user_id=? ORDER BY deleted_at DESC,capture_key DESC LIMIT -1 OFFSET 10000)').run(uid,uid);}
 function notifyDeleted(uid,kind,ids,taskIds=[],extra={}){const count=Math.max(ids.length,taskIds.length,extra.captureKeys?.length||0,extra.requestIds?.length||0);for(let offset=0;offset<count;offset+=200)publish(uid,{type:'history.deleted',kind,deletedIds:ids.slice(offset,offset+200),deletedTaskIds:taskIds.slice(offset,offset+200),captureKeys:(extra.captureKeys||[]).slice(offset,offset+200),requestIds:(extra.requestIds||[]).slice(offset,offset+200),reason:extra.reason||'manual'});}
 function journal(uid,relative,recursive,bytes){const resolved=path.resolve(dataDir,relative);if(!inside(path.resolve(dataDir),resolved))fail(500,'历史文件路径不在数据目录内');db.prepare('INSERT INTO history_file_gc(id,user_id,path,recursive,bytes,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),uid,relative,recursive?1:0,Math.max(0,bytes||0),now());}
 async function collectFiles(uid){
  for(const item of db.prepare('SELECT * FROM history_file_gc WHERE user_id=? ORDER BY created_at,id').all(uid)){
   try{const target=path.resolve(dataDir,item.path);if(!inside(path.resolve(dataDir),target))throw new Error('UNSAFE_PATH');let parent;try{parent=await realpath(path.dirname(target));}catch(error){if(error.code==='ENOENT'){db.prepare('DELETE FROM history_file_gc WHERE id=?').run(item.id);continue;}throw error;}if(!inside(root,parent)&&parent!==root)throw new Error('UNSAFE_PATH');if(item.recursive)await rm(target,{recursive:true,force:true});else await unlink(target).catch(error=>{if(error.code!=='ENOENT')throw error;});db.prepare('DELETE FROM history_file_gc WHERE id=?').run(item.id);
   }catch(error){db.prepare('UPDATE history_file_gc SET error=? WHERE id=?').run(String(error.code||error.message||'DELETE_FAILED').slice(0,80),item.id);}
  }
  captureByteCache.delete(uid);
 }
 async function removeCaptures(uid,ids,{force=false,automatic=false,check}={}){
  check?.();
  const rows=ids.map(id=>db.prepare('SELECT * FROM captures WHERE id=? AND user_id=?').get(id,uid)).filter(Boolean),skippedIds=[],deletedIds=[],deletedTaskIds=[],requestIds=[],keys=[];
  for(const row of rows){
   check?.();
   if(!force&&captureProtected(row.id,{automatic})){skippedIds.push(row.id);continue;}
   deletingCaptures.add(uid+':'+row.id);deletingKeys.add(uid+':'+row.capture_key);try{
   const tasks=db.prepare('SELECT DISTINCT t.* FROM tasks t LEFT JOIN task_captures tc ON tc.task_id=t.id WHERE t.capture_id=? OR tc.capture_id=?').all(row.id,row.id);
   // Mark terminal before waiting so neither the poller nor a retry can claim it.
   db.transaction(()=>{for(const task of tasks)if(['queued','running'].includes(task.status)){db.prepare("UPDATE tasks SET status='cancelled',stage='cancelled',updated_at=? WHERE id=?").run(now(),task.id);worker.cancel(task.id);}})();
   await Promise.all(tasks.map(task=>worker.waitFor(task.id)));check?.();
   if(!db.prepare('SELECT id FROM captures WHERE id=? AND user_id=?').get(row.id,uid))continue;
   if(!force&&captureProtected(row.id,{automatic})){skippedIds.push(row.id);continue;}
   db.transaction(()=>{journal(uid,row.path,false,row.size);tombstone(row);for(const task of tasks){db.prepare('DELETE FROM tasks WHERE id=?').run(task.id);deletedTaskIds.push(task.id);if(task.request_id)requestIds.push(task.request_id);}db.prepare('DELETE FROM captures WHERE id=? AND user_id=?').run(row.id,uid);})();deletedIds.push(row.id);keys.push(row.capture_key);
   }finally{deletingCaptures.delete(uid+':'+row.id);deletingKeys.delete(uid+':'+row.capture_key);}
  }
  pruneTombstones(uid);await collectFiles(uid);notifyDeleted(uid,'captures',deletedIds,[...new Set(deletedTaskIds)],{captureKeys:keys,requestIds,reason:automatic?'auto':'manual'});return {deletedIds,deletedTaskIds:[...new Set(deletedTaskIds)],skippedIds,deletedCount:deletedIds.length};
 }
 async function removeInterviews(uid,ids,{force=false,automatic=false,check}={}){
  const deletedIds=[],skippedIds=[];
  for(const id of ids){check?.();const row=db.prepare('SELECT * FROM interviews WHERE id=? AND user_id=?').get(id,uid);if(!row)continue;if(!force&&interviewProtected(id)){skippedIds.push(id);continue;}
   // The interview service fences triggers/recording while it drains active work.
   await interviews.deleteSession(uid,id,{removeFiles:false,check});try{check?.();
   const bytes=db.prepare('SELECT COALESCE(sum(byte_count),0) AS n FROM interview_audio_frames WHERE session_id=? AND byte_offset IS NOT NULL').get(id).n;
   db.transaction(()=>{journal(uid,path.join('users',uid,'interviews',id),true,bytes);db.prepare('UPDATE interview_audio_storage SET bytes=max(0,bytes-?) WHERE user_id=?').run(bytes,uid);db.prepare('DELETE FROM interviews WHERE id=? AND user_id=?').run(id,uid);})();deletedIds.push(id);publish(uid,{type:'interview.deleted',sessionId:id});}finally{interviews.releaseDeletion(id);}
  }
  await collectFiles(uid);notifyDeleted(uid,'interviews',deletedIds,[],{reason:automatic?'auto':'manual'});return {deletedIds,deletedTaskIds:[],skippedIds,deletedCount:deletedIds.length};
 }
 function trimTasks(uid,{reserve=0,explicit=false}={}){
  const count=db.prepare('SELECT count(*) AS n FROM tasks WHERE user_id=?').get(uid).n;if(count+reserve<=5000)return 0;
  if(!settings(uid).autoCleanup&&!explicit)fail(429,'截图回答历史已达上限，请先删除旧记录','HISTORY_STORAGE_LIMIT');
  const rows=db.prepare('SELECT id,capture_id,status,created_at FROM tasks WHERE user_id=? ORDER BY created_at DESC,id DESC').all(uid),members=new Map();
  for(const row of db.prepare('SELECT tc.task_id,tc.capture_id FROM task_captures tc JOIN tasks t ON t.id=tc.task_id WHERE t.user_id=?').all(uid)){if(!members.has(row.task_id))members.set(row.task_id,[]);members.get(row.task_id).push(row.capture_id);}
  const latest=new Set(),candidates=[];
  for(const row of rows){const ids=members.get(row.id)||[row.capture_id],isLatest=ids.some(id=>!latest.has(id));for(const id of ids)latest.add(id);if(!isLatest&&!['queued','running'].includes(row.status))candidates.push(row);}
  const needed=count+reserve-5000;if(candidates.length<needed)fail(429,'进行中的回答历史已达上限，请先完成或删除旧记录','HISTORY_STORAGE_LIMIT');
  const deleted=candidates.slice(-needed).map(x=>x.id);for(const id of deleted)db.prepare('DELETE FROM tasks WHERE id=?').run(id);
  // Task creation may still roll back. Notify only the removals that committed.
  queueMicrotask(()=>{if(!closed){const removed=deleted.filter(id=>!db.prepare('SELECT id FROM tasks WHERE id=?').get(id));if(removed.length)notifyDeleted(uid,'captures',[],removed,{reason:explicit?'manual':'auto'});}});
  return deleted.length;
 }
 async function cleanUser(uid,{reserveCaptures=0,reserveInterviews=0,reserveBytes=0,explicit=false,check}={}){
  await collectFiles(uid);check?.();const config=settings(uid),cutoff=new Date(Date.now()-config.retentionDays*DAY).toISOString();let deletedCaptures=0,deletedInterviews=0,deletedTasks=0;
  if(config.autoCleanup||explicit){
   const captures=db.prepare("SELECT c.id FROM captures c WHERE c.user_id=? AND max(c.created_at,COALESCE((SELECT max(t.updated_at) FROM tasks t LEFT JOIN task_captures tc ON tc.task_id=t.id WHERE t.capture_id=c.id OR tc.capture_id=c.id),c.created_at))<? ORDER BY c.created_at,c.id").all(uid,cutoff).map(x=>x.id),voices=db.prepare("SELECT id FROM interviews WHERE user_id=? AND COALESCE(ended_at,updated_at,created_at)<? ORDER BY created_at,id").all(uid,cutoff).map(x=>x.id);
   if(captures.length){const result=await removeCaptures(uid,captures,{automatic:true,check});deletedCaptures+=result.deletedCount;deletedTasks+=result.deletedTaskIds.length;}
   if(voices.length)deletedInterviews+=(await removeInterviews(uid,voices,{automatic:true,check})).deletedCount;
   let current=usage(uid);const pending=reservations.get(uid)||{captures:0,interviews:0,bytes:0};
   const over=()=>current.captures+reserveCaptures+pending.captures>config.maxCaptures||current.interviews+reserveInterviews+pending.interviews>config.maxInterviews||current.totalBytes+reserveBytes+pending.bytes>config.maxStorageMiB*MiB;
   if(over()){
    const candidates=[...db.prepare('SELECT id,created_at FROM captures WHERE user_id=? ORDER BY created_at,id').all(uid).filter(x=>!captureProtected(x.id,{automatic:true})).map(x=>({...x,kind:'captures'})),...db.prepare("SELECT id,created_at FROM interviews WHERE user_id=? AND status='ended' ORDER BY created_at,id").all(uid).filter(x=>!interviewProtected(x.id)).map(x=>({...x,kind:'interviews'}))].sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));
    for(const item of candidates){if(!over())break;if(item.kind==='captures'&&current.captures+reserveCaptures+pending.captures<=config.maxCaptures&&current.totalBytes+reserveBytes+pending.bytes<=config.maxStorageMiB*MiB)continue;if(item.kind==='interviews'&&current.interviews+reserveInterviews+pending.interviews<=config.maxInterviews&&current.totalBytes+reserveBytes+pending.bytes<=config.maxStorageMiB*MiB)continue;check?.();const result=await (item.kind==='captures'?removeCaptures:removeInterviews)(uid,[item.id],{automatic:true,check});if(item.kind==='captures'){deletedCaptures+=result.deletedCount;deletedTasks+=result.deletedTaskIds.length;}else deletedInterviews+=result.deletedCount;current=usage(uid);}
   }
   deletedTasks+=trimTasks(uid,{explicit});
  }
  pruneTombstones(uid);return {deletedCaptures,deletedInterviews,deletedTasks,usage:usage(uid)};
 }
 async function reserve(uid,{kind,bytes=0,check}={}){return serial(uid,async()=>{const config=settings(uid);await cleanUser(uid,{reserveCaptures:kind==='captures'?1:0,reserveInterviews:kind==='interviews'?1:0,reserveBytes:bytes,check});check?.();const current=usage(uid),pending=reservations.get(uid)||{captures:0,interviews:0,bytes:0};if(current.captures+pending.captures+(kind==='captures'?1:0)>config.maxCaptures||current.interviews+pending.interviews+(kind==='interviews'?1:0)>config.maxInterviews||current.totalBytes+pending.bytes+bytes>config.maxStorageMiB*MiB)fail(429,'历史容量已达上限，请删除旧记录或调整保留设置；正在进行的记录不会自动删除','HISTORY_STORAGE_LIMIT');const booking={captures:kind==='captures'?1:0,interviews:kind==='interviews'?1:0,bytes};for(const key of Object.keys(booking))pending[key]+=booking[key];reservations.set(uid,pending);let released=false;return ()=>{if(released)return;released=true;for(const key of Object.keys(booking))pending[key]-=booking[key];if(!pending.captures&&!pending.interviews&&!pending.bytes)reservations.delete(uid);captureByteCache.delete(uid);};});}
 function list(uid,kind,query){
  const limit=query.limit===undefined?50:Number(query.limit);if(!Number.isInteger(limit)||limit<1||limit>200)fail(400,'每页历史数量需为1至200');if(query.search!==undefined&&(typeof query.search!=='string'||query.search.length>300))fail(400,'历史搜索内容过长');let cursor=null;if(query.cursor){cursor=parse(Buffer.from(String(query.cursor),'base64url').toString(),null);if(!cursor||typeof cursor.time!=='string'||!UUID.test(cursor.id||'')||Number.isNaN(Date.parse(cursor.time)))fail(400,'历史分页游标无效');}
  const search=String(query.search||'').trim(),pattern='%'+search.replace(/[\\%_]/g,'\\$&')+'%',table=kind==='captures'?'captures':'interviews';let where='r.user_id=?',values=[uid];
  if(search){if(kind==='captures')where+=" AND (COALESCE((SELECT name FROM devices WHERE id=r.device_id),'网页截图') LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM tasks t LEFT JOIN task_captures tc ON tc.task_id=t.id WHERE (t.capture_id=r.id OR tc.capture_id=r.id) AND (t.question LIKE ? ESCAPE '\\' OR t.answer LIKE ? ESCAPE '\\')))";else where+=" AND (r.title LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM interview_segments s WHERE s.session_id=r.id AND s.text LIKE ? ESCAPE '\\') OR EXISTS(SELECT 1 FROM interview_answers a WHERE a.session_id=r.id AND a.text LIKE ? ESCAPE '\\'))";values.push(pattern,pattern,pattern);}
  const total=db.prepare(`SELECT count(*) AS n FROM ${table} r WHERE ${where}`).get(...values).n;if(cursor){where+=' AND (r.created_at<? OR (r.created_at=? AND r.id<?))';values.push(cursor.time,cursor.time,cursor.id);}const rows=db.prepare(`SELECT r.* FROM ${table} r WHERE ${where} ORDER BY r.created_at DESC,r.id DESC LIMIT ?`).all(...values,limit+1),hasMore=rows.length>limit;if(hasMore)rows.pop();
  const items=rows.map(row=>{const reason=kind==='captures'?captureProtected(row.id):interviewProtected(row.id);if(kind==='captures'){const task=db.prepare('SELECT DISTINCT t.* FROM tasks t LEFT JOIN task_captures tc ON tc.task_id=t.id WHERE t.capture_id=? OR tc.capture_id=? ORDER BY t.created_at DESC,t.id DESC LIMIT 1').get(row.id,row.id);return {...captureView(row),size:row.size,latestTask:task?taskView(task):null,protected:!!reason,protectedReason:reason};}return {...interviews.view(row),audioBytes:db.prepare('SELECT COALESCE(sum(byte_count),0) AS n FROM interview_audio_frames WHERE session_id=? AND byte_offset IS NOT NULL').get(row.id).n,protected:!!reason,protectedReason:reason};});
  const last=rows.at(-1);return {items,total,hasMore,nextCursor:hasMore?Buffer.from(JSON.stringify({time:last.created_at,id:last.id})).toString('base64url'):null};
 }
 const browser=(req,_res,next)=>req.identity.kind==='web'?next():next(Object.assign(new Error('请使用网站账号管理历史'),{status:403}));
 router.get('/settings',(req,res)=>res.json({settings:settings(req.identity.userId),usage:usage(req.identity.userId),rawAudioRetentionDays:interviews.rawAudioRetentionDays}));
 router.put('/settings',browser,route(async(req,res)=>{const uid=req.identity.userId,value=validate(req.body,settings(uid));const result=await serial(uid,async()=>{liveIdentity(req);db.prepare('INSERT INTO history_settings(user_id,value) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET value=excluded.value').run(uid,JSON.stringify(value));return cleanUser(uid,{check:()=>liveIdentity(req)});});publish(uid,{type:'history.updated',settings:value,usage:result.usage});res.json({settings:value,usage:result.usage,rawAudioRetentionDays:interviews.rawAudioRetentionDays});}));
 router.post('/cleanup',browser,route(async(req,res)=>{const uid=req.identity.userId,result=await serial(uid,()=>cleanUser(uid,{explicit:true,check:()=>liveIdentity(req)}));publish(uid,{type:'history.updated',usage:result.usage});res.json(result);}));
 router.post('/delete',browser,route(async(req,res)=>{const {kind,ids,all,before}=req.body;if(!['captures','interviews'].includes(kind))fail(400,'历史类型无效');if((all===true)===(ids!==undefined)||all!==undefined&&all!==true)fail(400,'请选择历史编号或明确清空全部');if(ids!==undefined&&(!Array.isArray(ids)||!ids.length||ids.length>200||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!UUID.test(id))))fail(400,'每次需选择1至200条不同历史记录');if(before!==undefined&&(typeof before!=='string'||Number.isNaN(Date.parse(before))))fail(400,'历史清理日期无效');const uid=req.identity.userId,result=await serial(uid,async()=>{liveIdentity(req);if(ids)for(const id of ids)if(!db.prepare(`SELECT id FROM ${kind} WHERE id=? AND user_id=?`).get(id,uid))fail(404,'历史记录不存在');const selected=ids||db.prepare(`SELECT id FROM ${kind} WHERE user_id=? ${before?'AND created_at<?':''} ORDER BY created_at,id`).all(uid,...(before?[new Date(before).toISOString()]:[])).map(x=>x.id);return (kind==='captures'?removeCaptures:removeInterviews)(uid,selected,{check:()=>liveIdentity(req)});});res.json({...result,usage:usage(uid)});}));
 router.get('/:kind',(req,res)=>{if(!['captures','interviews'].includes(req.params.kind))fail(404,'历史类型不存在');res.json(list(req.identity.userId,req.params.kind,req.query));});
 for(const row of db.prepare('SELECT id,path FROM captures WHERE size=0').all()){try{const info=await stat(path.join(dataDir,row.path));if(info.isFile())db.prepare('UPDATE captures SET size=? WHERE id=?').run(info.size,row.id);}catch{}}
 async function cleanupAll(){for(const row of db.prepare('SELECT id FROM users').all())if(!closed)await serial(row.id,()=>cleanUser(row.id));try{db.pragma('wal_checkpoint(PASSIVE)');}catch{}}
 if(options.startCleanup!==false)await cleanupAll();timer=setInterval(()=>void cleanupAll().catch(error=>console.error('[history] cleanup failed',error.code||error.name)),Math.max(60000,options.cleanupIntervalMs||3600000));timer.unref();
 return {router,settings,usage,reserve,trimTasks,assertNotDeletedKey,assertNotDeletedId,rawAudioRetentionDays:interviews.rawAudioRetentionDays,
  captureWritten(uid){captureByteCache.delete(uid);},
  audioBudget(uid){if(!captureByteCache.has(uid))usage(uid);return Math.max(0,settings(uid).maxStorageMiB*MiB-(captureByteCache.get(uid)||0)-(reservations.get(uid)?.bytes||0));},
  reserveAudio(uid,bytes){if(!captureByteCache.has(uid))usage(uid);const pending=reservations.get(uid)||{captures:0,interviews:0,bytes:0},stored=db.prepare('SELECT bytes FROM interview_audio_storage WHERE user_id=?').get(uid)?.bytes||0;if(stored+(captureByteCache.get(uid)||0)+pending.bytes+bytes>settings(uid).maxStorageMiB*MiB)fail(429,'历史媒体存储额度已满，请删除旧记录后继续','HISTORY_STORAGE_LIMIT');pending.bytes+=bytes;reservations.set(uid,pending);let released=false;return ()=>{if(released)return;released=true;pending.bytes-=bytes;if(!pending.bytes&&!pending.captures&&!pending.interviews)reservations.delete(uid);};},
  removeCapture(uid,id,check){return serial(uid,()=>removeCaptures(uid,[id],{force:true,check}));},
  removeInterview(uid,id,check){return serial(uid,()=>removeInterviews(uid,[id],{force:true,check}));},
  cleanupUser(uid){return serial(uid,()=>cleanUser(uid));},
  async close(){closed=true;clearInterval(timer);await Promise.allSettled([...chains.values()]);}
 };
}
