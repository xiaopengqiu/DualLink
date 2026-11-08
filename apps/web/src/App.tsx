import { captureId } from './uuid.mjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ArrowDownToLine, ArrowRight, BookOpen, Check, CheckCheck, ChevronRight, CircleHelp, Copy, FileText, ImagePlus, LayoutDashboard, Link2, LoaderCircle, LogOut, Maximize2, Monitor, MoreHorizontal, Plus, RefreshCw, ScanLine, Search, Settings2, ShieldCheck, Sparkles, Square, Tablet, Trash2, Upload, Users, Wifi, WifiOff, X } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, ApiError } from './api';
import { RealtimeClient } from './realtime';
import InterviewPanel from './InterviewPanel';
import AiSettings from './AiSettings';
import { InterviewEventHub } from './interview-state.mjs';
import { AudioLines } from 'lucide-react';
import type { AppConfig, Capture, CaptureResult, Device, KnowledgeFile, Prompt, Provider, ScreenshotPreferences, Task, User } from './types';

type Page = 'workspace' | 'interviews' | 'devices' | 'prompts' | 'knowledge' | 'account' | 'users';
type Notice = { id: number; message: string; kind: 'success' | 'error' | 'info' };
const pageTitles: Record<Page, string> = { workspace: '截图工作台', interviews: '面试会话', devices: '连接设备', prompts: '回答风格', knowledge: '我的知识库', account: '账号设置', users: '用户管理' };
const statusLabels: Record<Task['status'], string> = { queued: '等待处理', running: '正在分析', completed: '已完成', failed: '处理失败', cancelled: '已取消' };
const providerName = (provider: Provider) => provider === 'claude' ? 'Claude' : 'Codex';
const formatTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const formatDate = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const fileSize = (size: number) => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
const upsert = <T extends { id: string }>(items: T[], item: T) => [item, ...items.filter(existing => existing.id !== item.id)].sort((a, b) => String((b as T & { createdAt?: string }).createdAt || '').localeCompare(String((a as T & { createdAt?: string }).createdAt || '')));

function Brand({ light = false }: { light?: boolean }) { return <div className={`brand ${light ? 'brand-light' : ''}`}><span className="brand-mark"><Monitor size={21} strokeWidth={1.8} /><Tablet size={15} strokeWidth={2} /></span><span><strong>双端互联</strong><small>DUAL LINK</small></span></div>; }
function Spinner({ label = '正在加载' }: { label?: string }) { return <span className="spinner-label"><LoaderCircle className="spin" size={17} />{label}</span>; }
function EmptyState({ icon, title, text, children }: { icon: ReactNode; title: string; text: string; children?: ReactNode }) { return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{text}</p>{children}</div>; }
function StatusBadge({ status }: { status: Task['status'] }) { return <span className={`status-badge status-${status}`}>{status === 'running' || status === 'queued' ? <LoaderCircle size={12} className="spin" /> : status === 'completed' ? <Check size={12} /> : null}{statusLabels[status]}</span>; }

