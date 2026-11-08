import {test,expect} from '@playwright/test';
const stamp='2026-11-08T10:00:00.000Z';
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY4AAAAAASUVORK5CYII=';
async function prepare(page,seedDraft=false){
 const calls=[],settings={retentionDays:30,maxCaptures:1000,maxInterviews:200,maxStorageMiB:1024,autoCleanup:true};
 const captures=[{id:'capture-one',captureId:'local-one',deviceId:'pc',deviceName:'工作电脑',createdAt:stamp,imageUrl:image,size:2048,protected:false,latestTask:{id:'task-one',captureId:'capture-one',captureIds:['capture-one'],status:'completed',answer:'历史问题答案',provider:'codex',createdAt:stamp,updatedAt:stamp,sources:[],question:'完整历史问题'}},{id:'capture-busy',captureId:'local-busy',deviceId:'pc',deviceName:'正在处理的截图',createdAt:stamp,imageUrl:image,size:1024,protected:true,protectedReason:'回答生成中'},{id:'capture-old',captureId:'local-old',deviceId:null,createdAt:'2026-10-01T10:00:00.000Z',imageUrl:image,size:4096,protected:false,latestTask:null}];
 const interviews=[{id:'voice-ended',title:'后端面试记录',status:'ended',provider:'codex',createdAt:stamp,updatedAt:stamp,endedAt:stamp,audioBytes:8192,protected:false},{id:'voice-recording',title:'正在录音的会话',status:'recording',provider:'codex',createdAt:stamp,updatedAt:stamp,audioBytes:4096,protected:true,protectedReason:'会话尚未结束'}];
 const usage=()=>({captures:captures.length,interviews:interviews.length,tasks:1,captureBytes:captures.reduce((n,c)=>n+c.size,0),audioBytes:interviews.reduce((n,c)=>n+c.audioBytes,0),totalBytes:19456,protectedCaptures:captures.filter(c=>c.protected).length,protectedInterviews:interviews.filter(c=>c.protected).length});
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname,body=req.method()==='GET'?null:req.postDataJSON();
  const respond=(json,status=200)=>route.fulfill({json,status});
  if(path==='/api/auth/me')return respond({user:{id:'owner',name:'用户',email:'owner@test.example',role:'user',dailyLimit:100},csrfToken:'csrf'});
  if(path==='/api/config')return respond({providers:['codex','claude'],defaultProvider:'codex',iceServers:[],maxUploadBytes:12582912});
  if(path==='/api/ws-ticket')return respond({ticket:'ticket'});
  if(path==='/api/history/settings'){calls.push({path,method:req.method(),body});if(body){if(body.settings)return respond({error:'设置需直接提交字段'},400);Object.assign(settings,body);}return respond({settings,usage:usage()});}
  if(path==='/api/history/captures'||path==='/api/history/interviews'){
   calls.push({path,search:url.search});const source=path.endsWith('captures')?captures:interviews,query=url.searchParams.get('search')||'';
   const filtered=source.filter(row=>!query||JSON.stringify(row).includes(query));const offset=url.searchParams.get('cursor')==='next'?2:0;
   return respond({items:filtered.slice(offset,offset+2),total:filtered.length,nextCursor:filtered.length>offset+2?'next':null,hasMore:filtered.length>offset+2});
  }
  if(path==='/api/history/delete'){
   calls.push({path,method:req.method(),body});const source=body.kind==='captures'?captures:interviews,chosen=source.filter(row=>(body.all||body.ids.includes(row.id))),deleted=chosen.filter(row=>!row.protected);
   for(const row of deleted)source.splice(source.indexOf(row),1);
   return respond({deletedIds:deleted.map(row=>row.id),deletedTaskIds:deleted.some(row=>row.id==='capture-one')?['task-one']:[],skippedIds:chosen.filter(row=>row.protected).map(row=>row.id),deletedCount:deleted.length,usage:usage()});
  }
  if(path==='/api/history/cleanup'){calls.push({path,method:req.method(),body});return respond({deletedCaptures:1,deletedInterviews:0,deletedTasks:1,usage:usage()});}
  if(path==='/api/captures')return respond({captures:[captures[0]]});
  if(path==='/api/tasks')return respond({tasks:[captures[0]?.latestTask].filter(Boolean)});
  if(path==='/api/devices')return respond({devices:[]});
  if(path==='/api/prompts')return respond({prompts:[]});
  if(path==='/api/knowledge')return respond({files:[]});
  return respond({ok:true});
 });
 await page.addInitScript(()=>{class Socket{static OPEN=1;static CONNECTING=0;readyState=0;constructor(){window.__historySocket=this;setTimeout(()=>{this.readyState=1;this.onopen?.();},0);}send(){}close(){this.readyState=3;}}window.WebSocket=Socket;});
 if(seedDraft)await page.addInitScript(()=>sessionStorage.setItem('duallink.screenshot-draft.owner',JSON.stringify({ids:['capture-one'],sizes:{'capture-one':2048},request:null})));
 await page.goto('/');await expect(page.getByRole('heading',{name:'让截图，成为答案。'})).toBeVisible();await expect(page.locator('.connection-pill')).toHaveText('已连接');
 return {calls,captures,interviews};
}
async function openHistory(page){await page.getByRole('button',{name:'历史记录',exact:true}).click();await expect(page.getByRole('heading',{name:'管理历史，留出空间。'})).toBeVisible();}

