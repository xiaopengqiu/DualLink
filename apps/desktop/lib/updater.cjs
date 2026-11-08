'use strict';
const fs=require('node:fs/promises');
const {createReadStream}=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');

const REPOSITORY='https://github.com/xiaopengqiu/DualLink';
const API='https://api.github.com/repos/xiaopengqiu/DualLink/releases/latest';
const METADATA_LIMIT=1024*1024;
const BINARY_LIMIT=512*1024*1024;
const versionPattern=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const redirectHosts=new Set(['release-assets.githubusercontent.com','objects.githubusercontent.com']);
function problem(message,code='UPDATE_FAILED'){return Object.assign(new Error(message),{code});}
function versionParts(version){if(typeof version!=='string'||!versionPattern.test(version))throw problem('更新版本号无效');const parts=version.split('.').map(Number);if(parts.some(x=>!Number.isSafeInteger(x)))throw problem('更新版本号无效');return parts;}
function compareVersions(a,b){const x=versionParts(a),y=versionParts(b);for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]>y[i]?1:-1;}return 0;}
function assetUrl(url,version,name){
 let parsed;try{parsed=new URL(url);}catch{throw problem('更新下载地址无效');}
 const expected=`${REPOSITORY}/releases/download/v${version}/${name}`;
 if(parsed.href!==expected)throw problem('更新下载地址不属于官方发布仓库');
 return parsed.href;
}
function checksum(body,name){
 const found=[];
 for(const line of body.split(/\r?\n/)){const match=/^([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)$/.exec(line);if(match&&match[2]===name)found.push(match[1].toLowerCase());}
 if(found.length!==1)throw problem('更新包缺少唯一有效的 SHA256 校验值');
 return found[0];
}
async function boundedBody(response,max,signal){
 const declared=Number(response.headers?.get('content-length'));
 if(Number.isFinite(declared)&&declared>max)throw problem('更新信息超过大小限制');
 let size=0;const chunks=[];
 if(!response.body)throw problem('更新服务未返回内容');
 for await(const chunk of response.body){if(signal.aborted)throw signal.reason;size+=chunk.length;if(size>max)throw problem('更新信息超过大小限制');chunks.push(Buffer.from(chunk));}
 return Buffer.concat(chunks).toString('utf8');
}
async function hashFile(filePath,expectedSize){
 const stat=await fs.lstat(filePath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==expectedSize)throw problem('更新包大小发生变化，请重新下载');
 const hash=createHash('sha256');for await(const chunk of createReadStream(filePath))hash.update(chunk);return hash.digest('hex');
}

class UpdateController{
 constructor(options={}){
  versionParts(options.currentVersion);
  if(!['installed','portable'].includes(options.kind))throw new Error('Invalid update package kind');
  if(typeof options.cacheDir!=='string'||!options.cacheDir)throw new Error('Missing updater cache directory');
  this.currentVersion=options.currentVersion;this.kind=options.kind;this.cacheDir=path.resolve(options.cacheDir);
  this.fetchImpl=options.fetchImpl||globalThis.fetch;this.onChange=options.onChange||(()=>{});this.getBusyReason=options.getBusyReason||(()=> '');this.installer=options.install;
  this.disposed=false;this.release=null;this.downloaded=null;this.operation=null;this.abortController=null;
  this.state={currentVersion:this.currentVersion,latestVersion:null,phase:'idle',progress:0,downloadedBytes:0,totalBytes:0,error:'',releaseUrl:REPOSITORY+'/releases',notes:'',kind:this.kind};
 }
 view(){
  let blockedReason='';try{blockedReason=String(this.getBusyReason()||'').slice(0,300);}catch{blockedReason='暂时无法确认任务状态，请稍后重试';}
  return {...this.state,blockedReason,canInstall:!this.disposed&&!!this.downloaded&&!this.operation&&this.state.phase==='downloaded'&&!blockedReason};
 }
 publish(changes={}){Object.assign(this.state,changes);if(!this.disposed){try{this.onChange(this.view());}catch{}}}
 perform(action,timeoutMs,operation){
  if(this.disposed)return Promise.reject(problem('更新操作已取消','UPDATE_CANCELLED'));
  if(this.operation)return this.operation.action===action?this.operation.promise:Promise.reject(problem('另一个更新操作尚未完成，请稍后重试','UPDATE_BUSY'));
  const controller=new AbortController();this.abortController=controller;
  const timer=setTimeout(()=>controller.abort(problem('更新连接超时，请检查网络后重试','UPDATE_TIMEOUT')),timeoutMs);timer.unref?.();
  const promise=(async()=>{
   try{return await operation(controller.signal);}
   catch(error){
    const safe=controller.signal.aborted?controller.signal.reason:error?.code?.startsWith('UPDATE_')?error:problem('更新失败，请检查网络或文件权限后重试');
    if(safe.code!=='UPDATE_BUSY')this.publish({phase:'error',error:safe.message});
    throw safe;
   }
   finally{clearTimeout(timer);if(this.abortController===controller)this.abortController=null;}
  })();
  this.operation={action,promise};
  void promise.finally(()=>{if(this.operation?.promise===promise)this.operation=null;if(!this.disposed)this.publish();}).catch(()=>{});
  return promise.then(()=>this.view());
 }
 async request(initialUrl,type,signal){
  let url=initialUrl;
  for(let redirect=0;redirect<=4;redirect++){
   if(signal.aborted)throw signal.reason;
   const parsed=new URL(url);
   if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash||parsed.port)throw problem('拒绝不安全的更新下载地址');
   if(type==='api'){if(parsed.href!==API)throw problem('更新信息来源无效');}
   else if(parsed.hostname==='github.com'){if(parsed.href!==initialUrl)throw problem('更新重定向离开了官方发布文件');}
   else if(!redirectHosts.has(parsed.hostname))throw problem('更新下载地址不受信任');
   const response=await this.fetchImpl(parsed.href,{redirect:'manual',signal,headers:{Accept:type==='api'?'application/vnd.github+json':'application/octet-stream','User-Agent':`DualLink/${this.currentVersion}`}});
   if(response.status>=300&&response.status<400){const location=response.headers.get('location');await response.body?.cancel?.().catch(()=>{});if(!location||redirect===4)throw problem('更新下载重定向异常');url=new URL(location,parsed).href;continue;}
   if(!response.ok){await response.body?.cancel?.().catch(()=>{});throw problem(response.status===403||response.status===429?'更新服务访问受限，请稍后重试':response.status===404?'暂时找不到更新发布，请稍后重试':'更新服务暂时不可用，请稍后重试');}
   return response;
  }
  throw problem('更新下载重定向异常');
 }
 check(){return this.perform('check',30000,async signal=>{
  this.release=null;this.downloaded=null;this.publish({phase:'checking',error:'',progress:0,downloadedBytes:0,totalBytes:0,latestVersion:null,notes:''});
  const response=await this.request(API,'api',signal);const body=await boundedBody(response,METADATA_LIMIT,signal);
  let release;try{release=JSON.parse(body);}catch{throw problem('更新服务返回的信息格式无效');}
  if(!release||typeof release!=='object'||Array.isArray(release))throw problem('更新发布信息无效');
  if(release.draft||release.prerelease){this.publish({phase:'current',error:''});return;}
  const version=typeof release.tag_name==='string'&&release.tag_name.startsWith('v')?release.tag_name.slice(1):release.tag_name;
  versionParts(version);
  if(compareVersions(version,this.currentVersion)<=0){this.publish({phase:'current',latestVersion:version,error:''});return;}
  if(!Array.isArray(release.assets)||release.assets.length>100)throw problem('更新发布文件列表无效');
  const name=`DualLink-${version}-x64-${this.kind==='portable'?'portable':'setup'}.exe`,sumName=`SHA256SUMS-${version}.txt`;
  const asset=assetName=>{const matches=release.assets.filter(x=>x?.name===assetName);if(matches.length!==1)throw problem('新版尚未包含完整的升级文件，请稍后重试');return matches[0];};
  const file=asset(name),sum=asset(sumName);
  if(!Number.isSafeInteger(file.size)||file.size<=0||file.size>BINARY_LIMIT)throw problem('更新包大小无效');
  const url=assetUrl(file.browser_download_url,version,name),sumsUrl=assetUrl(sum.browser_download_url,version,sumName);
  const manifest=await this.request(sumsUrl,'asset',signal);const digest=checksum(await boundedBody(manifest,128*1024,signal),name);
  this.release={version,name,url,sha256:digest,size:file.size};
  this.publish({phase:'available',latestVersion:version,totalBytes:file.size,notes:typeof release.body==='string'?release.body.slice(0,8000):'',releaseUrl:`${REPOSITORY}/releases/tag/v${version}`,error:''});
 });}
 download(){return this.perform('download',15*60*1000,async signal=>{
  if(!this.release)throw problem('请先检查并选择可用更新');
  const release=this.release;this.downloaded=null;this.publish({phase:'downloading',progress:0,downloadedBytes:0,totalBytes:release.size,error:''});
  await fs.mkdir(this.cacheDir,{recursive:true,mode:0o700});
  const partial=path.join(this.cacheDir,release.name+'.'+randomUUID()+'.part'),destination=path.join(this.cacheDir,release.name);
  let file;try{
   const response=await this.request(release.url,'asset',signal);const contentLength=response.headers.get('content-length');
   if(contentLength!==null&&Number(contentLength)!==release.size)throw problem('更新包大小与发布信息不一致，请重试');
   if(!response.body)throw problem('更新下载未返回文件');
   file=await fs.open(partial,'wx',0o600);const hash=createHash('sha256');let size=0,lastUpdate=0;
   for await(const chunk of response.body){
    if(signal.aborted)throw signal.reason;size+=chunk.length;if(size>release.size||size>BINARY_LIMIT)throw problem('更新包超过声明大小');
    hash.update(chunk);let written=0;while(written<chunk.length){const part=await file.write(chunk,written,chunk.length-written);if(!part.bytesWritten)throw problem('无法完整保存更新文件');written+=part.bytesWritten;}
    if(Date.now()-lastUpdate>100){lastUpdate=Date.now();this.publish({progress:Math.min(99,Math.floor(size/release.size*100)),downloadedBytes:size});}
   }
   if(size!==release.size||hash.digest('hex')!==release.sha256)throw problem('更新包校验失败，未安装，请重新下载');
   await file.sync();await file.close();file=null;if(signal.aborted)throw signal.reason;
   await fs.rename(partial,destination);this.downloaded={...release,filePath:destination};
   this.publish({phase:'downloaded',progress:100,downloadedBytes:size,error:''});
  }finally{await file?.close().catch(()=>{});await fs.unlink(partial).catch(()=>{});}
 });}
 install(){return this.perform('install',120000,async signal=>{
  if(!this.downloaded)throw problem('请先完整下载并校验更新');
  let busy=this.view().blockedReason;if(busy){this.publish({phase:'downloaded',error:busy});throw problem(busy,'UPDATE_BUSY');}
  const downloaded=this.downloaded;
  try{if(await hashFile(downloaded.filePath,downloaded.size)!==downloaded.sha256)throw problem('更新包校验失败，请重新下载');}
  catch(error){this.downloaded=null;await fs.unlink(downloaded.filePath).catch(()=>{});throw error;}
  if(signal.aborted)throw signal.reason;
  busy=this.view().blockedReason;if(busy){this.publish({phase:'downloaded',error:busy});throw problem(busy,'UPDATE_BUSY');}
  if(typeof this.installer!=='function')throw problem('当前环境不支持安装更新');
  this.publish({phase:'installing',error:''});
  await this.installer({filePath:downloaded.filePath,sha256:downloaded.sha256,version:downloaded.version,kind:this.kind});
 });}
 dispose(){this.disposed=true;this.abortController?.abort(problem('更新操作已取消','UPDATE_CANCELLED'));}
}
module.exports={UpdateController,compareVersions};
