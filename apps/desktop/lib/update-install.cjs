'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');

const inside=(file,root)=>{const relative=path.relative(root,file);return !!relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
async function digest(file){const {createReadStream}=require('node:fs');const hash=crypto.createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function launch(command,args,spawnImpl=spawn,detached=true){
 return new Promise((resolve,reject)=>{
  let child;try{child=spawnImpl(command,args,{shell:false,windowsHide:true,detached,stdio:'ignore'});}catch(error){reject(new Error('无法启动升级程序：'+error.message));return;}
  child.once('error',error=>reject(new Error('无法启动升级程序：'+error.message)));
  child.once('spawn',()=>{child.unref();resolve(child);});
 });
}

async function prepareUpdateInstall({filePath,sha256,kind,cacheDir,portableExecutable,appPid,launcherPath=path.resolve(__dirname,'../../../.local/update-launcher.exe'),spawnImpl=spawn}){
 if(process.platform!=='win32')throw new Error('当前系统不支持 Windows 客户端升级');
 if(!['installed','portable'].includes(kind))throw new Error('升级包类型无效');
 if(typeof sha256!=='string'||!/^[a-fA-F0-9]{64}$/.test(sha256))throw new Error('升级文件校验值无效');
 if(typeof cacheDir!=='string'||typeof filePath!=='string'||!path.isAbsolute(cacheDir)||!path.isAbsolute(filePath))throw new Error('升级缓存路径无效');
 const cache=await fs.realpath(cacheDir),source=await fs.realpath(filePath);
 if(!inside(source,cache)||path.extname(source).toLowerCase()!=='.exe'||!(await fs.stat(source)).isFile())throw new Error('升级程序必须位于下载缓存目录');
 if(await digest(source)!==sha256.toLowerCase())throw new Error('升级文件校验失败，请重新下载');
 if(kind==='installed'){
  await launch(source,['--updated','/S','--force-run'],spawnImpl);
  return {kind,started:true};
 }
 if(typeof portableExecutable!=='string'||!path.isAbsolute(portableExecutable)||!Number.isSafeInteger(appPid)||appPid<=0)throw new Error('便携版升级目标或进程无效');
 const target=await fs.realpath(portableExecutable),targetDir=await fs.realpath(path.dirname(target));
 if(inside(target,cache)||target===source||path.extname(target).toLowerCase()!=='.exe'||!(await fs.stat(target)).isFile())throw new Error('便携版升级目标不能位于下载缓存目录');
 const nonce=crypto.randomUUID(),work=path.join(cache,'install-'+nonce);await fs.mkdir(work,{mode:0o700});
 const staged=path.join(targetDir,'.duallink-update-'+nonce+'.next.exe'),backup=path.join(targetDir,'.duallink-update-'+nonce+'.previous.exe');
 const configPath=path.join(work,'install.json'),scriptPath=path.join(work,'update-portable.ps1'),readyPath=path.join(work,'ready.json'),statusPath=path.join(work,'status.json'),cancelPath=path.join(work,'cancel.json'),persistentLauncher=path.join(work,'update-launcher.exe');
 let helper;
 // Preparing the new file beside the target verifies directory permissions and disk space
 // before asking the app to quit. A fresh name never overwrites an unrelated file.
 try{
  await fs.copyFile(source,staged,constants.COPYFILE_EXCL);
  if(await digest(staged)!==sha256.toLowerCase())throw new Error('便携版暂存文件校验失败');
  await fs.copyFile(path.join(__dirname,'update-portable.ps1'),scriptPath,constants.COPYFILE_EXCL);
  await fs.writeFile(configPath,JSON.stringify({schema:1,cacheDir:cache,source,target,targetDir,staged,backup,appPid,sha256:sha256.toLowerCase(),readyPath,statusPath,cancelPath}),{mode:0o600,flag:'wx'});
  if(!path.isAbsolute(launcherPath)||path.extname(launcherPath).toLowerCase()!=='.exe')throw new Error('升级启动器路径无效');
  await fs.access(launcherPath);
  // Portable resources are extracted to a temporary directory. Running the helper
  // there would keep that extraction (and possibly the outer old EXE) locked.
  await fs.copyFile(launcherPath,persistentLauncher,constants.COPYFILE_EXCL);
  // The GUI-subsystem launcher can detach from Electron's child-process job.
  // PowerShell itself is a console process and cannot reliably detach hidden.
  const child=helper=await launch(persistentLauncher,[scriptPath,configPath],spawnImpl);
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){
   try{const ready=JSON.parse((await fs.readFile(readyPath,'utf8')).replace(/^\uFEFF/,''));if(ready.phase==='ready')return {kind,started:true,statusPath,backupPath:backup};}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
   try{const status=JSON.parse((await fs.readFile(statusPath,'utf8')).replace(/^\uFEFF/,''));if(status.phase==='failed')throw new Error('便携版升级准备失败：'+status.message);}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
   if(child.exitCode!==null&&child.exitCode!==undefined)throw new Error('便携版升级程序提前退出（'+child.exitCode+'），请重试');
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('便携版升级程序未能就绪，当前客户端将继续运行');
 }catch(error){
  await fs.writeFile(cancelPath,'{}',{mode:0o600}).catch(()=>{});
  try{helper?.kill();}catch{}
  // This one generated staging filename is the only file removed here.
  if(inside(staged,targetDir)&&path.dirname(staged)===targetDir)await fs.unlink(staged).catch(()=>{});
  throw error;
 }
}
module.exports={prepareUpdateInstall};