test('history provides per-account thirty-day limits, all-page pagination and protected rows on iPad',async({page},testInfo)=>{
 await page.setViewportSize({width:820,height:1180});const fixture=await prepare(page);await openHistory(page);
 await expect(page.getByLabel('历史保留天数')).toHaveValue('30');await expect(page.getByText('附件空间（截图+音频）',{exact:true})).toBeVisible();
 await expect(page.getByRole('checkbox',{name:'选择截图 capture-busy'})).toBeDisabled();
 await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.getByRole('checkbox',{name:'选择截图 capture-old'})).toBeVisible();
 expect(fixture.calls.some(c=>c.search?.includes('cursor=next'))).toBe(true);
 await page.getByLabel('搜索历史记录').fill('工作电脑');await page.getByRole('button',{name:'搜索',exact:true}).click();
 await expect(page.getByRole('checkbox',{name:'选择截图 capture-one'})).toBeVisible();
 await page.getByLabel('历史保留天数').fill('60');await page.getByLabel('最多保留截图数').fill('500');await page.getByRole('button',{name:'保存清理设置',exact:true}).click();
 await expect.poll(()=>fixture.calls.filter(c=>c.path==='/api/history/settings'&&c.method==='PUT').length).toBe(1);
 const saved=fixture.calls.find(c=>c.path==='/api/history/settings'&&c.method==='PUT').body;expect(saved.retentionDays).toBe(60);expect(saved.settings).toBeUndefined();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath('history-ipad.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});const nav=page.getByRole('navigation',{name:'主导航'});const positions=await nav.getByRole('button').evaluateAll(buttons=>buttons.map(button=>Math.round(button.getBoundingClientRect().top)));
 expect(new Set(positions).size).toBe(1);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('selected history delete requires confirmation and clearing voice history covers all pages but keeps active sessions',async({page})=>{
 const fixture=await prepare(page);await openHistory(page);await page.getByRole('checkbox',{name:'选择截图 capture-one'}).check();
 page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'删除所选',exact:false}).click();expect(fixture.calls.filter(c=>c.path==='/api/history/delete')).toHaveLength(0);
 page.once('dialog',dialog=>{expect(dialog.message()).toMatch(/1.*截图/);dialog.accept();});await page.getByRole('button',{name:'删除所选',exact:false}).click();
 await expect(page.getByRole('checkbox',{name:'选择截图 capture-one'})).toHaveCount(0);
 expect(fixture.calls.find(c=>c.path==='/api/history/delete').body).toEqual({kind:'captures',ids:['capture-one']});
 await page.getByRole('tab',{name:'语音历史',exact:false}).click();await expect(page.getByText('后端面试记录',{exact:true})).toBeVisible();
 page.once('dialog',dialog=>{expect(dialog.message()).toMatch(/全部|所有页面/);dialog.accept();});await page.getByRole('button',{name:'清空语音历史',exact:true}).click();
 await expect(page.getByText('后端面试记录',{exact:true})).toHaveCount(0);await expect(page.getByText('正在录音的会话',{exact:true})).toBeVisible();
 expect(fixture.calls.filter(c=>c.path==='/api/history/delete').at(-1).body).toEqual({kind:'interviews',all:true});
});

