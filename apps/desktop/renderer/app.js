'use strict';
const $=id=>document.getElementById(id),api=window.dualLink;
let current,dirty=false,settingsDirty=false,localError='',rtcConfig={iceServers:[]},peers=new Map();
function text(id,value){$(id).textContent=value??'';}
function error(error){localError=String(error?.message||error).replace(/^Error invoking remote method '[^']+': Error: /,'');$('error').hidden=false;text('error',localError);}
async function action(button,fn){localError='';button.disabled=true;try{return await fn();}catch(e){error(e);}finally{button.disabled=false;if(current)render(current);}}
function render(state){
  current=state;
  window.DualUpdaterUI?.render(state.update);
  if(state.update?.currentVersion)document.querySelector('.version').textContent='WINDOWS CLIENT · V'+state.update.currentVersion;
  const status=state.connected?'云端已连接':state.connecting?'正在连接…':state.paired?'等待重连':'尚未配对';
  text('side-status',status);text('side-user',state.user?.name||state.settings.deviceName);text('connection-badge',state.connected?'● 已连接':state.paired?'连接中':'未配对');
  $('connection-badge').className='badge '+(state.connected?'online':state.paired?'waiting':'muted');$('side-dot').className='dot '+(state.connected?'online':'');
  $('error').hidden=!(state.error||localError);if(state.error||localError)text('error',state.error||localError);$('security-notice').hidden=state.secureStorage;
  $('setup-card').hidden=state.paired;$('connected-card').hidden=!state.paired;
  text('connected-name',state.device?.name||state.settings.deviceName);text('connected-origin',state.settings.cloudUrl);text('connected-account',state.user?`已绑定 ${state.user.name}`:'正在验证设备');
  $('open-web').disabled=!state.settings.cloudUrl;
  if(!dirty){$('cloud-url').value=state.settings.cloudUrl;$('device-name').value=state.settings.deviceName;}
  $('pair-code-area').hidden=!state.pairing;
  if(state.pairing){$('pair-qr').src=state.pairing.qr;text('pair-code',state.pairing.code);text('pair-expiry','有效期至 '+new Date(state.pairing.expiresAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}));text('pair-button','重新生成配对码');}else text('pair-button','生成配对码 →');
  for(const id of ['capture-full','capture-region'])$(id).disabled=!state.paired;
  text('full-key',state.settings.fullShortcut.replaceAll('+',' + '));text('region-key',state.settings.regionShortcut.replaceAll('+',' + '));
  text('pending-count',state.queue.length);text('peer-count',state.peerCount);$('retry').disabled=!state.paired||!state.queue.length;
  text('lan-status',state.peerCount?`${state.peerCount} 个网页已建立直连`:'iPad 连接后可启用同网直传');$('lan-dot').className='dot '+(state.peerCount?'online':'');
  $('preview-last').disabled=!state.lastCapture;
  if(!state.lastCapture){if($('preview-dialog').open)$('preview-dialog').close();$('preview-image').removeAttribute('src');}
  if(!settingsDirty){
    $('answer-shortcut').value=state.settings.answerShortcut||'Ctrl+Alt+Enter';$('full-shortcut').value=state.settings.fullShortcut;$('region-shortcut').value=state.settings.regionShortcut;$('provider').value=state.settings.provider;
    $('use-account-models').checked=state.settings.useAccountModels!==false;$('codex-model').value=state.settings.models?.codex||'';$('claude-model').value=state.settings.models?.claude||'';$('analyze').checked=state.settings.analyze;$('lan-first').checked=state.settings.lanFirst;$('auto-start').checked=state.settings.autoStart;$('auto-check-updates').checked=state.settings.autoCheckUpdates!==false;
    const selector=$('display');selector.replaceChildren();const defaultOption=document.createElement('option');defaultOption.value='';defaultOption.textContent='跟随鼠标所在显示器';selector.append(defaultOption);
    for(const display of state.displays){const option=document.createElement('option');option.value=display.id;option.textContent=`${display.name} · ${display.width} × ${display.height}`;selector.append(option);}selector.value=state.settings.displayId;
  }
  for(const id of ['provider','codex-model','claude-model'])$(id).disabled=$('use-account-models').checked;
  $('shortcut-warning').hidden=!state.shortcutsError;text('shortcut-warning',state.shortcutsError);
  const list=$('recent-list');
  if(state.recent.length){list.replaceChildren();for(const capture of state.recent){const row=document.createElement('div');row.className='recent-item';const icon=document.createElement('span');icon.className='recent-icon';icon.textContent='▧';const meta=document.createElement('div');meta.className='recent-meta';const title=document.createElement('strong');title.textContent=`屏幕截图 · ${capture.width} × ${capture.height}`;const time=document.createElement('small');time.textContent=new Date(capture.createdAt).toLocaleString('zh-CN');meta.append(title,time);const badge=document.createElement('span');badge.className='recent-status';badge.textContent=capture.status;row.append(icon,meta,badge);list.append(row);}}
  else {const empty=document.createElement('div');empty.className='empty-state';const label=document.createElement('p');label.textContent='还没有截图';empty.append(label);list.replaceChildren(empty);}
}
for(const field of ['cloud-url','device-name'])$(field).addEventListener('input',()=>{dirty=true;});
$('pair-form').addEventListener('submit',event=>{event.preventDefault();action($('pair-button'),async()=>{const result=await api.startPairing({cloudUrl:$('cloud-url').value,deviceName:$('device-name').value});dirty=false;render(result);});});
$('open-web').addEventListener('click',()=>api.openWebsite().catch(error));
$('reconnect').addEventListener('click',()=>action($('reconnect'),()=>api.reconnect()));
$('unpair').addEventListener('click',()=>{if(confirm('解除本机配对并清除尚未上传的截图？云端已有内容不会删除。'))action($('unpair'),async()=>{render(await api.unpair());dirty=false;});});
$('capture-full').addEventListener('click',()=>action($('capture-full'),()=>api.capture('full')));
$('capture-region').addEventListener('click',()=>action($('capture-region'),()=>api.capture('region')));
$('retry').addEventListener('click',()=>action($('retry'),()=>api.retryUploads()));
$('preview-last').addEventListener('click',async()=>{const image=await api.lastImage();if(image){$('preview-image').src=image;$('preview-dialog').showModal();}});
$('close-preview').addEventListener('click',()=>$('preview-dialog').close());
$('settings-form').addEventListener('input',()=>{settingsDirty=true;for(const id of ['provider','codex-model','claude-model'])$(id).disabled=$('use-account-models').checked;text('save-feedback','有未保存的修改');});
$('settings-form').addEventListener('submit',event=>{event.preventDefault();const button=event.submitter;action(button,async()=>{const state=await api.saveSettings({displayId:$('display').value,fullShortcut:$('full-shortcut').value,regionShortcut:$('region-shortcut').value,answerShortcut:$('answer-shortcut').value,provider:$('provider').value,useAccountModels:$('use-account-models').checked,models:{codex:$('codex-model').value.trim(),claude:$('claude-model').value.trim()},analyze:$('analyze').checked,lanFirst:$('lan-first').checked,autoStart:$('auto-start').checked,autoCheckUpdates:$('auto-check-updates').checked});settingsDirty=false;render(state);text('save-feedback','✓ 设置已保存');});});
for(const nav of document.querySelectorAll('[data-tab]'))nav.addEventListener('click',()=>{const tab=nav.dataset.tab;for(const section of ['workspace','preferences','voice'])$(section+'-tab').hidden=section!==tab;document.querySelectorAll('[data-tab]').forEach(button=>button.classList.toggle('active',button===nav));window.scrollTo(0,0);text('breadcrumb-page',tab==='voice'?'面试录音':tab==='preferences'?'偏好设置':'连接与截图');text('page-title',tab==='voice'?'让对话，成为连续的思路':tab==='preferences'?'让每一次截图更顺手':'连接你的下一块屏幕');text('page-description',tab==='voice'?'记录面试双方原话，结合前文与知识生成建议。':tab==='preferences'?'配置捕获方式、传输策略和默认模型。':'从电脑捕获内容，在 iPad 上接续思考。');});

