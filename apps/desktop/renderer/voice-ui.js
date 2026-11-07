'use strict';
(function(){
  const ui=id=>document.getElementById(id),api=window.dualLink,media=window.DualAudioMedia;
  let latest=null,preflight=false,preflightTimer,busy=false,lastDevice=null,captionSession=null,selectedDirty=false;
  const labels={idle:'尚未开始',connecting:'连接识别服务…',ready:'准备采音',recording:'正在录音',stopping:'保存尾句中…',paused:'已暂停',ended:'已结束并保存',error:'录音未启动'};
  function showError(error){ui('voice-error').textContent=String(error?.message||error).replace(/^Error invoking remote method '[^']+': Error: /,'');ui('voice-error').hidden=false;}
  async function action(button,operation){if(busy)return;busy=true;button.disabled=true;ui('voice-error').hidden=true;try{return await operation();}catch(error){showError(error);}finally{busy=false;if(latest)render(latest);}}
  function level(track,value){const safe=Math.max(0,Math.min(1,Number(value)||0));ui('voice-level-'+track).value=safe;ui('voice-'+track+'-percent').textContent=Math.round(safe*100)+'%';}
  async function stopPreflight(){clearTimeout(preflightTimer);await media.stop();preflight=false;ui('voice-preflight-stop').hidden=true;ui('voice-preflight').hidden=false;ui('voice-recording-indicator').hidden=!latest?.audio?.recording;level('remote',0);level('self',0);}
  async function startCapture(control){
    try{await media.start(control,{onLevel:level,onFailure:error=>{showError(error);void api.audioCaptureFailed({token:control.token,error:error.message});}});}
    catch(error){await api.audioCaptureFailed({token:control.token,error:error.message}).catch(()=>{});throw error;}
  }
  function formatTime(milliseconds){const seconds=Math.max(0,Math.floor(milliseconds/1000));return seconds>=3600?`${Math.floor(seconds/3600)}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`:`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
  function render(state){
    latest=state;const audio=state.audio||{phase:'idle',recoveries:[]};const active=['connecting','ready','recording','stopping','paused'].includes(audio.phase);
    ui('voice-status').textContent=preflight?'声音预检中':labels[audio.phase]||audio.phase;ui('voice-status').className='badge '+(audio.recording?'online':active?'waiting':'muted');
    ui('voice-recording-indicator').hidden=!(audio.recording||preflight);
    if(!selectedDirty&&audio.config){const defaults=audio.config.defaults||{};ui('voice-mode').value=defaults.mode||'transcript';ui('voice-provider').value=defaults.provider||audio.config.defaultProvider||'codex';ui('voice-transcribe').checked=defaults.transcribe!==false;ui('voice-audio-window').value=defaults.audioWindowSeconds||120;}
    const selectedSession=(audio.interviews||[]).find(item=>item.id===ui('voice-existing').value);
    const session=active?audio.interview:selectedSession;
    if(session){ui('voice-mode').value=session.mode||'transcript';ui('voice-provider').value=session.provider||'codex';ui('voice-transcribe').checked=session.transcribe!==false;ui('voice-audio-window').value=session.audioWindowSeconds||120;}
    const modelSelect=ui('voice-audio-model'),modelValue=session?.audioModel||(!selectedDirty?audio.config?.defaults?.audioModel:modelSelect.value)||'';
    modelSelect.replaceChildren(new Option('使用服务器默认模型',''));for(const model of audio.config?.audioModels||[])modelSelect.add(new Option(model,model));modelSelect.value=modelValue;
    const native=ui('voice-mode').value==='audio',configured=native?audio.config?.audioConfigured:audio.config?.configured;
    ui('voice-native-options').hidden=!native;ui('voice-text-options').hidden=native;
    ui('voice-config-note').hidden=configured!==false;ui('voice-config-note').textContent=native?'服务端尚未配置百炼音频直答模型，请管理员配置后刷新。':'服务端尚未配置百炼实时语音识别，请管理员配置后刷新。';
    ui('voice-start').hidden=active;ui('voice-start').disabled=busy||!state.paired||configured===false;
    for(const id of ['voice-mode','voice-audio-model','voice-transcribe','voice-audio-window'])ui(id).disabled=active||!!selectedSession;
    const triggerLabels={syncing:'正在同步当前音频…',submitting:'正在提交当前问题…',queued:'已提交，等待生成',running:'正在生成建议',completed:'建议已生成',cancelled:'本次生成已取消',failed:'触发失败，请重试'};
    ui('voice-trigger').disabled=busy||!state.paired||!['recording','ready','paused'].includes(audio.phase)||['syncing','submitting'].includes(audio.triggerStatus);
    ui('voice-trigger-status').textContent=audio.triggerError||triggerLabels[audio.triggerStatus]||(active?'按快捷键或点击按钮生成建议':'开始录音后可触发回答');
    ui('voice-answer-key').textContent=(state.settings?.answerShortcut||'Ctrl+Alt+Enter').replaceAll('+',' + ');

    ui('voice-pause').hidden=!['ready','recording'].includes(audio.phase);ui('voice-pause').disabled=busy;
    ui('voice-resume').hidden=audio.phase!=='paused';ui('voice-resume').disabled=busy;
    ui('voice-end').hidden=!active;ui('voice-end').disabled=busy||['connecting','stopping'].includes(audio.phase);
    for(const id of ['voice-preflight','voice-devices'])ui(id).disabled=busy||!state.paired||active&&audio.phase!=='paused';
    for(const id of ['voice-existing','voice-title','voice-provider','voice-prompt','voice-auto-answer'])ui(id).disabled=active||id==='voice-auto-answer'&&native;
    ui('voice-microphone').disabled=busy||active&&audio.phase!=='paused';
    ui('voice-preflight-stop').disabled=busy;
    ui('voice-backlog').textContent=String(audio.pending||0);ui('voice-cache').textContent=`${((audio.bytes||0)/1024/1024).toFixed(1)} MB`;
    ui('voice-network-note').textContent=audio.connected?'音频已连接云端，字幕会同步到已连接设备':audio.recording?'网络未连接，原始音频正在本机缓存':'尚未建立音频连接';
    ui('voice-network-note').classList.toggle('offline',!!audio.recording&&!audio.connected);
    if(audio.error)showError(audio.error);
    if(captionSession!==audio.interview?.id){captionSession=audio.interview?.id;const noText=audio.interview?.mode==='audio'&&audio.interview.transcribe===false;ui('voice-caption-remote').textContent=noText?'远端音频留档中，后台转写已关闭':'等待面试官发言…';ui('voice-caption-self').textContent=noText?'本人音频留档中，后台转写已关闭':'等待本人发言…';}
    if(!state.paired){selectedDirty=false;ui('voice-error').hidden=true;captionSession=null;}

    const existing=ui('voice-existing'),selected=existing.value;existing.replaceChildren(new Option('新建一场面试',''));
    for(const interview of audio.interviews||[])if(interview.status!=='ended')existing.add(new Option(`${interview.title} · ${interview.status==='paused'?'暂停':'进行中'}`,interview.id));existing.value=selected;
    const prompt=ui('voice-prompt'),selectedPrompt=prompt.value;prompt.replaceChildren(new Option('账号默认风格',''));for(const item of audio.prompts||[])prompt.add(new Option(item.name,item.id));prompt.value=selectedPrompt;
    const recoveries=ui('voice-recovery-list');recoveries.replaceChildren();
    for(const recovery of audio.recoveries||[]){
      const row=document.createElement('div');row.className='voice-recovery-row';const detail=document.createElement('div');const title=document.createElement('strong');title.textContent=recovery.title;const subtitle=document.createElement('small');subtitle.textContent=`${recovery.pending} 个待传分块 · ${(recovery.bytes/1024/1024).toFixed(1)} MB`;detail.append(title,subtitle);row.append(detail);
      for(const [label,method]of [['补传','audioRecover'],['导出录音','audioExportLocal'],['删除','audioDiscard']]){const button=document.createElement('button');button.className='button subtle';button.textContent=audio.recoveringId===recovery.id&&method==='audioRecover'?'补传中…':label;button.disabled=busy||!!audio.recoveringId;button.addEventListener('click',()=>{if(method==='audioDiscard'&&!confirm('删除本机尚未上传的录音？云端已有记录不会删除。'))return;void action(button,()=>api[method](recovery.id));});row.append(button);}recoveries.append(row);
    }
    if(!(audio.recoveries||[]).length){const empty=document.createElement('div');empty.className='empty-state';empty.textContent='没有待恢复录音';recoveries.append(empty);}
    if(state.paired&&state.device?.id!==lastDevice){lastDevice=state.device?.id;void api.audioRefresh().catch(showError);void loadMicrophones(false).catch(()=>{});}
    if(!state.paired)lastDevice=null;
  }
  async function loadMicrophones(request){const devices=await media.microphones(request);const selector=ui('voice-microphone'),value=selector.value;selector.replaceChildren(new Option('系统默认麦克风',''));for(const device of devices)selector.add(new Option(device.name,device.id));selector.value=value;}
  for(const id of ['voice-provider','voice-mode','voice-audio-model','voice-transcribe','voice-audio-window','voice-existing'])ui(id).addEventListener('change',()=>{selectedDirty=true;if(latest)render(latest);});
  ui('voice-trigger').addEventListener('click',()=>void action(ui('voice-trigger'),()=>api.audioTrigger()));
  ui('voice-refresh').addEventListener('click',()=>void action(ui('voice-refresh'),()=>api.audioRefresh()));
  ui('voice-devices').addEventListener('click',()=>void action(ui('voice-devices'),()=>loadMicrophones(true)));
  ui('voice-preflight').addEventListener('click',()=>void action(ui('voice-preflight'),async()=>{
    await api.audioPrepare();await stopPreflight();preflight=true;
    try{await media.start({token:'preflight-'+crypto.randomUUID(),epochMs:Date.now(),microphoneId:ui('voice-microphone').value},{preflight:true,onLevel:level,onFailure:error=>{showError(error);void stopPreflight();}});}catch(error){preflight=false;throw error;}
    ui('voice-preflight').hidden=true;ui('voice-preflight-stop').hidden=false;ui('voice-recording-indicator').hidden=false;ui('voice-preflight-result').textContent='请依次播放会议声音并说话，确认两路都有电平。';preflightTimer=setTimeout(()=>void stopPreflight(),15000);
  }));
  ui('voice-preflight-stop').addEventListener('click',()=>void stopPreflight());
  ui('voice-start').addEventListener('click',()=>void action(ui('voice-start'),async()=>{
    await stopPreflight();const control=await api.audioStart({title:ui('voice-title').value||'面试记录',provider:ui('voice-provider').value,mode:ui('voice-mode').value,audioModel:ui('voice-audio-model').value||undefined,transcribe:ui('voice-transcribe').checked,audioWindowSeconds:Number(ui('voice-audio-window').value),promptId:ui('voice-prompt').value||undefined,sessionId:ui('voice-existing').value||undefined,autoAnswer:ui('voice-auto-answer').checked,microphoneId:ui('voice-microphone').value});await startCapture(control);
  }));
  ui('voice-pause').addEventListener('click',()=>void action(ui('voice-pause'),async()=>{await media.stop();return api.audioPause();}));
  ui('voice-resume').addEventListener('click',()=>void action(ui('voice-resume'),async()=>{await stopPreflight();const control=await api.audioResume({microphoneId:ui('voice-microphone').value});await startCapture(control);}));
  ui('voice-end').addEventListener('click',()=>void action(ui('voice-end'),async()=>{await stopPreflight();return api.audioEnd();}));
  api.onState(render);api.onNetwork(event=>{if(event.type==='interview.segment'&&event.sessionId===captionSession&&['remote','self'].includes(event.segment?.track)){const text=ui('voice-caption-'+event.segment.track);text.textContent=event.segment.text||'';text.classList.toggle('partial',!event.segment.final);}});
  api.onAudioStop(()=>{if(media.isPreflight())void media.stop();preflight=false;clearTimeout(preflightTimer);ui('voice-preflight-stop').hidden=true;ui('voice-preflight').hidden=false;});
  setInterval(()=>{ui('voice-time').textContent=latest?.audio?.epochMs?formatTime(Date.now()-latest.audio.epochMs):'00:00';},1000);
  void api.getState().then(render).catch(showError);
})();
