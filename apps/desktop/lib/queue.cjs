'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
class CaptureQueue{
  constructor(dir,{maxItems=100,maxBytes=12*1024*1024,maxBatchItems=20,maxBatchBytes=96*1024*1024}={}){this.dir=path.resolve(dir);this.items=[];this.batches=[];this.maxItems=maxItems;this.maxBytes=maxBytes;this.maxBatchItems=maxBatchItems;this.maxBatchBytes=maxBatchBytes;this.pending=Promise.resolve();}
  async load(){
    await fs.mkdir(this.dir,{recursive:true,mode:0o700});
    try{
      const data=JSON.parse(await fs.readFile(path.join(this.dir,'queue.json'),'utf8')),legacy=Array.isArray(data),items=legacy?data:data?.version===2?data.items:null,batches=legacy?[]:data.batches;
      if(!Array.isArray(items)||!Array.isArray(batches)||items.some(x=>!x||!UUID.test(x.captureId))||new Set(items.map(x=>x.captureId)).size!==items.length||batches.some(b=>!b||!UUID.test(b.id)||!Array.isArray(b.captureIds)||!b.captureIds.length||b.captureIds.some(id=>!UUID.test(id))||new Set(b.captureIds).size!==b.captureIds.length)||new Set(batches.map(b=>b.id)).size!==batches.length)throw new Error('本地待传队列损坏，请备份后清理客户端数据');
      this.items=items.map(x=>({...x,analyze:false,...(legacy?{batchId:null,uploadedId:null}:{})}));this.batches=batches;
      for(const item of this.items)if(item.batchId&&!this.batches.some(b=>b.id===item.batchId&&b.captureIds.includes(item.captureId)))throw new Error('本地截图批次损坏，请备份后清理客户端数据');
      for(const batch of this.batches)if(batch.status!=='submitted'&&batch.captureIds.some(id=>!this.items.some(x=>x.captureId===id&&x.batchId===batch.id)))throw new Error('本地截图批次缺少图片，请备份后清理客户端数据');
    }catch(e){if(e.code!=='ENOENT')throw e;}
    this.items=this.items.filter(x=>typeof x.deviceId==='string'&&x.deviceId.length<100);
    return this.items;
  }
  mutate(fn){const op=this.pending.then(async()=>{const before=structuredClone({items:this.items,batches:this.batches});try{return await fn();}catch(error){this.items=before.items;this.batches=before.batches;throw error;}});this.pending=op.catch(()=>{});return op;}
  async persist(){const temp=path.join(this.dir,'queue.json.tmp');await fs.writeFile(temp,JSON.stringify({version:2,items:this.items,batches:this.batches}),{mode:0o600});await fs.rename(temp,path.join(this.dir,'queue.json'));}
  staged(deviceId){return this.items.filter(x=>!x.batchId&&(deviceId===undefined||x.deviceId===deviceId));}
  waitingUploads(){return this.items.filter(x=>x.batchId&&!x.uploadedId);}
  add(bytes,metadata){return this.mutate(async()=>{
    if(!Buffer.isBuffer(bytes)||bytes.length>this.maxBytes||!bytes.length)throw new Error('截图文件过大或为空，最大 12 MB');
    if(this.items.length>=this.maxItems)throw new Error('待传队列已满，请联网后重试');
    const staged=this.staged(metadata?.deviceId);
    if(staged.length>=this.maxBatchItems)throw new Error(`本题待答截图最多 ${this.maxBatchItems} 张，请先触发回答或移除误截图片`);
    if(staged.reduce((n,x)=>n+x.size,0)+bytes.length>this.maxBatchBytes)throw new Error('本题截图总大小超过限制，请先移除不需要的图片');
    const job={createdAt:new Date().toISOString(),name:'截图.png',mime:'image/png',attempts:0,nextAttemptAt:0,...metadata,captureId:randomUUID(),analyze:false,batchId:null,uploadedId:null,size:bytes.length};
    await fs.writeFile(path.join(this.dir,job.captureId+'.png'),bytes,{mode:0o600});this.items.push(job);await this.persist();return job;
  });}
  submit({deviceId,captureIds,provider,model=''}){return this.mutate(async()=>{
    if(!Array.isArray(captureIds)||!captureIds.length||captureIds.length>this.maxBatchItems||new Set(captureIds).size!==captureIds.length)throw new Error('请选择有效的待答截图，单题最多 '+this.maxBatchItems+' 张');
    const selected=captureIds.map(id=>this.items.find(x=>UUID.test(id)&&x.captureId===id&&!x.batchId&&x.deviceId===deviceId));
    if(selected.some(x=>!x))throw new Error('截图已提交或已移除，请检查本题缓存');
    if(!['codex','claude'].includes(provider))throw new Error('请选择 Codex 或 Claude');
    if(selected.reduce((n,x)=>n+x.size,0)>this.maxBatchBytes)throw new Error('本题截图总大小超过限制');
    const batch={id:randomUUID(),deviceId,captureIds:[...captureIds],provider,model,createdAt:new Date().toISOString(),status:'queued',attempts:0,nextAttemptAt:0};
    for(const item of selected){item.batchId=batch.id;item.analyze=false;}this.batches.push(batch);await this.persist();return batch;
  });}
  markUploaded(id,uploadedId){return this.mutate(async()=>{const item=this.items.find(x=>x.captureId===id&&x.batchId);if(!item)throw new Error('待传截图不存在');if(typeof uploadedId!=='string'||!uploadedId||uploadedId.length>100)throw new Error('服务未返回有效截图编号');item.uploadedId=uploadedId;item.error='';await this.persist();});}
  resetUploads(id){return this.mutate(async()=>{const batch=this.batches.find(x=>x.id===id&&x.status!=='submitted');if(!batch)throw new Error('待答批次不存在');for(const item of this.items)if(item.batchId===id){item.uploadedId=null;item.nextAttemptAt=0;item.forceCloud=true;}await this.persist();});}
  abortBatch(id){return this.mutate(async()=>{
    if(!UUID.test(id))throw new Error('截图批次编号无效');const batch=this.batches.find(x=>x.id===id);if(!batch)return [];
    const ids=[...batch.captureIds];this.items=this.items.filter(x=>x.batchId!==id);this.batches=this.batches.filter(x=>x.id!==id);await this.persist();
    for(const captureId of ids)await fs.unlink(path.join(this.dir,captureId+'.png')).catch(()=>{});return ids;
  });}
  cleanupOrphans({now=Date.now(),retentionDays=30}={}){return this.mutate(async()=>{
    const cutoff=now-Math.max(1,Math.min(365,Number(retentionDays)||30))*86400000,referenced=new Set(this.items.map(x=>x.captureId+'.png'));let removed=0;
    for(const entry of await fs.readdir(this.dir,{withFileTypes:true})){
      if(!entry.isFile()||!entry.name.endsWith('.png')||!UUID.test(entry.name.slice(0,-4))||referenced.has(entry.name))continue;
      const filename=path.join(this.dir,entry.name),info=await fs.lstat(filename).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(!info?.isFile()||info.mtimeMs>=cutoff)continue;await fs.unlink(filename).catch(error=>{if(error.code!=='ENOENT')throw error;});removed++;
    }return removed;
  });}
  failBatch(id,error){return this.mutate(async()=>{const batch=this.batches.find(x=>x.id===id&&x.status!=='submitted');if(!batch)return;batch.status='failed';batch.attempts++;batch.error=String(error).slice(0,240);batch.nextAttemptAt=Date.now()+Math.min(300000,1000*2**Math.min(batch.attempts,8));await this.persist();});}
  retry(){return this.mutate(async()=>{for(const item of this.items)item.nextAttemptAt=0;for(const batch of this.batches)batch.nextAttemptAt=0;await this.persist();});}
  completeBatch(id,taskId){return this.mutate(async()=>{
    const batch=this.batches.find(x=>x.id===id);if(!batch)throw new Error('待答批次不存在');if(batch.status==='submitted')return;
    const images=batch.captureIds.map(captureId=>this.items.find(x=>x.captureId===captureId));if(images.some(x=>!x?.uploadedId))throw new Error('还有截图未上传，不能完成批次');
    if(typeof taskId!=='string'||!taskId)throw new Error('服务未返回回答任务编号');
    this.items=this.items.filter(x=>x.batchId!==id);batch.status='submitted';batch.taskId=taskId;batch.error='';batch.nextAttemptAt=0;
    const completed=this.batches.filter(x=>x.status==='submitted');if(completed.length>20){const discard=new Set(completed.slice(0,-20).map(x=>x.id));this.batches=this.batches.filter(x=>!discard.has(x.id));}
    await this.persist();for(const image of images)await fs.unlink(path.join(this.dir,image.captureId+'.png')).catch(()=>{});
  });}
  discard(id){return this.mutate(async()=>{if(!UUID.test(id))throw new Error('截图编号无效');const image=this.items.find(x=>x.captureId===id);if(!image)return;if(image.batchId)throw new Error('截图已提交，不能修改本次问题');this.items=this.items.filter(x=>x.captureId!==id);await this.persist();await fs.unlink(path.join(this.dir,id+'.png')).catch(()=>{});});}
  clearStaged(deviceId){return this.mutate(async()=>{const images=this.staged(deviceId),ids=new Set(images.map(x=>x.captureId));this.items=this.items.filter(x=>!ids.has(x.captureId));await this.persist();for(const image of images)await fs.unlink(path.join(this.dir,image.captureId+'.png')).catch(()=>{});});}
  async read(id){if(!UUID.test(id)||!this.items.some(x=>x.captureId===id))throw new Error('待传截图不存在');return fs.readFile(path.join(this.dir,id+'.png'));}
  complete(id){return this.mutate(async()=>{if(!UUID.test(id))throw new Error('截图编号无效');this.items=this.items.filter(x=>x.captureId!==id);await this.persist();await fs.unlink(path.join(this.dir,id+'.png')).catch(e=>{if(e.code!=='ENOENT')throw e;});});}
  fail(id,error){return this.mutate(async()=>{const item=this.items.find(x=>x.captureId===id);if(!item)return;item.attempts++;item.error=String(error).slice(0,240);item.nextAttemptAt=Date.now()+Math.min(300000,1000*2**Math.min(item.attempts,8));await this.persist();});}
  clear(){return this.mutate(async()=>{const images=this.items;this.items=[];this.batches=[];await this.persist();for(const item of images)await fs.unlink(path.join(this.dir,item.captureId+'.png')).catch(()=>{});});}
}
module.exports={CaptureQueue};
