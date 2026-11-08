'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {CaptureQueue}=require('../lib/queue.cjs');
async function fixture(fn,options){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'duallink-batches-'));try{const q=new CaptureQueue(dir,options);await q.load();await fn(q,dir);}finally{await fs.rm(dir,{recursive:true,force:true});}}
const metadata={deviceId:'pc1',analyze:true,name:'截图.png'};
test('screenshots remain staged without uploads or analysis, including after restart',()=>fixture(async(q,dir)=>{
 const image=await q.add(Buffer.from('first'),metadata);
 assert.equal(image.analyze,false);assert.deepEqual(q.waitingUploads(),[]);assert.equal(q.staged('pc1').length,1);
 const restored=new CaptureQueue(dir);await restored.load();assert.equal(restored.staged('pc1')[0].captureId,image.captureId);assert.equal((await restored.read(image.captureId)).toString(),'first');
}));
test('one trigger freezes ordered screenshots as one batch; later screenshots belong to the next question',()=>fixture(async q=>{
 const a=await q.add(Buffer.from('first'),metadata),b=await q.add(Buffer.from('second'),metadata);
 const batch=await q.submit({deviceId:'pc1',captureIds:[a.captureId,b.captureId],provider:'claude',model:'vision-model'});
 assert.deepEqual(batch.captureIds,[a.captureId,b.captureId]);assert.equal(batch.provider,'claude');assert.equal(batch.model,'vision-model');
 const c=await q.add(Buffer.from('next'),metadata);assert.deepEqual(q.staged('pc1').map(x=>x.captureId),[c.captureId]);assert.deepEqual(q.waitingUploads().map(x=>x.captureId),[a.captureId,b.captureId]);
 assert.ok(q.waitingUploads().every(x=>x.analyze===false&&x.batchId===batch.id));
}));
test('concurrent submit of the same snapshot seals exactly one batch and rejects empty input',()=>fixture(async q=>{
 const a=await q.add(Buffer.from('a'),metadata),captureIds=[a.captureId];
 const results=await Promise.allSettled([q.submit({deviceId:'pc1',captureIds,provider:'codex'}),q.submit({deviceId:'pc1',captureIds,provider:'codex'})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(q.batches.length,1);
 await assert.rejects(q.submit({deviceId:'pc1',captureIds:[],provider:'codex'}),/截图/);
}));
test('uploads and request ID survive restart; uploaded files stay until the batch task is acknowledged',()=>fixture(async(q,dir)=>{
 const a=await q.add(Buffer.from('a'),metadata),b=await q.add(Buffer.from('b'),metadata);const batch=await q.submit({deviceId:'pc1',captureIds:[a.captureId,b.captureId],provider:'codex'});
 await q.markUploaded(a.captureId,'cloud-a');await q.failBatch(batch.id,'网络断开');
 const restored=new CaptureQueue(dir);await restored.load();assert.equal(restored.batches[0].id,batch.id);assert.equal(restored.items[0].uploadedId,'cloud-a');assert.equal(restored.batches[0].error,'网络断开');assert.deepEqual(restored.waitingUploads().map(x=>x.captureId),[b.captureId]);
 assert.equal((await restored.read(a.captureId)).toString(),'a');await restored.markUploaded(b.captureId,'cloud-b');await restored.completeBatch(batch.id,'task1');
 assert.equal(restored.items.length,0);assert.equal(restored.batches[0].status,'submitted');assert.equal(restored.batches[0].taskId,'task1');await assert.rejects(fs.access(path.join(dir,a.captureId+'.png')));
}));
test('an unacknowledged upload or partial batch cannot be discarded or completed',()=>fixture(async q=>{
 const a=await q.add(Buffer.from('a'),metadata);const batch=await q.submit({deviceId:'pc1',captureIds:[a.captureId],provider:'codex'});
 await assert.rejects(q.discard(a.captureId),/已提交/);await assert.rejects(q.completeBatch(batch.id,'task1'),/上传/);assert.equal(q.items.length,1);
}));
test('remove and clear only staged screenshots, leaving frozen batches and their data intact',()=>fixture(async q=>{
 const a=await q.add(Buffer.from('a'),metadata);const batch=await q.submit({deviceId:'pc1',captureIds:[a.captureId],provider:'codex'});const b=await q.add(Buffer.from('b'),metadata);
 await q.discard(b.captureId);await q.add(Buffer.from('c'),metadata);await q.clearStaged('pc1');assert.deepEqual(q.items.map(x=>x.captureId),batch.captureIds);assert.equal((await q.read(a.captureId)).toString(),'a');
 await q.clear();assert.equal(q.items.length,0);assert.equal(q.batches.length,0);
}));
test('batch limits prevent silent splitting or omitted images and permit the next batch',()=>fixture(async q=>{
 const a=await q.add(Buffer.from('aaa'),metadata);await q.add(Buffer.from('bbb'),metadata);await assert.rejects(q.add(Buffer.from('c'),metadata),/本题|待答/);
 const batch=await q.submit({deviceId:'pc1',captureIds:q.staged('pc1').map(x=>x.captureId),provider:'codex'});assert.equal(batch.captureIds[0],a.captureId);await q.add(Buffer.from('next'),metadata);assert.equal(q.staged('pc1').length,1);
},{maxBatchItems:2,maxBatchBytes:6}));
test('batch byte limit rejects a screenshot without evicting earlier images',()=>fixture(async q=>{
 await q.add(Buffer.from('abcd'),metadata);await assert.rejects(q.add(Buffer.from('abc'),metadata),/总大小/);assert.equal(q.items.length,1);
},{maxBatchBytes:6}));
test('legacy auto-analysis upload queue migrates to staged manual screenshots',()=>fixture(async(q,dir)=>{
 const a=await q.add(Buffer.from('old'),metadata);await fs.writeFile(path.join(dir,'queue.json'),JSON.stringify([{...a,analyze:true}]));const restored=new CaptureQueue(dir);await restored.load();assert.equal(restored.staged('pc1').length,1);assert.equal(restored.staged('pc1')[0].analyze,false);assert.deepEqual(restored.waitingUploads(),[]);
}));
test('batch submission rejects duplicate IDs, foreign devices and changed snapshot membership',()=>fixture(async q=>{
 const a=await q.add(Buffer.from('a'),metadata),b=await q.add(Buffer.from('b'),{deviceId:'other'});
 for(const captureIds of [[a.captureId,a.captureId],[b.captureId],['../private']])await assert.rejects(q.submit({deviceId:'pc1',captureIds,provider:'codex'}));
 await q.discard(a.captureId);await assert.rejects(q.submit({deviceId:'pc1',captureIds:[a.captureId],provider:'codex'}));assert.equal(q.batches.length,0);
}));
test('stale cloud upload IDs can be reset without losing local images, question order or request ID',()=>fixture(async(q,dir)=>{
 const a=await q.add(Buffer.from('a'),metadata),b=await q.add(Buffer.from('b'),metadata);const batch=await q.submit({deviceId:'pc1',captureIds:[a.captureId,b.captureId],provider:'claude',model:'vision'});
 await q.markUploaded(a.captureId,'deleted-cloud');await q.markUploaded(b.captureId,'other-cloud');await q.failBatch(batch.id,'截图已被删除');await q.resetUploads(batch.id);
 const restored=new CaptureQueue(dir);await restored.load();assert.deepEqual(restored.waitingUploads().map(x=>x.captureId),[a.captureId,b.captureId]);assert.ok(restored.waitingUploads().every(x=>x.forceCloud===true),'stale LAN acknowledgements must be bypassed even after restart');assert.equal(restored.batches[0].id,batch.id);assert.equal(restored.batches[0].model,'vision');assert.equal((await restored.read(a.captureId)).toString(),'a');
}));
