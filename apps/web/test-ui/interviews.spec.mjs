import { test, expect } from '@playwright/test';

async function prepare(page, configured = true, initialStatus = 'recording', paginated = false, options = {}) {
  let account = 'a';
  let interview = { id: 'session-a', title: '后端工程师面试', status: initialStatus, mode:options.mode||'transcript', transcribe:options.transcribe!==false, audioModel:'qwen3.8-omni-flash-realtime',audioWindowSeconds:120, provider: 'codex', promptName: '简洁回答', autoAnswer: true, deviceId: 'desktop-a', recordingStatus: 'streaming', createdAt: '2026-11-07T10:00:00Z', updatedAt: '2026-11-07T10:00:00Z', endedAt: null };
  const segment = { id: 'segment-a', sessionId: 'session-a', track: 'remote', segmentId: 'remote-1', text: '介绍一下 Redis 的持久化机制。', startMs: 1000, endMs: 3000, final: true, revision: 1, createdAt: interview.createdAt, updatedAt: interview.updatedAt };
  const self = { ...segment, id: 'segment-self', track: 'self', segmentId: 'self-1', text: '我在项目里使用过 AOF。', startMs: 4000, endMs: 6000 };
  const question = { id: 'question-a', sessionId: 'session-a', text: segment.text, segmentIds: [segment.id], revision: 1, status: 'answered', createdAt: interview.createdAt, updatedAt: interview.updatedAt };
  const answer = { id: 'answer-a', sessionId: 'session-a', questionId: question.id, questionRevision: 1, provider: 'codex', status: 'completed', text: '可以先说明 RDB 和 AOF 的区别。', contextSnapshotId: 'snapshot-a', sources: [{ name: '个人项目.txt', excerpt: '负责缓存持久化方案' }], contextSummary: { summary: '本次上下文包含目前可用的全部实际对话。', segmentIds: [segment.id, self.id] }, createdAt: interview.createdAt, updatedAt: interview.updatedAt };
  const seen = [];
  const pagingSeen = [];
  const preferenceSeen = [],triggerSeen=[];
  let preferences={mode:'transcript',provider:'bailian',transcribe:true,audioModel:'qwen3.8-omni-flash-realtime',audioWindowSeconds:120};
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    const json = (data, status = 200) => route.fulfill({ status, json: data });
    if (path === '/api/auth/login') { account = req.postDataJSON().email.startsWith('b@') ? 'b' : 'a'; return json({ user: { id: account, name: `用户${account}`, email: `${account}@test.example`, role: options.admin?'admin':'user', dailyLimit: 100 }, csrfToken: `csrf-${account}` }); }
    if (path === '/api/auth/logout') return json({ ok: true });
    if (path === '/api/auth/me') return json({ error: '请登录' }, 401);
    if (path === '/api/config') return json({ providers: ['codex', 'claude'], defaultProvider: 'codex', autoAnalyze: true, iceServers: [], maxUploadBytes: 12582912 });
    if (path === '/api/ws-ticket') return json({ ticket: account });
    if (path === '/api/prompts') return json({ prompts: [{ id: 'prompt-a', name: '简洁回答', content: '先结论', isDefault: true, version: 1, createdAt: interview.createdAt, updatedAt: interview.updatedAt }] });
    if (path === '/api/devices') return json({ devices: [{ id: 'desktop-a', name: '我的 Windows', online: true, createdAt: interview.createdAt, lastSeenAt: interview.createdAt }] });
    if (path === '/api/captures') return json({ captures: [] });
    if (path === '/api/tasks') return json({ tasks: [] });
    if (path === '/api/knowledge') return json({ files: [] });
    if (path === '/api/interviews/config') return json({ configured,audioConfigured:!!options.audioConfigured,audioModels:['qwen3.8-omni-flash-realtime','omni-test'],defaults:preferences, model: 'qwen-audio-3.1-asr-flash-streaming', region: 'cn-beijing', sampleRate: 16000, maxSessionMinutes: 120, rawAudioRetentionDays: 7, autoAnswerAvailable: true, providers: ['bailian', 'codex', 'claude'], defaultProvider: 'bailian' });
    if(path==='/api/interviews/preferences'){if(req.method()==='PATCH'){preferences={...preferences,...req.postDataJSON()};preferenceSeen.push(preferences);}return json({preferences});}
    if (path === '/api/interviews' && req.method() === 'GET') return json({ interviews: account === 'a' ? [interview] : [] });
    if (path === '/api/interviews' && req.method() === 'POST') { const body = req.postDataJSON(); seen.push(body); interview = { ...interview, ...body, id: 'session-new', status: 'recording', createdAt: new Date().toISOString() }; return json({ interview }); }
    if (path === '/api/interviews/session-new' && req.method() === 'GET') return json({ interview, segments: [], questions: [], answers: [], gaps: [] });
    if (path === '/api/interviews/session-a' && req.method() === 'GET' && paginated) {
      if (url.searchParams.has('cursor')) { pagingSeen.push(url.searchParams.get('cursor')); return json({ interview, segments: [{ ...segment, id: 'older-segment', text: '同一时间戳边界的较早原话。' }], questions: [], answers: [], gaps: [], segmentsTruncated: false, nextCursor: null }); }
      return json({ interview, segments: [segment], questions: [], answers: [], gaps: [], segmentsTruncated: true, nextCursor: '1000:2001' });
    }
    if (path === '/api/interviews/session-a' && req.method() === 'GET') return json({ interview, segments: options.transcribe===false?[]:[segment, self], questions: [question], answers: [answer], gaps: [], contextSummary: { id: 'snapshot-other', summary: '另一次生成的上下文，不应归到本次回答。', segmentIds: [] } });
    if(path==='/api/interviews/session-a/trigger'){triggerSeen.push(req.postDataJSON());return json({question:{...question,id:'audio-q',text:'音频提问 00:10–00:30',audioRange:{startMs:10000,endMs:30000},audioTruncated:true},answer:{...answer,id:'audio-a',questionId:'audio-q',provider:'omni',mode:'audio',text:'原生音频回答建议。'}});}
    if (path === '/api/interviews/session-a/questions') {
      seen.push(req.postDataJSON());
      return json({ question: { ...question, id: 'manual-q', text: '请结合刚才的实际回答继续解释' }, answer: { ...answer, id: 'manual-answer', questionId: 'manual-q', status: 'running', text: '' } });
    }
    if (/\/session-a\/(pause|resume|end)$/.test(path)) {
      interview = { ...interview, status: path.endsWith('/pause') ? 'paused' : path.endsWith('/end') ? 'ended' : 'recording', updatedAt: new Date().toISOString() };
      return json({ interview });
    }
    if (path === '/api/interviews/session-a' && req.method() === 'PATCH') { interview = { ...interview, ...req.postDataJSON() }; return json({ interview }); }
    return json({ ok: true });
  });
  await page.addInitScript(() => {
    class Socket {
      static OPEN = 1; static CONNECTING = 0;
      readyState = 0;
      constructor() { window.__voiceSocket = this; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {}
      close() { this.readyState = 3; this.onclose?.(); }
    }
    window.WebSocket = Socket;
  });
  await page.goto('/');
  await page.getByLabel('邮箱地址').fill('a@test.example');
  await page.getByLabel('登录密码').fill('Testing-password42!');
  await page.getByRole('button', { name: '进入工作空间' }).click();
  await expect(page.locator('.connection-pill')).toHaveText('已连接');
  return { seen, pagingSeen, preferenceSeen,triggerSeen };
}

