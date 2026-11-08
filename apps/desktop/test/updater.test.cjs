'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
let UpdateController;
try{({UpdateController}=require('../lib/updater.cjs'));}catch{}
const API='https://api.github.com/repos/xiaopengqiu/DualLink/releases/latest';
const repository='https://github.com/xiaopengqiu/DualLink';
const binary=Buffer.from('fixture executable, not a real Windows program');
const sha=value=>createHash('sha256').update(value).digest('hex');
function release(version='1.4.0',kind='installed'){
 const name=`DualLink-${version}-x64-${kind==='portable'?'portable':'setup'}.exe`;
 const sums=`SHA256SUMS-${version}.txt`;
 return {tag_name:'v'+version,draft:false,prerelease:false,html_url:repository+'/releases/tag/v'+version,body:'A release',assets:[{name,size:binary.length,browser_download_url:`${repository}/releases/download/v${version}/${name}`},{name:sums,size:sha(binary).length+name.length+3,browser_download_url:`${repository}/releases/download/v${version}/${sums}`} ]};
}
async function setup(t,options={}){
 assert.equal(typeof UpdateController,'function','updater controller must exist');
 const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'dual-updater-test-'));
 t.after(()=>fs.rm(cacheDir,{recursive:true,force:true}));
 const kind=options.kind||'installed',meta=options.release||release('1.4.0',kind),calls=[],installed=[],changes=[];
 const fetchImpl=options.fetchImpl||(async(url,request)=>{
  calls.push(String(url));assert.equal(request.redirect,'manual');
  if(String(url)===API)return Response.json(meta);
  if(String(url).endsWith('.txt'))return new Response(`${sha(binary)}  ${meta.assets[0].name}\n`);
  return new Response(options.bytes||binary);
 });
 const updater=new UpdateController({currentVersion:'1.3.0',kind,cacheDir,fetchImpl,onChange:value=>changes.push(value),getBusyReason:options.getBusyReason||(()=>''),install:async value=>installed.push(value),...options});
 t.after(()=>updater.dispose());
 return {updater,cacheDir,calls,installed,changes,meta};
}

test('explicit check and verified download select the correct package and expose safe progress',async t=>{
 for(const kind of ['installed','portable']){
  const {updater,calls,installed,changes}=await setup(t,{kind});
  assert.equal(updater.view().phase,'idle');assert.equal(calls.length,0);
  await updater.check();assert.equal(updater.view().phase,'available');assert.equal(updater.view().latestVersion,'1.4.0');assert.equal(installed.length,0);
  await updater.download();const state=updater.view();assert.equal(state.phase,'downloaded');assert.equal(state.progress,100);assert.equal(state.canInstall,true);
  assert.equal(state.downloadedBytes,binary.length);assert(!JSON.stringify(changes).includes('filePath'));
  assert(calls.some(url=>url.endsWith(kind==='portable'?'-portable.exe':'-setup.exe')));
  await updater.install();assert.equal(installed.length,1);assert.equal(installed[0].sha256,sha(binary));assert.equal(installed[0].kind,kind);
  assert.deepEqual(await fs.readFile(installed[0].filePath),binary);
 }
});

test('current and older releases never become installable, and prereleases are ignored',async t=>{
 for(const meta of [release('1.3.0'),release('1.2.0'),{...release(),prerelease:true},{...release(),draft:true}]){
  const {updater,calls}=await setup(t,{release:meta});await updater.check();assert.equal(updater.view().phase,'current');assert.equal(updater.view().canInstall,false);assert.equal(calls.length,1);await assert.rejects(updater.download());
 }
});

test('untrusted metadata URLs, invalid versions and duplicate or missing assets fail closed',async t=>{
 const bad=[];
 const wrong=release();wrong.assets[0].browser_download_url='http://github.com/xiaopengqiu/DualLink/releases/download/v1.4.0/'+wrong.assets[0].name;bad.push(wrong);
 const other=release();other.assets[0].browser_download_url=other.assets[0].browser_download_url.replace('/xiaopengqiu/DualLink/','/attacker/DualLink/');bad.push(other);
 const invalid=release();invalid.tag_name='v1.4.0/../../private';bad.push(invalid);
 const missing=release();missing.assets.pop();bad.push(missing);
 const duplicate=release();duplicate.assets.push({...duplicate.assets[0]});bad.push(duplicate);
 for(const meta of bad){const {updater,installed}=await setup(t,{release:meta});await assert.rejects(updater.check());assert.equal(updater.view().phase,'error');assert.equal(installed.length,0);}
});

test('checksum mismatch and truncated downloads remove partial data and remain retryable',async t=>{
 for(const bytes of [Buffer.from('bad'),Buffer.alloc(binary.length,0)]){
  const {updater,cacheDir,installed}=await setup(t,{bytes});
  await updater.check();await assert.rejects(updater.download());assert.equal(updater.view().phase,'error');assert.equal(installed.length,0);
  assert(!(await fs.readdir(cacheDir)).some(name=>name.endsWith('.part')||name.endsWith('.exe')));
 }
});

