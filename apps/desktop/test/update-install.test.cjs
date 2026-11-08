'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const exec=promisify(execFile);
const helpers=()=>require('../lib/update-install.cjs');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),"duallink 更新's "));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}));const cacheDir=path.join(root,'cache');await fs.mkdir(cacheDir);const filePath=path.join(cacheDir,'DualLink-1.4.1-x64-setup.exe'),bytes=Buffer.from('fixture-installer');await fs.writeFile(filePath,bytes);return{root,cacheDir,filePath,sha256:sha(bytes),appPid:process.pid};}
async function waitFor(fn,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Timed out waiting for portable helper');}
async function status(file){return JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));}
async function buildLauncher(t,input){
 const compiler=path.join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
 try{await fs.access(compiler);}catch{t.skip('Windows C# fixture compiler unavailable');return false;}
 input.launcherPath=path.join(input.root,'update-launcher.exe');
 await exec(compiler,['/nologo','/target:winexe','/out:'+input.launcherPath,path.resolve(__dirname,'../lib/update-launcher.cs')]);return true;
}

test('installed update verifies checksum and launches fixed NSIS arguments without a shell',async t=>{
 const input=await fixture(t),calls=[];let unref=false;
 const result=await helpers().prepareUpdateInstall({...input,kind:'installed',spawnImpl:(command,args,options)=>{calls.push({command,args,options});const child=new EventEmitter();child.unref=()=>{unref=true;};process.nextTick(()=>child.emit('spawn'));return child;}});
 assert.equal(result.started,true);assert.equal(unref,true);assert.equal(calls[0].command,input.filePath);assert.deepEqual(calls[0].args,['--updated','/S','--force-run']);assert.equal(calls[0].options.shell,false);assert.equal(calls[0].options.windowsHide,true);assert.equal(calls[0].options.detached,true);
});

test('tampered or out-of-cache executables fail before any process starts',async t=>{
 const input=await fixture(t);let launches=0;const spawnImpl=()=>{launches++;throw Error('must not spawn');};
 await assert.rejects(helpers().prepareUpdateInstall({...input,kind:'installed',sha256:'0'.repeat(64),spawnImpl}),/校验|checksum/i);
 const outside=path.join(input.root,'outside.exe');await fs.copyFile(input.filePath,outside);
 await assert.rejects(helpers().prepareUpdateInstall({...input,kind:'installed',filePath:outside,spawnImpl}),/缓存|cache/i);
 await assert.rejects(helpers().prepareUpdateInstall({...input,kind:'portable',portableExecutable:input.filePath,spawnImpl}),/目标|target|缓存|cache/i);
 assert.equal(launches,0);
});

test('installer spawn failure is reported without quitting the current application',async t=>{
 const input=await fixture(t);
 await assert.rejects(helpers().prepareUpdateInstall({...input,kind:'installed',spawnImpl:()=>{const child=new EventEmitter();child.unref=()=>{};process.nextTick(()=>child.emit('error',Error('launch failed')));return child;}}),/启动|launch/i);
});

test('portable helper preserves original filename and backup, waits for exit, then starts replacement', {skip:process.platform!=='win32',timeout:30000},async t=>{
 const input=await fixture(t),dir=path.join(input.root,"portable 文件's");await fs.mkdir(dir);const portableExecutable=path.join(dir,"我的 双端's.exe");await fs.writeFile(portableExecutable,'old portable fixture');
 const cs=path.join(input.root,'Fixture.cs');await fs.writeFile(cs,'using System;using System.IO;class Program{static void Main(){File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"launched.txt"),"new-version");}}');
 const csc=path.join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
 try{await fs.access(csc);}catch{t.skip('Windows C# fixture compiler unavailable');return;}
 if(!await buildLauncher(t,input))return;
 const download=path.join(input.cacheDir,'DualLink-1.4.1-x64-portable.exe');await exec(csc,['/nologo','/target:winexe','/out:'+download,cs]);
 const oldProcess=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});t.after(()=>{try{oldProcess.kill();}catch{}});await new Promise((r,j)=>{oldProcess.once('spawn',r);oldProcess.once('error',j);});
 let launchedCommand;
 const bytes=await fs.readFile(download),result=await helpers().prepareUpdateInstall({...input,kind:'portable',filePath:download,sha256:sha(bytes),portableExecutable,appPid:oldProcess.pid,spawnImpl:(command,args,options)=>{launchedCommand=command;return spawn(command,args,options);}});
 try{
  assert.equal(result.started,true);assert.equal(await fs.readFile(portableExecutable,'utf8'),'old portable fixture','must not replace while app is alive');
  assert.equal(path.dirname(launchedCommand),path.dirname(result.statusPath),'launcher must run from persistent update cache, not portable extraction resources');
  await fs.unlink(input.launcherPath);
 }finally{oldProcess.kill();}
 const final=await waitFor(async()=>{const s=await status(result.statusPath);return ['completed','failed','rolled-back'].includes(s.phase)&&s;});
 assert.equal(final.phase,'completed',JSON.stringify(final));await waitFor(()=>fs.readFile(path.join(dir,'launched.txt'),'utf8'));assert.equal(await fs.readFile(path.join(dir,'launched.txt'),'utf8'),'new-version');assert.deepEqual(await fs.readFile(portableExecutable),bytes);assert.equal(await fs.readFile(result.backupPath,'utf8'),'old portable fixture');
});

