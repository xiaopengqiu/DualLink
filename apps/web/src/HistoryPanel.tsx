import {useCallback,useEffect,useRef,useState} from 'react';
import type {FormEvent} from 'react';
import {Archive,ArrowLeft,ArrowRight,AudioLines,Check,Clock3,HardDrive,Image,LoaderCircle,RefreshCw,Search,Settings2,ShieldCheck,Trash2} from 'lucide-react';
import {api,ApiError} from './api';
import type {CaptureHistoryItem,HistoryDeleteResult,HistoryEvent,HistoryKind,HistoryOverview,HistoryPage,HistorySettings,HistoryUsage,InterviewHistoryItem} from './history-types';
import './history.css';

interface Props {ownerId:string;refreshKey:number;onError:(error:unknown)=>void;onOpenCapture:(item:CaptureHistoryItem)=>void;onOpenInterview:(id:string)=>void;onDeleted:(event:HistoryEvent)=>void;}
const defaults:HistorySettings={retentionDays:30,maxCaptures:1000,maxInterviews:200,maxStorageMiB:1024,autoCleanup:true};
const bytes=(size=0)=>size>=1024**3?`${(size/1024**3).toFixed(2)} GB`:size>=1024**2?`${(size/1024**2).toFixed(1)} MB`:size>=1024?`${(size/1024).toFixed(1)} KB`:`${size} B`;
const date=(value:string)=>new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
const stateLabels:Record<string,string>={queued:'排队中',running:'回答生成中',completed:'已回答',failed:'回答失败',cancelled:'已取消',recording:'录音进行中',paused:'会话已暂停',ended:'会话已结束'};
const isAbort=(error:unknown)=>error instanceof DOMException&&error.name==='AbortError';

