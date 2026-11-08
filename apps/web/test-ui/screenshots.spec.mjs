import {test,expect} from '@playwright/test';
const stamp='2026-11-08T10:00:00.000Z';
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY4AAAAAASUVORK5CYII=';
async function prepare(page,withGroup=false){
  let uploaded=0;const uploads=[],analyses=[],uploadedCaptures=[];
  const captures=['first','second'].map(id=>({id,captureId:id,createdAt:stamp,deviceId:'pc',deviceName:'我的电脑',imageUrl:image}));
  const task={id:'group',captureId:'first',captureIds:['first','second'],captures,provider:'claude',model:'quality',status:'completed',answer:'这是两张关联截图的统一回答。',question:'',promptName:'默认风格',createdAt:stamp,updatedAt:stamp,sources:[]};
  await page.route('**/api/**',route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    const json=(body,status=200)=>route.fulfill({json:body,status});
    if(path==='/api/auth/me')return json({user:{id:'u',name:'用户',email:'u@test.example',role:'user',dailyLimit:100},csrfToken:'csrf'});
    if(path==='/api/config')return json({providers:['codex','claude'],defaultProvider:'codex',autoAnalyze:true,iceServers:[],maxUploadBytes:12582912});
    if(path==='/api/ws-ticket')return json({ticket:'test'});
    if(path==='/api/captures/analyze'){const body=request.postDataJSON();analyses.push(body);return json({task:{...task,id:'new',captureId:body.captureIds[0],captureIds:body.captureIds,status:'queued',answer:''}});}
    if(path==='/api/captures'&&request.method()==='POST'){uploads.push(request.postData());uploaded++;const capture={id:'uploaded-'+uploaded,captureId:'capture-'+uploaded,deviceId:null,createdAt:stamp,imageUrl:image};uploadedCaptures.push(capture);return json({capture,task:null});}
    if(path==='/api/captures')return json({captures:[...(withGroup?captures:[]),...uploadedCaptures]});
    if(path==='/api/tasks')return json({tasks:withGroup?[task]:[]});
    if(path==='/api/devices')return json({devices:[]});
    if(path==='/api/prompts')return json({prompts:[]});
    if(path==='/api/knowledge')return json({files:[]});
    return json({ok:true});
  });
  await page.addInitScript(()=>{class Socket{static OPEN=1;static CONNECTING=0;readyState=0;constructor(){setTimeout(()=>{this.readyState=1;this.onopen?.();},0);}send(){}close(){this.readyState=3;}}window.WebSocket=Socket;});
  await page.goto('/');await expect(page.getByRole('heading',{name:'让截图，成为答案。'})).toBeVisible();
  return {uploads,analyses};
}

test('all screenshots in one question share one answer and reanalysis preserves every image',async({page},testInfo)=>{
  const {analyses}=await prepare(page,true);
  await expect(page.getByLabel('截图执行方式')).toBeDisabled();
  await expect(page.getByLabel('截图本次模型 ID')).toBeDisabled();
  await expect(page.getByText('截图默认配置',{exact:true})).toHaveCount(0);
  await expect(page.getByText('这是两张关联截图的统一回答。',{exact:true})).toBeVisible();
  const batch=page.getByRole('region',{name:'本题关联截图'});
  await expect(batch.getByRole('button')).toHaveCount(2);
  await batch.getByRole('button',{name:'查看本题第 2 张截图'}).click();
  await expect(page.getByText('这是两张关联截图的统一回答。',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'再次分析',exact:false}).click();
  await expect.poll(()=>analyses.length).toBe(1);
  expect(analyses[0].captureIds).toEqual(['first','second']);
  await page.screenshot({path:testInfo.outputPath('grouped-screenshots.png'),fullPage:true});
});

test('multiple web uploads remain pending until one explicit analysis trigger',async({page})=>{
  const {uploads,analyses}=await prepare(page);
  const buffer=Buffer.from(image.split(',')[1],'base64');
  await page.getByLabel('选择截图文件').setInputFiles([{name:'题干.png',mimeType:'image/png',buffer},{name:'选项.png',mimeType:'image/png',buffer}]);
  await expect.poll(()=>uploads.length).toBe(2);
  expect(uploads.every(body=>/name="analyze"\r\n\r\nfalse/.test(body))).toBe(true);
  expect(analyses).toEqual([]);
  await expect(page.getByText('待提交截图 · 2 张',{exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByText('待提交截图 · 2 张',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'回答这道题（2 张）',exact:true}).click();
  await expect.poll(()=>analyses.length).toBe(1);
  expect(analyses[0].captureIds).toEqual(['uploaded-1','uploaded-2']);
});