test('interview page renders actual speech separately, revises live text and streams manual answers', async ({ page }, testInfo) => {
  const { seen } = await prepare(page);
  await page.getByRole('button', { name: '面试会话', exact: true }).click();
  const timeline = page.getByRole('region', { name: '面试转写时间线' });
  await expect(page.getByText('正在接收音频', { exact: true })).toBeVisible();
  await page.getByText('本次回答的对话依据', { exact: true }).click();
  await expect(page.getByText('本次上下文包含目前可用的全部实际对话。', { exact: true })).toBeVisible();
  await page.getByText('参考了 1 个知识片段', { exact: true }).click();
  await expect(page.getByText('个人项目.txt', { exact: true })).toBeVisible();
  await expect(page.getByText('另一次生成的上下文，不应归到本次回答。', { exact: true })).toHaveCount(0);
  await expect(timeline.getByText('我在项目里使用过 AOF。', { exact: true })).toBeVisible();
  await expect(timeline.getByText('可以先说明 RDB 和 AOF 的区别。')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'AI 回答建议' }).getByText('可以先说明 RDB 和 AOF 的区别。')).toBeVisible();
  await page.evaluate(() => {
    const send = event => window.__voiceSocket.onmessage({ data: JSON.stringify(event) });
    const base = { id: 'live-segment', sessionId: 'session-a', track: 'remote', segmentId: 'remote-live', startMs: 8000, endMs: null, final: false, revision: 1, text: '那么 Redis' };
    send({ type: 'interview.segment', sessionId: 'session-a', segment: base });
    send({ type: 'interview.segment', sessionId: 'session-a', segment: { ...base, text: '那么 Redis 如何避免缓存穿透？', revision: 2, final: true, endMs: 10000 } });
    send({ type: 'interview.segment', sessionId: 'session-other', segment: { ...base, id: 'foreign', sessionId: 'session-other', text: '不应出现的其他面试' } });
  });
  await expect(timeline.getByText('那么 Redis 如何避免缓存穿透？', { exact: true })).toHaveCount(1);
  await expect(timeline.getByText('不应出现的其他面试')).toHaveCount(0);
  await page.getByLabel('选择远端发言：介绍一下 Redis 的持久化机制。').check();
  await page.getByLabel('补充或整理提问').fill('请结合刚才的实际回答继续解释');
  await page.getByRole('button', { name: '生成回答', exact: true }).click();
  expect(seen[0].segmentIds).toEqual(['segment-a']);
  await expect(page.getByLabel('查看面试提问')).toHaveValue('manual-q');
  await page.evaluate(() => window.__voiceSocket.onmessage({ data: JSON.stringify({ type: 'interview.answer.delta', sessionId: 'session-a', answerId: 'manual-answer', delta: '这是一段新的流式建议。' }) }));
  await expect(page.getByRole('region', { name: 'AI 回答建议' }).getByText('这是一段新的流式建议。')).toBeVisible();
  await expect(page.getByRole('link', { name: '导出 Markdown' })).toHaveAttribute('href', '/api/interviews/session-a/export?format=md');
  await page.screenshot({ path: testInfo.outputPath('interview-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '暂停会话', exact: true }).click();
  await expect(page.getByRole('button', { name: '继续会话', exact: true })).toBeVisible();
});

test('tablet interview creation uses the configured text provider and domain hotwords', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  const { seen } = await prepare(page, true, 'ended');
  await page.getByRole('button', { name: '面试会话', exact: true }).click();
  await page.getByRole('button', { name: '创建面试会话', exact: true }).click();
  await page.getByLabel('面试会话名称').fill('平台研发 · 技术二面');
  await expect(page.getByLabel('新会话回答模型')).toHaveValue('bailian');
  await page.getByLabel('面试识别热词').fill('Redis，Kubernetes\n项目青竹，Redis');
  await page.getByRole('button', { name: '保存并创建', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^平台研发 · 技术二面/ })).toBeVisible();
  expect(seen[0].provider).toBe('bailian');
  expect(seen[0].hotwords).toEqual(['Redis', 'Kubernetes', '项目青竹']);
  await expect(page.getByRole('button', { name: '查看 AI 建议', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '切换面试会话', exact: true })).toHaveAttribute('aria-expanded', 'false');
  const suggestionBounds = await page.getByRole('region', { name: 'AI 回答建议' }).boundingBox();
  expect(suggestionBounds.y).toBeLessThan(650);
  await expect(page.getByRole('region', { name: '面试转写时间线' })).toBeHidden();
  await page.getByRole('button', { name: '查看双方原话', exact: true }).click();
  await expect(page.getByRole('region', { name: '面试转写时间线' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'AI 回答建议' })).toBeHidden();
  await page.getByRole('button', { name: '查看 AI 建议', exact: true }).click();
  await page.getByRole('button', { name: '切换面试会话', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '面试会话历史' })).toBeVisible();
  await page.getByRole('button', { name: '切换面试会话', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('interview-tablet.png'), fullPage: true });
});