function updatePeerCount(){api.peerCount([...peers.values()].filter(p=>p.channel?.readyState==='open').length);}
function removePeer(id){const peer=peers.get(id);if(peer){peers.delete(id);peer.channel?.close();peer.pc.close();updatePeerCount();}}
async function createPeer(id){
  removePeer(id);const pc=new RTCPeerConnection({iceServers:rtcConfig.iceServers||[]});const channel=pc.createDataChannel('dual-link-captures',{ordered:true});channel.binaryType='arraybuffer';
  const peer={pc,channel,chain:Promise.resolve(),candidates:[]};peers.set(id,peer);
  pc.onicecandidate=event=>{if(event.candidate)api.signal(id,{kind:'ice',candidate:event.candidate.toJSON()});};
  pc.onconnectionstatechange=()=>{if(['failed','closed'].includes(pc.connectionState))removePeer(id);};
  channel.onopen=updatePeerCount;channel.onclose=updatePeerCount;
  const offer=await pc.createOffer();await pc.setLocalDescription(offer);api.signal(id,{kind:'offer',sdp:offer.sdp});return peer;
}
async function network(event){
  if(event.type==='hello'){for(const peer of event.peers||[])if(peer.kind==='web')await createPeer(peer.id);}
  if(event.type==='peer.joined'&&event.peer?.kind==='web')await createPeer(event.peer.id);
  if(event.type==='peer.left')removePeer(event.peerId);
  if(event.type==='signal'){
    const id=event.fromPeerId,payload=event.payload;if(!payload)return;
    if(payload.kind==='request'){await createPeer(id);return;}
    const peer=peers.get(id);if(!peer)return;
    if(payload.kind==='answer'){await peer.pc.setRemoteDescription({type:'answer',sdp:payload.sdp});for(const candidate of peer.candidates)await peer.pc.addIceCandidate(candidate);peer.candidates=[];}
    else if(payload.kind==='ice'&&payload.candidate){if(peer.pc.remoteDescription)await peer.pc.addIceCandidate(payload.candidate);else peer.candidates.push(payload.candidate);}
  }
}
api.onState(render);api.onRtcConfig(config=>{rtcConfig=config;});api.onNetwork(event=>network(event).catch(()=>{}));api.onReset(()=>{for(const id of [...peers.keys()])removePeer(id);});
api.onCapture(({metadata,data})=>{
  if(typeof data!=='string'||data.length>17*1024*1024)return;
  const binary=atob(data),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  for(const peer of peers.values())if(peer.channel.readyState==='open')peer.chain=peer.chain.catch(()=>{}).then(()=>DualTransfer.sendCapture(peer.channel,metadata,bytes)).then(()=>api.acknowledge(metadata.captureId)).catch(()=>{});
});
api.getState().then(render).catch(error);
