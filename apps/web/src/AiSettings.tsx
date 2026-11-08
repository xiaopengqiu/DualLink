import { useEffect, useState } from 'react';
import { api } from './api';
import './ai-settings.css';

type Profile = { effectiveModel?:string; modelSource?:string; transport?:string; chunkSeconds?:string; authType?:string; model?: string; baseUrl?: string; workspaceId?: string; region?: string; hasApiKey?: boolean; apiKey?: string };
type Profiles = Record<string, Profile>;
const groups = [
  { title: '截图回答', note: '选择支持图片输入的模型。Codex 与 Claude 分别保存配置。', names: ['screenshot.codex', 'screenshot.claude'] },
  { title: '转写后的文字回答', note: '独立于截图，可配置响应更快的文字模型。', names: ['transcript.codex', 'transcript.claude', 'transcript.bailian'] },
  { title: '语音识别与音频直答', note: '语音识别用于转写和后台留档；音频直答直接理解声音，两者配置独立。', names: ['asr', 'omni'] },
];
const titles: Record<string,string> = { 'screenshot.codex':'Codex CLI','screenshot.claude':'Claude CLI','transcript.codex':'Codex CLI','transcript.claude':'Claude CLI','transcript.bailian':'百炼文本 API',asr:'百炼语音识别（ASR）',omni:'百炼音频直答（Qwen-Omni）' };

