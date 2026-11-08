import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { createHttpAsrFactory } from './asr-http.mjs';

export class AsrError extends Error {
  constructor(code, message) { super(message); this.name = 'AsrError'; this.code = code; }
}
export function asrConfiguration(options = {}) {
  const apiKey = options.apiKey ?? process.env.DASHSCOPE_API_KEY ?? '';
  const workspaceId = options.workspaceId ?? process.env.DASHSCOPE_WORKSPACE_ID ?? '';
  const region = options.region || process.env.ASR_REGION || 'cn-beijing';
  const requested = options.transport || process.env.ASR_TRANSPORT || 'auto';
  const tokenPlan = requested === 'token-plan' || apiKey.startsWith('sk-sp-');
  const model = options.model || (tokenPlan ? 'qwen-audio-3.0-asr-flash' : process.env.ASR_MODEL || 'qwen-audio-3.1-asr-flash-streaming');
  const transport = requested === 'token-plan' || (requested === 'auto' && (tokenPlan || /^qwen-audio-\d+\.\d+-asr-flash$/.test(model))) ? 'http' : 'websocket';
  const wsUrl = options.wsUrl || options.baseUrl?.replace(/^https:/,'wss:') || process.env.ASR_WS_URL || (workspaceId && /^[A-Za-z0-9_-]{1,100}$/.test(workspaceId) && /^[a-z0-9-]{2,40}$/.test(region) ? `wss://${workspaceId}.${region}.maas.aliyuncs.com/api-ws/v1/inference` : '');
  let httpUrl = options.httpUrl || options.baseUrl || process.env.ASR_HTTP_URL || (tokenPlan ? 'https://token-plan.cn-beijing.maas.aliyuncs.com' : workspaceId ? `https://${workspaceId}.${region}.maas.aliyuncs.com` : '');
  if (httpUrl) {
    try { const url = new URL(httpUrl); if (['/', '/compatible-mode/v1', '/compatible-mode/v1/', '/v1', '/v1/'].includes(url.pathname)) url.pathname = '/api/v1/services/aigc/multimodal-generation/generation'; httpUrl = url.toString(); } catch { /* The factory reports the invalid URL without exposing credentials. */ }
  }
  return { ...options, chunkSeconds: Math.max(2,Math.min(15,Number(options.chunkSeconds||process.env.ASR_CHUNK_SECONDS)||4)), apiKey, workspaceId, region, model, transport, tokenPlan, wsUrl, httpUrl, configured: !!apiKey && !!(transport === 'http' ? httpUrl : wsUrl) };
}

