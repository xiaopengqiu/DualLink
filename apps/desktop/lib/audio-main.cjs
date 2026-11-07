'use strict';
const WebSocket=require('ws');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {AudioSpool}=require('./audio-spool.cjs');
const {validateSessionId}=require('./audio-core.cjs');

class AudioController {
  constructor({root,getOwner,api,emit,onUnauthorized}) {
    this.root=path.resolve(root);this.getOwner=getOwner;this.api=api;this.emit=emit;this.onUnauthorized=onUnauthorized;
    this.state={phase:'idle',connected:false,interview:null,error:'',recoveries:[],interviews:[],config:null,pending:0,bytes:0,recording:false};
    this.generation=0;this.triggerRevision=0;this.owner=null;this.spool=null;this.connection=null;this.reconnectTimer=null;this.reconnectAttempt=0;this.replaying=new Set();this.replayConnections=new Set();this.pendingWrites=0;this.inflightFrames=new Set();this.answerStates=new Map();this.lastNotice=0;this.closed=false;
  }
  view(){return {...this.state,token:this.token||null,epochMs:this.spool?.meta.startedAt||null,pending:this.spool?.pendingCount??this.state.pending,bytes:this.spool?.bytes??this.state.bytes};}
  notify(force=false){if(force||Date.now()-this.lastNotice>350){this.lastNotice=Date.now();this.emit('audio.state',this.view());}}
  valid(owner=this.owner,generation=this.generation){return !this.closed&&!!owner&&owner===this.getOwner()&&generation===this.generation;}
  check(owner,generation){if(!this.valid(owner,generation))throw new Error('设备配对已变化，录音操作已取消');}
  async refresh(){
    const owner=this.getOwner();if(!owner){this.state.interviews=[];this.state.recoveries=[];this.state.config=null;this.notify(true);return this.view();}
    const generation=this.generation;
    const [config,result,prompts,spools]=await Promise.all([this.api(owner,'/interviews/config'),this.api(owner,'/interviews?limit=50'),this.api(owner,'/prompts'),AudioSpool.list(this.root,owner)]);
    if(owner!==this.getOwner()||generation!==this.generation)return this.view();
    this.state.config=config;this.state.interviews=result.interviews||[];this.state.prompts=prompts.prompts||[];this.state.recoveries=spools.filter(s=>s.pendingCount).map(s=>s.view());this.notify(true);return this.view();
  }
  async start(input={}) {
    if(this.state.interview&&!['ended','idle','error'].includes(this.state.phase))throw new Error('请先结束当前录音会话');
    const owner=this.getOwner();if(!owner)throw new Error('请先配对电脑');
    const generation=++this.generation;this.invalidateTrigger();let startedId;this.owner=owner;this.state.phase='connecting';this.state.error='';this.notify(true);
    try {
      const config=await this.api(owner,'/interviews/config');this.check(owner,generation);
      this.state.config=config;
      const defaults={mode:'transcript',provider:config.defaultProvider||'codex',transcribe:true,audioWindowSeconds:120,...config.defaults};
      let interview;
      if(input.sessionId){validateSessionId(input.sessionId);interview=(await this.api(owner,`/interviews/${input.sessionId}`)).interview;this.check(owner,generation);if(interview.status==='ended')throw new Error('此面试已经结束');if(interview.status==='paused')interview=(await this.api(owner,`/interviews/${interview.id}/resume`,{method:'POST',body:{}})).interview;}
      else {
        const mode=input.mode||defaults.mode;
        if(mode==='audio'?!config.audioConfigured:!config.configured)throw new Error(mode==='audio'?'云端尚未配置音频直答模型密钥，请配置百炼模型后重试':'云端尚未配置语音识别密钥，请配置百炼服务后重试');
        interview=(await this.api(owner,'/interviews',{method:'POST',body:{title:input.title||'面试记录',mode,provider:input.provider||defaults.provider,transcribe:mode==='transcript'?true:(input.transcribe??defaults.transcribe),audioModel:input.audioModel||defaults.audioModel,audioWindowSeconds:input.audioWindowSeconds??defaults.audioWindowSeconds,autoAnswer:mode==='transcript'&&input.autoAnswer===true,...(input.promptId?{promptId:input.promptId}:{})}})).interview;
      }
      this.check(owner,generation);validateSessionId(interview.id);this.state.interview=interview;startedId=interview.id;
      if(interview.mode==='audio'?!config.audioConfigured:!config.configured)throw new Error('云端尚未配置此模式的模型，请检查配置后重试');
      this.spool=await AudioSpool.open(this.root,interview.id).catch(e=>{if(e.code==='ENOENT')return AudioSpool.create(this.root,{sessionId:interview.id,title:interview.title,deviceId:owner.deviceId,cloudUrl:owner.cloudUrl,startedAt:Date.now()-Math.max(0,Date.now()-Date.parse(interview.createdAt))});throw e;});
      if(!this.spool.matchesOwner(owner))throw new Error('此本地录音属于另一个配对设备');
      this.check(owner,generation);this.token=crypto.randomUUID();await this.openSocket('live',this.spool,owner,generation);this.check(owner,generation);
      this.state.phase='ready';this.state.recording=false;await this.spool.status('recording');this.notify(true);
      return this.control(input.microphoneId);
    }catch(error){await this.connectionFailed(error,owner,generation,'error',startedId);throw error;}
  }
  async connectionFailed(error,owner,generation,phase,sessionId){
    if(!this.valid(owner,generation))return;
    if(this.connection){this.connection.stopping=true;this.connection.ws.terminate();this.connection=null;}
    clearTimeout(this.reconnectTimer);this.state.phase=phase;this.state.connected=false;this.state.recording=false;this.state.error=error.message;this.notify(true);
    if(sessionId){
      try{const result=await this.api(owner,`/interviews/${sessionId}/pause`,{method:'POST',body:{}});if(this.valid(owner,generation)&&this.state.interview?.id===sessionId)this.state.interview=result.interview;}
      catch{if(this.valid(owner,generation))this.state.error=error.message+'；云端状态未确认，可在网页暂停或结束该会话后重试';}
      if(!this.valid(owner,generation))return;
      await this.spool?.status('paused').catch(()=>{});if(!this.valid(owner,generation))return;
      this.notify(true);void this.refresh().catch(()=>{});
    }
  }
  control(microphoneId){return {token:this.token,sessionId:this.state.interview.id,epochMs:this.spool.meta.startedAt,microphoneId:typeof microphoneId==='string'?microphoneId:'',maxSessionMinutes:this.state.config?.maxSessionMinutes||120};}
  markStarted(token){if(token!==this.token||!this.valid())throw new Error('录音启动已失效');this.state.phase='recording';this.state.recording=true;this.state.error='';this.notify(true);}
  markFlushed(input){if(this.flushWaiter&&input?.token===this.flushWaiter.token&&input?.requestId===this.flushWaiter.requestId)this.flushWaiter.resolve();}
  async flushCapture(){
    const token=this.token,requestId=crypto.randomUUID();
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{if(this.flushWaiter?.requestId===requestId)this.flushWaiter=null;reject(new Error('音频尾块同步超时，请重试回答'));},1500);
      this.flushWaiter={token,requestId,resolve:()=>{clearTimeout(timer);this.flushWaiter=null;resolve();},reject:error=>{clearTimeout(timer);this.flushWaiter=null;reject(error);}};
      this.emit('audio.capture.flush',{token,requestId});
    });
  }
  invalidateTrigger(){this.triggerRevision++;this.lastTriggerResult=null;this.lastTriggerAt=0;this.triggerPromise=null;this.state.triggerAnswerId=null;this.state.triggerStatus='';this.state.triggerError='';}
  trigger(){
    if(this.triggerPromise)return this.triggerPromise;
    if(this.lastTriggerResult&&Date.now()-this.lastTriggerAt<600)return Promise.resolve(this.lastTriggerResult);
    const operation=this.triggerCurrent();this.triggerPromise=operation;
    void operation.finally(()=>{if(this.triggerPromise===operation)this.triggerPromise=null;}).catch(()=>{});return operation;
  }
  async triggerCurrent(){
    const owner=this.owner,generation=this.generation,spool=this.spool,revision=this.triggerRevision;
    const check=()=>{this.check(owner,generation);if(revision!==this.triggerRevision)throw new Error('面试配置或录音状态已变化，回答触发已取消，请重新触发');};
    if(!this.state.interview||!spool||!['ready','recording','paused'].includes(this.state.phase))throw new Error('请先开始或选择本场面试录音');
    check();this.state.triggerStatus='syncing';this.state.triggerError='';this.notify(true);
    try{
      const recording=this.state.phase!=='paused',connection=this.connection;
      if(recording&&(!this.state.connected||!connection?.ready||connection.ws.readyState!==WebSocket.OPEN))throw new Error('音频连接未恢复，请等待同步完成后再回答');
      if(recording)await this.flushCapture();check();
      await this.waitFrames();await spool.serial;check();
      const waiting=Array.from(spool.pending.keys()),deadline=Date.now()+5000;
      while(waiting.some(key=>spool.pending.has(key))){
        if(recording&&(!this.state.connected||this.connection!==connection||connection.ws.readyState!==WebSocket.OPEN))throw new Error('音频连接中断，请等待同步后再回答');
        if(Date.now()>deadline)throw new Error('音频尚未同步完成，请等待重连或补传后再回答');
        await new Promise(resolve=>setTimeout(resolve,20));check();
      }
      if(recording&&this.connection!==connection)throw new Error('音频连接已变化，请等待同步后再回答');
      if(!['ready','recording','paused'].includes(this.state.phase))throw new Error('本场录音正在停止，回答触发已取消');
      this.state.triggerStatus='submitting';this.notify(true);
      const result=await this.api(owner,`/interviews/${this.state.interview.id}/trigger`,{method:'POST',body:{requestId:crypto.randomUUID()}});check();
      const observed=this.answerStates.get(result.answer?.id);this.state.triggerStatus=observed?.status||result.answer?.status||'queued';this.state.triggerError=observed?.error||'';this.state.triggerAnswerId=result.answer?.id||null;this.lastTriggerAt=Date.now();this.lastTriggerResult=result;this.notify(true);return result;
    }catch(error){if(this.valid(owner,generation)&&revision===this.triggerRevision){this.state.triggerStatus='failed';this.state.triggerError=error.message;this.notify(true);}throw error;}
  }
  markStopped(token){if(this.stopWaiter&&this.stopWaiter.token===token)this.stopWaiter.resolve();}
  async stopCapture(){
    if(!this.token)return;if(this.stopWaiter?.token===this.token)return this.stopWaiter.promise;
    const token=this.token;let finish;
    const promise=new Promise(resolve=>{finish=resolve;});
    const timer=setTimeout(()=>{if(this.stopWaiter?.token===token){this.state.error='采音停止确认超时，部分尾音可能未保存，请检查录音设备';this.stopWaiter.resolve();}},1500);
    this.stopWaiter={token,promise,resolve:()=>{clearTimeout(timer);this.acceptingTailToken=null;this.stopWaiter=null;finish();}};this.acceptingTailToken=token;
    this.emit('audio.capture.stop',{token});return promise;
  }
  async openSocket(mode,spool,owner,generation) {
    const ticket=await this.api(owner,`/interviews/${spool.id}/audio-ticket`,{method:'POST',body:{mode}});this.check(owner,generation);
    const url=new URL(ticket.path||`/audio?ticket=${encodeURIComponent(ticket.ticket)}`,owner.cloudUrl);const origin=new URL(owner.cloudUrl);
    if(url.origin!==origin.origin||url.pathname!=='/audio')throw new Error('服务器返回的音频连接地址无效');url.protocol=url.protocol==='https:'?'wss:':'ws:';
    const ws=new WebSocket(url,{maxPayload:256*1024,handshakeTimeout:15000,followRedirects:false});
    const conn={ws,mode,spool,owner,generation,ready:false,stopping:false,sent:new Set(),stopResolve:null};
    if(mode==='live')this.connection=conn;else this.replayConnections.add(conn);
    await new Promise((resolve,reject)=>{
      let settled=false;const timeout=setTimeout(()=>finish(new Error('语音识别启动超时，请检查服务器配置和网络')),20000);
      const finish=error=>{if(settled)return;settled=true;clearTimeout(timeout);if(error){ws.terminate();reject(error);}else resolve();};
      ws.on('open',()=>{if(!this.valid(owner,generation)){finish(new Error('设备配对已变化'));return;}ws.send(JSON.stringify({type:'audio.start',sampleRate:16000,format:'pcm_s16le',tracks:['remote','self']}));});
      ws.on('message',(data,binary)=>{
        if(binary||!this.valid(owner,generation))return;
        let message;try{message=JSON.parse(data.toString());}catch{return;}
        if(message.type==='audio.ready'){
          conn.ready=true;if(mode==='live'){this.state.connected=true;this.state.error='';this.reconnectAttempt=0;this.notify(true);}finish();
        }else if(message.type==='audio.ack'){
          const track=message.track===0?'remote':message.track===1?'self':message.track;
          void spool.ack(track,message.seq).then(()=>{if(this.valid(owner,generation))this.notify();}).catch(error=>{if(!this.valid(owner,generation))return;if(mode==='live')this.fail(error);else{this.state.error='历史音频缓存写入失败：'+error.message;this.notify(true);ws.close();}});
        }else if(message.type==='audio.stopped'){conn.stopResolve?.();}
        else if(message.type==='audio.error'||message.type==='error'){
          const error=new Error(typeof message.error==='string'?message.error:message.message||'云端语音识别中断');
          if(!conn.ready)finish(error);else{this.state.error=error.message;this.notify(true);ws.close();}
        }
      });
      ws.on('error',()=>{if(!settled)finish(new Error('无法连接云端语音识别服务'));});
      ws.on('close',(code)=>{
        conn.stopResolve?.();this.replayConnections.delete(conn);
        if(!settled)finish(new Error('语音识别连接提前关闭，请检查云端配置'));
        if(mode==='live'&&this.connection===conn){this.connection=null;this.state.connected=false;
          if(this.valid(owner,generation)&&!conn.stopping&&['recording','ready'].includes(this.state.phase)){
            this.state.error=code===1008?'录音连接被服务端拒绝，请检查设备权限和会话状态':'音频网络连接中断，正在本地缓存并重连';this.notify(true);this.scheduleReconnect();
          }
        }
      });
    });return conn;
  }
  scheduleReconnect(){
    clearTimeout(this.reconnectTimer);if(!this.owner||!this.spool||this.closed)return;
    this.reconnectTimer=setTimeout(async()=>{
      if(!this.valid()||!['recording','ready'].includes(this.state.phase))return;
      try{const conn=await this.openSocket('live',this.spool,this.owner,this.generation);if(conn.ready)void this.recover(this.spool.id).catch(error=>{this.state.error='实时连接已恢复，历史补传失败：'+error.message;this.notify(true);});}
      catch(error){if(!this.valid())return;if(error.status===401||error.status===403){this.onUnauthorized?.();return;}this.state.error=error.message;this.notify(true);this.scheduleReconnect();}
    },Math.min(15000,1000*2**Math.min(this.reconnectAttempt++,4)));this.reconnectTimer.unref();
  }
  ingest(input){const pending=this.ingestFrame(input);this.inflightFrames.add(pending);void pending.finally(()=>this.inflightFrames.delete(pending)).catch(()=>{});return pending;}
  async waitFrames(){await Promise.allSettled([...this.inflightFrames]);}
  async ingestFrame({token,track,startMs,samples}) {
    const generation=this.generation,owner=this.owner,spool=this.spool;
    if(token!==this.token||!spool||!this.valid(owner,generation)||!(['ready','recording'].includes(this.state.phase)||this.state.phase==='stopping'&&token===this.acceptingTailToken))return;
    if(++this.pendingWrites>50){this.pendingWrites--;throw new Error('音频缓存写入跟不上采集速度，请停止录音后检查磁盘');}
    try {
      const limit=(this.state.config?.maxSessionMinutes||120)*60000+10000;
      if(!Number.isFinite(startMs)||startMs<0||startMs>limit)throw new Error('录音时间超过会话上限，请结束本场面试');
      const record=await spool.append({track,startMs,samples});if(!this.valid(owner,generation))return;
      const conn=this.connection;
      if(conn?.ready&&conn.ws.readyState===WebSocket.OPEN&&conn.ws.bufferedAmount<512*1024){const frame=await spool.read(record);if(this.valid(owner,generation)&&this.connection===conn)conn.ws.send(frame);}
      this.notify();
    } finally{this.pendingWrites--;}
  }
  async drain(conn=this.connection){
    if(!conn)return;conn.stopping=true;
    if(conn.ws.readyState===WebSocket.OPEN){await new Promise(resolve=>{const timer=setTimeout(resolve,10000);conn.stopResolve=()=>{clearTimeout(timer);resolve();};conn.ws.send(JSON.stringify({type:'audio.stop'}));});}
    conn.ws.close();if(this.connection===conn){this.connection=null;this.state.connected=false;}
  }
  async pause(){
    if(!this.state.interview||!this.owner)return this.view();const owner=this.owner,generation=this.generation;
    this.invalidateTrigger();
    this.state.phase='stopping';this.state.recording=false;clearTimeout(this.reconnectTimer);this.notify(true);
    await this.stopCapture();this.check(owner,generation);await this.waitFrames();await this.spool?.serial;await this.drain();this.check(owner,generation);
    const {interview}=await this.api(owner,`/interviews/${this.state.interview.id}/pause`,{method:'POST',body:{}});this.check(owner,generation);
    this.state.interview=interview;this.state.phase='paused';await this.spool.status('paused');this.notify(true);return this.view();
  }
  async resume(input={}){
    if(!this.state.interview||!this.owner||!this.spool)throw new Error('没有可继续的录音会话');const owner=this.owner,generation=this.generation;
    this.invalidateTrigger();
    try{
    const {interview}=await this.api(owner,`/interviews/${this.state.interview.id}/resume`,{method:'POST',body:{}});this.check(owner,generation);this.state.interview=interview;this.token=crypto.randomUUID();this.state.phase='connecting';this.notify(true);
    await this.openSocket('live',this.spool,owner,generation);this.check(owner,generation);this.state.phase='ready';this.notify(true);void this.recover(this.spool.id).catch(()=>{});return this.control(input.microphoneId);
    }catch(error){await this.connectionFailed(error,owner,generation,'paused',this.state.interview?.id);throw error;}
  }
  async end(){
    if(!this.state.interview||!this.owner)return this.view();const owner=this.owner,generation=this.generation;
    this.invalidateTrigger();
    this.state.phase='stopping';this.state.recording=false;clearTimeout(this.reconnectTimer);this.notify(true);
    await this.stopCapture();this.check(owner,generation);await this.waitFrames();await this.spool?.serial;await this.drain();this.check(owner,generation);
    const {interview}=await this.api(owner,`/interviews/${this.state.interview.id}/end`,{method:'POST',body:{}});this.check(owner,generation);
    this.state.interview=interview;this.state.phase='ended';this.token=null;await this.spool.status('ended');
    if(!this.spool.pendingCount){await this.spool.remove();this.spool=null;this.state.pending=0;this.state.bytes=0;}
    this.notify(true);await this.refresh();return this.view();
  }
  async captureFailed({token,error}){if(token!==this.token)return;this.state.error=String(error||'采音中断，请检查麦克风和系统声音').slice(0,300);try{await this.pause();}catch{}this.state.error=String(error||'采音中断，请检查设备');this.state.recording=false;this.notify(true);}
  fail(error){this.state.error=error.message||String(error);this.notify(true);this.emit('audio.capture.stop',{token:this.token});void this.pause().catch(()=>{});}
  async recover(id){
    validateSessionId(id);if(this.replaying.has(id))return this.view();const owner=this.getOwner(),generation=this.generation;if(!owner)throw new Error('请先配对设备');
    const spool=this.spool?.id===id?this.spool:await AudioSpool.open(this.root,id);if(!spool.matchesOwner(owner))throw new Error('录音缓存不属于当前配对');
    this.replaying.add(id);this.state.recoveringId=id;this.notify(true);let conn=null;
    try {
      const records=spool.pendingRecords().slice().sort((a,b)=>a.startMs-b.startMs||a.offset-b.offset);let lastMs=null;
      for(const record of records){this.check(owner,generation);
        if(!conn||lastMs!==null&&record.startMs-lastMs>500){if(conn)await this.drain(conn);conn=await this.openSocket('replay',spool,owner,generation);lastMs=null;}
        if(lastMs!==null){const delay=Math.max(0,Math.min(200,record.startMs-lastMs));if(delay)await new Promise(r=>setTimeout(r,delay));}
        while(conn.ws.bufferedAmount>256*1024){await new Promise(r=>setTimeout(r,30));this.check(owner,generation);if(conn.ws.readyState!==WebSocket.OPEN)throw new Error('历史音频补传连接中断');}
        if(conn.ws.readyState!==WebSocket.OPEN)throw new Error('历史音频补传连接中断');conn.ws.send(await spool.read(record,true));lastMs=record.startMs;
      }
      if(conn)await this.drain(conn);await spool.serial;this.check(owner,generation);
      if(spool.meta.status==='ended'&&!spool.pendingCount){await spool.remove();if(this.spool===spool)this.spool=null;}
      this.state.error='';return this.view();
    } finally{if(conn&&conn.ws.readyState!==WebSocket.CLOSED){conn.stopping=true;conn.ws.terminate();}this.replaying.delete(id);if(this.valid(owner,generation)){this.state.recoveringId=null;this.notify(true);void this.refresh().catch(()=>{});}}
  }
  async discard(id){validateSessionId(id);if(this.spool?.id===id&&!['ended','idle','error'].includes(this.state.phase))throw new Error('请先结束当前录音');const spool=await AudioSpool.open(this.root,id);if(!spool.matchesOwner(this.getOwner()))throw new Error('此录音不属于当前设备');await spool.remove();await this.refresh();return this.view();}
  async exportWav(id,directory){
    validateSessionId(id);const owner=this.getOwner(),generation=this.generation;
    const spool=this.spool?.id===id?this.spool:await AudioSpool.open(this.root,id);
    if(!spool.matchesOwner(owner))throw new Error('录音缓存不属于当前配对');this.check(owner,generation);
    const destination=path.resolve(directory);if(!(await fs.stat(destination)).isDirectory())throw new Error('请选择一个本机文件夹');
    await spool.serial;const records=spool.records.slice(),files=[];
    try{
      for(const track of ['remote','self']){
        const trackRecords=records.filter(record=>record.track===track).sort((a,b)=>a.startMs-b.startMs||a.seq-b.seq);
        const totalSamples=trackRecords.reduce((end,record)=>Math.max(end,Math.round(record.startMs*16)+(record.length-16)/2),0);
        if(totalSamples>16000*60*130)throw new Error('录音时长超过导出上限');
        const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+totalSamples*2,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(totalSamples*2,40);
        const file=path.join(destination,`DualLink-${id}-${track}.wav`),handle=await fs.open(file,'wx',0o600);files.push(file);
        try{await handle.writeFile(header);let sampleAt=0;const silence=Buffer.alloc(32768);
          for(const record of trackRecords){this.check(owner,generation);const start=Math.round(record.startMs*16);let gap=Math.max(0,start-sampleAt)*2;
            while(gap){const count=Math.min(gap,silence.length);await handle.write(silence,0,count);gap-=count;sampleAt+=count/2;this.check(owner,generation);}
            const frame=await spool.read(record),skip=Math.max(0,sampleAt-start)*2,pcm=frame.subarray(16+skip);if(pcm.length){await handle.writeFile(pcm);sampleAt+=pcm.length/2;}
          }
        }finally{await handle.close();}
      }
      this.check(owner,generation);const indexPath=path.join(destination,`DualLink-${id}-index.json`);
      await fs.writeFile(indexPath,JSON.stringify({sessionId:id,title:spool.meta.title,startedAt:spool.meta.startedAt,sampleRate:16000,format:'pcm_s16le',note:'两路WAV以本场面试时间轴对齐，暂停和未采集区间为静音。',frames:records.map(({track,seq,startMs,length})=>({track,seq,startMs,samples:(length-16)/2}))},null,2),{flag:'wx',mode:0o600});files.push(indexPath);return {files};
    }catch(error){for(const file of files)await fs.unlink(file).catch(()=>{});throw error;}
  }
  receive(event){
    if(event.type==='interview.answer'&&event.sessionId===this.state.interview?.id&&event.answer?.id){this.answerStates.set(event.answer.id,event.answer);if(this.answerStates.size>50)this.answerStates.delete(this.answerStates.keys().next().value);if(event.answer.id===this.state.triggerAnswerId){this.state.triggerStatus=event.answer.status;this.state.triggerError=event.answer.error||'';this.notify(true);}}
    if(event.type==='interview.updated'&&event.interview?.id===this.state.interview?.id){if(['mode','provider','transcribe','audioModel','audioWindowSeconds','promptId','autoAnswer','status'].some(key=>this.state.interview[key]!==event.interview[key]))this.invalidateTrigger();this.state.interview=event.interview;if(['paused','ended'].includes(event.interview.status)&&['recording','ready','connecting'].includes(this.state.phase))void this.externalStop(event.interview.status).catch(error=>{if(this.valid()){this.state.error=error.message;this.notify(true);}});}
    if(event.type==='interview.audio.status'&&event.sessionId===this.state.interview?.id&&(event.error||event.gap)){this.state.error=String(event.error||'音频中断，转写记录中已标记缺口');this.notify(true);}
  }
  async externalStop(status){
    this.invalidateTrigger();
    const owner=this.owner,generation=this.generation,spool=this.spool;this.state.phase='stopping';this.state.recording=false;clearTimeout(this.reconnectTimer);
    // The remote endpoint may already have stopped ASR. Preserve flushed tails for timestamped replay.
    if(this.connection){this.connection.stopping=true;this.connection.ws.close();this.connection=null;}this.state.connected=false;this.notify(true);
    await this.stopCapture();this.check(owner,generation);await this.waitFrames();await spool?.serial;if(spool)await spool.status(status);this.check(owner,generation);
    this.state.phase=status;if(status==='ended'){this.token=null;if(spool&&!spool.pendingCount){await spool.remove();if(this.spool===spool)this.spool=null;}}
    this.notify(true);await this.refresh();
  }
  async reset({removeLocal=false}={}){
    const oldOwner=this.owner||this.getOwner();++this.generation;this.flushWaiter?.reject(new Error('设备配对已变化，回答已取消'));this.invalidateTrigger();this.stopWaiter?.resolve();this.acceptingTailToken=null;this.emit('audio.capture.stop',{token:this.token});clearTimeout(this.reconnectTimer);
    if(this.connection){this.connection.stopping=true;this.connection.ws.terminate();this.connection=null;}
    for(const conn of this.replayConnections){conn.stopping=true;conn.ws.terminate();}this.replayConnections.clear();this.replaying.clear();
    await this.waitFrames();await this.spool?.serial;
    if(removeLocal&&oldOwner){for(const spool of await AudioSpool.list(this.root,oldOwner))await spool.remove();}
    this.spool=null;this.owner=null;this.token=null;this.answerStates.clear();this.state={phase:'idle',connected:false,interview:null,error:'',recoveries:[],interviews:[],config:null,pending:0,bytes:0,recording:false};this.notify(true);
  }
  async shutdown(){await this.reset();this.closed=true;}
}
module.exports={AudioController};
