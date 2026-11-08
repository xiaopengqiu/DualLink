import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fail } from './auth.mjs';
import { modelId } from './model-settings.mjs';

export const profileNames = ['screenshot.codex','screenshot.claude','transcript.codex','transcript.claude','transcript.bailian','asr','omni'];
const fields = ['apiKey','baseUrl','model','workspaceId','region','authType','transport','chunkSeconds'];
export function createAiSettings({db,dataDir}) {
  db.exec('CREATE TABLE IF NOT EXISTS service_ai(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)');
  const keyPath=path.join(dataDir,'.ai-settings.key');
  let key;try{key=readFileSync(keyPath);}catch(e){if(e.code!=='ENOENT')throw e;key=randomBytes(32);try{writeFileSync(keyPath,key,{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;key=readFileSync(keyPath);}}
  if(key.length!==32)throw new Error('服务模型配置加密密钥无效');
  const encrypt=value=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64');};
  const read=()=>{const row=db.prepare('SELECT value FROM service_ai WHERE id=1').get();if(!row)return {};const b=Buffer.from(row.value,'base64'),decipher=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));decipher.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(b.subarray(28)),decipher.final()]).toString());};
  const profile=name=>read()[name]||{};
  const view=()=>Object.fromEntries(profileNames.map(name=>{const {apiKey,...rest}=profile(name);return [name,{...rest,hasApiKey:!!apiKey}];}));
  function save(patch){
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!profileNames.includes(k)))fail(400,'模型配置无效');
    const all=read();
    for(const [name,input] of Object.entries(patch)){
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!fields.includes(k)))fail(400,'模型配置字段无效');
      const next={...(all[name]||{})};
      for(const [field,value] of Object.entries(input)){
        if(typeof value!=='string'||value.length>(field==='apiKey'?4096:500)||/[\x00-\x1f\x7f]/.test(value))fail(400,'模型配置内容无效');
        const v=value.trim();
        if(field==='model')modelId(v);
        if(field==='transport'&&v&&!['auto','token-plan','websocket'].includes(v))fail(400,'语音识别方式无效');
        if(field==='chunkSeconds'&&v&&(!/^\d+$/.test(v)||Number(v)<2||Number(v)>15))fail(400,'语音分段时长需为2至15秒');
        if(['transport','chunkSeconds'].includes(field)&&name!=='asr')fail(400,'仅语音识别支持分段设置');
        if(field==='authType'&&v&&!['api-key','bearer'].includes(v))fail(400,'认证方式无效');
        if(field==='baseUrl'&&v){let u;try{u=new URL(v);}catch{fail(400,'接口地址无效');}if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)fail(400,'接口地址需为 HTTPS，不能包含密钥、查询参数或片段');}
        if(field==='workspaceId'&&v&&!/^[A-Za-z0-9_-]{1,100}$/.test(v))fail(400,'业务空间 ID 无效');
        if(field==='region'&&v&&!/^[a-z0-9-]{2,40}$/.test(v))fail(400,'地域无效');
        next[field]=v;
      }
      all[name]=next;
    }
    db.prepare('INSERT INTO service_ai(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(encrypt(all));
    return view();
  }
  function cli(stage,provider,base={}){
    const p=profile(`${stage}.${provider}`),extraEnv={...(base.extraEnv||{})};
    if(provider==='claude'){
      if(p.apiKey)Object.assign(extraEnv,{ANTHROPIC_AUTH_TOKEN:p.authType==='bearer'?p.apiKey:'',ANTHROPIC_API_KEY:p.authType==='bearer'?'':p.apiKey,CLAUDE_CODE_OAUTH_TOKEN:''});
      if(p.baseUrl)extraEnv.ANTHROPIC_BASE_URL=p.baseUrl;
    }else{
      if(p.apiKey)Object.assign(extraEnv,{CODEX_API_KEY:p.apiKey,OPENAI_API_KEY:p.apiKey});
      if(p.baseUrl)extraEnv.OPENAI_BASE_URL=p.baseUrl;
    }
    return {...base,extraEnv,...(p.model?{[provider==='codex'?'codexModel':'claudeModel']:p.model}:{})};
  }
  function api(name,base={}){
    const p=profile(name),result={...base};
    for(const field of ['apiKey','workspaceId','region','model'])if(p[field])result[field]=p[field];
    if(name==='asr'){if(p.transport)result.transport=p.transport;if(p.chunkSeconds)result.chunkSeconds=Number(p.chunkSeconds);}
    if(p.baseUrl){if(name==='asr')result.baseUrl=p.baseUrl;else if(name==='transcript.bailian')result.textBaseUrl=p.baseUrl;else result.wsUrl=p.baseUrl.replace(/^https:/,'wss:');}
    if(name==='transcript.bailian')for(const [field,target] of Object.entries({apiKey:'textApiKey',workspaceId:'textWorkspaceId',region:'textRegion',model:'textModel'}))if(p[field])result[target]=p[field];
    return result;
  }
  const owner=()=>db.prepare("SELECT id FROM users WHERE role='admin' AND disabled=0 ORDER BY created_at,id LIMIT 1").get()?.id;
  return {profile,view,save,cli,api,owner};
}