test('portable invalid replacement is rolled back and preparation cancellation leaves the old file intact',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const input=await fixture(t),dir=path.join(input.root,'portable');await fs.mkdir(dir);const portableExecutable=path.join(dir,'DualLink.exe');await fs.writeFile(portableExecutable,'original executable');
 if(!await buildLauncher(t,input))return;
 const sleeper=()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});t.after(()=>{try{child.kill();}catch{}});return child;};
 let old=sleeper();await new Promise(r=>old.once('spawn',r));
 const first=await helpers().prepareUpdateInstall({...input,kind:'portable',portableExecutable,appPid:old.pid});old.kill();
 const rolled=await waitFor(async()=>{const s=await status(first.statusPath);return ['rolled-back','failed'].includes(s.phase)&&s;});
 assert.equal(rolled.phase,'rolled-back',JSON.stringify(rolled));assert.equal(await fs.readFile(portableExecutable,'utf8'),'original executable');
 old=sleeper();await new Promise(r=>old.once('spawn',r));
 const second=await helpers().prepareUpdateInstall({...input,kind:'portable',portableExecutable,appPid:old.pid});
 await fs.writeFile(path.join(path.dirname(second.statusPath),'cancel.json'),'{}');old.kill();
 const cancelled=await waitFor(async()=>{const s=await status(second.statusPath);return s.phase==='failed'&&s;});
 assert.match(cancelled.message,/cancelled/);assert.equal(await fs.readFile(portableExecutable,'utf8'),'original executable');await assert.rejects(fs.access(second.backupPath));
});

test('portable helper survives its actual Node parent exiting normally',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const input=await fixture(t),dir=path.join(input.root,'portable');await fs.mkdir(dir);const portableExecutable=path.join(dir,'DualLink.exe');await fs.writeFile(portableExecutable,'old');
 const cs=path.join(input.root,'Fixture.cs'),download=path.join(input.cacheDir,'portable.exe');await fs.writeFile(cs,'using System;using System.IO;class Program{static void Main(){File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"restarted.txt"),"restarted");}}');
 const csc=path.join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');try{await fs.access(csc);}catch{t.skip('Windows C# fixture compiler unavailable');return;}
 if(!await buildLauncher(t,input))return;
 await exec(csc,['/nologo','/target:winexe','/out:'+download,cs]);
 const parent=path.join(input.root,'parent.cjs'),args=path.join(input.root,'args.json');await fs.writeFile(args,JSON.stringify({...input,filePath:download,sha256:sha(await fs.readFile(download)),portableExecutable,kind:'portable'}));
 await fs.writeFile(parent,'const fs=require("fs");const {prepareUpdateInstall}=require('+JSON.stringify(require.resolve('../lib/update-install.cjs'))+');const data=JSON.parse(fs.readFileSync(process.argv[2]));prepareUpdateInstall({...data,appPid:process.pid}).then(value=>{console.log(JSON.stringify(value));process.exit(0);}).catch(error=>{console.error(error);process.exit(1);});');
 const output=await exec(process.execPath,[parent,args],{windowsHide:true});const result=JSON.parse(output.stdout.trim());
 try{await waitFor(()=>fs.readFile(path.join(dir,'restarted.txt'),'utf8'));}catch(error){t.diagnostic(JSON.stringify(await status(result.statusPath).catch(()=>({phase:'no-status'}))));throw error;}
 assert.equal((await status(result.statusPath)).phase,'completed');assert.equal(await fs.readFile(result.backupPath,'utf8'),'old');
});