test('installation is blocked while work is active and rechecks downloaded files for tampering',async t=>{
 let busy='正在录音';const {updater,cacheDir,installed}=await setup(t,{getBusyReason:()=>busy});
 await updater.check();await updater.download();assert.equal(updater.view().canInstall,false);assert.equal(updater.view().blockedReason,busy);
 await assert.rejects(updater.install());assert.equal(installed.length,0);assert.equal(updater.view().phase,'downloaded');
 busy='';const executable=(await fs.readdir(cacheDir)).find(name=>name.endsWith('.exe'));await fs.writeFile(path.join(cacheDir,executable),Buffer.alloc(binary.length,1));
 await assert.rejects(updater.install());assert.equal(installed.length,0);assert.equal(updater.view().canInstall,false);
});

test('redirects cannot move downloads to HTTP or arbitrary hosts',async t=>{
 for(const location of ['http://github.com/xiaopengqiu/DualLink','https://evil.example/payload.exe','https://github.com/attacker/DualLink/releases/download/v1.4.0/payload.exe']){
  const meta=release(),seen=[];const {updater}=await setup(t,{fetchImpl:async(url)=>{seen.push(String(url));if(String(url)===API)return Response.json(meta);return new Response(null,{status:302,headers:{location}});}});
  await assert.rejects(updater.check());assert.equal(seen.length,2);assert.equal(updater.view().phase,'error');
 }
});

test('official GitHub asset CDN redirects are followed without changing the selected package',async t=>{
 const meta=release(),seen=[];const {updater}=await setup(t,{fetchImpl:async(url)=>{
  const value=String(url);seen.push(value);
  if(value===API)return Response.json(meta);
  if(value===meta.assets[1].browser_download_url)return new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/release/checksums?signature=fixture'}});
  if(value.startsWith('https://release-assets.githubusercontent.com/'))return new Response(`${sha(binary)}  ${meta.assets[0].name}\n`);
  if(value===meta.assets[0].browser_download_url)return new Response(null,{status:302,headers:{location:'https://objects.githubusercontent.com/release/installer?signature=fixture'}});
  if(value.startsWith('https://objects.githubusercontent.com/'))return new Response(binary);
  throw Error('Unexpected URL');
 }});
 await updater.check();await updater.download();assert.equal(updater.view().phase,'downloaded');assert.equal(seen.length,5);
});

test('metadata body limits and missing checksum entries fail before downloading executable',async t=>{
 for(const body of ['x'.repeat(1024*1024+1),'not a valid checksum manifest']){
  const meta=release(),seen=[];const {updater}=await setup(t,{fetchImpl:async(url)=>{seen.push(String(url));return String(url)===API?Response.json(meta):new Response(body);}});
  await assert.rejects(updater.check());assert(!seen.some(url=>url.endsWith('.exe')));
 }
});

test('concurrent checks share a request, and dispose aborts pending network work',async t=>{
 let count=0,observedSignal;
 const {updater}=await setup(t,{fetchImpl:(_url,options)=>{count++;observedSignal=options.signal;return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}});
 const first=updater.check(),second=updater.check();assert.equal(count,1);
 updater.dispose();await Promise.allSettled([first,second]);assert.equal(observedSignal.aborted,true);assert.equal(updater.view().canInstall,false);
});

test('a failed download can be retried and a failed installer never runs automatically on check',async t=>{
 let attempts=0;const meta=release();const {updater,installed}=await setup(t,{fetchImpl:async(url)=>{
  if(String(url)===API)return Response.json(meta);
  if(String(url).endsWith('.txt'))return new Response(`${sha(binary)}  ${meta.assets[0].name}\n`);
  attempts++;if(attempts===1)throw new Error('network failure including private address');return new Response(binary);
 }});
 await updater.check();await assert.rejects(updater.download(),e=>!e.message.includes('private address'));
 await updater.download();assert.equal(updater.view().phase,'downloaded');assert.equal(installed.length,0);assert.equal(attempts,2);
 await updater.install();assert.equal(installed.length,1);
});

test('work starting during verification prevents installer launch',async t=>{
 let busy='';const {updater,installed}=await setup(t,{getBusyReason:()=>busy});await updater.check();await updater.download();
 const pending=updater.install();busy='正在上传截图';await assert.rejects(pending);assert.equal(installed.length,0);assert.equal(updater.view().phase,'downloaded');
});

test('aborting an active stream removes its incomplete executable',async t=>{
 let streamController,requestSignal,started;
 const streaming=new Promise(resolve=>{started=resolve;});const meta=release();
 const {updater,cacheDir}=await setup(t,{fetchImpl:async(url,request)=>{
  if(String(url)===API)return Response.json(meta);
  if(String(url).endsWith('.txt'))return new Response(`${sha(binary)}  ${meta.assets[0].name}\n`);
  requestSignal=request.signal;return new Response(new ReadableStream({start(controller){streamController=controller;controller.enqueue(binary.subarray(0,1));request.signal.addEventListener('abort',()=>controller.error(request.signal.reason),{once:true});started();}}));
 }});
 await updater.check();const pending=updater.download();await streaming;updater.dispose();await assert.rejects(pending);assert.equal(requestSignal.aborted,true);assert.equal((await fs.readdir(cacheDir)).length,0);
});
