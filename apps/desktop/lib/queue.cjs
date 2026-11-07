'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
class CaptureQueue{
  constructor(dir,{maxItems=100,maxBytes=12*1024*1024}={}){this.dir=path.resolve(dir);this.items=[];this.maxItems=maxItems;this.maxBytes=maxBytes;this.pending=Promise.resolve();}
  async load(){
    await fs.mkdir(this.dir,{recursive:true,mode:0o700});
    try{const data=JSON.parse(await fs.readFile(path.join(this.dir,'queue.json'),'utf8'));if(!Array.isArray(data)||data.some(x=>!UUID.test(x.captureId)))throw new Error('本地待传队列损坏，请备份后清理客户端数据');this.items=data;}catch(e){if(e.code!=='ENOENT')throw e;}
    this.items=this.items.filter(x=>typeof x.deviceId==='string'&&x.deviceId.length<100);
    return this.items;
  }
  mutate(fn){const op=this.pending.then(fn);this.pending=op.catch(()=>{});return op;}
  async persist(){const temp=path.join(this.dir,'queue.json.tmp');await fs.writeFile(temp,JSON.stringify(this.items),{mode:0o600});await fs.rename(temp,path.join(this.dir,'queue.json'));}
  add(bytes,metadata){return this.mutate(async()=>{
    if(!Buffer.isBuffer(bytes)||bytes.length>this.maxBytes||!bytes.length)throw new Error('截图文件过大或为空，最大 12 MB');
    if(this.items.length>=this.maxItems)throw new Error('待传队列已满，请联网后重试');
    const job={captureId:randomUUID(),createdAt:new Date().toISOString(),name:'截图.png',mime:'image/png',attempts:0,nextAttemptAt:0,...metadata,size:bytes.length};
    await fs.writeFile(path.join(this.dir,job.captureId+'.png'),bytes,{mode:0o600});this.items.push(job);await this.persist();return job;
  });}
  async read(id){if(!UUID.test(id)||!this.items.some(x=>x.captureId===id))throw new Error('待传截图不存在');return fs.readFile(path.join(this.dir,id+'.png'));}
  complete(id){return this.mutate(async()=>{if(!UUID.test(id))throw new Error('截图编号无效');this.items=this.items.filter(x=>x.captureId!==id);await this.persist();await fs.unlink(path.join(this.dir,id+'.png')).catch(e=>{if(e.code!=='ENOENT')throw e;});});}
  fail(id,error){return this.mutate(async()=>{const item=this.items.find(x=>x.captureId===id);if(!item)return;item.attempts++;item.error=String(error).slice(0,240);item.nextAttemptAt=Date.now()+Math.min(300000,1000*2**Math.min(item.attempts,8));await this.persist();});}
  async clear(){for(const item of [...this.items])await this.complete(item.captureId);}
}
module.exports={CaptureQueue};