export default function App() {
  const initialPair = useMemo(() => new URLSearchParams(location.search).get('pair') || '', []);
  const initialInterview = useMemo(() => new URLSearchParams(location.search).get('interview') || '', []);
  const interviewEvents = useMemo(() => new InterviewEventHub(), []);
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [page, setPage] = useState<Page>(initialPair ? 'devices' : initialInterview ? 'interviews' : 'workspace');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeFile[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider>('codex');
  const [screenshotModels, setScreenshotModels] = useState<Record<Provider,string>>({codex:'',claude:''});
  const [promptId, setPromptId] = useState('');
  const [question, setQuestion] = useState('');
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [directCount, setDirectCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [localPreview, setLocalPreview] = useState<{ url: string; captureId: string } | null>(null);
  const [historyQuery, setHistoryQuery] = useState('');
  const [pairCode, setPairCode] = useState(initialPair);
  const [promptDraft, setPromptDraft] = useState({ id: '', name: '', content: '', isDefault: false });
  const [diagnostics, setDiagnostics] = useState<unknown>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const knowledgeRef = useRef<HTMLInputElement>(null);
  const autoAnalyzeRef = useRef(autoAnalyze);
  const userIdRef = useRef(user?.id);
  autoAnalyzeRef.current = autoAnalyze;
  userIdRef.current = user?.id;

  const notify = useCallback((message: string, kind: Notice['kind'] = 'success') => setNotice({ id: Date.now(), message, kind }), []);
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(null), notice.kind === 'error' ? 9000 : 4500); return () => clearTimeout(timer); } }, [notice]);
  const handleError = useCallback((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    if (error instanceof ApiError && error.status === 401) { setUser(null); api.setCsrfToken(''); notify('登录已失效，请重新登录', 'info'); return; }
    notify(error instanceof Error ? error.message : '操作失败，请稍后重试', 'error');
  }, [notify]);

  useEffect(() => {
    const abort = new AbortController();
    api.request<{ user: User; csrfToken: string }>('/auth/me', { signal: abort.signal }).then(result => {
      if (!abort.signal.aborted) { api.setCsrfToken(result.csrfToken); setUser(result.user); }
    }).catch(error => { if (!(error instanceof ApiError && error.status === 401) && !abort.signal.aborted) handleError(error); }).finally(() => { if (!abort.signal.aborted) setBooting(false); });
    return () => abort.abort();
  }, [handleError]);

  const loadWorkspace = useCallback(async () => {
    const currentUserId = userIdRef.current;
    if (!currentUserId) return;
    try {
      const [captureResult, taskResult, deviceResult, promptResult, knowledgeResult] = await Promise.all([
        api.request<{ captures: Capture[] }>('/captures?limit=100'), api.request<{ tasks: Task[] }>('/tasks?limit=100'), api.request<{ devices: Device[] }>('/devices'), api.request<{ prompts: Prompt[] }>('/prompts'), api.request<{ files: KnowledgeFile[] }>('/knowledge'),
      ]);
      if (userIdRef.current !== currentUserId) return;
      setCaptures(captureResult.captures); setTasks(taskResult.tasks); setDevices(deviceResult.devices); setPrompts(promptResult.prompts); setKnowledge(knowledgeResult.files);
      setSelectedId(current => captureResult.captures.some(capture => capture.id === current) ? current : captureResult.captures[0]?.id || null);
      setPromptId(current => promptResult.prompts.some(prompt => prompt.id === current) ? current : promptResult.prompts.find(prompt => prompt.isDefault)?.id || promptResult.prompts[0]?.id || '');
    } catch (error) { if (userIdRef.current === currentUserId) handleError(error); }
  }, [handleError]);

  useEffect(() => {
    // Everything below belongs to one account, including transient form and blob state.
    // Reset on both logout and a direct account-ID change before loading the next workspace.
    setConfig(null); setCaptures([]); setTasks([]); setSelectedId(null);
    setDevices([]); setPrompts([]); setKnowledge([]); setUsers([]);
    setLocalPreview(null); setQuestion(''); setHistoryQuery(''); setPromptId('');
    setProvider('codex'); setScreenshotModels({codex:'',claude:''}); setAutoAnalyze(true); setBusy(''); setNotice(null); setDiagnostics(null);
    setDirectCount(0); setConnection('connecting');
    setPromptDraft({ id: '', name: '', content: '', isDefault: false });
    setPage(initialPair ? 'devices' : initialInterview ? 'interviews' : 'workspace'); setPairCode(initialPair);
    if (!user) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    void Promise.all([loadWorkspace(), api.request<AppConfig>('/config').then(result => { if (!cancelled) { setConfig(result); setProvider(result.screenshotPreferences?.provider||result.defaultProvider); setScreenshotModels({codex:result.screenshotPreferences?.models.codex||'',claude:result.screenshotPreferences?.models.claude||''}); setAutoAnalyze(result.autoAnalyze ?? true); } })]).catch(handleError).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user?.id, initialPair, initialInterview, handleError, loadWorkspace]);

  useEffect(() => {
    if (!user || !config) return;
    const realtime = new RealtimeClient({
      config, autoAnalyze: () => autoAnalyzeRef.current, onConnection: setConnection, onDirectCount: setDirectCount,
      onCapture: capture => { setCaptures(previous => upsert(previous, capture)); setSelectedId(capture.id); setLocalPreview(previous => previous?.captureId === capture.captureId ? null : previous); },
      onTask: task => setTasks(previous => upsert(previous, task)),
      onDelta: (taskId, delta) => setTasks(previous => previous.map(task => task.id === taskId ? { ...task, answer: (task.answer || '') + delta } : task)),
      onDevices: setDevices, onError: handleError, onRestore: () => { void loadWorkspace(); if (userIdRef.current === user.id) interviewEvents.publish(user.id, { type: 'interview.restore' }); },
      onInterviewEvent: event => { if (userIdRef.current === user.id) interviewEvents.publish(user.id, event); },
      onPreview: (blob, metadata) => setLocalPreview({ url: URL.createObjectURL(blob), captureId: metadata.captureId }),
      onUploaded: result => { setCaptures(previous => upsert(previous, result.capture)); setSelectedId(result.capture.id); if (result.task) setTasks(previous => upsert(previous, result.task!)); setLocalPreview(null); },
    });
    realtime.start();
    const restore = () => { if (document.visibilityState === 'visible') void loadWorkspace(); };
    document.addEventListener('visibilitychange', restore);
    return () => { realtime.stop(); document.removeEventListener('visibilitychange', restore); };
  }, [user?.id, config, handleError, loadWorkspace, interviewEvents]);
  useEffect(() => () => { if (localPreview) URL.revokeObjectURL(localPreview.url); }, [localPreview]);

  useEffect(() => {
    if (!user || !knowledge.some(file => file.status === 'processing')) return;
    const timer = setInterval(() => { void api.request<{ files: KnowledgeFile[] }>('/knowledge').then(result => setKnowledge(result.files)).catch(handleError); }, 2500);
    return () => clearInterval(timer);
  }, [knowledge, user?.id, handleError]);
  useEffect(() => { if (page === 'users' && user?.role === 'admin') void api.request<{ users: User[] }>('/admin/users').then(result => setUsers(result.users)).catch(handleError); }, [page, user?.role, handleError]);

  const perform = async <T,>(key: string, action: () => Promise<T>, message?: string): Promise<T | undefined> => {
    const accountId = userIdRef.current;
    setBusy(key);
    try { const result = await action(); if (message && userIdRef.current === accountId) notify(message); return result; }
    catch (error) { if (userIdRef.current === accountId) handleError(error); return undefined; }
    finally { if (userIdRef.current === accountId) setBusy(current => current === key ? '' : current); }
  };
  const selected = captures.find(capture => capture.id === selectedId);
  const selectedTask = tasks.filter(task => task.captureId === selected?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const filteredCaptures = captures.filter(capture => !historyQuery || `${capture.deviceName || ''} ${formatDate(capture.createdAt)} ${tasks.filter(task => task.captureId === capture.id).map(task => `${task.question} ${task.answer}`).join(' ')}`.toLowerCase().includes(historyQuery.toLowerCase()));
  const onlineDevices = devices.filter(device => device.online).length;

  const acceptUpload = async (file: File | undefined) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { notify('请选择 PNG、JPEG 或 WebP 图片', 'error'); return; }
    if (file.size > (config?.maxUploadBytes || 12 * 1024 * 1024)) { notify('图片过大，请上传不超过 12 MB 的图片', 'error'); return; }
    const form = new FormData(); form.append('image', file); form.append('captureId', captureId()); form.append('provider', provider); form.append('model', screenshotModels[provider].trim()); form.append('analyze', String(autoAnalyze)); if (promptId) form.append('promptId', promptId); if (question) form.append('question', question);
    await perform('upload', async () => { const result = await api.request<CaptureResult>('/captures', { method: 'POST', body: form }); setCaptures(previous => upsert(previous, result.capture)); setSelectedId(result.capture.id); if (result.task) setTasks(previous => upsert(previous, result.task!)); setPage('workspace'); }, autoAnalyze ? '截图已提交，正在等待分析' : '截图已保存，可在预览后开始分析');
    if (uploadRef.current) uploadRef.current.value = '';
  };

  const updateAutoAnalyze = async (next: boolean) => {
    const previous = autoAnalyze;
    const currentUserId = userIdRef.current;
    setAutoAnalyze(next);
    setBusy('settings');
    try {
      await api.request('/settings', { method: 'PUT', body: { autoAnalyze: next } });
      if (userIdRef.current === currentUserId) setConfig(current => current ? { ...current, autoAnalyze: next } : current);
    } catch (error) {
      if (userIdRef.current === currentUserId) { setAutoAnalyze(previous); handleError(error); }
    } finally { setBusy(current => current === 'settings' ? '' : current); }
  };

  const analyzeCapture = async () => {
    if (!selected) return;
    await perform('analyze', async () => { const { task } = await api.request<{ task: Task }>(`/captures/${selected.id}/analyze`, { method: 'POST', body: { provider, model:screenshotModels[provider].trim(), promptId: promptId || undefined, question } }); setTasks(previous => upsert(previous, task)); });
  };
  const saveScreenshotPreferences = async (event:FormEvent) => {
    event.preventDefault();
    await perform('screenshot-preferences',async()=>{
      const result=await api.request<{preferences:{screenshot:ScreenshotPreferences}}>('/model-preferences',{method:'PUT',body:{preferences:{screenshot:{provider,models:{codex:screenshotModels.codex.trim(),claude:screenshotModels.claude.trim()}}}}});
      const next=result.preferences.screenshot;
      setProvider(next.provider);setScreenshotModels(next.models);
      setConfig(current=>current?{...current,screenshotPreferences:next}:current);
    },'截图默认配置已保存，不影响面试模型配置');
  };
  const mutateTask = async (action: 'cancel' | 'retry') => {
    if (!selectedTask) return;
    await perform(action, async () => { const { task } = await api.request<{ task: Task }>(`/tasks/${selectedTask.id}/${action}`, { method: 'POST', body: {} }); setTasks(previous => upsert(previous, task)); }, action === 'cancel' ? '任务已取消' : '已重新加入处理队列');
  };
  const deleteCapture = async () => {
    if (!selected || !window.confirm('删除这张截图及相关回答？此操作无法撤销。')) return;
    await perform('deleteCapture', async () => { await api.request(`/captures/${selected.id}`, { method: 'DELETE' }); setCaptures(previous => previous.filter(capture => capture.id !== selected.id)); setTasks(previous => previous.filter(task => task.captureId !== selected.id)); setSelectedId(captures.find(capture => capture.id !== selected.id)?.id || null); }, '截图已删除');
  };
  const copyAnswer = async () => { try { await navigator.clipboard.writeText(selectedTask?.answer || ''); notify('回答已复制'); } catch { notify('浏览器不允许自动复制，请长按选择回答内容', 'info'); } };

  const uploadKnowledge = async (files: FileList | null) => {
    if (!files?.length) return;
    await perform('knowledgeUpload', async () => {
      for (const file of Array.from(files).slice(0, 10)) {
        if (!/\.(txt|md|pdf|docx)$/i.test(file.name)) throw new Error('知识库支持 TXT、Markdown、PDF 和 DOCX 文件');
        if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} 超过 10 MB 限制`);
        const form = new FormData(); form.append('file', file);
        const result = await api.request<{ file: KnowledgeFile }>('/knowledge', { method: 'POST', body: form }); setKnowledge(previous => upsert(previous, result.file));
      }
    }, '知识文件已上传');
    if (knowledgeRef.current) knowledgeRef.current.value = '';
  };
  const savePrompt = async (event: FormEvent) => {
    event.preventDefault();
    await perform('savePrompt', async () => {
      const { prompt } = await api.request<{ prompt: Prompt }>(promptDraft.id ? `/prompts/${promptDraft.id}` : '/prompts', { method: promptDraft.id ? 'PUT' : 'POST', body: { name: promptDraft.name, content: promptDraft.content, isDefault: promptDraft.isDefault } });
      setPromptDraft({ id: prompt.id, name: prompt.name, content: prompt.content, isDefault: prompt.isDefault });
      const result = await api.request<{ prompts: Prompt[] }>('/prompts'); setPrompts(result.prompts); if (prompt.isDefault) setPromptId(prompt.id);
    }, '回答风格已保存');
  };

  if (booting) return <div className="boot-screen"><Brand /><Spinner label="正在连接你的工作台" /></div>;
  if (!user) return <LoginScreen onLogin={(nextUser, token) => { api.setCsrfToken(token); setUser(nextUser); setPage(initialPair ? 'devices' : initialInterview ? 'interviews' : 'workspace'); }} notify={notify} />;

  const navigate = (next: Page) => { setPage(next); setHistoryQuery(''); };
  const nav = [{ id: 'workspace' as const, title: '截图工作台', icon: <LayoutDashboard size={19} /> }, { id: 'interviews' as const, title: '面试会话', icon: <AudioLines size={19} /> }, { id: 'devices' as const, title: '连接设备', icon: <Monitor size={19} /> }, { id: 'prompts' as const, title: '回答风格', icon: <Sparkles size={19} /> }, { id: 'knowledge' as const, title: '我的知识库', icon: <BookOpen size={19} /> }];

  return <div className="app-shell">
    <aside className="sidebar">
      <Brand light />
      <div className="sidebar-label">你的工作空间</div>
      <nav aria-label="主导航">{nav.map(item => <button key={item.id} aria-label={item.title} title={item.title} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)}>{item.icon}<span>{item.title}</span>{item.id === 'devices' && onlineDevices > 0 && <small>{onlineDevices}</small>}</button>)}</nav>
      <div className="sidebar-connection"><span className={`tiny-dot ${connection === 'online' ? 'green' : 'amber'}`} /><span>{connection === 'online' ? '云端连接正常' : connection === 'connecting' ? '正在连接云端' : '等待重新连接'}</span><Wifi size={14} /></div>
      <div className="sidebar-note"><span className="note-kicker">一个快捷键，两块屏幕</span><ScanLine size={27} /><p>在电脑捕捉问题，<br />在这里找到思路。</p><button onClick={() => navigate('devices')}>连接你的第一台电脑 <ArrowRight size={14} /></button></div>
      <div className="sidebar-bottom">{user.role === 'admin' && <button aria-label="用户管理" title="用户管理" className={`nav-item ${page === 'users' ? 'active' : ''}`} onClick={() => navigate('users')}><Users size={18} /><span>用户管理</span><ShieldCheck size={14} /></button>}<button aria-label="账号设置" title="账号设置" className={`nav-item ${page === 'account' ? 'active' : ''}`} onClick={() => navigate('account')}><Settings2 size={18} /><span>账号设置</span></button><div className="user-card"><span className="avatar">{(user.name || user.email)[0].toUpperCase()}</span><span><strong>{user.name}</strong><small>{user.role === 'admin' ? '管理员' : '个人账号'}</small></span><button aria-label="退出登录" title="退出登录" onClick={() => void perform('logout', async () => { await api.request('/auth/logout', { method: 'POST', body: {} }); api.setCsrfToken(''); setUser(null); })}><LogOut size={17} /></button></div></div>
    </aside>
    <div className="app-content">
      <header className="topbar"><div className="breadcrumb"><span>工作空间</span><ChevronRight size={14} /><strong>{pageTitles[page]}</strong></div><div className="topbar-right"><span className="today">{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())}</span><span className={`connection-pill ${connection === 'online' ? '' : 'disconnected'}`}>{connection === 'online' ? <Wifi size={13} /> : <WifiOff size={13} />}<span>{connection === 'online' ? '已连接' : '重连中'}</span></span><button className="mobile-account" aria-label="打开账号设置" onClick={() => navigate('account')}>{(user.name || user.email)[0].toUpperCase()}</button></div></header>
      <main className={`main main-${page}`}>
        {page === 'interviews' && <InterviewPanel isAdmin={user.role==='admin'} key={user.id} ownerId={user.id} events={interviewEvents} prompts={prompts} devices={devices} providers={config?.providers || ['codex', 'claude']} defaultProvider={config?.defaultProvider || 'codex'} initialId={initialInterview} connection={connection} onError={handleError} />}
        {page === 'workspace' && <>
          <div className="page-heading"><div><div className="eyebrow">CAPTURE. CONNECT. CLARIFY.</div><h1>让截图，成为答案<span>。</span></h1><p>捕捉电脑上的问题，结合你的知识与风格，接着往下想。</p></div><button className="button primary" onClick={() => uploadRef.current?.click()} disabled={busy === 'upload'}>{busy === 'upload' ? <LoaderCircle className="spin" size={17} /> : <ImagePlus size={18} />}上传截图</button></div>
          {user.role==='admin' && <details className="panel screenshot-preferences"><summary><Settings2 size={15}/><span>截图默认配置</span><small>与面试模型分别保存</small></summary><form onSubmit={saveScreenshotPreferences}><div className="screenshot-model-grid"><label>默认执行方式<select aria-label="截图默认执行方式" value={provider} onChange={event=>setProvider(event.target.value as Provider)}>{(config?.providers||['codex','claude']).map(item=><option key={item} value={item}>{providerName(item)} CLI</option>)}</select></label>{(['codex','claude'] as Provider[]).map(item=><label key={item}>{providerName(item)} 截图模型 ID<input aria-label={`${providerName(item)} 截图模型 ID`} maxLength={100} placeholder="留空使用服务器默认模型" value={screenshotModels[item]} onChange={event=>setScreenshotModels(current=>({...current,[item]:event.target.value}))}/></label>)}</div><div className="screenshot-model-footer"><span>可为截图选高质量模型。模型必须支持图片输入，并在对应 CLI 的接口中可用。下方本次配置可直接修改；保存后成为此账号默认值。</span><button className="button primary compact" disabled={busy==='screenshot-preferences'}>保存截图默认配置</button></div></form></details>}
          <div className="workspace-summary"><div><span className="summary-icon mint"><Monitor size={18} /></span><span><strong>{onlineDevices}<small> / {devices.length}</small></strong><small>电脑在线</small></span></div><div><span className="summary-icon lavender"><CheckCheck size={18} /></span><span><strong>{tasks.filter(task => task.status === 'completed').length}</strong><small>已完成回答</small></span></div><div><span className="summary-icon sand"><BookOpen size={18} /></span><span><strong>{knowledge.filter(file => file.status === 'ready').length}</strong><small>知识文件</small></span></div><div className="summary-hint"><span className={`tiny-dot ${directCount ? 'green' : 'neutral'}`} />{directCount ? `${directCount} 台设备已建立局域网直连` : '同一 Wi-Fi 下可自动尝试直连'}</div></div>
          <div className="workspace-grid">
            <section className="panel capture-panel" aria-label="截图预览">
              <div className="panel-heading"><span className="panel-title"><ScanLine size={17} />截图预览</span><span className="panel-subtitle">{localPreview ? '局域网接收中' : selected ? formatTime(selected.createdAt) : '等待新截图'}</span></div>
              <div className={`capture-stage ${selected || localPreview ? 'has-image' : ''}`} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void acceptUpload(event.dataTransfer.files[0]); }}>
                {localPreview ? <><img src={localPreview.url} alt="正在上传的局域网截图" /><div className="image-uploading"><Spinner label="正在同步到云端" /></div></> : selected ? <img src={selected.imageUrl} alt={`截图，${formatDate(selected.createdAt)}`} /> : loading ? <Spinner /> : <div className="capture-empty"><div className="capture-guide"><i /><i /><i /><i /><Monitor size={48} strokeWidth={1.1} /><span className="guide-spark"><Plus size={16} /></span></div><h3>下一张截图，从电脑开始</h3><p>按下客户端截图快捷键，<br />问题会自动出现在这里。</p><button className="text-button" onClick={() => navigate('devices')}>连接电脑 <ArrowRight size={14} /></button><span className="or-divider">或</span><button className="button secondary compact" onClick={() => uploadRef.current?.click()}><Upload size={14} />选择图片 / 拖拽上传</button></div>}
              </div>
              <div className="capture-footer"><span><span className={`tiny-dot ${selected?.deviceId ? 'green' : 'neutral'}`} />{selected?.deviceName || (selected ? '网页上传' : '支持 PNG、JPEG、WebP · 最大 12 MB')}</span><div>{selected && <><a className="icon-button" href={selected.imageUrl} target="_blank" rel="noreferrer" aria-label="查看原图" title="查看原图"><Maximize2 size={15} /></a><button className="icon-button danger-hover" aria-label="删除截图" title="删除截图" onClick={() => void deleteCapture()} disabled={busy === 'deleteCapture'}><Trash2 size={15} /></button></>}</div></div>
              <div className="capture-options"><label>截图执行方式<select disabled={user.role!=='admin'} value={provider} onChange={event => setProvider(event.target.value as Provider)}>{(config?.providers || ['codex', 'claude']).map(value => <option key={value} value={value}>{providerName(value)}</option>)}</select></label><label>本次模型 ID<input aria-label="截图本次模型 ID" disabled={user.role!=='admin'} maxLength={100} placeholder="留空使用服务器默认模型" value={screenshotModels[provider]} onChange={event=>setScreenshotModels(current=>({...current,[provider]:event.target.value}))}/></label><label>回答风格<select value={promptId} onChange={event => setPromptId(event.target.value)}><option value="">默认风格</option>{prompts.map(prompt => <option value={prompt.id} key={prompt.id}>{prompt.name}{prompt.isDefault ? ' · 默认' : ''}</option>)}</select></label><label className="check-label auto-analyze"><input type="checkbox" checked={autoAnalyze} disabled={busy === 'settings'} onChange={event => void updateAutoAnalyze(event.target.checked)} /><span>接收图片后自动分析</span><CircleHelp size={13}><title>电脑客户端设置为手动确认时，仍需手动开始分析。</title></CircleHelp></label></div>
            </section>
            <section className="panel answer-panel" aria-label="AI 回答">
              <div className="panel-heading"><span className="panel-title"><Sparkles size={17} />AI 回答</span><div className="answer-heading-right">{selectedTask && <><span className="model-label">{providerName(selectedTask.provider)}{selectedTask.model?` · ${selectedTask.model}`:" · 默认模型"}</span><StatusBadge status={selectedTask.status} /></>}{selectedTask?.answer && <button className="icon-button" aria-label="复制回答" title="复制回答" onClick={() => void copyAnswer()}><Copy size={15} /></button>}</div></div>
              <div className="answer-body" aria-live="polite" aria-busy={selectedTask?.status === 'running'}>
                {selectedTask?.answer ? <><div className="answer-meta"><span className="ai-avatar"><Sparkles size={15} /></span><strong>{providerName(selectedTask.provider)}</strong>{selectedTask.model&&<small>{selectedTask.model}</small>}<span>·</span><small>{selectedTask.promptName || '默认风格'}</small></div><div className="markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{selectedTask.answer}</Markdown>{selectedTask.status === 'running' && <span className="writing-cursor" />}</div>{selectedTask.sources?.length > 0 && <details className="source-details"><summary><BookOpen size={14} />参考了 {selectedTask.sources.length} 个知识片段</summary>{selectedTask.sources.map((source, index) => <div key={`${source.name}-${index}`}><strong>{source.name}</strong><p>{source.excerpt}</p></div>)}</details>}</> : selectedTask?.status === 'running' || selectedTask?.status === 'queued' ? <div className="thinking-state"><div className="thinking-orbit"><Sparkles size={28} /></div><h3>{selectedTask.status === 'queued' ? '问题已就位，等待开始' : selectedTask.stage === 'extracting' ? '正在读取截图并检索知识库' : '正在生成回答'}</h3><p>{selectedTask.status === 'queued' ? '云端任务已保存，可以安心等待。' : '结合画面、回答风格和你的知识库，整理答案。'}</p><span className="thinking-dots"><i /><i /><i /></span></div> : selectedTask?.status === 'failed' ? <EmptyState icon={<RefreshCw size={27} />} title="这次分析未能完成" text={selectedTask.error || '请检查模型服务后重新尝试。'}><button className="button secondary compact" onClick={() => void mutateTask('retry')}>重新分析</button></EmptyState> : selectedTask?.status === 'cancelled' ? <EmptyState icon={<Square size={25} />} title="任务已取消" text="截图仍然保留，你可以随时重新开始。" /> : <EmptyState icon={<Sparkles size={29} strokeWidth={1.4} />} title={selected ? '准备好，就开始分析' : '好答案，从一个问题开始'} text={selected ? '选择模型与回答风格，补充需要关注的内容。' : '收到截图后，AI 会在这里为你整理思路与回答。'}><div className="answer-empty-tags"><span><BookOpen size={12} />你的知识</span><span><Sparkles size={12} />你的风格</span></div></EmptyState>}
                {selectedTask?.retrievalWarning && <div className="retrieval-note"><BookOpen size={13} />{selectedTask.retrievalWarning}</div>}{selectedTask?.error && selectedTask.answer && <div className="inline-error">{selectedTask.error}</div>}
              </div>
              <div className="question-composer"><label htmlFor="question">补充说明 <span>可选</span></label><textarea id="question" placeholder="例如：请重点解释解题思路，并给出一个例子…" value={question} onChange={event => setQuestion(event.target.value)} maxLength={8000} rows={2} /><div className="composer-footer"><span><ShieldCheck size={13} />仅在你的账号中保存</span>{selectedTask && ['queued', 'running'].includes(selectedTask.status) ? <button className="button secondary compact" disabled={busy === 'cancel'} onClick={() => void mutateTask('cancel')}><Square size={13} />取消任务</button> : <button className="button primary compact" disabled={!selected || !!localPreview || busy === 'analyze'} onClick={() => void analyzeCapture()}>{busy === 'analyze' ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}{selectedTask ? '再次分析' : '开始分析'}<ArrowRight size={14} /></button>}</div></div>
            </section>
          </div>
          <section className="history-section"><div className="section-heading"><div><h2>最近截图 <span>{captures.length}</span></h2><p>每一次捕捉，都保留在你的工作空间。</p></div><label className="search-field"><Search size={15} /><input aria-label="搜索截图历史" placeholder="搜索历史回答" value={historyQuery} onChange={event => setHistoryQuery(event.target.value)} /></label></div>{filteredCaptures.length > 0 ? <div className="capture-history">{filteredCaptures.map(capture => { const task = tasks.filter(item => item.captureId === capture.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]; return <button className={`history-card ${selectedId === capture.id ? 'selected' : ''}`} key={capture.id} onClick={() => { setSelectedId(capture.id); setQuestion(''); setLocalPreview(null); }}><div className="history-image"><img src={capture.imageUrl} alt={`历史截图 ${formatDate(capture.createdAt)}`} loading="lazy" />{selectedId === capture.id && <span><Check size={12} />当前预览</span>}</div><div className="history-card-info"><strong>{capture.deviceName || '网页截图'}</strong><small>{formatDate(capture.createdAt)}</small>{task ? <StatusBadge status={task.status} /> : <span className="status-badge status-manual">待分析</span>}</div></button>; })}</div> : <div className="history-empty"><ScanLine size={18} /><span>{historyQuery ? '没有找到匹配的截图' : '截图历史将显示在这里'}</span></div>}</section>
        </>}

        {page === 'devices' && <>
          <PageHeading eyebrow="STAY CONNECTED" title="连接，让灵感同步。" text="将 Windows 客户端与当前账号配对，截图即可跨屏到达。" />
          <div className="device-layout"><section className="panel pairing-panel"><div className="panel-heading"><span className="panel-title"><Link2 size={18} />配对一台新电脑</span><span className="tag">安全配对</span></div><div className="pairing-content"><div className="pair-illustration"><Monitor size={52} strokeWidth={1.2} /><span className="pair-dots"><i /><i /><i /></span><Tablet size={42} strokeWidth={1.2} /></div><p>打开电脑上的「双端互联」客户端，<br />将客户端显示的配对码输入下方。</p><form onSubmit={event => { event.preventDefault(); void perform('pair', async () => { const result = await api.request<{ device: Device }>('/pairings/approve', { method: 'POST', body: { code: pairCode.replace(/[\s-]/g, '').toUpperCase() } }); setDevices(previous => upsert(previous, result.device)); setPairCode(''); history.replaceState(null, '', location.pathname); }, '配对成功，电脑已绑定到当前账号'); }}><label htmlFor="pair-code">电脑配对码</label><input id="pair-code" className="pair-code" placeholder="ABCD 1234" autoComplete="off" maxLength={12} value={pairCode} onChange={event => setPairCode(event.target.value.toUpperCase())} required /><button className="button primary" disabled={busy === 'pair' || pairCode.replace(/[\s-]/g, '').length < 8}>{busy === 'pair' ? <LoaderCircle className="spin" size={16} /> : <Link2 size={16} />}确认配对</button></form><span className="privacy-note"><ShieldCheck size={14} />配对码短时有效，设备可随时解绑</span></div></section><div className="device-info-column"><section className="panel info-panel"><span className="round-icon"><Wifi size={21} /></span><h3>同一 Wi-Fi，更快一步</h3><p>电脑与 iPad 同网时会自动尝试 WebRTC 直连。连接不可用时，客户端继续通过云端传输。</p><div className="info-status"><span className={`tiny-dot ${directCount ? 'green' : 'neutral'}`} />{directCount ? `已建立 ${directCount} 条直连` : '等待局域网设备'}</div></section><section className="panel info-panel muted-panel"><CircleHelp size={20} /><h3>iPad 锁屏后会怎样？</h3><p>云端已收到的任务会继续处理。回到网页后会自动恢复连接，并同步最新的截图和回答。</p></section></div></div>
          <div className="section-heading"><div><h2>已配对的电脑 <span>{devices.length}</span></h2><p>仅此账号能够接收这些电脑的截图。</p></div><button className="button secondary compact" onClick={() => void loadWorkspace()}><RefreshCw size={14} />刷新</button></div>
          <div className="device-list">{devices.length ? devices.map(device => <div className="panel device-card" key={device.id}><div className={`device-icon ${device.online ? 'online' : ''}`}><Monitor size={27} /></div><div className="device-details"><h3>{device.name}<span className={`status-badge ${device.online ? 'status-completed' : 'status-manual'}`}>{device.online ? '在线' : '离线'}</span></h3><p>{device.lastSeenAt ? `最近连接 ${formatDate(device.lastSeenAt)}` : `配对于 ${formatDate(device.createdAt)}`}</p></div><button className="button text danger" disabled={busy === `device-${device.id}`} onClick={() => { if (window.confirm(`解除与「${device.name}」的配对？客户端需要重新配对才能上传。`)) void perform(`device-${device.id}`, async () => { await api.request(`/devices/${device.id}`, { method: 'DELETE' }); setDevices(previous => previous.filter(item => item.id !== device.id)); }, '设备已解绑'); }}><Link2 size={15} />解除配对</button></div>) : <section className="panel"><EmptyState icon={<Monitor size={28} />} title="还没有配对的电脑" text="完成上方配对后，你的电脑就会显示在这里。" /></section>}</div>
        </>}

        {page === 'prompts' && <>
          <PageHeading eyebrow="MAKE IT YOURS" title="答案，也可以很像你。" text="为不同场景保存回答风格，每次分析时随时切换。"><button className="button primary" onClick={() => setPromptDraft({ id: '', name: '', content: '', isDefault: false })}><Plus size={17} />新建风格</button></PageHeading>
          <div className="prompt-layout"><div className="prompt-list">{prompts.map(prompt => <button className={`panel prompt-card ${promptDraft.id === prompt.id ? 'selected' : ''}`} key={prompt.id} onClick={() => setPromptDraft({ id: prompt.id, name: prompt.name, content: prompt.content, isDefault: prompt.isDefault })}><div><span className="round-icon small"><Sparkles size={17} /></span>{prompt.isDefault && <span className="tag">默认</span>}</div><h3>{prompt.name}</h3><p>{prompt.content}</p><small>版本 {prompt.version} · {formatDate(prompt.updatedAt)}</small></button>)}{!prompts.length && <div className="subtle-empty">新建第一套回答风格，让答案更符合你的习惯。</div>}</div><form className="panel prompt-editor" onSubmit={event => void savePrompt(event)}><div className="panel-heading"><span className="panel-title"><FileText size={17} />{promptDraft.id ? '编辑回答风格' : '新建回答风格'}</span>{promptDraft.id && <button type="button" className="icon-button danger-hover" aria-label="删除回答风格" onClick={() => { if (window.confirm('删除这套回答风格？历史任务的配置快照会保留。')) void perform('deletePrompt', async () => { await api.request(`/prompts/${promptDraft.id}`, { method: 'DELETE' }); setPromptDraft({ id: '', name: '', content: '', isDefault: false }); await loadWorkspace(); }, '回答风格已删除'); }}><Trash2 size={16} /></button>}</div><div className="form-content"><label>风格名称<input value={promptDraft.name} onChange={event => setPromptDraft(previous => ({ ...previous, name: event.target.value }))} placeholder="例如：简洁技术讲解" maxLength={80} required /></label><label>提示词<textarea className="prompt-textarea" aria-label="提示词" value={promptDraft.content} onChange={event => setPromptDraft(previous => ({ ...previous, content: event.target.value }))} placeholder={'用中文回答，先给结论，再解释思路。\n涉及代码时，给出可运行的示例。\n优先参考知识库，不确定时明确说明。'} maxLength={32000} required /><span className="field-caption">描述语言、语气、结构与回答深度。个人经历和资料放在知识库。</span></label><label className="check-label"><input type="checkbox" checked={promptDraft.isDefault} onChange={event => setPromptDraft(previous => ({ ...previous, isDefault: event.target.checked }))} />设为账号默认风格</label></div><div className="form-footer"><span>{promptDraft.content.length.toLocaleString()} / 32,000 字符</span><button className="button primary compact" disabled={busy === 'savePrompt'}>{busy === 'savePrompt' ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存风格</button></div></form></div>
        </>}

        {page === 'knowledge' && <>
          <PageHeading eyebrow="YOUR PERSONAL CONTEXT" title="让回答，有你的底气。" text="上传项目资料、学习笔记或常用文档，AI 会按问题选取相关片段。"><button className="button primary" disabled={busy === 'knowledgeUpload'} onClick={() => knowledgeRef.current?.click()}>{busy === 'knowledgeUpload' ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}上传文件</button></PageHeading>
          <div className="knowledge-upload" role="button" tabIndex={0} onClick={() => knowledgeRef.current?.click()} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); knowledgeRef.current?.click(); } }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void uploadKnowledge(event.dataTransfer.files); }}><span className="upload-cloud"><Upload size={27} strokeWidth={1.5} /></span><div><strong>{busy === 'knowledgeUpload' ? '正在上传并解析文件…' : '把你的知识，放到这里'}</strong><p>拖拽文件到此处，或点击选择文件</p><small>TXT、Markdown、PDF、DOCX · 单个文件最大 10 MB</small></div><span className="upload-arrow"><ArrowRight size={20} /></span></div>
          <div className="knowledge-note"><ShieldCheck size={17} /><p>文件仅供当前账号使用。扫描版 PDF 需先进行文字识别；回答中会展示引用的文件片段。</p></div>
          <div className="section-heading"><div><h2>知识文件 <span>{knowledge.length}</span></h2><p>共 {knowledge.reduce((sum, file) => sum + (file.characters || 0), 0).toLocaleString()} 字符已整理</p></div></div>
          <section className="panel knowledge-list">{knowledge.length ? knowledge.map(file => <div className="knowledge-row" key={file.id}><div className={`file-icon ${file.name.toLowerCase().endsWith('.pdf') ? 'pdf' : ''}`}><FileText size={23} /><small>{file.name.split('.').pop()?.toUpperCase().slice(0, 4)}</small></div><div className="file-details"><h3>{file.name}</h3><p>{fileSize(file.size)}<span>·</span>{formatDate(file.createdAt)}<span>·</span>{file.characters.toLocaleString()} 字符</p>{file.error && <p className="file-error">{file.error}</p>}</div><span className={`status-badge ${file.status === 'ready' ? 'status-completed' : file.status === 'error' ? 'status-failed' : 'status-running'}`}>{file.status === 'ready' ? <Check size={12} /> : file.status === 'processing' ? <LoaderCircle className="spin" size={12} /> : null}{file.status === 'ready' ? '可引用' : file.status === 'processing' ? '解析中' : '解析失败'}</span><div className="row-actions"><a className="icon-button" href={`/api/knowledge/${file.id}/download`} aria-label={`下载 ${file.name}`} title="下载原文件"><ArrowDownToLine size={16} /></a><button className="icon-button danger-hover" aria-label={`删除 ${file.name}`} title="删除文件" disabled={busy === `knowledge-${file.id}`} onClick={() => { if (window.confirm(`删除知识文件「${file.name}」？`)) void perform(`knowledge-${file.id}`, async () => { await api.request(`/knowledge/${file.id}`, { method: 'DELETE' }); setKnowledge(previous => previous.filter(item => item.id !== file.id)); }, '知识文件已删除'); }}><Trash2 size={16} /></button></div></div>) : <EmptyState icon={<BookOpen size={28} />} title="你的知识库，等待第一份资料" text="上传后，回答会多一份来自你自己的依据。" />}</section>
        </>}

        {page === 'account' && <>
          {user.role!=='admin' && <div className="panel ai-settings-note">模型、接口和密钥由管理员统一配置，你的截图与语音会自动使用相应模式的配置。</div>}
          <PageHeading eyebrow="ACCOUNT & SECURITY" title="你的工作空间，由你管理。" text={user.role==='admin'?'统一管理各模式的模型与接口配置，并更新登录密码。':'查看账号信息，更新登录密码；模型配置由管理员统一维护。'}><div className="account-heading-actions">{user.role === 'admin' && <button className="button secondary compact" onClick={() => navigate('users')}><Users size={15} />用户管理</button>}<button className="button secondary compact" onClick={() => void perform('logout', async () => { await api.request('/auth/logout', { method: 'POST', body: {} }); api.setCsrfToken(''); setUser(null); })}><LogOut size={15} />退出登录</button></div></PageHeading>
          {user.role === 'admin' && <AiSettings key={user.id} onError={handleError} onSaved={()=>{void loadWorkspace();void api.request<AppConfig>('/config').then(next=>{setConfig(next);if(next.screenshotPreferences){setProvider(next.screenshotPreferences.provider);setScreenshotModels(next.screenshotPreferences.models);}}).catch(handleError);}}/>}
          <div className="account-layout"><section className="panel profile-panel"><span className="profile-avatar">{user.name[0]?.toUpperCase() || 'U'}</span><h2>{user.name}</h2><p>{user.email}</p><span className="tag">{user.role === 'admin' ? '管理员' : '个人账号'}</span><div className="profile-stat"><span>每日任务额度</span><strong>{user.dailyLimit}</strong></div><div className="profile-stat"><span>服务地址</span><strong className="host-value">{location.host}</strong></div></section><section className="panel"><div className="panel-heading"><span className="panel-title"><ShieldCheck size={18} />更新登录密码</span></div><form className="password-form" onSubmit={event => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); if (data.get('newPassword') !== data.get('confirmPassword')) { notify('两次输入的新密码不一致', 'error'); return; } void perform('password', async () => { await api.request('/auth/password', { method: 'POST', body: { currentPassword: data.get('currentPassword'), newPassword: data.get('newPassword') } }); form.reset(); }, '密码已更新'); }}><label>当前密码<input type="password" name="currentPassword" autoComplete="current-password" required /></label><label>新密码<input type="password" name="newPassword" autoComplete="new-password" minLength={10} maxLength={256} placeholder="至少 10 个字符" required /></label><label>确认新密码<input type="password" name="confirmPassword" autoComplete="new-password" minLength={10} maxLength={256} required /></label><button className="button primary" disabled={busy === 'password'}>{busy === 'password' ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}更新密码</button></form></section></div>
        </>}



        {page === 'users' && user.role === 'admin' && <>
          <PageHeading eyebrow="ADMINISTRATION" title="管理账号，各有空间。" text="每个账号独立维护设备、回答风格、知识库和历史记录。"><button className="button secondary" onClick={() => void perform('diagnostics', async () => setDiagnostics(await api.request('/admin/diagnostics')))}><Settings2 size={16} />服务诊断</button></PageHeading>
          {diagnostics !== null && <section className="panel diagnostics"><div className="panel-heading"><span className="panel-title">模型服务诊断</span><button className="icon-button" aria-label="关闭诊断" onClick={() => setDiagnostics(null)}><X size={16} /></button></div><pre>{JSON.stringify(diagnostics, null, 2)}</pre></section>}
          <section className="panel"><div className="panel-heading"><span className="panel-title"><Plus size={17} />创建账号</span><span className="panel-subtitle">账号由管理员分配</span></div><form className="create-user-form" onSubmit={event => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); void perform('createUser', async () => { const { user: created } = await api.request<{ user: User }>('/admin/users', { method: 'POST', body: { email: data.get('email'), name: data.get('name'), password: data.get('password'), dailyLimit: Number(data.get('dailyLimit')) } }); setUsers(previous => upsert(previous, created)); form.reset(); }, '新账号已创建'); }}><label>姓名<input name="name" placeholder="账号使用者" maxLength={80} required /></label><label>邮箱<input type="email" name="email" placeholder="name@example.com" autoComplete="off" required /></label><label>初始密码<input type="password" name="password" minLength={10} maxLength={256} placeholder="至少 10 个字符" autoComplete="new-password" required /></label><label>每日任务额度<input type="number" name="dailyLimit" defaultValue={100} min={0} max={100000} required /></label><button className="button primary" disabled={busy === 'createUser'}><Plus size={16} />创建账号</button></form></section>
          <div className="section-heading"><div><h2>全部账号 <span>{users.length}</span></h2><p>禁用账号会同时撤销其登录与设备连接。</p></div></div><section className="panel user-list">{users.map(item => <UserRow key={item.id} user={item} isSelf={item.id === user.id} busy={busy === `user-${item.id}`} onSave={(changes) => void perform(`user-${item.id}`, async () => { const { user: updated } = await api.request<{ user: User }>(`/admin/users/${item.id}`, { method: 'PATCH', body: changes }); setUsers(previous => upsert(previous, updated)); if (updated.id === user.id) setUser(updated); }, '账号设置已更新')} />)}</section>
        </>}
        <footer className="page-footer"><span>双端互联 <span>·</span> 你的截图，你的知识，你的答案。</span><span><ShieldCheck size={12} />自托管工作空间</span></footer>
      </main>
    </div>
    <input ref={uploadRef} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择截图文件" onChange={event => void acceptUpload(event.target.files?.[0])} />
    <input ref={knowledgeRef} className="visually-hidden" type="file" accept=".txt,.md,.pdf,.docx" multiple aria-label="选择知识文件" onChange={event => void uploadKnowledge(event.target.files)} />
    {notice && <div className={`toast toast-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'success' ? <Check size={17} /> : <CircleHelp size={17} />}<span>{notice.message}</span><button aria-label="关闭提示" onClick={() => setNotice(null)}><X size={15} /></button></div>}
  </div>;
}