export default function HistoryPanel({ownerId,refreshKey,onError,onOpenCapture,onOpenInterview,onDeleted}:Props){
 const [kind,setKind]=useState<HistoryKind>('captures');
 const [refreshSignal,setRefreshSignal]=useState(refreshKey);
 const [page,setPage]=useState<HistoryPage>({items:[],total:0,nextCursor:null,hasMore:false});
 const [cursors,setCursors]=useState<(string|null)[]>([null]);
 const [search,setSearch]=useState(''),[query,setQuery]=useState('');
 const [settings,setSettings]=useState<HistorySettings>(defaults);
 const [savedSettings,setSavedSettings]=useState<HistorySettings>(defaults);
 const [usage,setUsage]=useState<HistoryUsage|null>(null);
 const [rawAudioDays,setRawAudioDays]=useState<number|null>(null);
 const [selected,setSelected]=useState<string[]>([]);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState('');
 const [notice,setNotice]=useState<{text:string;error:boolean}|null>(null);
 const lifetime=useRef(0),live=useRef(false),listSequence=useRef(0),overviewSequence=useRef(0),mutation=useRef(false),settingsDirty=useRef(false);
 const abort=useRef<AbortController|null>(null);
 const cursor=cursors[cursors.length-1];
 useEffect(()=>{live.current=true;lifetime.current++;abort.current=new AbortController();return()=>{live.current=false;lifetime.current++;abort.current?.abort();};},[ownerId]);
 const request=useCallback(async<T,>(path:string,options:{method?:string;body?:unknown}={})=>{
  const own=lifetime.current,result=await api.request<T>(path,{...options,signal:abort.current?.signal});
  if(!live.current||own!==lifetime.current)throw new DOMException('History account changed','AbortError');return result;
 },[]);
 const report=useCallback((error:unknown)=>{if(isAbort(error))return;if(error instanceof ApiError&&error.status===401){onError(error);return;}if(live.current)setNotice({text:error instanceof Error?error.message:'读取历史记录失败，请重试',error:true});},[onError]);
 const loadOverview=useCallback(async()=>{
  const own=++overviewSequence.current,result=await request<HistoryOverview>('/history/settings');if(own!==overviewSequence.current)return;
  setUsage(result.usage);setSavedSettings({...defaults,...result.settings});if(!settingsDirty.current)setSettings({...defaults,...result.settings});setRawAudioDays(result.rawAudioRetentionDays??null);
 },[request]);
 const loadPage=useCallback(async()=>{
  const own=++listSequence.current;setLoading(true);
  try{const params=new URLSearchParams({limit:'50',search:query});if(cursor)params.set('cursor',cursor);
   const result=await request<HistoryPage>(`/history/${kind}?${params}`);if(own!==listSequence.current)return;
   setPage(result);setSelected(previous=>previous.filter(id=>result.items.some(row=>row.id===id&&!row.protected)));
   if(!result.items.length&&cursor)setCursors([null]);
  }finally{if(live.current&&own===listSequence.current)setLoading(false);}
 },[kind,cursor,query,request]);
 useEffect(()=>{const timer=setTimeout(()=>setRefreshSignal(refreshKey),200);return()=>clearTimeout(timer);},[refreshKey]);
 useEffect(()=>{void loadOverview().catch(report);},[loadOverview,report,refreshSignal]);
 useEffect(()=>{void loadPage().catch(report);},[loadPage,report,refreshSignal]);
 async function perform(key:string,operation:()=>Promise<void>){if(mutation.current)return;mutation.current=true;setBusy(key);setNotice(null);try{await operation();}catch(error){report(error);}finally{mutation.current=false;if(live.current)setBusy('');}}
 function changeKind(next:HistoryKind){if(next===kind||mutation.current)return;setKind(next);setCursors([null]);setSearch('');setQuery('');setSelected([]);setLoading(true);setNotice(null);}
 const eligible=page.items.filter(row=>!row.protected),allSelected=eligible.length>0&&eligible.every(row=>selected.includes(row.id));
 function toggle(id:string,checked:boolean){setSelected(previous=>checked?[...new Set([...previous,id])].slice(0,200):previous.filter(value=>value!==id));}
 async function remove(all=false,onlyId?:string){
  const ids=onlyId?[onlyId]:selected,count=all?(kind==='captures'?usage?.captures:usage?.interviews)??page.total:ids.length;
  if(!count)return;
  const label=kind==='captures'?'截图':'语音';
  const scope=all?`所有页面的全部 ${count} 条${label}历史`:`${count} 条${label}历史`;
  if(!window.confirm(`永久删除${scope}？${kind==='captures'?'关联问题和回答也会删除。':'对应转写、问答与保留音频也会删除。'}进行中的记录将保留。此操作无法撤销。`))return;
  await perform('delete',async()=>{
   const result=await request<HistoryDeleteResult>('/history/delete',{method:'POST',body:all?{kind,all:true}:{kind,ids}});
   onDeleted({type:'history.deleted',kind,deletedIds:result.deletedIds,deletedTaskIds:result.deletedTaskIds,reason:'manual'});
   if(result.usage)setUsage(result.usage);setSelected([]);
   setNotice({text:`已删除 ${result.deletedCount} 条${label}历史${result.skippedIds.length?`，${result.skippedIds.length} 条进行中的记录已保留`:''}`,error:false});
   await Promise.all([loadOverview(),loadPage()]);
  });
 }
 async function save(event:FormEvent){event.preventDefault();await perform('save',async()=>{
  const result=await request<HistoryOverview>('/history/settings',{method:'PUT',body:settings});
  settingsDirty.current=false;setSettings({...defaults,...result.settings});setSavedSettings({...defaults,...result.settings});setUsage(result.usage);setRawAudioDays(result.rawAudioRetentionDays??rawAudioDays);setNotice({text:'历史清理设置已保存',error:false});await loadPage();
 });}
 async function cleanup(){await perform('cleanup',async()=>{
  const result=await request<{deletedCaptures:number;deletedInterviews:number;deletedTasks:number;usage:HistoryUsage}>('/history/cleanup',{method:'POST',body:{}});
  setUsage(result.usage);setSelected([]);setNotice({text:`已清理 ${result.deletedCaptures} 条截图、${result.deletedInterviews} 场语音历史和 ${result.deletedTasks} 个关联回答`,error:false});await loadPage();
 });}
 function updateSettings(change:Partial<HistorySettings>){settingsDirty.current=true;setSettings(previous=>({...previous,...change}));}
 const total=kind==='captures'?usage?.captures:usage?.interviews,protectedCount=kind==='captures'?usage?.protectedCaptures:usage?.protectedInterviews;
 return <section className="history-manager" aria-label="历史记录管理">
  <div className="page-heading"><div><div className="eyebrow">HISTORY & STORAGE</div><h1>管理历史，留出空间。</h1><p>删除不需要的截图与语音记录，设置保留期限和容量上限。</p></div><button className="button secondary" disabled={!!busy||loading} onClick={()=>void perform('refresh',async()=>{await Promise.all([loadOverview(),loadPage()]);})}><RefreshCw size={16}/>刷新</button></div>
  {notice&&<div className={`history-notice ${notice.error?'history-notice-error':''}`} role={notice.error?'alert':'status'}>{notice.error?<ShieldCheck size={16}/>:<Check size={16}/>}<span>{notice.text}</span></div>}
  <div className="history-storage-summary" aria-label="历史空间统计"><div><span className="summary-icon mint"><Image size={19}/></span><span><strong>{usage?.captures??'—'}</strong><small>截图历史</small></span><em>{bytes(usage?.captureBytes)}</em></div><div><span className="summary-icon lavender"><AudioLines size={19}/></span><span><strong>{usage?.interviews??'—'}</strong><small>语音会话</small></span><em>{bytes(usage?.audioBytes)}</em></div><div><span className="summary-icon sand"><HardDrive size={19}/></span><span><strong>{usage?bytes(usage.totalBytes):'—'}</strong><small>附件空间（截图+音频）</small></span><em>上限 {savedSettings.maxStorageMiB} MB</em></div></div>
  {!!usage?.pendingFileDeletes&&<p className="history-file-note" role="status">有 {usage.pendingFileDeletes} 个文件（{bytes(usage.pendingFileBytes)}）等待后台清理，将自动重试。</p>}
  <details className="panel history-policy" open><summary><Settings2 size={17}/><span>自动清理与容量限制</span><small>仅影响当前账号</small></summary><form onSubmit={event=>void save(event)}>
   <div className="history-settings-grid"><label>历史保留天数<input aria-label="历史保留天数" type="number" min={1} max={3650} required value={settings.retentionDays} onChange={event=>updateSettings({retentionDays:Number(event.target.value)})}/><small>默认 30 天；到期删除整条问答记录。</small></label><label>最多保留截图数<input aria-label="最多保留截图数" type="number" min={1} max={5000} required value={settings.maxCaptures} onChange={event=>updateSettings({maxCaptures:Number(event.target.value)})}/></label><label>最多保留语音会话数<input aria-label="最多保留语音会话数" type="number" min={1} max={2000} required value={settings.maxInterviews} onChange={event=>updateSettings({maxInterviews:Number(event.target.value)})}/></label><label>附件容量上限（MB）<input aria-label="附件容量上限（MB）" type="number" min={1} max={102400} required value={settings.maxStorageMiB} onChange={event=>updateSettings({maxStorageMiB:Number(event.target.value)})}/></label></div>
   <label className="check-label history-auto"><input type="checkbox" checked={settings.autoCleanup} onChange={event=>updateSettings({autoCleanup:event.target.checked})}/>自动清理到期或超出上限的历史</label>
   <p className="history-policy-description"><Clock3 size={15}/><span>保存后立即按已启用的规则清理，删除无法撤销。自动清理和批量删除保留正在生成回答的截图及尚未结束的语音会话；关闭自动清理后，达到上限将停止新增。</span></p>
   <p className="history-policy-description"><AudioLines size={15}/><span>原始录音另受服务器保留期{rawAudioDays===null?'':`（${rawAudioDays} 天）`}限制，可能早于问答记录过期。到期后仍可查看保留期限内的文字历史。</span></p>
   <div className="history-policy-actions"><button className="button secondary" type="button" disabled={!!busy||!usage} onClick={()=>void cleanup()}>{busy==='cleanup'?<LoaderCircle className="spin" size={15}/>:<Archive size={15}/>}立即按规则清理</button><button className="button primary" disabled={!!busy}>{busy==='save'?<LoaderCircle className="spin" size={15}/>:<Check size={15}/>}保存清理设置</button></div>
  </form></details>
  <section className="panel history-records"><div className="history-toolbar"><div role="tablist" aria-label="历史类型" className="history-tabs"><button role="tab" aria-selected={kind==='captures'} disabled={!!busy} onClick={()=>changeKind('captures')}><Image size={16}/>截图历史</button><button role="tab" aria-selected={kind==='interviews'} disabled={!!busy} onClick={()=>changeKind('interviews')}><AudioLines size={16}/>语音历史</button></div><form className="history-search" onSubmit={event=>{event.preventDefault();if(mutation.current)return;setCursors([null]);setSelected([]);setQuery(search.trim());}}><Search size={15}/><input aria-label="搜索历史记录" disabled={!!busy} placeholder={kind==='captures'?'搜索问题、回答或设备':'搜索语音会话名称'} value={search} onChange={event=>setSearch(event.target.value)}/><button className="button secondary compact" type="submit" disabled={!!busy}>搜索</button></form></div>
   <div className="history-bulk-actions"><label className="check-label"><input aria-label="全选本页可删除记录" type="checkbox" checked={allSelected} disabled={!!busy||loading||!eligible.length} onChange={event=>setSelected(event.target.checked?eligible.map(row=>row.id):[])}/>全选本页</label><span>已选 {selected.length} 条 · 共 {page.total} 条</span><button className="button secondary compact history-danger" disabled={!!busy||!selected.length} onClick={()=>void remove(false)}>删除所选{selected.length?`（${selected.length}）`:''}</button><button className="button secondary compact history-danger" disabled={!!busy||!usage||!((total??0)-(protectedCount??0))} onClick={()=>void remove(true)}>{kind==='captures'?'清空截图历史':'清空语音历史'}</button></div>
   <div role="tabpanel" aria-label={kind==='captures'?'截图历史列表':'语音历史列表'} className="history-record-list">
    {loading?<div className="history-list-empty"><LoaderCircle className="spin" size={22}/><span>正在读取历史记录</span></div>:page.items.length?page.items.map(row=>{
     const capture=kind==='captures'?row as CaptureHistoryItem:null,interview=kind==='interviews'?row as InterviewHistoryItem:null;
     const label=capture?`选择截图 ${row.id}`:`选择语音 ${row.id}`,title=capture?capture.deviceName||'网页截图':interview!.title,status=capture?capture.latestTask?.status:interview!.status;
     return <article className={`history-record ${row.protected?'history-record-protected':''}`} key={row.id}>
      <input type="checkbox" aria-label={label} checked={selected.includes(row.id)} disabled={row.protected||!!busy} onChange={event=>toggle(row.id,event.target.checked)}/>
      {capture?<button className="history-thumbnail" aria-label={`查看历史截图 ${row.id}`} onClick={()=>onOpenCapture(capture)}><img src={capture.imageUrl} alt="" loading="lazy"/></button>:<span className="history-voice-icon"><AudioLines size={23}/></span>}
      <div className="history-record-info"><strong>{title}</strong><small>{date(row.createdAt)} · {bytes(capture?.size??interview?.audioBytes)}</small>{capture?.latestTask?.question&&<p>{capture.latestTask.question}</p>}{row.protected?<span className="history-protected-label"><ShieldCheck size={12}/>{row.protectedReason||'正在使用，暂不批量删除'}</span>:<span>{status?stateLabels[status]||status:'待分析'}</span>}</div>
      <div className="history-record-actions"><button className="button secondary compact" onClick={()=>capture?onOpenCapture(capture):onOpenInterview(row.id)}>查看</button><button className="icon-button danger-hover" aria-label={`删除${capture?'截图':'语音'} ${row.id}`} disabled={row.protected||!!busy} title={row.protected?'请先结束会话或等待回答完成':'永久删除'} onClick={()=>void remove(false,row.id)}><Trash2 size={16}/></button></div>
     </article>;
    }):<div className="history-list-empty"><Archive size={27}/><strong>{query?'没有找到匹配记录':'没有历史记录'}</strong><span>截图与语音历史会显示在这里。</span></div>}
   </div><div className="history-pagination"><span>第 {cursors.length} 页 · 共 {page.total} 条</span><div><button className="button secondary compact" disabled={!!busy||loading||cursors.length===1} onClick={()=>{setSelected([]);setCursors(previous=>previous.slice(0,-1));}}><ArrowLeft size={14}/>上一页</button><button className="button secondary compact" disabled={!!busy||loading||!page.hasMore||!page.nextCursor} onClick={()=>{setSelected([]);setCursors(previous=>[...previous,page.nextCursor]);}}>下一页<ArrowRight size={14}/></button></div></div>
  </section>
 </section>;
}