test('cross-device history deletion removes workspace preview, answer and pending browser draft',async({page})=>{
 const fixture=await prepare(page,true);await expect(page.getByText('历史问题答案',{exact:true})).toBeVisible();await expect(page.getByText('待提交截图 · 1 张',{exact:true})).toBeVisible();
 await page.evaluate(()=>window.__historySocket.onmessage({data:JSON.stringify({type:'history.deleted',kind:'captures',deletedIds:['capture-one'],deletedTaskIds:['task-one'],reason:'manual'})}));
 await expect(page.getByText('历史问题答案',{exact:true})).toHaveCount(0);await expect(page.locator('.capture-stage img')).toHaveCount(0);
 await expect(page.getByText('待提交截图 · 1 张',{exact:true})).toHaveCount(0);expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('duallink.screenshot-draft.owner')).ids)).toEqual([]);
 await page.evaluate(capture=>{
  window.__historySocket.onmessage({data:JSON.stringify({type:'capture.created',capture})});window.__historySocket.onmessage({data:JSON.stringify({type:'task.updated',task:capture.latestTask})});document.dispatchEvent(new Event('visibilitychange'));
 },fixture.captures[0]);
 await expect(page.getByText('历史问题答案',{exact:true})).toHaveCount(0);await expect(page.locator('.capture-stage img')).toHaveCount(0);
 expect(fixture.calls.filter(c=>c.path==='/api/history/delete')).toHaveLength(0);
});

test('cleanup is explicit, uses saved policy and remains accessible to ordinary accounts',async({page})=>{
 const fixture=await prepare(page);await openHistory(page);await page.getByRole('button',{name:'立即按规则清理',exact:true}).click();
 await expect.poll(()=>fixture.calls.filter(c=>c.path==='/api/history/cleanup').length).toBe(1);
 await expect(page.getByText(/已清理.*1.*截图/)).toBeVisible();
});

test('bulk cleanup events coalesce history refreshes instead of flooding the API',async({page})=>{
 const fixture=await prepare(page);await openHistory(page);await expect(page.getByLabel('历史保留天数')).toHaveValue('30');
 const before=fixture.calls.filter(c=>c.path==='/api/history/settings').length;
 await page.evaluate(async()=>{for(let i=0;i<8;i++){window.__historySocket.onmessage({data:JSON.stringify({type:'history.updated'})});await new Promise(requestAnimationFrame);}});
 await expect.poll(()=>fixture.calls.filter(c=>c.path==='/api/history/settings').length).toBeGreaterThan(before);
 expect(fixture.calls.filter(c=>c.path==='/api/history/settings').length-before).toBeLessThanOrEqual(2);
});

test('opening a stale multi-image history row cannot resurrect a deleted related answer',async({page})=>{
 await prepare(page);await openHistory(page);await expect(page.getByRole('checkbox',{name:'选择截图 capture-one'})).toBeVisible();
 await page.evaluate(()=>window.__historySocket.onmessage({data:JSON.stringify({type:'history.deleted',kind:'captures',deletedIds:['another-batch-member'],deletedTaskIds:['task-one'],reason:'manual'})}));
 await page.getByRole('button',{name:'查看历史截图 capture-one',exact:true}).click();
 await expect(page.getByRole('heading',{name:'让截图，成为答案。'})).toBeVisible();await expect(page.locator('.capture-stage img')).toBeVisible();
 await expect(page.getByText('历史问题答案',{exact:true})).toHaveCount(0);
});

test('pending deletion locks history type and search until its original page refresh completes',async({page})=>{
 await prepare(page);await openHistory(page);await page.getByRole('checkbox',{name:'选择截图 capture-one'}).check();
 let release;const held=new Promise(resolve=>release=resolve);await page.route('**/api/history/delete',async route=>{await held;await route.fallback();});
 try{page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'删除所选',exact:false}).click();
  await expect(page.getByRole('tab',{name:'语音历史',exact:true})).toBeDisabled();await expect(page.getByLabel('搜索历史记录')).toBeDisabled();await expect(page.getByRole('button',{name:'搜索',exact:true})).toBeDisabled();
 }finally{release();}
 await expect(page.getByRole('checkbox',{name:'选择截图 capture-one'})).toHaveCount(0);await expect(page.getByRole('tab',{name:'语音历史',exact:true})).toBeEnabled();await page.getByRole('tab',{name:'语音历史',exact:true}).click();await expect(page.getByText('后端面试记录',{exact:true})).toBeVisible();
});