function PageHeading({ eyebrow, title, text, children }: { eyebrow: string; title: string; text: string; children?: ReactNode }) { return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{text}</p></div>{children}</div>; }

function UserRow({ user, isSelf, busy, onSave }: { user: User; isSelf: boolean; busy: boolean; onSave: (changes: Partial<User> & { password?: string }) => void }) {
  const [editing, setEditing] = useState(false);
  return <div className="admin-user-row"><div className="admin-user-summary"><span className="avatar">{user.name[0]?.toUpperCase() || 'U'}</span><div><h3>{user.name}{isSelf && <span className="tag">你</span>}{user.role === 'admin' && <ShieldCheck size={14} />}</h3><p>{user.email}</p></div><span className={`status-badge ${user.disabled ? 'status-manual' : 'status-completed'}`}>{user.disabled ? '已禁用' : '正常'}</span><span className="user-quota">{`${user.dailyLimit} 次 / 天`}</span><button className="icon-button" title="管理账号" aria-label={`管理 ${user.name}`} onClick={() => setEditing(value => !value)}>{editing ? <X size={18} /> : <MoreHorizontal size={20} />}</button></div>{editing && <form className="user-edit-form" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); const password = String(data.get('password') || ''); onSave({ name: String(data.get('name')), dailyLimit: Number(data.get('dailyLimit')), ...(password ? { password } : {}) }); }}><label>姓名<input name="name" defaultValue={user.name} maxLength={80} required /></label><label>每日任务额度<input type="number" name="dailyLimit" defaultValue={user.dailyLimit} min={0} max={100000} required /></label><label>重置密码<input type="password" name="password" placeholder="留空则保留现有密码" minLength={10} autoComplete="new-password" /></label><button className="button primary compact" disabled={busy}>保存设置</button><button className={`button ${user.disabled ? 'secondary' : 'text danger'} compact`} type="button" disabled={isSelf || busy || user.role === 'admin'} onClick={() => { if (window.confirm(user.disabled ? `重新启用「${user.name}」？` : `禁用「${user.name}」并断开其设备？`)) onSave({ disabled: !user.disabled }); }}>{user.disabled ? '启用账号' : '禁用账号'}</button></form>}</div>;
}

