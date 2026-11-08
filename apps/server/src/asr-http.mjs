import { AsrError } from './asr.mjs';

const bounded = (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value) || fallback));
const failure = (code, message) => new AsrError(code, message);

function wave(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Bounded, independent queues for each recording track; ACK never waits for an HTTP request. */
export function createHttpAsrFactory(config) {
  return async function start({ track, model = config.model, hotwords = [], onResult = () => {}, onError = () => {}, onStatus = () => {} } = {}) {
    if (!config.configured) throw failure('ASR_NOT_CONFIGURED', '请在管理员账号设置中配置语音识别密钥和接口');
    if (!['remote', 'self'].includes(track)) throw failure('ASR_INVALID_TRACK', '未知音频轨道');
    if (!/^qwen-audio-\d+\.\d+-asr-flash$/.test(model)) throw failure('ASR_INVALID_CONFIG', '分段识别需要非实时模型，例如 qwen-audio-3.0-asr-flash');
    const url = new URL(config.httpUrl);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw failure('ASR_INVALID_CONFIG', '分段识别接口必须使用 HTTPS，且不能包含凭据或查询参数');
    const chunkMs = bounded(config.chunkSeconds, 4, 2, 15) * 1000;
    const silenceMs = bounded(config.silenceMs, 500, 200, 1500);
    const timeoutMs = bounded(config.requestTimeoutMs, 10000, 50, 30000);
    const maxPending = bounded(config.maxPendingChunks, 4, 1, 8);
    const root = new AbortController();
    let closed = false, finishing = false, terminalError, queue = Promise.resolve(), pending = 0, nextId = 0;
    let frames = [], bytes = 0, voiced = false, voicedMs = 0, silentMs = 0, previousEnd = null;
    const reset = () => { frames = []; bytes = 0; voiced = false; voicedMs = 0; silentMs = 0; };
    const fail = error => {
      if (closed || terminalError) return;
      terminalError = error; root.abort(); reset();
      try { onError(error); } catch { /* The recording layer owns its callback errors. */ }
    };
    async function recognize(chunk, segmentId) {
      const pcm = Buffer.concat(chunk.map(f => f.pcm)), startMs = chunk[0].startMs, duration = pcm.length / 32;
      const vocabulary = Object.fromEntries(hotwords.filter(w => typeof w === 'string' && w.trim() && w.length <= 80).slice(0, 200).map(w => [w.trim(), 4]));
      const payload = { model, input: { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,' + wave(pcm).toString('base64') } }] }] }, parameters: { format: 'wav', sample_rate: 16000, language_hints: ['zh', 'en'], ...(Object.keys(vocabulary).length ? { vocabulary } : {}) } };
      let body;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (root.signal.aborted) return;
        const deadline = AbortSignal.timeout(timeoutMs);
        try {
          const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.any([root.signal, deadline]), headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          if (!response.ok) {
            await response.body?.cancel();
            if ((response.status === 429 || response.status >= 500) && !attempt) { await delay(); continue; }
            throw failure(response.status === 401 || response.status === 403 ? 'ASR_AUTH_FAILED' : 'ASR_UPSTREAM_FAILED', response.status === 401 || response.status === 403 ? '语音识别认证或模型权限不足，请管理员核对 Token Plan Key 与套餐额度' : `分段语音识别接口返回 HTTP ${response.status}，请检查模型、额度及接口地址`);
          }
          let size = 0, chunks = [];
          for await (const data of response.body) {
            size += data.length;
            if (size > 1024 * 1024) throw failure('ASR_PROTOCOL_ERROR', '语音识别结果超过大小限制');
            chunks.push(data);
          }
          try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw failure('ASR_PROTOCOL_ERROR', '语音识别返回了无法解析的数据'); }
          break;
        } catch (error) {
          if (root.signal.aborted) return;
          if (error instanceof AsrError) throw error;
          if (!attempt) { await delay(); continue; }
          throw failure(deadline.aborted ? 'ASR_TIMEOUT' : 'ASR_CONNECTION_FAILED', deadline.aborted ? '分段语音识别请求超时，录音已保存，可重新连接补传' : '分段语音识别连接失败，录音已保存，请检查服务器网络');
        }
      }
      if (closed || terminalError || root.signal.aborted) return;
      if (body.code) throw failure('ASR_UPSTREAM_FAILED', '语音识别任务失败，请检查模型权限、额度及请求配置');
      const output = body.output || body, sentence = output.sentence;
      const sentences = Array.isArray(sentence) ? sentence : sentence ? [sentence] : Array.isArray(output.sentences) ? output.sentences : null;
      const results = sentences || [{ text: output.text ?? body.text }];
      if (!results.length || results.some(s => typeof s.text !== 'string' || s.text.length > 16000)) throw failure('ASR_PROTOCOL_ERROR', '语音识别结果缺少有效文字字段');
      for (const [index, result] of results.entries()) {
        if (!result.text.trim()) continue;
        const at = value => Math.max(0, Math.min(duration, Number(value) || 0));
        try { onResult({ segmentId: `${segmentId}:${index}`, text: result.text.trim(), startMs: Math.round(startMs + at(result.begin_time)), endMs: Math.round(startMs + (Number.isFinite(result.end_time) ? at(result.end_time) : duration)), final: true, usage: body.usage }); }
        catch { throw failure('ASR_CALLBACK_FAILED', '无法保存语音识别结果，请检查服务器存储状态'); }
      }
    }
    function delay() {
      return new Promise(resolve => { const finish = () => { clearTimeout(timer); root.signal.removeEventListener('abort', finish); resolve(); }; const timer = setTimeout(finish, 300); root.signal.addEventListener('abort', finish, { once: true }); if (root.signal.aborted) finish(); });
    }
    function submit() {
      if (!voiced) { reset(); return; }
      if (pending >= maxPending) { const error = failure('ASR_BACKPRESSURE', '语音识别处理积压，录音已保存，请稍后重新连接补传'); fail(error); throw error; }
      const chunk = frames, id = String(nextId++); reset(); pending++;
      queue = queue.then(() => { if (!closed && !terminalError) return recognize(chunk, id); }).catch(fail).finally(() => { pending--; });
    }
    async function flush() {
      if (terminalError) throw terminalError;
      if (closed) throw failure('ASR_CLOSED', '语音识别已关闭');
      submit(); await queue;
      if (terminalError) throw terminalError;
      if (closed) throw failure('ASR_CLOSED', '语音识别已关闭');
    }
    onStatus('ready');
    return {
      async write(pcm, startMs) {
        if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > 6400 || !Number.isFinite(startMs) || startMs < 0) throw failure('ASR_BAD_FRAME', '音频 frame 大小或时间戳无效');
        if (terminalError) throw terminalError;
        if (closed || finishing) throw failure('ASR_CLOSED', '语音识别已关闭');
        if (previousEnd !== null && startMs < previousEnd - 5) throw failure('ASR_BAD_FRAME', '音频时间轴重叠');
        if (previousEnd !== null && Math.abs(startMs - previousEnd) > 5) submit();
        const duration = pcm.length / 32;
        let energy = 0; for (let i = 0; i < pcm.length; i += 2) { const n = pcm.readInt16LE(i); energy += n * n; }
        const speech = Math.sqrt(energy / (pcm.length / 2)) > (config.energyThreshold ?? 150);
        frames.push({ pcm: Buffer.from(pcm), startMs }); bytes += pcm.length;
        if (speech) { voiced = true; voicedMs += duration; silentMs = 0; } else silentMs += duration;
        previousEnd = startMs + duration;
        // Keep a short lead-in but never submit long periods of silence.
        if (!voiced) while (bytes > 6400 && frames.length > 1) bytes -= frames.shift().pcm.length;
        if (voiced && (bytes / 32 >= chunkMs || (silentMs >= silenceMs && voicedMs >= 100))) submit();
      },
      flush,
      async finish() {
        finishing = true;
        let timer;
        try { await Promise.race([flush(), new Promise((_, reject) => { timer = setTimeout(() => { const error = failure('ASR_FINISH_TIMEOUT', '分段语音尾段识别超时，录音已保存，可重新连接补传'); fail(error); reject(error); }, bounded(config.finishTimeoutMs, 15000, 50, 30000)); })]); return {}; }
        finally { clearTimeout(timer); }
      },
      close() { if (closed) return; closed = true; root.abort(); reset(); }
    };
  };
}