/** Each call owns one independent remote/self ASR task. Credentials never cross client APIs. */
export function createDashScopeAsrFactory(options = {}) {
  const config = asrConfiguration(options);
  if(config.transport==='http')return createHttpAsrFactory(config);
  return async function start({ track, model = config.model, onResult = () => {}, onError = () => {}, onStatus = () => {}, hotwords = [], context = [] } = {}) {
    if (!config.configured) throw new AsrError('ASR_NOT_CONFIGURED', '尚未配置实时语音识别，请管理员设置百炼 API Key、业务空间和地域');
    if(/^qwen-audio-\d+\.\d+-asr-flash$/.test(model))throw new AsrError('ASR_INVALID_CONFIG','该模型使用 HTTP 分段识别，请管理员将识别方式设为自动或 Token Plan');
    const url = new URL(config.wsUrl);
    if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new AsrError('ASR_INVALID_CONFIG', '语音识别接口必须使用安全 WebSocket 地址');
    if (!['remote', 'self'].includes(track)) throw new AsrError('ASR_INVALID_TRACK', '未知音频轨道');
    const taskId = randomUUID();
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${config.apiKey}` }, handshakeTimeout: config.startTimeoutMs || 10000, maxPayload: 512 * 1024, followRedirects: false });
    let ready = false, finished = false, closed = false, finishing = false, terminalError;
    let readyResolve, readyReject, finishResolve, finishReject, finishTimer;
    const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const finishPromise = new Promise((resolve, reject) => { finishResolve = resolve; finishReject = reject; });
    // finish may never be called after an upstream failure; attach a rejection
    // handler now while preserving the original rejecting promise for callers.
    finishPromise.catch(() => {});
    let samples = 0; const offsets = [];
    const mapTime = time => {
      if (time === null || time === undefined || !Number.isFinite(Number(time))) return null;
      const value = Math.max(0, Number(time));
      let point = offsets[0];
      for (let low = 0, high = offsets.length - 1; low <= high;) {
        const middle = (low + high) >> 1;
        if (offsets[middle].streamMs <= value) { point = offsets[middle]; low = middle + 1; } else high = middle - 1;
      }
      return Math.round(point ? point.sessionMs + value - point.streamMs : value);
    };
    const fail = error => {
      if (terminalError || finished || closed) return;
      terminalError = error;
      clearTimeout(startTimer); clearTimeout(finishTimer);
      readyReject(error); finishReject(error);
      try { onError(error); } catch {}
      socket.terminate();
    };
    const startTimer = setTimeout(() => fail(new AsrError('ASR_START_TIMEOUT', '语音识别连接启动超时，请检查云端网络和配置')), config.startTimeoutMs || 10000);
    socket.on('open', () => {
      const vocabulary = Object.fromEntries(hotwords.filter(word => typeof word === 'string' && word.trim() && word.length <= 80).slice(0, 200).map(word => [word.trim(), 3]));
      const parameters = { format: 'pcm', sample_rate: 16000, heartbeat: true, language_hints: ['zh', 'en'], ...(Object.keys(vocabulary).length ? { vocabulary } : {}) };
      if (model.startsWith('qwen-audio-3.1-')) parameters.vad_model = 'near_meeting_16k';
      else parameters.max_sentence_silence = Math.max(200, Math.min(6000, config.silenceMs || 600));
      const input = context.length ? { context: context.slice(-5) } : {};
      socket.send(JSON.stringify({ header: { action: 'run-task', task_id: taskId, streaming: 'duplex' }, payload: { task_group: 'audio', task: 'asr', function: 'recognition', model, parameters, input } }));
    });
    socket.on('message', (bytes, binary) => {
      if (binary || terminalError || closed) return;
      let event; try { event = JSON.parse(bytes.toString()); } catch { fail(new AsrError('ASR_PROTOCOL_ERROR', '语音识别返回了无法解析的数据')); return; }
      if (event.header?.task_id !== taskId) return;
      if (event.header.event === 'task-started') { ready = true; clearTimeout(startTimer); readyResolve(); try { onStatus('ready'); } catch {} }
      else if (event.header.event === 'task-failed') {
        const auth = /auth|key|permission|access/i.test(String(event.header.error_code || ''));
        fail(new AsrError(auth ? 'ASR_AUTH_FAILED' : 'ASR_UPSTREAM_FAILED', auth ? '语音识别认证失败，请管理员核对百炼密钥、业务空间和地域' : '语音识别任务失败，请检查服务配置、额度和网络后重试'));
      } else if (event.header.event === 'result-generated') {
        const sentence = event.payload?.output?.sentence;
        if (!sentence || sentence.heartbeat || !Number.isInteger(sentence.sentence_id) || typeof sentence.text !== 'string' || sentence.text.length > 16000) return;
        try { onResult({ segmentId: String(sentence.sentence_id), text: sentence.text, startMs: mapTime(sentence.begin_time) ?? 0, endMs: mapTime(sentence.end_time), final: sentence.sentence_end === true, usage: event.payload?.usage }); }
        catch { fail(new AsrError('ASR_CALLBACK_FAILED', '无法保存语音识别结果，请检查服务器存储状态')); }
      } else if (event.header.event === 'task-finished') { finished = true; clearTimeout(startTimer); clearTimeout(finishTimer); finishResolve({ usage: event.payload?.usage }); socket.close(); }
    });
    socket.on('error', () => fail(new AsrError('ASR_CONNECTION_FAILED', '语音识别连接失败，请检查服务器网络和百炼配置')));
    socket.on('close', () => {
      if (!finished && !closed && !terminalError) fail(new AsrError('ASR_DISCONNECTED', '语音识别连接已中断，录音可能存在缺口，请重新连接'));
      clearTimeout(startTimer); clearTimeout(finishTimer);
    });
    await readyPromise;
    return {
      taskId,
      async write(pcm, startMs) {
        if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % 2 || pcm.length > 6400 || !Number.isFinite(startMs) || startMs < 0) throw new AsrError('ASR_BAD_FRAME', '音频 frame 大小或时间戳无效');
        if (!ready || finishing || finished || closed || terminalError || socket.readyState !== WebSocket.OPEN) throw terminalError || new AsrError('ASR_NOT_READY', '语音识别连接尚未就绪或已经关闭');
        if (socket.bufferedAmount > 512 * 1024) { const error = new AsrError('ASR_BACKPRESSURE', '语音识别网络拥塞，已停止当前音频流以避免无限积压'); fail(error); throw error; }
        const streamMs = samples / 16;
        const last = offsets.at(-1);
        if (!last || Math.abs(startMs - (last.sessionMs + streamMs - last.streamMs)) > 5) offsets.push({ streamMs, sessionMs: startMs });
        samples += pcm.length / 2;
        if (offsets.length > 20000) { const error = new AsrError('ASR_TIMELINE_LIMIT', '音频时间轴中断过多，请结束后重新开始会话'); fail(error); throw error; }
        await new Promise((resolve, reject) => socket.send(pcm, { binary: true }, error => error ? reject(new AsrError('ASR_SEND_FAILED', '音频发送失败，请检查网络')) : resolve()));
      },
      async finish() {
        if (terminalError) throw terminalError;
        if (closed) throw new AsrError('ASR_CLOSED', '语音识别已关闭');
        if (!finishing && !finished) {
          finishing = true;
          finishTimer = setTimeout(() => fail(new AsrError('ASR_FINISH_TIMEOUT', '语音识别结束等待超时，最后一句可能尚未保存')), config.finishTimeoutMs || 10000);
          socket.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }));
        }
        return finishPromise;
      },
      close() { if (closed) return; closed = true; clearTimeout(startTimer); clearTimeout(finishTimer); const error = new AsrError('ASR_CLOSED', '语音识别已关闭'); readyReject(error); if (!finished) finishReject(error); socket.terminate(); }
    };
  };
}