export default function AiSettings({ onSaved, onError }: { onSaved: () => void; onError: (error: unknown) => void }) {
  const [defaults,setDefaults]=useState({screenshotProvider:'codex',textProvider:'codex'});
  const [profiles, setProfiles] = useState<Profiles | null>(null);
  const [keys, setKeys] = useState<Record<string,string>>({});
  const [cleared, setCleared] = useState<Record<string,boolean>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => { const controller=new AbortController(); api.request<{profiles:Profiles;defaults:{screenshotProvider:string;textProvider:string}}>('/account/ai',{signal:controller.signal}).then(result=>{setProfiles(result.profiles);setDefaults(result.defaults);}).catch(error=>{if(!controller.signal.aborted)onError(error);}); return ()=>controller.abort(); },[onError]);
  function change(name:string, field:keyof Profile, value:string) { setSaved(false);setProfiles(current=>({...current,[name]:{...current?.[name],[field]:value}})); }
  async function save() {
    if(!profiles)return;setBusy(true);setSaved(false);
    try {
      const patch=Object.fromEntries(Object.entries(profiles).map(([name,p])=>[name,{model:p.model||'',baseUrl:p.baseUrl||'',workspaceId:p.workspaceId||'',region:p.region||'',...(name==='asr'?{transport:p.transport||'auto',chunkSeconds:p.chunkSeconds||'4'}:{}),...(name.endsWith('.claude')?{authType:p.authType||'api-key'}:{}),...(cleared[name]?{apiKey:''}:keys[name]?{apiKey:keys[name]}:{})}]));
      const result=await api.request<{profiles:Profiles;defaults:{screenshotProvider:string;textProvider:string}}>('/account/ai',{method:'PUT',body:{profiles:patch,defaults}});
      setProfiles(result.profiles);setKeys({});setCleared({});setSaved(true);onSaved();
    } catch(error){onError(error);} finally {setBusy(false);}
  }
  return <section className="ai-settings" aria-label="管理员模型配置">
    <div className="section-heading"><div><h2>模型与接口配置</h2><p>仅管理员可修改，所有用户和已配对客户端自动使用这里的配置。</p></div></div>
    <p className="ai-settings-note">API Key 保存后不会回显。密钥输入框留空表示保留已有密钥；其他字段留空使用服务器默认值。保存后用于后续请求，已提交任务保留原模型记录。正在录音时，更改语音识别配置后请暂停再继续。</p>
    {!profiles ? <p>正在加载模型配置…</p> : <form onSubmit={event=>{event.preventDefault();void save();}}>
      <fieldset disabled={busy} className="ai-settings-fields">
      {groups.map(group=><section className="panel ai-settings-group" key={group.title}><div className="panel-heading"><span className="panel-title">{group.title}</span></div><p className="ai-settings-note">{group.note}</p>{group.names[0].includes('.')&&<label className="ai-provider-choice">默认执行方式<select aria-label={`${group.title}默认执行方式`} value={group.names[0].startsWith('screenshot')?defaults.screenshotProvider:defaults.textProvider} onChange={event=>{const field=group.names[0].startsWith('screenshot')?'screenshotProvider':'textProvider';setDefaults(current=>({...current,[field]:event.target.value}));setSaved(false);}}><option value="codex">Codex CLI</option><option value="claude">Claude CLI</option>{group.names.length===3&&<option value="bailian">百炼文本 API</option>}</select></label>}<div className="ai-profile-grid">{group.names.map(name=>{
        const p=profiles[name]||{},audio=name==='asr'||name==='omni',bailian=name.includes('bailian')||audio;
        return <div className="ai-profile" key={name}><h3>{titles[name]}</h3><small>已保存的生效模型：{p.effectiveModel||'CLI 默认模型'} · {p.modelSource||'服务器默认'}</small>
          {name==='asr'&&<><label>识别方式<select aria-label="语音识别方式" value={p.transport||'auto'} onChange={event=>{change(name,'transport',event.target.value);if(event.target.value==='token-plan'){change(name,'model','qwen-audio-3.0-asr-flash');change(name,'baseUrl','https://token-plan.cn-beijing.maas.aliyuncs.com');}}}><option value="auto">自动匹配模型与套餐</option><option value="token-plan">Token Plan · HTTP 分段识别</option><option value="websocket">实时识别 · WebSocket</option></select></label><label>最长分段时长（秒）<input aria-label="语音分段时长" type="number" min={2} max={15} value={p.chunkSeconds||'4'} onChange={event=>change(name,'chunkSeconds',event.target.value)}/><small>默认4秒；停顿后提前识别，回答快捷键会提交当前尾段。仅影响 HTTP 分段识别。</small></label></>}
          <label>模型 ID<input aria-label={`${name} 模型 ID`} maxLength={100} value={p.model||''} placeholder="留空使用服务器默认模型" onChange={event=>change(name,'model',event.target.value)}/></label>
          {name.includes('claude')&&<label>认证方式<select aria-label={`${name} 认证方式`} value={p.authType||'api-key'} onChange={event=>change(name,'authType',event.target.value)}><option value="api-key">API Key（x-api-key）</option><option value="bearer">Bearer Token（兼容供应商）</option></select></label>}
          <label>{name.includes('claude')?'认证 Token / API Key':'API Key'}<input aria-label={`${name} API Key`} type="password" autoComplete="new-password" maxLength={4096} value={keys[name]||''} placeholder={cleared[name]?'保存后清除，改用服务器认证':p.hasApiKey?'已配置；留空保留，填写可替换':'留空使用服务器认证'} onChange={event=>{setKeys(current=>({...current,[name]:event.target.value}));setCleared(current=>({...current,[name]:false}));setSaved(false);}}/></label>
          {(p.hasApiKey||cleared[name])&&<button type="button" className="text-button" onClick={()=>{setCleared(current=>({...current,[name]:!current[name]}));setKeys(current=>({...current,[name]:''}));setSaved(false);}}>{cleared[name]?'取消清除密钥':'清除已保存密钥'}</button>}
          <label>{audio?'语音接口地址（HTTPS）':'API Base URL'}<input aria-label={`${name} API Base URL`} type="url" maxLength={500} value={p.baseUrl||''} placeholder={name==='asr'?'Token Plan 可留空自动生成，或填写套餐域名':audio?'留空自动生成；完整路径 /api-ws/v1/realtime':name.includes('claude')?'https://供应商域名/兼容接口':name.includes('codex')?'https://供应商域名/v1':'https://业务空间.地域.maas.aliyuncs.com/compatible-mode/v1'} onChange={event=>change(name,'baseUrl',event.target.value)}/></label>
          {name==='asr'&&<small>Token Plan 使用套餐 Key，无需业务空间 ID；qwen-audio-3.0-asr-flash 会自动使用 HTTP。普通实时识别仍需匹配业务空间和地域。</small>}
          {bailian&&<><label>业务空间 ID<input aria-label={`${name} 业务空间 ID`} maxLength={100} value={p.workspaceId||''} placeholder="与 API Key 同一业务空间" onChange={event=>change(name,'workspaceId',event.target.value)}/></label><label>地域<input aria-label={`${name} 地域`} maxLength={40} value={p.region||''} placeholder="cn-beijing" onChange={event=>change(name,'region',event.target.value)}/></label></>}
        </div>;
      })}</div></section>)}
      </fieldset><div className="ai-settings-save"><span role="status">{saved?'已保存，后续请求将使用新配置。':''}</span><button className="button primary" disabled={busy}>{busy?'正在保存…':'保存全部模型配置'}</button></div>
    </form>}
  </section>;
}
