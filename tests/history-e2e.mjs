import {chromium,expect} from '@playwright/test';
import {createApp} from '../apps/server/src/app.mjs';
import {mkdtemp,mkdir,writeFile,rm,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const temp=await mkdtemp(path.join(tmpdir(),'duallink-history-ui-'));
const service=await createApp({dataDir:path.join(temp,'server'),secureCookies:false,runner:async()=>({answer:'历史测试回答'})});
const owner=service.createUser({email:'history@test.example',name:'历史测试',password:'OnlyForHistory42!',role:'admin'});
const foreign=service.createUser({email:'foreign@test.example',name:'其他账号',password:'OnlyForHistory42!'});
await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${service.server.address().port}`;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=','base64');
const emailOf=user=>user.email;
async function login(user){const response=await fetch(origin+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:emailOf(user),password:'OnlyForHistory42!'})});assert.equal(response.status,200);const body=await response.json();return {cookie:response.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':body.csrfToken};}
async function request(headers,route,method='GET',body){const response=await fetch(origin+'/api'+route,{method,headers:{...headers,...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body?(body instanceof FormData?body:JSON.stringify(body)):undefined});assert.ok(response.ok,`${method} ${route}: ${response.status} ${response.ok?'':await response.text()}`);return response.json();}
async function capture(headers){const form=new FormData();form.set('captureId',randomUUID());form.set('analyze','false');form.set('image',new Blob([png],{type:'image/png'}),'合成历史.png');return (await request(headers,'/captures','POST',form)).capture;}
function voice(user,title,status){const id=randomUUID(),now=new Date().toISOString();service.db.prepare('INSERT INTO interviews(id,user_id,title,status,provider,prompt_name,style_snapshot,created_at,updated_at,ended_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,user.id,title,status,'codex','默认风格','',now,now,status==='ended'?now:null);return id;}
let browser;
try{
 const auth=await login(owner),other=await login(foreign),captures=[];
 for(let i=0;i<52;i++)captures.push(await capture(auth));
 const foreignCapture=await capture(other),ended=voice(owner,'可删除的语音历史','ended'),active=voice(owner,'仍在使用的语音会话','paused'),foreignVoice=voice(foreign,'其他账号的语音','ended');
 const audioDir=path.join(service.dataDir,'users',owner.id,'interviews',ended);await mkdir(audioDir,{recursive:true});await writeFile(path.join(audioDir,'remote.pcm'),Buffer.alloc(32));
 service.db.prepare('INSERT INTO interview_audio_frames(session_id,track,seq,start_ms,sample_count,byte_offset,byte_count,hash,replay,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(ended,'remote',0,0,16,0,32,'synthetic',0,new Date().toISOString());service.db.prepare('INSERT OR REPLACE INTO interview_audio_storage(user_id,bytes) VALUES(?,?)').run(owner.id,32);
 const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';browser=await chromium.launch(existsSync(edge)?{executablePath:edge}:{});
 const context=await browser.newContext({viewport:{width:820,height:1180},hasTouch:true}),page=await context.newPage(),peer=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));peer.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin);await page.getByLabel('邮箱地址').fill(owner.email);await page.getByLabel('登录密码').fill('OnlyForHistory42!');await page.getByRole('button',{name:'进入工作空间'}).click();await expect(page.locator('.connection-pill')).toHaveText('已连接');await peer.goto(origin);await expect(peer.locator('.connection-pill')).toHaveText('已连接');
 await page.getByRole('button',{name:'历史记录',exact:true}).click();await expect(page.getByRole('heading',{name:'管理历史，留出空间。'})).toBeVisible();await expect(page.getByLabel('历史保留天数')).toHaveValue('30');
 await expect(page.getByRole('checkbox',{name:/选择截图/})).toHaveCount(50);await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.getByRole('checkbox',{name:/选择截图/})).toHaveCount(2);
 await page.getByRole('checkbox',{name:'全选本页可删除记录'}).check();page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'删除所选',exact:false}).click();await expect.poll(()=>service.db.prepare('SELECT count(*) AS n FROM captures WHERE user_id=?').get(owner.id).n).toBe(50);
 assert.ok(service.db.prepare('SELECT id FROM captures WHERE id=?').get(foreignCapture.id));
 console.log('PASS: real iPad-size history pagination and page selection delete persisted files/records only for the current account');
 await page.getByLabel('历史保留天数').fill('14');await page.getByRole('button',{name:'保存清理设置',exact:true}).click();await expect(page.getByText('历史清理设置已保存',{exact:true})).toBeVisible();assert.equal((await request(auth,'/history/settings')).settings.retentionDays,14);
 await page.getByRole('tab',{name:'语音历史',exact:false}).click();await expect(page.getByRole('checkbox',{name:'选择语音 '+active})).toBeDisabled();page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'清空语音历史',exact:true}).click();await expect.poll(()=>service.db.prepare('SELECT id FROM interviews WHERE id=?').get(ended)).toBeUndefined();await assert.rejects(stat(audioDir));assert.ok(service.db.prepare('SELECT id FROM interviews WHERE id=?').get(active));assert.ok(service.db.prepare('SELECT id FROM interviews WHERE id=?').get(foreignVoice));
 console.log('PASS: adjustable 30-day defaults persist; voice clear removes PCM and cascaded history while protecting active and foreign sessions');
 await page.getByRole('tab',{name:'截图历史',exact:false}).click();page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'清空截图历史',exact:true}).click();await expect.poll(()=>service.db.prepare('SELECT count(*) AS n FROM captures WHERE user_id=?').get(owner.id).n).toBe(0);await expect(peer.locator('.capture-stage img')).toHaveCount(0);
 const remaining=await request(auth,'/history/settings');assert.equal(remaining.usage.captures,0);assert.equal(remaining.usage.captureBytes,0);assert.ok(service.db.prepare('SELECT id FROM captures WHERE id=?').get(foreignCapture.id));
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);await mkdir('.local',{recursive:true});await page.screenshot({path:'.local/history-real-ipad.png',fullPage:true});
 console.log('PASS: all-page clear releases image storage and synchronizes deletion into a second already-open browser page');
}finally{await browser?.close();await service.close();await rm(temp,{recursive:true,force:true});}
