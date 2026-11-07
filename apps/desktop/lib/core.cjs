'use strict';
const DEFAULT_SETTINGS=Object.freeze({cloudUrl:'',deviceName:'我的电脑',displayId:'',fullShortcut:'Ctrl+Alt+S',regionShortcut:'Ctrl+Alt+R',answerShortcut:'Ctrl+Alt+Enter',provider:'codex',analyze:true,lanFirst:false,autoStart:false});
function normalizeCloudUrl(value){
  if(typeof value!=='string'||value.length>2048)throw new Error('请输入有效的云服务地址');
  let url;try{url=new URL(value.trim());}catch{throw new Error('请输入完整地址，例如 https://assist.example.com');}
  if(!['http:','https:'].includes(url.protocol))throw new Error('云服务地址必须使用 HTTP 或 HTTPS');
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('服务地址只需域名和端口，不包含路径、账号或查询参数');
  return url.origin;
}
function validateSettings(value){
  const settings={...DEFAULT_SETTINGS,...value};
  if(settings.cloudUrl)settings.cloudUrl=normalizeCloudUrl(settings.cloudUrl);
  if(typeof settings.deviceName!=='string'||!settings.deviceName.trim()||settings.deviceName.length>80)throw new Error('电脑名称需为 1–80 个字符');
  settings.deviceName=settings.deviceName.trim();
  if(!['codex','claude'].includes(settings.provider))throw new Error('请选择 Codex 或 Claude');
  for(const key of ['fullShortcut','regionShortcut','answerShortcut']){
    if(typeof settings[key]!=='string'||settings[key].length>80||!/(Ctrl|Control|CommandOrControl|Alt|Shift|Super|Command)\+/i.test(settings[key]))throw new Error('快捷键需包含 Ctrl、Alt 或 Shift 等修饰键');
  }
  const normalized=['fullShortcut','regionShortcut','answerShortcut'].map(key=>settings[key].toLowerCase().replace(/commandorcontrol|control/g,'ctrl').replace(/\s+/g,'').split('+').sort().join('+'));
  if(new Set(normalized).size!==3)throw new Error('截图与回答快捷键不能相同');
  for(const key of ['analyze','lanFirst','autoStart'])if(typeof settings[key]!=='boolean')throw new Error('设置值无效');
  settings.displayId=String(settings.displayId||'');
  return settings;
}
function cropRect(rect,view,image){
  if(!rect||![rect.x,rect.y,rect.width,rect.height,view.width,view.height,image.width,image.height].every(Number.isFinite)||rect.x<0||rect.y<0||rect.width<1||rect.height<1||view.width<=0||view.height<=0||rect.x+rect.width>view.width+1||rect.y+rect.height>view.height+1)throw new Error('截图区域无效');
  const x=Math.max(0,Math.floor(rect.x*image.width/view.width));
  const y=Math.max(0,Math.floor(rect.y*image.height/view.height));
  return {x,y,width:Math.max(1,Math.min(image.width-x,Math.round(rect.width*image.width/view.width))),height:Math.max(1,Math.min(image.height-y,Math.round(rect.height*image.height/view.height)))};
}
module.exports={DEFAULT_SETTINGS,normalizeCloudUrl,validateSettings,cropRect};
