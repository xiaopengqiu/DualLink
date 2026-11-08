'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {encodeAudioFrame,validateSessionId}=require('./audio-core.cjs');
class AudioSpool {
  constructor(root,id,options={}) {
    this.root=path.resolve(root);this.id=validateSessionId(id);this.dir=path.resolve(this.root,this.id);
    if(path.dirname(this.dir)!==this.root)throw new Error('录音目录无效');
    this.maxBytes=options.maxBytes||512*1024*1024;this.maxFrames=options.maxFrames||200000;
    this.records=[];this.acked=new Set();this.pending=new Map();this.byOffset=new Map();this.sequences={remote:0,self:0};this.bytes=0;this.serial=Promise.resolve();
  }
  static async create(root,meta,options={}) {
    const spool=new AudioSpool(root,meta.sessionId,options);await fs.mkdir(spool.dir,{recursive:true,mode:0o700});
    try{await fs.access(path.join(spool.dir,'session.json'));throw new Error('此录音缓存已存在');}catch(e){if(e.code!=='ENOENT')throw e;}
    spool.meta={...meta,status:'recording'};await spool.saveMeta();return spool;
  }
  static async open(root,id,options={}) {
    const spool=new AudioSpool(root,id,options);spool.meta=JSON.parse(await fs.readFile(path.join(spool.dir,'session.json'),'utf8'));
    const file=path.join(spool.dir,'journal.ndjson');
    const journal=await fs.readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
    if(journal.length>32*1024*1024)throw new Error('录音缓存索引过大');
    for(const line of journal.split('\n')){
      if(!line)continue;let record;try{record=JSON.parse(line);}catch{continue;}
      if(record.type==='frame'){
        if(!['remote','self'].includes(record.track)||!Number.isSafeInteger(record.seq)||!Number.isSafeInteger(record.offset)||!Number.isInteger(record.length)||record.length<18||record.length>6416||record.offset<0)throw new Error('录音缓存索引损坏');
        spool.records.push(record);spool.byOffset.set(record.offset,record);spool.pending.set(record.track+':'+record.seq,record);spool.sequences[record.track]=Math.max(spool.sequences[record.track],record.seq+1);spool.bytes=Math.max(spool.bytes,record.offset+record.length);
      }else if(record.type==='ack'&&['remote','self'].includes(record.track)&&Number.isInteger(record.seq)){const key=record.track+':'+record.seq;spool.acked.add(key);spool.pending.delete(key);}
    }
    const actual=await fs.stat(path.join(spool.dir,'frames.bin')).catch(e=>{if(e.code==='ENOENT')return {size:0};throw e;});
    if(spool.bytes>actual.size||spool.bytes>spool.maxBytes||spool.records.length>spool.maxFrames)throw new Error('录音缓存不完整或超过上限');
    if(actual.size>spool.bytes&&options.repairTail!==false)await fs.truncate(path.join(spool.dir,'frames.bin'),spool.bytes);
    return spool;
  }
  mutate(fn){const result=this.serial.then(fn);this.serial=result.catch(()=>{});return result;}
  async saveMeta(){
    const temp=path.join(this.dir,'session.json.tmp');await fs.writeFile(temp,JSON.stringify(this.meta),{mode:0o600});
    for(let attempt=0;;attempt++)try{await fs.rename(temp,path.join(this.dir,'session.json'));return;}catch(error){if(!['EPERM','EBUSY','EACCES'].includes(error.code)||attempt>=5)throw error;await new Promise(resolve=>setTimeout(resolve,20*(attempt+1)));}
  }
  matchesOwner(owner){return !!owner&&owner.deviceId===this.meta.deviceId&&owner.cloudUrl===this.meta.cloudUrl;}
  nextSequence(track){if(!['remote','self'].includes(track))throw new Error('音轨无效');return this.sequences[track];}
  append({track,startMs,samples}) { return this.mutate(async()=>{
    const seq=this.nextSequence(track);const frame=encodeAudioFrame({track,seq,startMs,samples});
    if(this.bytes+frame.length>this.maxBytes||this.records.length>=this.maxFrames)throw new Error('本地录音缓存空间达到上限，请停止并恢复上传');
    const record={type:'frame',track,seq,startMs:Math.round(startMs),offset:this.bytes,length:frame.length};
    await fs.appendFile(path.join(this.dir,'frames.bin'),frame,{mode:0o600});
    await fs.appendFile(path.join(this.dir,'journal.ndjson'),JSON.stringify(record)+'\n',{mode:0o600});
    this.bytes+=frame.length;this.sequences[track]++;this.records.push(record);this.byOffset.set(record.offset,record);this.pending.set(track+':'+seq,record);return record;
  });}
  ack(track,seq){return this.mutate(async()=>{
    if(!['remote','self'].includes(track)||!Number.isInteger(seq)||seq<0||seq>=this.sequences[track])return;
    const key=track+':'+seq;if(this.acked.has(key))return;
    await fs.appendFile(path.join(this.dir,'journal.ndjson'),JSON.stringify({type:'ack',track,seq})+'\n',{mode:0o600});
    this.acked.add(key);this.pending.delete(key);
  });}
  get pendingCount(){return this.pending.size;}
  pendingRecords(){return Array.from(this.pending.values());}
  async read(record,replay=false){
    if(this.byOffset.get(record.offset)?.length!==record.length)throw new Error('录音分块不存在');
    const handle=await fs.open(path.join(this.dir,'frames.bin'),'r');try{const bytes=Buffer.alloc(record.length);const result=await handle.read(bytes,0,bytes.length,record.offset);if(result.bytesRead!==bytes.length)throw new Error('录音缓存不完整');bytes.writeUInt16BE(replay?1:0,2);return bytes;}finally{await handle.close();}
  }
  status(status){return this.mutate(async()=>{this.meta.status=status;if(status==='ended'&&!this.meta.endedAt)this.meta.endedAt=Date.now();await this.saveMeta();});}
  async remove(){await this.serial;const target=path.resolve(this.dir);if(path.dirname(target)!==this.root)throw new Error('拒绝清理未知录音目录');await fs.rm(target,{recursive:true,force:true});}
  view(){return {id:this.id,title:this.meta.title||'未完成录音',startedAt:this.meta.startedAt,status:this.meta.status,bytes:this.bytes,pending:this.pendingCount,deviceId:this.meta.deviceId};}
  static async list(root,owner){const result=[];for(const entry of await fs.readdir(root,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){if(!entry.isDirectory())continue;try{const spool=await AudioSpool.open(root,entry.name,{repairTail:false});if(spool.matchesOwner(owner))result.push(spool);}catch{}}return result.sort((a,b)=>b.meta.startedAt-a.meta.startedAt);}
  static async cleanup(root,owner,{retentionDays=30,now=Date.now(),isProtected=()=>false,isValid=()=>true}={}){
    const cutoff=now-Math.max(1,Math.min(365,Number(retentionDays)||30))*86400000,removed=[];
    for(const spool of await AudioSpool.list(root,owner)){
      if(!isValid())break;
      const finishedAt=Number(spool.meta.endedAt||spool.meta.startedAt);
      if(spool.meta.status!=='ended'||spool.pendingCount||!Number.isFinite(finishedAt)||finishedAt>=cutoff||isProtected(spool.id))continue;
      await spool.remove();removed.push(spool.id);
    }
    return removed;
  }
}
module.exports={AudioSpool};
