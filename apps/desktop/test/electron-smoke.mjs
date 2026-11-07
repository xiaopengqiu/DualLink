import {_electron as electron} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../..',import.meta.url));
const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'dual-link-electron-smoke-'));
const application=await electron.launch({args:[path.join(root,'apps','desktop')],env:{...process.env,DUALLINK_TEST_MODE:'1',DUALLINK_TEST_USER_DATA:dataDir}});
try{
  const page=await application.firstWindow();
  await page.getByRole('heading',{name:'连接你的下一块屏幕'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'全屏截图',exact:false}).isEnabled(),false);
  await page.getByRole('button',{name:'偏好设置'}).click();
  await page.getByLabel('默认模型服务').selectOption('claude');
  await page.getByRole('button',{name:'保存偏好设置'}).click();
  await page.getByText('✓ 设置已保存').waitFor();
  const renderer=await page.evaluate(()=>({node:typeof window.require}));
  assert.equal(renderer.node,'undefined');
  const state=await page.evaluate(()=>window.dualLink.getState());assert.equal(state.settings.provider,'claude');
  await page.getByRole('button',{name:'连接与截图'}).click();
  await fs.mkdir(path.join(root,'.local'),{recursive:true});
  await page.screenshot({path:path.join(root,'.local','desktop-smoke.png')});
  const settings=JSON.parse(await fs.readFile(path.join(dataDir,'settings.json'),'utf8'));
  assert.equal(settings.settings.provider,'claude');assert.equal('secret' in settings,false);
  console.log('Electron smoke passed: local UI, secure preload, settings persistence.');
}finally{await application.close();if(dataDir.startsWith(path.join(os.tmpdir(),'dual-link-electron-smoke-')))await fs.rm(dataDir,{recursive:true,force:true});}
