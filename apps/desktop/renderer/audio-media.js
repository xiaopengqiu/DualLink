'use strict';
(function(){
  let active=null,generation=0,stopping=null;
  const stopStream=stream=>{for(const track of stream?.getTracks()||[])track.stop();};
  function stop(){
    if(stopping)return stopping;const recording=active;if(!recording)return Promise.resolve();recording.stopping=true;active=null;++generation;
    stopping=(async()=>{
    navigator.mediaDevices?.removeEventListener('devicechange',recording.onDeviceChange);
    await Promise.all(recording.nodes.map(node=>new Promise(resolve=>{const timeout=setTimeout(resolve,150);node.flushed=()=>{clearTimeout(timeout);resolve();};try{node.port.postMessage({type:'flush'});}catch{clearTimeout(timeout);resolve();}})));
    for(const node of recording.nodes){node.port.onmessage=null;node.disconnect();}
    for(const source of recording.sources)source.disconnect();
    for(const oscillator of recording.oscillators||[])try{oscillator.stop();}catch{}
    stopStream(recording.remote);stopStream(recording.self);
    await recording.context?.close().catch(()=>{});
    recording.onLevel?.('remote',0);recording.onLevel?.('self',0);
    })().finally(()=>{stopping=null;});return stopping;
  }
  async function microphones(requestAccess=false){
    if(!navigator.mediaDevices)throw new Error('当前客户端不能访问音频设备');
    let temporary;
    if(requestAccess){await window.dualLink.audioPrepare();temporary=await navigator.mediaDevices.getUserMedia({audio:true,video:false});}
    try{return (await navigator.mediaDevices.enumerateDevices()).filter(device=>device.kind==='audioinput').map((device,index)=>({id:device.deviceId,name:device.label||`麦克风 ${index+1}`}));}
    finally{stopStream(temporary);}
  }
  async function start(control,{preflight=false,synthetic=false,onLevel,onFailure}={}){
    await stop();const own=++generation;
    const recording={token:control.token,preflight,nodes:[],sources:[],oscillators:[],remote:null,self:null,context:null,stopping:false,onLevel};
    const current=()=>generation===own&&!recording.stopping;
    const fatal=async error=>{if(!current())return;await stop();onFailure?.(error instanceof Error?error:new Error(String(error)));};
    active=recording;
    try{
      if(!synthetic){
        const results=await Promise.allSettled([
          navigator.mediaDevices.getDisplayMedia({video:{frameRate:1},audio:true}),
          navigator.mediaDevices.getUserMedia({audio:{...(control.microphoneId?{deviceId:{exact:control.microphoneId}}:{}),echoCancellation:true,noiseSuppression:true,autoGainControl:false},video:false})
        ]);
        recording.remote=results[0].status==='fulfilled'?results[0].value:null;
        recording.self=results[1].status==='fulfilled'?results[1].value:null;
        if(results.some(result=>result.status==='rejected'))throw new Error('双路采音未能同时启动，请允许麦克风与屏幕音频访问并检查输入设备');
        if(!recording.remote.getAudioTracks().length||!recording.self.getAudioTracks().length)throw new Error('系统声音或麦克风音轨不可用，已停止两路采集');
        if(!current()){stopStream(recording.remote);stopStream(recording.self);return;}
      }else if(!window.dualLink.audioTestFrame)throw new Error('合成音频仅允许自动化测试使用');
      const context=new AudioContext();recording.context=context;
      await context.audioWorklet.addModule(new URL('./audio-worklet.mjs',location.href).href);
      if(!current()){await context.close();stopStream(recording.remote);stopStream(recording.self);return;}
      for(const track of ['remote','self']){
        const node=new AudioWorkletNode(context,'dual-link-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],processorOptions:{track,baseMs:Math.max(0,Date.now()-control.epochMs)}});
        recording.nodes.push(node);
        node.onprocessorerror=()=>void fatal(new Error('音频处理器中断，请暂停后重新预检设备'));
        node.port.onmessage=event=>{
          if(event.data?.type==='flushed'){node.flushed?.();return;}
          if(!current()&&!recording.stopping)return;
          if(event.data?.type==='level')onLevel?.(track,event.data.level);
          else if(event.data?.type==='pcm'&&!preflight)window.dualLink.audioFrame({token:control.token,track,startMs:event.data.startMs,samples:event.data.samples});
        };
        let source;
        if(synthetic){source=context.createOscillator();source.frequency.value=track==='remote'?440:660;recording.oscillators.push(source);source.start();}
        else source=context.createMediaStreamSource(recording[track==='remote'?'remote':'self']);
        recording.sources.push(source);source.connect(node);node.connect(context.destination);
      }
      for(const track of [...recording.remote?.getTracks()||[],...recording.self?.getTracks()||[]])track.addEventListener('ended',()=>{if(!recording.stopping)void fatal(new Error('音频设备或系统共享已停止，请检查设备后继续'));},{once:true});
      recording.onDeviceChange=async()=>{
        if(!current()||synthetic)return;
        try{const input=recording.self?.getAudioTracks()[0]?.getSettings().deviceId;if(input&&!(await navigator.mediaDevices.enumerateDevices()).some(device=>device.kind==='audioinput'&&device.deviceId===input))void fatal(new Error('当前麦克风已断开，请重新选择设备后继续'));}catch{void fatal(new Error('无法检查音频设备，请重新预检'));}
      };
      navigator.mediaDevices?.addEventListener('devicechange',recording.onDeviceChange);
      await context.resume();
      if(!current())return;
      if(!preflight)await window.dualLink.audioCaptureStarted(control.token);
      return {sampleRate:context.sampleRate,tracks:['remote','self']};
    }catch(error){if(active===recording)await stop();else{stopStream(recording.remote);stopStream(recording.self);await recording.context?.close().catch(()=>{});}throw error;}
  }
  window.DualAudioMedia={microphones,start,stop,isActive:()=>!!active,isPreflight:()=>!!active?.preflight,token:()=>active?.token};
  window.dualLink.onAudioStop(({token})=>{if(!token||active?.token===token||!active)void stop().finally(()=>window.dualLink.audioCaptureStopped(token)).catch(()=>{});});
  window.addEventListener('beforeunload',()=>{void stop();});
})();