function LoginScreen({ onLogin, notify }: { onLogin: (user: User, token: string) => void; notify: (message: string, kind?: Notice['kind']) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <div className="login-page"><section className="login-story"><Brand light /><div className="login-story-content"><span className="login-kicker"><span className="tiny-dot green" />YOUR PRIVATE AI WORKSPACE</span><h1>问题留在电脑，<br />思路来到手边<span>。</span></h1><p>一张截图，连接你的屏幕、知识与 AI。<br />在自己的空间里，找到自己的答案。</p><div className="login-device-art"><div className="art-monitor"><div className="art-monitor-toolbar"><i /><i /><i /></div><div className="art-code"><span /><span /><span /><span /></div><div className="art-capture-corner a" /><div className="art-capture-corner b" /></div><div className="art-link"><i /><i /><span><ArrowRight size={20} /></span><i /></div><div className="art-tablet"><span className="art-tablet-camera" /><div className="art-answer-heading"><span><Sparkles size={17} /></span><strong>思路，已连接</strong></div><div className="art-answer-lines"><i /><i /><i /></div><div className="art-answer-check"><Check size={12} />结合你的知识库</div></div><span className="art-glow" /></div><div className="login-features"><span><ScanLine size={16} />快捷截图</span><span><BookOpen size={16} />个人知识</span><span><ShieldCheck size={16} />独立管理</span></div></div><div className="login-story-footer"><span>DUAL LINK</span><span>CAPTURE THE QUESTION. CONNECT THE ANSWER.</span></div></section><section className="login-form-side"><div className="mobile-login-brand"><Brand /></div><div className="login-form-wrap"><span className="welcome-tag">欢迎回来</span><h2>登录你的工作空间</h2><p>连接电脑与 iPad，让下一步更清晰。</p><form onSubmit={async event => { event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setError(''); try { const result = await api.request<{ user: User; csrfToken: string }>('/auth/login', { method: 'POST', body: { email: data.get('email'), password: data.get('password') } }); onLogin(result.user, result.csrfToken); } catch (failure) { const message = failure instanceof Error ? failure.message : '登录失败'; setError(message); notify(message, 'error'); } finally { setBusy(false); } }}><label>邮箱地址<input type="email" name="email" autoComplete="username" placeholder="输入你的账号邮箱" required autoFocus /></label><label>登录密码<input type="password" name="password" autoComplete="current-password" placeholder="输入登录密码" maxLength={256} required /></label>{error && <p className="login-error" role="alert">{error}</p>}<button className="button primary login-submit" disabled={busy}>{busy ? <Spinner label="正在登录" /> : <>进入工作空间<ArrowRight size={17} /></>}</button></form><div className="login-help"><ShieldCheck size={17} /><p>账号由服务管理员创建。首次使用或忘记密码，请联系你的管理员。</p></div></div><div className="login-form-footer"><span>你的设备 · 你的云端 · 你的 AI</span></div></section></div>;
}
