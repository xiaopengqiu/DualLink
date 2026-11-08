import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowDownToLine, ArrowRight, AudioLines, BookOpen, Check, ChevronDown, Clock3, FileText, LoaderCircle, MessageSquare, Mic, Monitor, Pause, Pencil, Play, Plus, RefreshCw, Search, ShieldCheck, Sparkles, Square, Trash2, WifiOff, X } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, ApiError } from './api';
import {captureId} from './uuid.mjs';
import {interviewPreferences,modeReady} from './interview-config.mjs';
import { applyInterviewEvent, createInterviewState, InterviewEventHub, mergeInterviewSnapshot } from './interview-state.mjs';
import type { Interview, InterviewAnswer, InterviewConfig, InterviewDetail, InterviewEvent, InterviewProvider,InterviewMode,InterviewPreferences } from './interview-types';
import type { Device, Prompt, Provider } from './types';
import './interviews.css';

interface Props {
  ownerId: string;
  isAdmin?: boolean;
  events: InterviewEventHub;
  prompts: Prompt[];
  devices: Device[];
  providers: Provider[];
  defaultProvider: Provider;
  initialId?: string;
  connection: 'connecting' | 'online' | 'offline';
  onError: (error: unknown) => void;
}
const statusText = { recording: '会话进行中', paused: '已暂停', ended: '已结束' };
const answerStatus = { queued: '等待生成', running: '生成中', completed: '已完成', failed: '生成失败', cancelled: '已取消' };
const activeAnswer = (answer: InterviewAnswer) => answer.status === 'running' || answer.status === 'queued';
const providerName = (provider: InterviewProvider|'omni') => provider === 'omni' ? 'Qwen-Omni' : provider === 'bailian' ? '百炼文本 API' : provider === 'claude' ? 'Claude' : 'Codex';
const formatDate = (value?: string | null) => value && !Number.isNaN(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '时间待同步';
const timestamp = (ms = 0) => { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; };
const byUpdated = (a: Interview, b: Interview) => b.createdAt.localeCompare(a.createdAt);
const upsertInterview = (items: Interview[], next: Interview) => [next, ...items.filter(item => item.id !== next.id)].sort(byUpdated);
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

function ModelId({label,value,onChange,disabled,prefix,models=[],custom=true}:{label:string;value:string;onChange:(model:string)=>void;disabled:boolean;prefix:string;models?:string[];custom?:boolean}){
  const [draft,setDraft]=useState(value);
  useEffect(()=>setDraft(value),[value]);
  const listId=useId();
  return <label>{label}{custom?<><input aria-label={`${prefix}${label}`} type="text" list={models.length?listId:undefined} maxLength={100} placeholder="留空使用服务器默认模型" value={draft} disabled={disabled} onChange={event=>{setDraft(event.target.value);if(prefix!=='面试')onChange(event.target.value);}} onBlur={()=>{if(prefix==='面试'&&draft.trim()!==value)onChange(draft.trim());}}/>{models.length>0&&<datalist id={listId}>{models.map(model=><option key={model} value={model}/>)}</datalist>}</>:<select aria-label={`${prefix}${label}`} disabled={disabled} value={value} onChange={event=>onChange(event.target.value)}>{models.map(model=><option key={model} value={model}>{model}</option>)}</select>}</label>;
}

function ModeOptions({value,onChange,disabled=false,prefix,models,providers,showBoth=false,config,modelsReadOnly=false}:{value:InterviewPreferences;onChange:(value:Partial<InterviewPreferences>)=>void;disabled?:boolean;prefix:string;models:string[];providers:InterviewProvider[];showBoth?:boolean;modelsReadOnly?:boolean;config:InterviewConfig|null}){
  const textProviders=showBoth?providers:[value.provider];
  return <>
    <label>回答方式<select aria-label={`${prefix}回答方式`} value={value.mode} disabled={disabled} onChange={event=>onChange({mode:event.target.value as InterviewMode})}><option value="transcript">语音转文字再回答</option><option value="audio">直接语音理解回答</option></select></label>
    <label>文字回答执行方式<select aria-label={`${prefix}回答模型`} value={value.provider} disabled={disabled||modelsReadOnly} onChange={event=>onChange({provider:event.target.value as InterviewProvider})}>{providers.map(provider=><option value={provider} key={provider}>{providerName(provider)}{provider==='bailian'?'':' CLI'}</option>)}</select><small>用于转写后回答及手动文字提问。</small></label>
    {textProviders.map(provider=><ModelId key={provider} label={`${providerName(provider)} 文字模型 ID`} prefix={prefix} value={value.textModels[provider]} disabled={disabled||modelsReadOnly} onChange={model=>onChange({textModels:{...value.textModels,[provider]:model}})}/>)}
    {(showBoth||value.mode==='transcript'||value.transcribe)&&<ModelId label="语音识别模型 · 百炼 API" prefix={prefix} value={value.asrModel} models={config?.asrModels||[]} custom={config?.customAsrModelsAllowed!==false} disabled={disabled||modelsReadOnly} onChange={asrModel=>onChange({asrModel})}/>}
    {(showBoth||value.mode==='audio')&&<><ModelId label="音频理解模型 · 百炼 API" prefix={prefix} value={value.audioModel} models={models} custom={config?.customAudioModelsAllowed!==false} disabled={disabled||modelsReadOnly} onChange={audioModel=>onChange({audioModel})}/><label className="check-label interview-transcribe-control"><input aria-label={`${prefix}后台转写`} type="checkbox" disabled={disabled||modelsReadOnly||value.mode==='transcript'} checked={value.mode==='transcript'||value.transcribe} onChange={event=>onChange({transcribe:event.target.checked})}/>后台转写留档</label></>}
    <label>问题音频上限（秒）<input aria-label={`${prefix}问题音频时长`} type="number" min={15} max={180} key={`${prefix}:${value.audioWindowSeconds}`} defaultValue={value.audioWindowSeconds} disabled={disabled||modelsReadOnly} onBlur={event=>{const next=Number(event.target.value);if(Number.isFinite(next)&&next>=15&&next<=180)onChange({audioWindowSeconds:next});else event.currentTarget.value=String(value.audioWindowSeconds);}}/></label>
  </>;
}

export default function InterviewPanel({ isAdmin=false, ownerId, events, prompts, devices, providers, defaultProvider, initialId, connection, onError }: Props) {
  const [config, setConfig] = useState<InterviewConfig | null>(null);
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [selectedId, setSelectedId] = useState(initialId || '');
  const [detail, setDetail] = useState(() => createInterviewState(initialId || ''));
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [preferences,setPreferences]=useState<InterviewPreferences>(()=>interviewPreferences({defaultProvider}));
  const [draft, setDraft] = useState({ title: '', ...interviewPreferences({defaultProvider}), promptId: '', autoAnswer: false, hotwords: '' });
  const [search, setSearch] = useState('');
  const [transcriptSearch, setTranscriptSearch] = useState('');
  const [selectedSegments, setSelectedSegments] = useState<string[]>([]);
  const [question, setQuestion] = useState('');
  const [questionId, setQuestionId] = useState('');
  const [followLatest, setFollowLatest] = useState(true);
  const [followTranscript, setFollowTranscript] = useState(true);
  const [compactView, setCompactView] = useState<'suggestions' | 'transcript'>('suggestions');
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const live = useRef(false), lifetime = useRef(0), selectedRef = useRef(selectedId), listSequence = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const followQuestionRef = useRef(followLatest);
  selectedRef.current = selectedId; followQuestionRef.current = followLatest;

  const report = useCallback((error: unknown) => {
    if (isAbort(error)) return;
    if (error instanceof ApiError && error.status === 401) { onError(error); return; }
    setNotice({ text: error instanceof Error ? error.message : '面试会话操作失败，请重试', error: true });
  }, [onError]);

  const request = useCallback(async <T,>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}) => {
    const ownLifetime = lifetime.current;
    const result = await api.request<T>(path, { ...options, signal: options.signal || abortRef.current?.signal });
    if (!live.current || ownLifetime !== lifetime.current) throw new DOMException('Interview workspace changed', 'AbortError');
    return result;
  }, []);

  const refreshList = useCallback(async () => {
    const sequence = ++listSequence.current;
    const result = await request<{ interviews: Interview[] }>('/interviews?limit=100');
    if (sequence !== listSequence.current) return;
    setInterviews(result.interviews || []);
    setSelectedId(current => result.interviews.some(item => item.id === current) ? current : result.interviews[0]?.id || '');
  }, [request]);

  const refreshDetail = useCallback(async (id = selectedRef.current, before?: string | number) => {
    if (!id) return;
    const suffix = typeof before === 'string' ? `?cursor=${encodeURIComponent(before)}` : before === undefined ? '' : `?beforeStartMs=${before}`;
    const result = await request<InterviewDetail>(`/interviews/${encodeURIComponent(id)}${suffix}`);
    if (selectedRef.current !== id) return;
    setDetail(current => mergeInterviewSnapshot(current, result, { earlier: before !== undefined }));
    setInterviews(items => upsertInterview(items, result.interview));
  }, [request]);

  useEffect(() => {
    live.current = true; lifetime.current++;
    abortRef.current = new AbortController();
    setLoading(true);
    void Promise.all([
      refreshList(),
      Promise.all([request<InterviewConfig>('/interviews/config'),request<{preferences:InterviewPreferences}>('/interviews/preferences')]).then(([next,result])=>{setConfig(next);const initial=interviewPreferences(next,result.preferences||next.defaults);setPreferences(initial);setDraft(current=>({...current,...initial,autoAnswer:false}));}),
    ]).catch(report).finally(() => { if (live.current) setLoading(false); });
    return () => { live.current = false; lifetime.current++; abortRef.current?.abort(); };
  }, [ownerId, refreshList, request, report]);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(createInterviewState(selectedId)); setSelectedSegments([]); setQuestion(''); setQuestionId('');
    setTranscriptSearch(''); setFollowLatest(true); setFollowTranscript(true); setEditingTitle(false); setCompactView('suggestions'); setHistoryExpanded(false);
    if (!selectedId) { setDetailLoading(false); return; }
    setDetailLoading(true);
    void request<InterviewDetail>(`/interviews/${encodeURIComponent(selectedId)}`, { signal: controller.signal }).then(result => {
      if (selectedRef.current !== selectedId) return;
      setDetail(current => mergeInterviewSnapshot(current, result));
      setInterviews(items => upsertInterview(items, result.interview));
      setQuestionId(result.questions[result.questions.length - 1]?.id || '');
    }).catch(report).finally(() => { if (!controller.signal.aborted && selectedRef.current === selectedId) setDetailLoading(false); });
    return () => controller.abort();
  }, [selectedId, request, report]);

  useEffect(() => events.subscribe(ownerId, (event: InterviewEvent) => {
    if (!live.current) return;
    if (event.type === 'interview.restore') {
      void Promise.all([refreshList(), refreshDetail(), request<InterviewConfig>('/interviews/config').then(setConfig)]).catch(report);
      return;
    }
    if (event.type === 'interview.deleted' && event.sessionId) {
      setInterviews(items => items.filter(item => item.id !== event.sessionId));
      if (selectedRef.current === event.sessionId) setSelectedId('');
      setNotice({ text: '此会话已在其他设备删除', error: false });
      return;
    }
    if (event.type === 'interview.updated' && event.interview) {
      setInterviews(items => upsertInterview(items, event.interview!));
      setSelectedId(current => current || event.interview!.id);
    }
    const eventSession = event.sessionId || event.interview?.id;
    if (eventSession !== selectedRef.current) return;
    if(event.type==='interview.trigger.status'){setNotice({text:event.status==='failed'?event.error||'回答触发失败':event.status==='processing'?'已收到回答请求，正在同步语音并识别当前问题…':'问题已提交，正在生成回答',error:event.status==='failed'});return;}
    setDetail(current => applyInterviewEvent(current, event));
    if (event.type === 'interview.question' && event.question && followQuestionRef.current) setQuestionId(event.question.id);
  }), [ownerId, events, refreshList, refreshDetail, request, report]);

  useEffect(() => {
    const restore = () => { if (document.visibilityState === 'visible') void Promise.all([refreshList(), refreshDetail()]).catch(report); };
    document.addEventListener('visibilitychange', restore);
    const timer = setInterval(() => { if (connection !== 'online' && selectedRef.current && document.visibilityState === 'visible') void refreshDetail().catch(report); }, 5000);
    return () => { document.removeEventListener('visibilitychange', restore); clearInterval(timer); };
  }, [connection, refreshList, refreshDetail, report]);

  useEffect(() => {
    if (followTranscript && !transcriptSearch) { const container = transcriptEnd.current?.parentElement; container?.scrollTo({ top: container.scrollHeight, behavior: 'smooth' }); }
  }, [detail.segments, followTranscript, transcriptSearch]);
  useEffect(() => { if (!draft.promptId && prompts.length) setDraft(current => ({ ...current, promptId: prompts.find(item => item.isDefault)?.id || prompts[0].id })); }, [prompts, draft.promptId]);
  useEffect(() => { if (notice && !notice.error) { const timer = setTimeout(() => setNotice(null), 4000); return () => clearTimeout(timer); } }, [notice]);

  const perform = async (key: string, action: () => Promise<void>, sessionId?: string) => {
    const ownLifetime = lifetime.current; setBusy(key); setNotice(null);
    try { await action(); }
    catch (error) { if (ownLifetime === lifetime.current && (!sessionId || selectedRef.current === sessionId)) report(error); }
    finally { if (ownLifetime === lifetime.current) setBusy(current => current === key ? '' : current); }
  };
  const active = detail.interview;
  const visibleInterviews = interviews.filter(item => `${item.title} ${formatDate(item.createdAt)}`.toLowerCase().includes(search.toLowerCase()));
  const visibleSegments = detail.segments.filter(item => !transcriptSearch || item.text.toLowerCase().includes(transcriptSearch.toLowerCase()));
  const currentQuestion = detail.questions.find(item => item.id === questionId) || detail.questions[detail.questions.length - 1];
  const currentAnswers = detail.answers.filter(item => item.questionId === currentQuestion?.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const latestAnswer = currentAnswers[currentAnswers.length - 1];
  const selectedText = detail.segments.filter(item => selectedSegments.includes(item.id)).map(item => item.text).join('\n');
  const recorder = devices.find(device => device.id === active?.deviceId);
  const hasRecording = interviews.some(item => item.status === 'recording');
  const audioWarnings = Object.values(detail.audioStatus).filter(item=>item.status==='transcription_warning').map(item=>item.error).filter(Boolean);
  const audioErrors = Object.values(detail.audioStatus).filter(item=>item.status!=='transcription_warning').map(item => item.error).filter(Boolean);
  const audioReady = [active?.recordingStatus, ...Object.values(detail.audioStatus).map(item => item.status)].some(status => status && ['ready', 'streaming', 'recording', 'connected'].includes(status));
  const answerContext = latestAnswer?.contextSummary || (detail.contextSummary?.id === latestAnswer?.contextSnapshotId ? detail.contextSummary : null);
  const interviewProviders = config?.providers || providers;
  const audioModels=[...new Set([...(config?.audioModels||[]),draft.audioModel,preferences.audioModel,active?.audioModel].filter(Boolean))] as string[];
  const canConfigure=!!active&&active.status==='paused'&&busy!=='settings';
  const nativeWithoutTranscript=active?.mode==='audio'&&active.transcribe===false;

  const trigger=()=>{
    if(!active||!['recording','paused'].includes(active.status))return;
    const id=active.id;
    void perform('trigger',async()=>{
      const result=await request<{question:InterviewDetail['questions'][number];answer:InterviewAnswer}>(`/interviews/${id}/trigger`,{method:'POST',body:{requestId:captureId()}});
      if(selectedRef.current!==id)return;
      setDetail(current=>applyInterviewEvent(applyInterviewEvent(current,{type:'interview.question',sessionId:id,question:result.question}),{type:'interview.answer',sessionId:id,answer:result.answer}));setQuestionId(result.question.id);setFollowLatest(true);
      void refreshDetail(id).catch(report);
    },id);
  };

  const createInterview = (event: FormEvent) => {
    event.preventDefault();
    void perform('create', async () => {
      const hotwords = [...new Set(draft.hotwords.split(/[\n,，、;]/).map(word => word.trim()).filter(Boolean))].slice(0, 50);
      const { interview } = await request<{ interview: Interview }>('/interviews', { method: 'POST', body: { title: draft.title.trim() || `面试记录 ${formatDate(new Date().toISOString())}`, provider: draft.provider,textModels:draft.textModels,asrModel:draft.asrModel,mode:draft.mode,transcribe:draft.mode==='transcript'||draft.transcribe,audioModel:draft.audioModel,audioWindowSeconds:draft.audioWindowSeconds, promptId: draft.promptId || undefined, autoAnswer: draft.mode==='transcript'&&draft.autoAnswer, hotwords } });
      setInterviews(items => upsertInterview(items, interview)); setSelectedId(interview.id); setShowCreate(false); setDraft(current => ({ ...current, title: '', hotwords: '' }));
      setNotice({ text: '会话已创建，请在 Windows 客户端选择此会话并开始双路采音', error: false });
    });
  };
  const changeState = (action: 'pause' | 'resume' | 'end') => {
    if (!active) return;
    if (action === 'end' && !window.confirm('结束本场面试？正在接收的语音会先保存，历史记录仍可查看。')) return;
    const id = active.id;
    void perform(action, async () => {
      const result = await request<{ interview: Interview }>(`/interviews/${id}/${action}`, { method: 'POST', body: {} });
      if (selectedRef.current === id) setDetail(current => mergeInterviewSnapshot(current, result));
      setInterviews(items => upsertInterview(items, result.interview));
    }, id);
  };
  const updateInterview = (changes: Partial<Interview>) => {
    if (!active) return;
    const id = active.id;
    void perform('settings', async () => {
      const result = await request<{ interview: Interview }>(`/interviews/${id}`, { method: 'PATCH', body: changes });
      if (selectedRef.current === id) { setDetail(current => mergeInterviewSnapshot(current, result)); setEditingTitle(false); }
      setInterviews(items => upsertInterview(items, result.interview));
    }, id);
  };
  const ask = (event?: FormEvent) => {
    event?.preventDefault(); if (!active || (!question.trim() && !selectedSegments.length)) return;
    const id = active.id;
    void perform('ask', async () => {
      const result = await request<{ question: InterviewDetail['questions'][number]; answer: InterviewAnswer }>(`/interviews/${id}/questions`, { method: 'POST', body: { text: question.trim() || undefined, segmentIds: selectedSegments } });
      if (selectedRef.current !== id) return;
      setDetail(current => applyInterviewEvent(applyInterviewEvent(current, { type: 'interview.question', sessionId: id, question: result.question }), { type: 'interview.answer', sessionId: id, answer: result.answer }));
      setQuestionId(result.question.id); setFollowLatest(true); setSelectedSegments([]); setQuestion('');
    }, id);
  };
  const regenerate = () => {
    if (!active || !currentQuestion) return;
    const id = active.id, qid = currentQuestion.id;
    void perform('regenerate', async () => {
      const result = await request<{ question: InterviewDetail['questions'][number]; answer: InterviewAnswer }>(`/interviews/${id}/questions/${qid}/answer`, { method: 'POST', body: {} });
      if (selectedRef.current === id) setDetail(current => applyInterviewEvent(current, { type: 'interview.answer', sessionId: id, answer: result.answer }));
    }, id);
  };

  return <div className="interview-workspace">
    <div className="page-heading"><div><div className="eyebrow">LISTEN. REMEMBER. RESPOND.</div><h1>每一轮对话，都有上下文<span>。</span></h1><p>电脑持续收听，由你触发回答；音频直答与转写回答自由选择。</p></div><button className="button primary" disabled={!(config?.configured||config?.audioConfigured) || hasRecording} title={hasRecording ? '请先结束当前进行中的面试' : undefined} onClick={() => setShowCreate(value => !value)}><Plus size={17} />创建面试会话</button></div>
    {config?.asrTransport==='http'&&<div className="interview-notice"><AudioLines size={17}/><span>当前使用 HTTP 分段转写（最长 {config.asrChunkSeconds||4} 秒），短暂停顿后更新字幕；点击回答或按快捷键会先识别尚未提交的语音。</span></div>}
    {active&&detail.segments.some(s=>s.track==='self')&&!detail.segments.some(s=>s.track==='remote')&&<div className="interview-notice"><Monitor size={17}/><span>已收到本人麦克风转写，尚未收到远端提问。回答快捷键使用远端/系统声音；测试时请播放对方声音，并在电脑客户端的录音预检中确认两路电平均有变化。</span></div>}
    {audioWarnings.length>0&&<div className="interview-notice"><AudioLines size={17}/><span>{audioWarnings[0]}</span></div>}
    {notice && <div className={`interview-notice ${notice.error ? 'is-error' : ''}`} role={notice.error ? 'alert' : 'status'}><span>{notice.text}</span><button className="icon-button" aria-label="关闭面试提示" onClick={() => setNotice(null)}><X size={15} /></button></div>}
    {config && !config.configured && (!active || !nativeWithoutTranscript) && <div className="interview-notice asr-missing"><span className="round-icon"><Mic size={19} /></span><div><strong>语音识别尚未配置</strong><p>请管理员在服务器配置百炼 API Key、业务空间和地域。转写模式录音需完成此配置；音频直答可使用单独配置的音频模型。已有记录仍可查看、导出。</p></div></div>}
    {isAdmin&&<details className="panel interview-preferences"><summary><Sparkles size={15}/>默认面试配置<ChevronDown size={14}/></summary><form onSubmit={event=>{event.preventDefault();void perform('preferences',async()=>{const result=await request<{preferences:InterviewPreferences}>('/interviews/preferences',{method:'PATCH',body:preferences});const next=interviewPreferences(config||{},result.preferences);setPreferences(next);setDraft(current=>({...current,...next,autoAnswer:false}));setNotice({text:'默认配置已保存，新会话和电脑客户端可使用此配置',error:false});});}}><div className="interview-mode-grid"><ModeOptions value={preferences} onChange={changes=>setPreferences(current=>({...current,...changes}))} prefix="默认" models={audioModels} providers={interviewProviders} config={config} showBoth/></div><div className="interview-preferences-footer"><span>与截图配置分别保存。语音识别与直接音频回答使用百炼 API；文字回答的 Codex、Claude 模型各自保留。默认手动触发。</span><button className="button primary compact" disabled={busy==='preferences'}>保存默认配置</button></div></form></details>}
    {config&&!config.audioConfigured&&(draft.mode==='audio'||active?.mode==='audio')&&<div className="interview-notice is-error" role="alert"><AudioLines size={17}/><span>音频直答尚未配置，请管理员在服务器设置音频模型的 Key、业务空间和模型权限。</span></div>}
    {showCreate && <form className="panel interview-create" onSubmit={createInterview}><div className="panel-heading"><span className="panel-title"><Plus size={17} />新建面试会话</span><button type="button" className="icon-button" aria-label="关闭新建面试" onClick={() => setShowCreate(false)}><X size={17} /></button></div><div className="interview-create-grid"><label>会话名称<input aria-label="面试会话名称" placeholder="例如：后端工程师 · 一面" maxLength={120} value={draft.title} onChange={event => setDraft(current => ({ ...current, title: event.target.value }))} /></label><ModeOptions modelsReadOnly={!isAdmin} value={draft} onChange={changes=>setDraft(current=>({...current,...changes,autoAnswer:changes.mode==='audio'?false:current.autoAnswer}))} prefix="新会话" models={audioModels} providers={interviewProviders} config={config}/><label>回答风格<select aria-label="面试回答风格" value={draft.promptId} onChange={event => setDraft(current => ({ ...current, promptId: event.target.value }))}><option value="">账号默认风格</option>{prompts.map(prompt => <option key={prompt.id} value={prompt.id}>{prompt.name}</option>)}</select></label><label className="interview-hotwords">本场识别热词 <span className="optional-label">可选</span><textarea aria-label="面试识别热词" rows={2} maxLength={4000} placeholder="Redis、Kubernetes、你的项目名称……用逗号或换行分隔，最多 50 个。" value={draft.hotwords} onChange={event => setDraft(current => ({ ...current, hotwords: event.target.value }))} /></label></div><div className="interview-create-footer"><label className="check-label"><input type="checkbox" checked={draft.mode==='transcript'&&draft.autoAnswer} disabled={draft.mode==='audio'||!config?.autoAnswerAvailable} onChange={event => setDraft(current => ({ ...current, autoAnswer: event.target.checked }))} />自动回答（可选；默认由快捷键触发）</label><button className="button primary compact" disabled={busy === 'create' || !modeReady(config,draft.mode)}>{busy === 'create' ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}保存并创建</button></div></form>}
    <div className="interview-layout">
      {selectedId && <button type="button" className="interview-history-picker" aria-label="切换面试会话" aria-expanded={historyExpanded} onClick={() => setHistoryExpanded(value => !value)}><MessageSquare size={15} /><span>切换会话</span><strong>{active?.title || '正在同步会话'}</strong><ChevronDown size={14} /></button>}
      <aside className={`panel interview-history ${selectedId && !historyExpanded ? 'is-collapsed' : ''}`} aria-label="面试会话历史"><div className="panel-heading"><span className="panel-title"><MessageSquare size={17} />面试会话 <small>{interviews.length}</small></span><button className="icon-button" aria-label="刷新面试记录" onClick={() => void perform('refresh', async () => { await Promise.all([refreshList(), refreshDetail(), request<InterviewConfig>('/interviews/config').then(setConfig)]); })}><RefreshCw size={15} className={busy === 'refresh' ? 'spin' : ''} /></button></div><label className="interview-history-search"><Search size={14} /><input aria-label="搜索面试会话" placeholder="搜索面试记录" value={search} onChange={event => setSearch(event.target.value)} /></label><div className="interview-session-list">{loading ? <div className="interview-loading"><LoaderCircle className="spin" size={20} />正在读取会话</div> : visibleInterviews.length ? visibleInterviews.map(item => <button className={`interview-session ${selectedId === item.id ? 'selected' : ''}`} key={item.id} onClick={() => { setSelectedId(item.id); setHistoryExpanded(false); }}><span className={`session-dot session-${item.status}`} /><span><strong>{item.title}</strong><small>{formatDate(item.createdAt)} · {providerName(item.provider)}</small><span className={`session-state session-${item.status}`}>{statusText[item.status]}</span></span><ArrowRight size={13} /></button>) : <div className="interview-small-empty"><AudioLines size={28} /><strong>{search ? '没有匹配的会话' : '还没有面试记录'}</strong><p>在电脑客户端开始录音，或先创建一场会话。</p></div>}</div><div className="interview-history-note"><ShieldCheck size={14} /><span>记录仅在当前账号内同步</span></div></aside>
      <div className="interview-current" role="region" aria-label="当前面试">
        {!active && !detailLoading ? <div className="panel interview-welcome"><span className="interview-welcome-icon"><AudioLines size={42} strokeWidth={1.3} /></span><span className="eyebrow">A CONVERSATION THAT STAYS WITH YOU</span><h2>把对话，完整留在这里。</h2><p>选择一场会话，或在 Windows 客户端开始录音。<br />面试官提问、你的实际回答与 AI 建议会分别保存。</p><div className="interview-welcome-steps"><span><Monitor size={17} />电脑双路采音</span><ArrowRight size={14} /><span><FileText size={17} />云端实时转写</span><ArrowRight size={14} /><span><Sparkles size={17} />结合历史回答</span></div></div> : <>
          <section className="panel interview-session-header"><div className="interview-session-heading"><div className="interview-title"><span className={`recording-orb ${active?.status || ''}`}><AudioLines size={20} /></span><div>{editingTitle ? <form className="interview-title-edit" onSubmit={event => { event.preventDefault(); updateInterview({ title: titleDraft.trim() }); }}><input aria-label="编辑面试名称" value={titleDraft} onChange={event => setTitleDraft(event.target.value)} maxLength={120} required /><button className="icon-button" aria-label="保存面试名称" disabled={busy === 'settings'}><Check size={16} /></button><button type="button" className="icon-button" aria-label="取消编辑名称" onClick={() => setEditingTitle(false)}><X size={16} /></button></form> : <h2>{active?.title || '正在读取会话'}{active && <button className="icon-button" aria-label="修改面试名称" onClick={() => { setTitleDraft(active.title); setEditingTitle(true); }}><Pencil size={13} /></button>}</h2>}<p><Clock3 size={12} />{formatDate(active?.createdAt)}<span>·</span>{active ? statusText[active.status] : '同步中'}</p></div></div><div className="interview-session-actions">{active?.status === 'recording' && <button className="button secondary compact" disabled={!!busy} onClick={() => changeState('pause')}><Pause size={14} />暂停会话</button>}{active?.status === 'paused' && <button className="button secondary compact" disabled={!!busy || !modeReady(config,active.mode)} onClick={() => changeState('resume')}><Play size={14} />继续会话</button>}{active && active.status !== 'ended' && <button className="button secondary compact interview-end" disabled={!!busy} onClick={() => changeState('end')}><Square size={13} />结束会话</button>}</div></div><div className="interview-session-meta"><span><Monitor size={13} />{recorder?.name || (active?.deviceId ? '已绑定电脑' : '等待电脑连接采音')}</span><span className={audioReady ? 'audio-connected' : ''}><span className={`tiny-dot ${audioReady ? 'green' : 'neutral'}`} />{active?.status === 'ended' ? '录音已结束' : active?.status === 'paused' ? '采音已暂停' : audioReady ? '正在接收音频' : '等待客户端音频'}</span><span><BookOpen size={13} />{active?.promptName || '默认风格'}</span><span className="interview-mode-badge">{active?.mode==='audio'?'直接语音理解':'转写后回答'} · {active?.mode==='audio'?(active.audioModel||'Qwen-Omni'):`${providerName(active?.provider||defaultProvider)} · ${active?.textModels?.[active.provider]||'默认模型'}`}</span></div><details className="interview-session-config"><summary>本场回答配置<ChevronDown size={13}/></summary><div className="interview-active-settings"><ModeOptions modelsReadOnly={!isAdmin} value={interviewPreferences(config||{},active||{})} onChange={changes=>updateInterview({...changes,...(changes.mode==='audio'?{autoAnswer:false}:{})})} disabled={!canConfigure} prefix="面试" models={audioModels} providers={interviewProviders} config={config}/><label className="check-label interview-auto"><input type="checkbox" aria-label="自动回答面试提问" checked={active?.mode!=='audio'&&!!active?.autoAnswer} disabled={!active||active.mode==='audio'||active.status==='ended'||busy==='settings'||!config?.autoAnswerAvailable} onChange={event=>updateInterview({autoAnswer:event.target.checked})}/>自动回答（可选）</label><span className="interview-settings-note">回答方式与模型请暂停后切换。</span></div></details></section>
          {(audioErrors.length > 0 || active?.error) && <div className="interview-notice is-error" role="alert"><WifiOff size={17} /><span>{audioErrors[0] || active?.error}</span></div>}
          {active?.mode==='audio'&&<div className="interview-native-note"><AudioLines size={16}/><div><strong>{nativeWithoutTranscript?'后台转写已关闭':'音频直接用于回答，后台转写留档'}</strong><p>{nativeWithoutTranscript?'原始声音与 AI 建议分开保存；没有逐字文字记录。回答上下文使用有限时长音频，较早未转写内容可能未被选入。':'回答不等待文字转写，后台原话用于记录、检索与后续上下文。'}</p><span>原始录音按服务端保留策略提供：</span>{active.audioAvailable===false?<span>暂无保留录音</span>:<><a href={`/api/interviews/${active.id}/audio/remote`}>远端录音</a><a href={`/api/interviews/${active.id}/audio/self`}>本人录音</a></>}</div></div>}
          {detail.gaps.length > 0 && <details className="interview-gap"><summary><WifiOff size={15} />存在 {detail.gaps.length} 处录音中断或补传记录<ChevronDown size={14} /></summary><p>中断区间可能缺少实时转写。补传用于补齐历史，不会自动回答过时的问题。</p>{detail.gaps.map(gap => <div key={gap.id}><span>{typeof gap.startMs !== 'number' ? formatDate(gap.createdAt) : `${timestamp(gap.startMs)}${typeof gap.endMs !== 'number' ? '' : `–${timestamp(gap.endMs)}`}`}</span><span>{gap.reason || gap.message || '音频连接中断，等待恢复'}</span></div>)}</details>}
          {answerContext && <details className="interview-context"><summary><BookOpen size={14} />本次回答的对话依据<ChevronDown size={13} /></summary><p>{answerContext.summary}</p><span>选入 {answerContext.segmentIds.length} 段双方实际发言；全量原话保存在本场记录中。</span></details>}
          <div className="interview-compact-switch" role="group" aria-label="平板内容切换">
            <button type="button" aria-label="查看 AI 建议" aria-pressed={compactView === 'suggestions'} onClick={() => setCompactView('suggestions')}><Sparkles size={15} />AI 建议</button>
            <button type="button" aria-label="查看双方原话" aria-pressed={compactView === 'transcript'} onClick={() => setCompactView('transcript')}><AudioLines size={15} />双方原话 <small>{detail.segments.length}</small></button>
          </div>
          <div className={`interview-dialogue-grid view-${compactView}`}>
            <section className="panel interview-transcript" role="region" aria-label="面试转写时间线"><div className="panel-heading"><span className="panel-title"><AudioLines size={17} />双方实际发言 <small>{detail.segments.length}</small></span><label className="check-label follow-control"><input type="checkbox" checked={followTranscript} onChange={event => setFollowTranscript(event.target.checked)} />跟随最新</label></div><div className="interview-transcript-toolbar"><span><i className="remote-key" />远端发言</span><span><i className="self-key" />本人发言</span><label><Search size={13} /><input aria-label="搜索面试转写" placeholder="搜索转写" value={transcriptSearch} onChange={event => setTranscriptSearch(event.target.value)} /></label></div><div className="transcript-scroll">{detail.segmentsTruncated && <div className="transcript-older"><span>更早记录仍保存在云端，导出可获取完整会话。</span><button className="text-button" disabled={busy === 'older'} onClick={() => void perform('older', () => refreshDetail(active?.id, detail.nextCursor ?? Math.min(...detail.segments.map(item => item.startMs))))}>加载更早记录</button></div>}{detailLoading ? <div className="interview-loading"><LoaderCircle className="spin" size={20} />正在同步转写</div> : visibleSegments.length ? visibleSegments.map(segment => <article className={`transcript-entry transcript-${segment.track} ${segment.final ? '' : 'is-partial'}`} key={segment.id} data-segment-id={segment.id}><div className="transcript-speaker"><span>{segment.track === 'remote' ? <Monitor size={13} /> : <Mic size={13} />}{segment.track === 'remote' ? '远端' : '本人'}</span><time>{timestamp(segment.startMs)}</time>{!segment.final && <small className="partial-label"><span />识别中</small>}{segment.replay && <small>补传</small>}{segment.revision > 1 && segment.final && <small title="识别结果已修订">已修订</small>}{segment.track === 'remote' && segment.final && <input type="checkbox" aria-label={`选择远端发言：${segment.text}`} checked={selectedSegments.includes(segment.id)} onChange={event => setSelectedSegments(items => event.target.checked ? [...items, segment.id] : items.filter(id => id !== segment.id))} />}</div><p>{segment.text}{!segment.final && <span className="transcript-cursor" />}</p></article>) : <div className="interview-transcript-empty"><AudioLines size={34} strokeWidth={1.2} /><h3>{transcriptSearch ? '没有匹配的发言' : nativeWithoutTranscript?'当前使用音频记录':'等待第一句对话'}</h3><p>{transcriptSearch ? '换一个关键词试试。' : nativeWithoutTranscript?'后台转写关闭时，这里不生成逐字字幕；请查看上方保留录音。':'在电脑客户端开始采音后，远端与本人声音会分别转写到这里。'}</p></div>}<div ref={transcriptEnd} /></div><div className="transcript-bottom-note"><ShieldCheck size={12} />原话按时间保存；临时转写会在终稿到达后更新。</div></section>
            <section className="panel interview-assistant" role="region" aria-label="AI 回答建议"><div className="panel-heading"><span className="panel-title"><Sparkles size={17} />AI 回答建议</span><button type="button" className="button primary compact interview-trigger" disabled={!active||!['recording','paused'].includes(active.status)||busy==='trigger'||!modeReady(config,active.mode)} onClick={trigger}>{busy==='trigger'?<LoaderCircle size={14} className="spin"/>:<Sparkles size={14}/>}回答当前问题</button></div><div className="interview-suggestion-note">快捷键默认 Ctrl + Alt + Enter，也可点击“回答当前问题”。建议单独保存，不代表你已经说出。</div>{detail.questions.length > 0 && <div className="interview-question-picker"><label>当前提问<select aria-label="查看面试提问" value={currentQuestion?.id || ''} onChange={event => { setQuestionId(event.target.value); setFollowLatest(false); }}>{[...detail.questions].reverse().map(item => <option key={item.id} value={item.id}>{item.text.slice(0, 100)}</option>)}</select></label><label className="check-label"><input type="checkbox" checked={followLatest} onChange={event => { setFollowLatest(event.target.checked); if (event.target.checked) setQuestionId(detail.questions[detail.questions.length - 1]?.id || ''); }} />跟随新提问</label></div>}<div className="interview-answer-scroll" aria-live="polite" aria-busy={latestAnswer ? activeAnswer(latestAnswer) : false}>{currentQuestion && <div className="interview-current-question"><MessageSquare size={15} /><div><p>{currentQuestion.text}</p>{currentQuestion.audioTruncated&&<small className="interview-truncation">当前问题音频已按时长上限节选；可调整问题音频上限后重新触发。</small>}</div></div>}{latestAnswer ? <><div className="interview-answer-meta"><span className="ai-avatar"><Sparkles size={14} /></span><strong>{providerName(latestAnswer.provider)}</strong>{(latestAnswer.model||latestAnswer.audioModel)&&<small>{latestAnswer.model||latestAnswer.audioModel}</small>}<span className={`status-badge status-${latestAnswer.status}`}>{activeAnswer(latestAnswer) && <LoaderCircle className="spin" size={11} />}{answerStatus[latestAnswer.status]}</span>{latestAnswer.contextSnapshotId && <small title="已保存本次生成所用的上下文">已关联会话上下文</small>}</div>{latestAnswer.text ? <div className="markdown interview-answer-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{latestAnswer.text}</Markdown>{activeAnswer(latestAnswer) && <span className="writing-cursor" />}</div> : activeAnswer(latestAnswer) ? <div className="interview-thinking"><LoaderCircle size={22} className="spin" /><span>正在结合前文整理回答…</span></div> : null}{latestAnswer.error && <div className="inline-error">{latestAnswer.error}</div>}{latestAnswer.sources && latestAnswer.sources.length > 0 && <details className="source-details"><summary><BookOpen size={14} />参考了 {latestAnswer.sources.length} 个知识片段</summary>{latestAnswer.sources.map((source, index) => <div key={`${source.name}-${index}`}><strong>{source.name}</strong><p>{source.excerpt}</p></div>)}</details>}<div className="interview-answer-actions">{activeAnswer(latestAnswer) ? <button className="button secondary compact" disabled={busy === 'cancel-answer'} onClick={() => { const id = active!.id; void perform('cancel-answer', async () => { const result = await request<{ answer: InterviewAnswer }>(`/interviews/${id}/answers/${latestAnswer.id}/cancel`, { method: 'POST', body: {} }); if (selectedRef.current === id) setDetail(current => applyInterviewEvent(current, { type: 'interview.answer', sessionId: id, answer: result.answer })); }, id); }}><Square size={12} />取消回答</button> : <button className="button secondary compact" disabled={busy === 'regenerate'} onClick={regenerate}><RefreshCw size={13} />重新生成建议</button>}{latestAnswer.text && <button className="text-button" onClick={() => { void Promise.resolve().then(() => navigator.clipboard.writeText(latestAnswer.text)).then(() => setNotice({ text: '建议已复制', error: false })).catch(() => setNotice({ text: '自动复制不可用，请选择文字复制', error: true })); }}>复制建议</button>}</div>{currentAnswers.length > 1 && <details className="interview-previous-answers"><summary>查看此前 {currentAnswers.length - 1} 次生成</summary>{currentAnswers.slice(0, -1).reverse().map(answer => <div key={answer.id}><span>{providerName(answer.provider)}{answer.model ? ` · ${answer.model}` : ''} · {answerStatus[answer.status]} · {formatDate(answer.createdAt)}</span><p>{answer.text || answer.error || '无回答内容'}</p></div>)}</details>}</> : <div className="interview-transcript-empty suggestion-empty"><Sparkles size={34} strokeWidth={1.3} /><h3>下一句提问，接着前文思考。</h3><p>在电脑按回答快捷键，或点击“回答当前问题”。也可以选择远端发言或输入文字提问。</p></div>}</div><form className="interview-question-form" onSubmit={ask}><div className="interview-manual-label"><label htmlFor="interview-question">补充或整理提问</label>{selectedSegments.length > 0 && <button type="button" className="text-button" onClick={() => setSelectedSegments([])}>清除已选 {selectedSegments.length} 段</button>}</div>{selectedText && <div className="interview-selected-text">{selectedText}</div>}<textarea id="interview-question" value={question} onChange={event => setQuestion(event.target.value)} placeholder="选择远端发言，或输入需要回答的问题…" maxLength={8000} rows={2} /><div><span>文字提问使用本场文字模型；本人发言仅作为历史依据。</span><button className="button primary compact" disabled={!active || busy === 'ask' || (!selectedSegments.length && !question.trim()) || !config?.autoAnswerAvailable}>{busy === 'ask' ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}生成回答<ArrowRight size={13} /></button></div></form></section>
          </div>
          {active?.mode!=='audio'&&active?.audioAvailable&&<div className="interview-native-note"><AudioLines size={16}/><div><strong>本场保留录音</strong><p>包含本场已保存的双方实际声音，切换回答模式不会删除先前录音。</p><a href={`/api/interviews/${active.id}/audio/remote`}>远端录音</a><a href={`/api/interviews/${active.id}/audio/self`}>本人录音</a></div></div>}
          <div className="interview-session-footer"><span><ShieldCheck size={13} />双方原话与 AI 建议分别保存</span><div>{active && <><a className="button secondary compact" href={`/api/interviews/${active.id}/export?format=md`}><ArrowDownToLine size={13} />导出 Markdown</a><a className="button secondary compact" href={`/api/interviews/${active.id}/export?format=json`}><FileText size={13} />导出 JSON</a><button className="icon-button danger-hover" aria-label="删除面试会话" disabled={busy === 'delete'} onClick={() => { const id = active.id; if (window.confirm('删除本场面试的转写、AI 建议及保留音频？此操作无法撤销。')) void perform('delete', async () => { await request(`/interviews/${id}`, { method: 'DELETE' }); setInterviews(items => items.filter(item => item.id !== id)); if (selectedRef.current === id) setSelectedId(interviews.find(item => item.id !== id)?.id || ''); setNotice({ text: '面试会话已删除', error: false }); }, id); }}><Trash2 size={15} /></button></>}</div></div>
        </>}
      </div>
    </div>
  </div>;
}
