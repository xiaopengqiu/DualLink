import {_electron as electron,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'duallink-update-ui-'));
const entry=path.join(temp,'main.cjs');
// Only this test entry substitutes the network and process launch. Production has
// no environment switch for arbitrary update feeds or installer paths.
await fs.writeFile(entry,`
const path=require('node:path'),fs=require('node:fs/promises'),crypto=require('node:crypto');
const {app}=require('electron');
Object.defineProperty(app,'isPackaged',{get:()=>true});
const root=${JSON.stringify(root)},version='1.4.0',bytes=Buffer.from('MZ-fixture-update-payload'),digest=crypto.createHash('sha256').update(bytes).digest('hex');
const kind=process.env.PORTABLE_EXECUTABLE_FILE?'portable':'installed',name='DualLink-'+version+'-x64-'+(kind==='portable'?'portable':'setup')+'.exe',sum='SHA256SUMS-'+version+'.txt',base='https://github.com/xiaopengqiu/DualLink/releases/download/v'+version+'/';
const realUpdater=require(path.join(root,'apps/desktop/lib/updater.cjs')).UpdateController;
require.cache[require.resolve(path.join(root,'apps/desktop/lib/updater.cjs'))].exports={UpdateController:class extends realUpdater{constructor(options){super({...options,currentVersion:'1.3.0',fetchImpl:async url=>{if(url.includes('api.github.com'))return Response.json({tag_name:'v'+version,assets:[{name,size:bytes.length,browser_download_url:base+name},{name:sum,browser_download_url:base+sum}],body:'更新测试版本'});if(url.endsWith('.txt'))return new Response(digest+'  '+name+'\\n');return new Response(bytes);}});global.__refreshUpdate=options.onChange;}}};
const realAudio=require(path.join(root,'apps/desktop/lib/audio-main.cjs')).AudioController;
global.__updateAudio={phase:'idle'};
require.cache[require.resolve(path.join(root,'apps/desktop/lib/audio-main.cjs'))].exports={AudioController:class extends realAudio{view(){return {...super.view(),...global.__updateAudio};}}};
const helper=require.resolve(path.join(root,'apps/desktop/lib/update-install.cjs'));
require(helper);require.cache[helper].exports={prepareUpdateInstall:async update=>{await fs.writeFile(path.join(app.getPath('userData'),'installed.json'),JSON.stringify({kind:update.kind,sha256:update.sha256,verified:crypto.createHash('sha256').update(await fs.readFile(update.filePath)).digest('hex')===update.sha256}));}};
require(path.join(root,'apps/desktop/main.cjs'));
`);
try{
 for(const scenario of ['installed','portable','oneclick']){
  const kind=scenario==='portable'?'portable':'installed';
  const userData=path.join(temp,scenario);let application;
  try{
   application=await electron.launch({args:[entry],env:{...process.env,DUALLINK_TEST_MODE:'1',DUALLINK_TEST_USER_DATA:userData,...(kind==='portable'?{PORTABLE_EXECUTABLE_FILE:path.join(temp,'portable.exe')}:{})}});
   application.process().stderr.on('data',chunk=>{if(chunk.toString().includes('启动失败'))process.stderr.write(chunk);});
   const page=await application.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.locator('[data-tab="preferences"]').click();
   await page.getByLabel('启动时检查更新').uncheck();
   await page.getByRole('button',{name:'保存偏好设置',exact:true}).click();await expect(page.getByText('✓ 设置已保存',{exact:true})).toBeVisible();
   if(scenario==='oneclick'){
    const closed=application.waitForEvent('close');
    await page.getByRole('button',{name:'一键升级',exact:true}).click().catch(error=>{if(!/closed|destroyed/i.test(error.message))throw error;});await closed;
    const install=JSON.parse(await fs.readFile(path.join(userData,'installed.json'),'utf8'));assert.equal(install.verified,true);
    assert.equal(JSON.parse(await fs.readFile(path.join(userData,'settings.json'),'utf8')).settings.autoCheckUpdates,false);
    assert.deepEqual(errors,[]);console.log('PASS: one click performs check -> verified download -> install and exit without further confirmation');continue;
   }
   await page.getByRole('button',{name:'检查更新',exact:true}).click();await expect(page.locator('#update-latest-version')).toHaveText('1.4.0');
   await page.getByRole('button',{name:'下载更新',exact:true}).click();await expect(page.locator('#update-status')).toHaveAttribute('data-phase','downloaded');
   const state=await page.evaluate(()=>window.dualLink.getState());assert.equal(state.update.kind,kind);assert.equal(state.update.progress,100);assert(!JSON.stringify(state.update).includes('filePath'));
   await application.evaluate(()=>{global.__updateAudio={phase:'recording'};global.__refreshUpdate();});
   await expect(page.getByRole('button',{name:'安装并重启',exact:true})).toBeDisabled();await expect(page.locator('#update-blocked')).toContainText('面试');
   const rejection=await page.evaluate(()=>window.dualLink.updateInstall().then(()=>'',error=>error.message));assert.match(rejection,/面试/);
   await assert.rejects(fs.access(path.join(userData,'installed.json')));
   await application.evaluate(()=>{global.__updateAudio={phase:'idle'};global.__refreshUpdate();});
   await expect(page.getByRole('button',{name:'安装并重启',exact:true})).toBeEnabled();
   await fs.mkdir(path.join(root,'.local'),{recursive:true});await page.screenshot({path:path.join(root,'.local','updater-'+kind+'.png'),fullPage:true});
   const closed=application.waitForEvent('close');await page.getByRole('button',{name:'安装并重启',exact:true}).click().catch(error=>{if(!/closed|destroyed/i.test(error.message))throw error;});await closed;
   const install=JSON.parse(await fs.readFile(path.join(userData,'installed.json'),'utf8'));assert.equal(install.kind,kind);assert.equal(install.verified,true);
   const saved=JSON.parse(await fs.readFile(path.join(userData,'settings.json'),'utf8'));assert.equal(saved.settings.autoCheckUpdates,false);assert.equal(saved.settings.fullShortcut,'Ctrl+Alt+S');assert.deepEqual(errors,[]);
   console.log('PASS: '+kind+' real Electron UI/IPC -> verified download -> recording blocks install -> explicit install -> settings preserved and app exits');
  }finally{await application?.close().catch(()=>{});}
 }
}finally{await fs.rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
