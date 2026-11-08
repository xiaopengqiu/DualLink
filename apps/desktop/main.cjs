'use strict';
const {app,BrowserWindow,ipcMain,safeStorage,Tray,Menu,globalShortcut,desktopCapturer,screen,nativeImage,shell,Notification,dialog}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const WebSocket=require('ws');
const QRCode=require('qrcode');
const {DEFAULT_SETTINGS,normalizeCloudUrl,validateSettings,cropRect,screenshotSelection}=require('./lib/core.cjs');
const {CaptureQueue}=require('./lib/queue.cjs');
const {AudioController}=require('./lib/audio-main.cjs');
const {UpdateController}=require('./lib/updater.cjs');
const {prepareUpdateInstall}=require('./lib/update-install.cjs');
const {updateBlockReason}=require('./lib/update-policy.cjs');

const testMode=process.env.DUALLINK_TEST_MODE==='1';
if(process.env.DUALLINK_TEST_USER_DATA)app.setPath('userData',path.resolve(process.env.DUALLINK_TEST_USER_DATA));
if(!app.requestSingleInstanceLock())app.quit();
let win,tray,overlay,queue,credential=null,pendingPair=null,settings={...DEFAULT_SETTINGS,deviceName:os.hostname()};
let quitting=false,capturing=false,uploading=false,socket,reconnectTimer,pairTimer,generation=0,reconnectAttempts=0;
let lastImage=null,recent=[],peerCount=0,audioController,audioPermissionUntil=0,updater,updateTimer,activeActions=0;
const directWaiters=new Map(),lanAttempted=new Set();
const state={connected:false,connecting:false,error:'',secureStorage:false,pairing:null,user:null,device:null,queue:[],lastCapture:null,shortcutsError:''};
const configPath=()=>path.join(app.getPath('userData'),'settings.json');
const emit=(channel,data)=>{if(win&&!win.isDestroyed())win.webContents.send(channel,data);};
function updateView(){return {...(updater?.view()||{phase:'idle',currentVersion:app.getVersion(),kind:process.env.PORTABLE_EXECUTABLE_FILE?'portable':'installed'}),supported:process.platform==='win32'&&app.isPackaged};}
function updateBusyReason(){return updateBlockReason({capturing,uploading,activeActions,queueLength:queue?.items.length||0,audio:audioController?.view()||{}});}
function assertNotInstalling(){if(updater?.view().phase==='installing')throw new Error('正在安装更新，请等待客户端重启');}
function assertUpdateSupported(){if(!updateView().supported)throw new Error('请使用已打包的 Windows 客户端进行升级');}
function snapshot(){return {...state,settings,paired:!!credential,update:updateView(),queue:queue?.items.map(({captureId,createdAt,attempts,error,name,size,analyze})=>({captureId,createdAt,attempts,error,name,size,analyze}))||[],recent,peerCount,audio:audioController?.view()||{phase:'idle',interview:null,recording:false,recoveries:[]},displays:screen.getAllDisplays().map(d=>({id:String(d.id),name:d.label||`显示器 ${d.id}`,width:Math.round(d.bounds.width*d.scaleFactor),height:Math.round(d.bounds.height*d.scaleFactor),scaleFactor:d.scaleFactor}))};}
function changed(){emit('state',snapshot());updateTray();}
function message(error){state.error=error instanceof Error?error.message:String(error);changed();}
function encryptedStorageAvailable(){return safeStorage.isEncryptionAvailable()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text');}
async function persist(){
  const body={settings};
  if(credential&&encryptedStorageAvailable())body.credential=safeStorage.encryptString(JSON.stringify(credential)).toString('base64');
  const temp=configPath()+'.tmp';await fs.mkdir(app.getPath('userData'),{recursive:true,mode:0o700});await fs.writeFile(temp,JSON.stringify(body),{mode:0o600});await fs.rename(temp,configPath());
}
async function load(){
  state.secureStorage=encryptedStorageAvailable();
  try{const saved=JSON.parse(await fs.readFile(configPath(),'utf8'));settings=validateSettings({...DEFAULT_SETTINGS,...saved.settings});if(saved.credential&&state.secureStorage){const item=JSON.parse(safeStorage.decryptString(Buffer.from(saved.credential,'base64')));if(item.cloudUrl===settings.cloudUrl&&/^[a-f0-9]{64}$/.test(item.secret))credential=item;}}
  catch(e){if(e.code!=='ENOENT')state.error='读取本地设置失败，请重新设置服务地址并配对';}
}
async function api(route,{method='GET',body,secret,timeout=20000,baseUrl=settings.cloudUrl}={}){
  const base=normalizeCloudUrl(baseUrl);const headers={};
  if(secret||credential?.secret)headers.Authorization='Bearer '+(secret||credential.secret);
  if(body&&!(body instanceof FormData)){headers['Content-Type']='application/json';body=JSON.stringify(body);}
  const response=await fetch(base+'/api'+route,{method,headers,body,signal:AbortSignal.timeout(timeout),redirect:'error'});
  const text=await response.text();let result;try{result=JSON.parse(text);}catch{throw new Error('服务未返回有效数据，请确认域名指向双端互联服务');}
  if(!response.ok){const error=new Error(result.error||`请求失败 (${response.status})`);error.status=response.status;throw error;}return result;
}
function trustedWindow(event,kind='main'){
  const target=kind==='overlay'?overlay:win;
  if(!target||event.sender!==target.webContents)throw new Error('拒绝未知页面请求');
  const expected=pathToFileURL(path.join(__dirname,'renderer',kind==='overlay'?'overlay.html':'index.html')).href;
  if(event.senderFrame.url.split('?')[0]!==expected)throw new Error('页面来源无效');
}
function secureWindow(target){
  target.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  target.webContents.on('will-navigate',(event)=>event.preventDefault());
  target.webContents.session.setPermissionRequestHandler((webContents,permission,callback,details)=>{
    const own=webContents===win?.webContents&&webContents.getURL()===pathToFileURL(path.join(__dirname,'renderer','index.html')).href;
    callback(own&&Date.now()<audioPermissionUntil&&((permission==='media'&&(!details.mediaTypes||details.mediaTypes.every(type=>type==='audio')))||permission==='display-capture'));
  });
  target.webContents.session.setPermissionCheckHandler((webContents,permission,_origin,details)=>webContents===win?.webContents&&Date.now()<audioPermissionUntil&&(permission==='display-capture'||permission==='media'&&details?.mediaType==='audio'));
  target.webContents.on('will-attach-webview',event=>event.preventDefault());
}
function showWindow(){if(!win)return;if(win.isMinimized())win.restore();win.show();win.focus();}
function updateTray(){if(!tray)return;tray.setToolTip(`双端互联 · ${state.connected?'已连接':'未连接'}`);tray.setContextMenu(Menu.buildFromTemplate([
  {label:'打开双端互联',click:showWindow},
  {label:`全屏截图  ${settings.fullShortcut}`,enabled:!!credential,click:()=>capture('full').catch(message)},
  {label:`框选截图  ${settings.regionShortcut}`,enabled:!!credential,click:()=>capture('region').catch(message)},
  {label:`回答当前问题  ${settings.answerShortcut}`,enabled:!!credential&&!!audioController?.state.interview,click:()=>audioController.trigger().catch(message)},
  {type:'separator'},{label:state.connected?'云端已连接':'云端未连接',enabled:false},{label:`待上传：${queue?.items.length||0} 张`,enabled:false},
  {type:'separator'},{label:'退出',click:()=>{quitting=true;app.quit();}}
]));}
function bindShortcuts(){
  if(testMode)return;globalShortcut.unregisterAll();state.shortcutsError='';
  for(const [key,mode] of [['fullShortcut','full'],['regionShortcut','region']]){
    try{if(!globalShortcut.register(settings[key],()=>capture(mode).catch(message)))state.shortcutsError+=' '+settings[key]+' 已被占用。';}catch{state.shortcutsError+=' '+settings[key]+' 格式无效。';}
  }
  try{if(!globalShortcut.register(settings.answerShortcut,()=>audioController?.trigger().catch(message)))state.shortcutsError+=' '+settings.answerShortcut+' 已被占用。';}catch{state.shortcutsError+=' '+settings.answerShortcut+' 格式无效。';}
}
function disconnect(){generation++;clearTimeout(reconnectTimer);if(socket){socket.removeAllListeners();socket.close();socket=null;}peerCount=0;state.connected=false;state.connecting=false;emit('network-reset',{});}
async function revoked(){
  audioPermissionUntil=0;await audioController?.reset({removeLocal:true});
  disconnect();clearTimeout(pairTimer);pendingPair=null;credential=null;
  state.device=null;state.user=null;state.screenshotPreferences=null;state.pairing=null;state.lastCapture=null;lastImage=null;recent=[];
  for(const finish of [...directWaiters.values()])finish();directWaiters.clear();lanAttempted.clear();
  if(overlay&&!overlay.isDestroyed())overlay.destroy();
  await queue.clear();await persist();message('设备配对已撤销或账号不可用，请重新配对');
}
function scheduleReconnect(){if(quitting||!credential)return;state.connected=false;state.connecting=false;changed();clearTimeout(reconnectTimer);reconnectTimer=setTimeout(()=>connect().catch(message),Math.min(30000,1000*2**Math.min(reconnectAttempts++,5)));}
async function connect(){
  if(!credential||quitting)return;disconnect();const ownGeneration=generation;state.connecting=true;state.error='';changed();
  try{
    const me=await api('/device/me');if(ownGeneration!==generation)return;state.device=me.device;state.user=me.user;state.screenshotPreferences=me.settings?.screenshotPreferences||null;
    const config=await api('/config');const {ticket}=await api('/ws-ticket',{method:'POST',body:{kind:'desktop'}});if(ownGeneration!==generation)return;
    const url=new URL('/ws',credential.cloudUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('ticket',ticket);
    const ws=new WebSocket(url,{maxPayload:256*1024,handshakeTimeout:15000,followRedirects:false});socket=ws;
    ws.on('open',()=>{if(ownGeneration!==generation)return;state.connected=true;state.connecting=false;state.error='';reconnectAttempts=0;changed();processQueue().catch(message);});
    ws.on('message',raw=>{if(ownGeneration!==generation)return;try{const event=JSON.parse(raw.toString());if(event.type==='ping'){ws.send(JSON.stringify({type:'pong'}));return;}if(event.type==='hello')emit('rtc-config',{iceServers:config.iceServers||[],deviceId:me.device.id});audioController?.receive(event);emit('network-event',event);}catch{}});
    ws.on('error',()=>{if(ownGeneration===generation){state.error='实时连接中断，正在重连';changed();}});
    ws.on('close',(code)=>{if(ownGeneration!==generation)return;emit('network-reset',{});if(code===4001||code===4003){revoked().catch(message);}else scheduleReconnect();});
  }catch(e){if(ownGeneration!==generation)return;if(e.status===401||e.status===403)await revoked();else{state.error=e.message;scheduleReconnect();}}
}
async function beginPairing(input){
  assertNotInstalling();
  if(credential)throw new Error('请先解除当前配对');settings=validateSettings({...settings,cloudUrl:input.cloudUrl,deviceName:input.deviceName});await queue.clear();await persist();clearTimeout(pairTimer);
  const secret=crypto.randomBytes(32).toString('hex');const result=await api('/pairings',{method:'POST',body:{name:settings.deviceName,deviceSecret:secret},secret});
  const link=new URL(settings.cloudUrl);link.searchParams.set('pair',result.code);
  pendingPair={id:result.id,secret,expiresAt:result.expiresAt};state.pairing={...result,link:link.href,qr:await QRCode.toDataURL(link.href,{width:220,margin:1,color:{dark:'#14373B',light:'#FFFFFF'}})};state.error='';changed();pollPairing();return snapshot();
}
async function pollPairing(){
  const attempt=pendingPair;if(!attempt)return;
  try{
    const result=await api('/pairings/'+encodeURIComponent(attempt.id),{secret:attempt.secret});if(pendingPair!==attempt)return;
    if(result.status==='approved'){
      credential={secret:attempt.secret,cloudUrl:settings.cloudUrl,deviceId:result.device.id};pendingPair=null;state.pairing=null;state.device=result.device;await persist();changed();await connect();return;
    }
    if(result.status==='expired'||Date.parse(attempt.expiresAt)<Date.now()){pendingPair=null;state.pairing=null;message('配对码已过期，请重新生成');return;}
  }catch(e){if(pendingPair!==attempt)return;state.error=e.message;changed();if(Date.parse(attempt.expiresAt)<Date.now()){pendingPair=null;state.pairing=null;changed();return;}}
  pairTimer=setTimeout(pollPairing,1800);
}
async function saveSettings(input){
  assertNotInstalling();
  const next=validateSettings({...settings,...input});
  if(credential&&next.cloudUrl!==settings.cloudUrl)throw new Error('切换服务器前请先解除当前配对');
  settings=next;await persist();bindShortcuts();if(!testMode)app.setLoginItemSettings({openAtLogin:settings.autoStart,path:process.env.PORTABLE_EXECUTABLE_FILE||app.getPath('exe')});changed();return snapshot();
}
async function unpair(){
  assertNotInstalling();
  audioPermissionUntil=0;await audioController?.reset({removeLocal:true});
  if(credential)await api('/device/me',{method:'DELETE',timeout:4000}).catch(()=>{});
  clearTimeout(pairTimer);pendingPair=null;disconnect();credential=null;state.pairing=null;state.device=null;state.user=null;state.screenshotPreferences=null;lastImage=null;recent=[];state.lastCapture=null;await queue.clear();await persist();state.error='';changed();return snapshot();
}
async function screenshot(display){
  const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.round(display.bounds.width*display.scaleFactor),height:Math.round(display.bounds.height*display.scaleFactor)},fetchWindowIcons:false});
  const source=sources.find(s=>s.display_id===String(display.id))||(sources.length===1?sources[0]:null);if(!source||source.thumbnail.isEmpty())throw new Error('无法读取选中的显示器，请重新选择显示器');return source.thumbnail;
}
function chooseRegion(image,display){
  return new Promise((resolve,reject)=>{
    let settled=false;const finish=(value,error)=>{if(settled)return;settled=true;ipcMain.removeListener('overlay-result',onResult);const existing=overlay;overlay=null;if(existing&&!existing.isDestroyed())existing.destroy();error?reject(error):resolve(value);};
    overlay=new BrowserWindow({x:display.bounds.x,y:display.bounds.y,width:display.bounds.width,height:display.bounds.height,frame:false,resizable:false,movable:false,alwaysOnTop:true,skipTaskbar:true,show:false,backgroundColor:'#101A21',enableLargerThanScreen:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    secureWindow(overlay);overlay.setMenuBarVisibility(false);
    function onResult(event,rect){try{trustedWindow(event,'overlay');if(!rect){finish(null);return;}finish(image.crop(cropRect(rect,display.bounds,image.getSize())));}catch(e){finish(null,e);}}
    ipcMain.on('overlay-result',onResult);overlay.on('closed',()=>finish(null));
    overlay.once('ready-to-show',()=>{if(!overlay)return;overlay.webContents.send('overlay-image',{dataUrl:image.toDataURL(),width:display.bounds.width,height:display.bounds.height});overlay.show();overlay.focus();});
    overlay.loadFile(path.join(__dirname,'renderer','overlay.html')).catch(e=>finish(null,e));
  });
}
async function capture(mode){
  assertNotInstalling();
  if(!credential)throw new Error('请先完成设备配对');if(capturing)return;capturing=true;const restore=win?.isVisible();
  const captureOwner=credential;
  try{
    if(settings.useAccountModels){try{const result=await api('/model-preferences',{timeout:3000});if(credential===captureOwner)state.screenshotPreferences=result.preferences?.screenshot||null;}catch(error){if(error.status===401||error.status===403)throw error;}}
    if(credential!==captureOwner)return;
    const modelSelection=screenshotSelection(settings,state.screenshotPreferences);
    if(win?.isVisible())win.hide();await new Promise(r=>setTimeout(r,160));
    const display=screen.getAllDisplays().find(d=>String(d.id)===settings.displayId)||screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    let image=await screenshot(display);if(mode==='region')image=await chooseRegion(image,display);if(!image||credential!==captureOwner)return;
    let bytes=image.toPNG(),mime='image/png',extension='png';if(bytes.length>12*1024*1024){bytes=image.toJPEG(88);mime='image/jpeg';extension='jpg';}
    const job=await queue.add(bytes,{deviceId:captureOwner.deviceId,analyze:settings.analyze,...modelSelection,mime,name:`截图 ${new Date().toLocaleString('zh-CN').replace(/[/:]/g,'-')}.${extension}`});
    if(credential!==captureOwner){await queue.complete(job.captureId);return;}
    lastImage=image.toDataURL();state.lastCapture={captureId:job.captureId,createdAt:job.createdAt,width:image.getSize().width,height:image.getSize().height,status:'待上传'};
    recent=[{...state.lastCapture},...recent].slice(0,8);changed();processQueue().catch(message);
  }finally{capturing=false;if(restore)showWindow();}
}
async function tryDirect(job,bytes){
  if(!settings.lanFirst||!peerCount)return false;
  return new Promise(resolve=>{
    const timer=setTimeout(()=>{directWaiters.delete(job.captureId);resolve(false);},2000);
    directWaiters.set(job.captureId,()=>{clearTimeout(timer);directWaiters.delete(job.captureId);resolve(true);});
    emit('capture-direct',{metadata:job,data:bytes.toString('base64')});
  });
}
async function processQueue(){
  if(uploading||!credential||quitting||updater?.view().phase==='installing')return;uploading=true;
  try{
    for(const job of [...queue.items]){
      if(!credential||job.deviceId!==credential.deviceId)continue;if(job.nextAttemptAt>Date.now())continue;
      const owner=credential;
      try{
        const bytes=await queue.read(job.captureId);
        let direct=false;
        if(!lanAttempted.has(job.captureId)){lanAttempted.add(job.captureId);direct=await tryDirect(job,bytes);if(!settings.lanFirst)emit('capture-direct',{metadata:job,data:bytes.toString('base64')});}
        if(credential!==owner)break;
        if(!direct){
          const form=new FormData();form.append('image',new Blob([bytes],{type:job.mime}),job.name);for(const key of ['captureId','deviceId','provider','model','analyze'])if(job[key]!==undefined&&job[key]!==null)form.append(key,String(job[key]));
          await api('/captures',{method:'POST',body:form,timeout:45000});
        }
        await queue.complete(job.captureId);lanAttempted.delete(job.captureId);const item=recent.find(x=>x.captureId===job.captureId);if(item)item.status=direct?'直传完成':'上传完成';if(state.lastCapture?.captureId===job.captureId)state.lastCapture.status=direct?'直传完成':'上传完成';state.error='';changed();
      }catch(e){await queue.fail(job.captureId,e.message);if(e.status===401||e.status===403){await revoked();break;}message(e);}
    }
  }finally{uploading=false;changed();}
}
function registerIpc(){
  const mutations=new Set(['save-settings','start-pairing','unpair','capture','retry-uploads','reconnect','audio-refresh','audio-start','audio-resume','audio-pause','audio-end','audio-recover','audio-discard','audio-export-local']);
  const handle=(channel,fn)=>ipcMain.handle(channel,async(event,...args)=>{trustedWindow(event);if(!mutations.has(channel))return fn(...args);assertNotInstalling();activeActions++;changed();try{return await fn(...args);}finally{activeActions--;changed();}});
  handle('get-state',()=>snapshot());handle('save-settings',saveSettings);handle('start-pairing',beginPairing);handle('unpair',unpair);
  handle('update-check',async()=>{assertUpdateSupported();await updater.check();return updateView();});
  handle('update-download',async()=>{assertUpdateSupported();await updater.download();return updateView();});
  handle('update-install',async()=>{assertUpdateSupported();await updater.install();return updateView();});
  handle('update-upgrade',async()=>{
    assertUpdateSupported();
    if(!['available','downloaded'].includes(updater.view().phase))await updater.check();
    if(updater.view().phase==='current')return updateView();
    if(updater.view().phase!=='downloaded')await updater.download();
    if(!updateBusyReason())await updater.install();
    return updateView();
  });
  handle('capture',mode=>{if(!['full','region'].includes(mode))throw new Error('截图模式无效');return capture(mode);});
  handle('retry-uploads',async()=>{for(const item of queue.items)item.nextAttemptAt=0;await processQueue();return snapshot();});
  handle('last-image',()=>lastImage);
  handle('open-website',()=>shell.openExternal(normalizeCloudUrl(settings.cloudUrl)));
  handle('reconnect',()=>connect());
  handle('audio-status',()=>audioController.view());
  handle('audio-refresh',()=>audioController.refresh());
  handle('audio-prepare',()=>{assertNotInstalling();if(!credential)throw new Error('请先配对设备');audioPermissionUntil=Date.now()+60000;return {allowed:true};});
  handle('audio-trigger',()=>audioController.trigger());
  handle('audio-capture-flushed',input=>audioController.markFlushed(input));
  handle('audio-start',async input=>{assertNotInstalling();audioPermissionUntil=Date.now()+60000;return audioController.start(input||{});});
  handle('audio-capture-started',token=>audioController.markStarted(token));
  handle('audio-capture-stopped',token=>audioController.markStopped(token));
  handle('audio-capture-failed',input=>audioController.captureFailed(input||{}));
  handle('audio-pause',async()=>{audioPermissionUntil=0;return audioController.pause();});
  handle('audio-resume',async input=>{assertNotInstalling();audioPermissionUntil=Date.now()+60000;return audioController.resume(input||{});});
  handle('audio-end',async()=>{audioPermissionUntil=0;return audioController.end();});
  handle('audio-recover',id=>{assertNotInstalling();return audioController.recover(id);});
  handle('audio-discard',id=>audioController.discard(id));
  handle('audio-export-local',async id=>{const selection=await dialog.showOpenDialog(win,{title:'选择本机录音恢复文件的导出目录',properties:['openDirectory','createDirectory']});if(selection.canceled)return null;return audioController.exportWav(id,selection.filePaths[0]);});
  ipcMain.on('audio-frame',(event,input)=>{try{trustedWindow(event);void audioController.ingest(input||{}).catch(error=>audioController.fail(error));}catch{}});
  if(testMode)handle('audio-test-frame',input=>audioController.ingest(input||{}));
  ipcMain.on('signal',(event,input)=>{try{trustedWindow(event);if(!input||typeof input.targetPeerId!=='string'||JSON.stringify(input).length>128*1024)return;if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'signal',targetPeerId:input.targetPeerId,payload:input.payload}));}catch{}});
  ipcMain.on('direct-ack',(event,captureId)=>{try{trustedWindow(event);if(typeof captureId==='string')directWaiters.get(captureId)?.();}catch{}});
  ipcMain.on('peer-count',(event,count)=>{try{trustedWindow(event);if(Number.isInteger(count)&&count>=0&&count<=100){peerCount=count;changed();}}catch{}});
}
app.on('second-instance',showWindow);
app.whenReady().then(async()=>{
  app.setAppUserModelId('cn.duallink.client');await load();queue=new CaptureQueue(path.join(app.getPath('userData'),'pending'));await queue.load();
  audioController=new AudioController({root:path.join(app.getPath('userData'),'audio'),getOwner:()=>credential,api:(owner,route,options={})=>api(route,{...options,secret:owner.secret,baseUrl:owner.cloudUrl}),emit:(channel,data)=>channel==='audio.state'?changed():emit(channel,data),onUnauthorized:()=>revoked().catch(message)});
  const cacheDir=path.join(app.getPath('userData'),'updates');
  updater=new UpdateController({currentVersion:app.getVersion(),kind:process.env.PORTABLE_EXECUTABLE_FILE?'portable':'installed',cacheDir,getBusyReason:updateBusyReason,onChange:()=>changed(),install:async update=>{
    await persist();await queue.pending;
    const blocked=updateBusyReason();if(blocked)throw new Error(blocked);
    await prepareUpdateInstall({...update,cacheDir,portableExecutable:process.env.PORTABLE_EXECUTABLE_FILE,appPid:process.pid,launcherPath:path.join(process.resourcesPath,'update-launcher.exe')});
    quitting=true;app.quit();
  }});
  win=new BrowserWindow({width:1020,height:790,minWidth:820,minHeight:650,title:'双端互联',backgroundColor:'#F4F7F8',icon:path.join(__dirname,'assets','icon.png'),show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  secureWindow(win);win.setMenuBarVisibility(false);win.on('close',event=>{if(!quitting){event.preventDefault();win.hide();}});win.once('ready-to-show',()=>{showWindow();changed();});
  win.webContents.session.setDisplayMediaRequestHandler(async(request,callback)=>{
    if(Date.now()>=audioPermissionUntil||request.frame?.url!==pathToFileURL(path.join(__dirname,'renderer','index.html')).href){callback({});return;}
    try{const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:0,height:0}});if(Date.now()>=audioPermissionUntil||!sources.length){callback({});return;}callback({video:sources[0],audio:'loopback'});}catch{callback({});}
  },{useSystemPicker:false});
  registerIpc();await win.loadFile(path.join(__dirname,'renderer','index.html'));
  tray=new Tray(nativeImage.createFromPath(path.join(__dirname,'assets','icon.png')).resize({width:24,height:24}));tray.on('double-click',showWindow);bindShortcuts();changed();
  if(credential)connect().catch(message);setInterval(()=>processQueue().catch(message),3000).unref();
  if(!testMode&&settings.autoCheckUpdates&&updateView().supported){updateTimer=setTimeout(()=>updater.check().catch(()=>{}),10000);updateTimer.unref();}
  screen.on('display-added',changed);screen.on('display-removed',changed);
}).catch(error=>{console.error('启动失败：',error.message);quitting=true;app.quit();});
app.on('before-quit',()=>{quitting=true;audioPermissionUntil=0;clearTimeout(updateTimer);updater?.dispose();void audioController?.shutdown();disconnect();clearTimeout(pairTimer);globalShortcut.unregisterAll();});
app.on('window-all-closed',()=>{});