test('missing ASR credentials are explicit and switching accounts removes the old interview', async ({ page }) => {
  await prepare(page, false);
  await page.getByRole('button', { name: '面试会话', exact: true }).click();
  await expect(page.getByText('语音识别尚未配置', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建面试会话', exact: true })).toBeDisabled();
  await expect(page.getByText('我在项目里使用过 AOF。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByLabel('邮箱地址').fill('b@test.example');
  await page.getByLabel('登录密码').fill('Testing-password42!');
  await page.getByRole('button', { name: '进入工作空间' }).click();
  await page.getByRole('button', { name: '面试会话', exact: true }).click();
  await expect(page.getByText('我在项目里使用过 AOF。', { exact: true })).toHaveCount(0);
  await expect(page.getByText('后端工程师面试', { exact: true })).toHaveCount(0);
});

test('a session deleted on another device removes its transcript from the current device', async ({ page }) => {
  await prepare(page);
  await page.getByRole('button', { name: '面试会话', exact: true }).click();
  await expect(page.getByText('我在项目里使用过 AOF。', { exact: true })).toBeVisible();
  await page.evaluate(() => window.__voiceSocket.onmessage({ data: JSON.stringify({ type: 'interview.deleted', sessionId: 'session-a' }) }));
  await expect(page.getByText('我在项目里使用过 AOF。', { exact: true })).toHaveCount(0);
  await expect(page.getByText('还没有面试记录', { exact: true })).toBeVisible();
});

test('older transcript pages use the composite cursor and remain complete after reconnect refreshes', async ({ page }) => {
  const { pagingSeen } = await prepare(page, true, 'recording', true);
  await page.getByRole('button', { name: '面试会话', exact: true }).click();
  await page.getByRole('button', { name: '加载更早记录', exact: true }).click();
  await expect(page.getByText('同一时间戳边界的较早原话。', { exact: true })).toBeVisible();
  expect(pagingSeen).toEqual(['1000:2001']);
  await expect(page.getByRole('button', { name: '加载更早记录', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '刷新面试记录', exact: true }).click();
  await expect(page.getByText('同一时间戳边界的较早原话。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '加载更早记录', exact: true })).toHaveCount(0);
});

test('account defaults save native mode without ASR and new sessions remain explicitly triggered',async({page})=>{
 const {preferenceSeen,seen}=await prepare(page,false,'ended',false,{audioConfigured:true,admin:true});
 await page.getByRole('button',{name:'面试会话',exact:true}).click();
 await page.getByText('默认面试配置',{exact:true}).click();
 await page.getByLabel('默认回答方式').selectOption('audio');
 await page.getByLabel('默认后台转写').uncheck();
 await page.getByLabel('默认音频理解模型 · 百炼 API').fill('omni-test');
 await page.getByLabel('默认问题音频时长').fill('60');
 await page.getByRole('button',{name:'保存默认配置',exact:true}).click();
 expect(preferenceSeen[0]).toMatchObject({mode:'audio',transcribe:false,audioModel:'omni-test',audioWindowSeconds:60});
 await page.getByRole('button',{name:'创建面试会话',exact:true}).click();
 await expect(page.getByLabel('新会话回答方式')).toHaveValue('audio');
 await page.getByRole('button',{name:'保存并创建',exact:true}).click();
 expect(seen[0]).toMatchObject({mode:'audio',transcribe:false,audioModel:'omni-test',audioWindowSeconds:60,autoAnswer:false});
});

test('audio session triggers only on request and shows native answer with honest transcript and truncation states',async({page},testInfo)=>{
 await page.setViewportSize({width:820,height:1180});
 const {triggerSeen}=await prepare(page,false,'recording',false,{audioConfigured:true,mode:'audio',transcribe:false});
 await page.getByRole('button',{name:'面试会话',exact:true}).click();
 await expect(page.getByLabel('面试回答方式')).toBeDisabled();
 await expect(page.getByText('后台转写已关闭',{exact:true})).toBeVisible();
 expect(triggerSeen.length).toBe(0);
 await page.getByRole('button',{name:'回答当前问题',exact:true}).click();
 expect(triggerSeen[0].requestId).toMatch(/^[\da-f-]{36}$/);
 await expect(page.getByRole('region',{name:'AI 回答建议'}).getByText('Qwen-Omni',{exact:true})).toBeVisible();
 await expect(page.getByText('原生音频回答建议。',{exact:true})).toBeVisible();
 await expect(page.getByText(/当前问题音频已按时长上限节选/)).toBeVisible();
 await expect(page.getByRole('link',{name:'远端录音'})).toHaveAttribute('href','/api/interviews/session-a/audio/remote');
 await expect(page.getByText('原生音频回答建议。',{exact:true})).toBeInViewport();
 await page.screenshot({path:testInfo.outputPath('native-tablet.png'),fullPage:true});
 await page.getByRole('button',{name:'暂停会话',exact:true}).click();
 await expect(page.getByLabel('面试回答方式')).toBeEnabled();
});

test('screenshot models persist separately for each CLI and manual requests snapshot the selected model',async({page},testInfo)=>{
 await prepare(page,true,'ended',false,{admin:true});
 const saved=[],requests=[];
 await page.route('**/api/model-preferences',async route=>{
   const body=route.request().postDataJSON();saved.push(body);await route.fulfill({json:body});
 });
 await page.route('**/api/captures/analyze',async route=>{
   const body=route.request().postDataJSON();requests.push(body);
   await route.fulfill({json:{task:{id:'model-task',captureId:'capture-model',provider:body.provider,model:body.model,status:'completed',answer:'模型已选择',promptName:'测试',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),sources:[]}}});
 });
 await page.getByText('截图默认配置',{exact:true}).click();
 await page.getByLabel('Codex 截图模型 ID').fill('gpt-quality');
 await page.getByLabel('Claude 截图模型 ID').fill('qwen-quality');
 await page.getByLabel('截图默认执行方式').selectOption('claude');
 await page.getByRole('button',{name:'保存截图默认配置',exact:true}).click();
 await expect.poll(()=>saved.length).toBe(1);
 expect(saved[0]).toEqual({preferences:{screenshot:{provider:'claude',models:{codex:'gpt-quality',claude:'qwen-quality'}}}});
 await page.getByLabel('截图执行方式').selectOption('codex');
 await expect(page.getByLabel('截图本次模型 ID')).toHaveValue('gpt-quality');
 await page.getByLabel('截图执行方式').selectOption('claude');
 await expect(page.getByLabel('截图本次模型 ID')).toHaveValue('qwen-quality');
 await page.getByLabel('截图本次模型 ID').fill('qwen-once');
 await page.evaluate(()=>window.__voiceSocket.onmessage({data:JSON.stringify({type:'capture.created',capture:{id:'capture-model',captureId:'capture-model',deviceId:null,createdAt:new Date().toISOString(),imageUrl:'/model.png'}})}));
 await page.getByRole('button',{name:'开始分析',exact:true}).click();
 await expect.poll(()=>requests.length).toBe(1);
 expect(requests[0]).toMatchObject({provider:'claude',model:'qwen-once'});
 await expect(page.getByText('Claude · qwen-once',{exact:true})).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('screenshot-models.png'),fullPage:true});
});

test('interview defaults distinguish ASR API from per-CLI text models and preserve both when switching',async({page},testInfo)=>{
 const {preferenceSeen,seen}=await prepare(page,true,'ended',false,{audioConfigured:true,admin:true});
 await page.getByRole('button',{name:'面试会话',exact:true}).click();
 await page.getByText('默认面试配置',{exact:true}).click();
 await page.getByLabel('默认Codex 文字模型 ID').fill('gpt-flash');
 await page.getByLabel('默认Claude 文字模型 ID').fill('qwen-flash');
 await page.getByLabel('默认语音识别模型 · 百炼 API').fill('asr-streaming-custom');
 await page.getByLabel('默认音频理解模型 · 百炼 API').fill('omni-flash-custom');
 await page.getByLabel('默认回答模型').selectOption('claude');
 await page.getByRole('button',{name:'保存默认配置',exact:true}).click();
 await expect.poll(()=>preferenceSeen.length).toBe(1);
 expect(preferenceSeen[0]).toMatchObject({provider:'claude',textModels:{codex:'gpt-flash',claude:'qwen-flash'},asrModel:'asr-streaming-custom',audioModel:'omni-flash-custom'});
 await page.getByRole('button',{name:'创建面试会话',exact:true}).click();
 await expect(page.getByLabel('新会话Claude 文字模型 ID')).toHaveValue('qwen-flash');
 await page.getByLabel('新会话回答模型').selectOption('codex');
 await expect(page.getByLabel('新会话Codex 文字模型 ID')).toHaveValue('gpt-flash');
 await page.getByRole('button',{name:'保存并创建',exact:true}).click();
 await expect.poll(()=>seen.length).toBe(1);
 expect(seen[0]).toMatchObject({provider:'codex',textModels:{codex:'gpt-flash',claude:'qwen-flash'},asrModel:'asr-streaming-custom'});
 await page.screenshot({path:testInfo.outputPath('interview-models.png'),fullPage:true});
});
