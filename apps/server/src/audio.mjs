import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open, stat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { hash, now, fail } from './auth.mjs';

export function parseAudioFrame(buffer, mode = 'live') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 18 || buffer.length > 6416 || buffer[0] !== 1 || buffer[1] > 1) fail(400, '音频数据帧格式无效');
  const flags = buffer.readUInt16BE(2), sampleCount = buffer.readUInt32BE(12);
  if (flags !== (mode === 'replay' ? 1 : 0) || sampleCount < 1 || sampleCount > 3200 || buffer.length !== 16 + sampleCount * 2) fail(400, '音频轨道、大小或回补标记无效');
  return { track: buffer[1] === 0 ? 'remote' : 'self', seq: buffer.readUInt32BE(4), startMs: buffer.readUInt32BE(8), sampleCount, pcm: buffer.subarray(16) };
}

export function attachInterviewAudio({ server, db, dataDir, publicOrigin, asrFactory, recordSegment, status, gap, maxSessionMinutes = 120, retentionDays = 7, maxUserBytes = 512 * 1024 * 1024, maxDailyMinutes = 480, asrEnabled = () => true, asrRequired = () => true, asrRequested = () => true, sessionAvailable = () => true,maxUserBytesFor = () => Infinity,reserveFrame = null,onStored = () => {} }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  const connections = new Map(), archiveChains = new Map();
  let closed = false;
  // Recompute once on startup, never by scanning an increasing recording per frame.
  db.exec(`DELETE FROM interview_audio_storage;
    UPDATE interviews SET frame_count=(SELECT count(*) FROM interview_audio_frames f WHERE f.session_id=interviews.id);
    INSERT INTO interview_audio_storage(user_id,bytes) SELECT i.user_id,sum(f.byte_count) FROM interview_audio_frames f JOIN interviews i ON i.id=f.session_id WHERE f.byte_offset IS NOT NULL GROUP BY i.user_id;
    INSERT OR IGNORE INTO interview_audio_usage(user_id,day,samples) SELECT i.user_id,substr(f.created_at,1,10),sum(f.sample_count) FROM interview_audio_frames f JOIN interviews i ON i.id=f.session_id WHERE f.asr_submitted=1 GROUP BY i.user_id,substr(f.created_at,1,10);`);
  const send = (connection, event) => { if (connection.ws.readyState === WebSocket.OPEN && connection.ws.bufferedAmount < 256 * 1024) connection.ws.send(JSON.stringify(event)); };
  const valid = c => {
    const row = db.prepare('SELECT i.status,i.device_id,u.disabled,d.user_id FROM interviews i JOIN users u ON u.id=i.user_id LEFT JOIN devices d ON d.id=? WHERE i.id=? AND i.user_id=?').get(c.deviceId, c.sessionId, c.userId);
    return sessionAvailable(c.sessionId)&&!!row && !row.disabled && row.user_id === c.userId && row.device_id === c.deviceId && (c.mode === 'replay' || row.status === 'recording');
  };
  const serialArchive = (key, operation) => {
    const prior = archiveChains.get(key) || Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    archiveChains.set(key, next);
    void next.finally(() => { if (archiveChains.get(key) === next) archiveChains.delete(key); }).catch(() => {});
    return next;
  };
  async function acceptFrame(c, frame) {
    if (!valid(c)) fail(403, '录音设备或会话状态已失效');
    if (frame.startMs + frame.sampleCount / 16 > maxSessionMinutes * 60000 + 1000 || frame.seq > maxSessionMinutes * 6000 + 10000) fail(400, '音频时间轴超过本场面试上限');
    const digest = createHash('sha256').update(frame.pcm).digest('hex');
    const duplicate = db.prepare('SELECT * FROM interview_audio_frames WHERE session_id=? AND track=? AND seq=?').get(c.sessionId, frame.track, frame.seq);
    if (duplicate) {
      if (duplicate.hash !== digest || duplicate.start_ms !== frame.startMs || duplicate.sample_count !== frame.sampleCount) fail(409, '同一音频编号的数据不一致');
      // ACK means durable receipt, not completed recognition. A replay must be
      // able to recover a stored frame whose first upstream submission failed.
      const replayKey = `${frame.track}:${frame.seq}`;
      if (c.mode !== 'replay' || c.replayed.has(replayKey)) return false;
      const prior=c.lastFrames.get(frame.track);
      if(prior&&(frame.seq<=prior.seq||frame.startMs<prior.startMs+prior.sampleCount/16-5))fail(400,'回补音频帧乱序或时间轴重叠');
      c.replayed.add(replayKey);c.lastFrames.set(frame.track,frame);return true;
    }
    const last = c.lastFrames.get(frame.track);
    if (last && (frame.seq <= last.seq || frame.startMs < last.startMs + last.sampleCount / 16 - 5)) fail(400, '音频帧乱序或时间轴重叠');
    if (last && frame.startMs > last.startMs + last.sampleCount / 16 + 100) gap(c.sessionId, frame.track, last.startMs + last.sampleCount / 16, frame.startMs, '音频采集时间轴存在间隙');
    let byteOffset = null;
    await serialArchive(c.userId, async () => {
      // Recheck inside the serialized operation, before accepting an old socket's data.
      if (!valid(c)) fail(403, '录音设备或会话状态已失效');
      const previous = db.prepare('SELECT hash FROM interview_audio_frames WHERE session_id=? AND track=? AND seq=?').get(c.sessionId, frame.track, frame.seq);
      if (previous) { if (previous.hash !== digest) fail(409, '重复音频数据不一致'); return; }
      const release=reserveFrame?.(c.userId,frame.pcm.length);try{
      if (c.mode === 'live') {
        const latest = db.prepare('SELECT seq,start_ms,sample_count FROM interview_audio_frames WHERE session_id=? AND track=? ORDER BY seq DESC LIMIT 1').get(c.sessionId,frame.track);
        if (latest && (frame.seq <= latest.seq || frame.startMs < latest.start_ms + latest.sample_count / 16 - 5)) fail(400,'音频帧编号或时间轴未延续上次连接');
      }
      const day=now().slice(0,10);
      const daily=db.prepare('SELECT samples FROM interview_audio_usage WHERE user_id=? AND day=?').get(c.userId,day)?.samples || 0;
      if(c.asrRequired && c.asrEnabled && daily+frame.sampleCount>maxDailyMinutes*60*16000)fail(429,'已达到今日音频识别额度，请明日继续或调整云端额度');
      if(db.prepare('SELECT frame_count FROM interviews WHERE id=?').get(c.sessionId).frame_count>=300000)fail(429,'本场面试音频帧数达到上限');
      { // Keep working PCM until session completion, even when archival retention is zero.
        const stored = db.prepare('SELECT bytes FROM interview_audio_storage WHERE user_id=?').get(c.userId)?.bytes || 0;
        if (stored + frame.pcm.length > Math.min(maxUserBytes,release?Infinity:maxUserBytesFor(c.userId))) fail(429, '原始录音或历史存储额度已满，请导出并删除旧记录后继续');
        const directory = path.join(dataDir, 'users', c.userId, 'interviews', c.sessionId);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const handle = await open(path.join(directory, `${frame.track}.pcm`), 'a', 0o600);
        try { byteOffset = (await handle.stat()).size; await handle.write(frame.pcm); } finally { await handle.close(); }
      }
      if (!valid(c)) fail(403, '录音设备或会话状态已失效');
      db.transaction(()=>{
        db.prepare('INSERT INTO interview_audio_frames(session_id,track,seq,start_ms,sample_count,byte_offset,byte_count,hash,replay,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(c.sessionId, frame.track, frame.seq, frame.startMs, frame.sampleCount, byteOffset, frame.pcm.length, digest, c.mode === 'replay' ? 1 : 0, now());
        let energy=0;for(let i=0;i<frame.pcm.length;i+=2){const sample=frame.pcm.readInt16LE(i);energy+=sample*sample;}const energetic=Math.sqrt(energy/frame.sampleCount)>150;
        db.prepare('UPDATE interview_audio_frames SET active=? WHERE session_id=? AND track=? AND seq=?').run(energetic?1:0,c.sessionId,frame.track,frame.seq);
        const firstFrame=db.prepare('SELECT frame_count FROM interviews WHERE id=?').get(c.sessionId).frame_count===0;
        db.prepare('UPDATE interviews SET frame_count=frame_count+1 WHERE id=?').run(c.sessionId);if(firstFrame)queueMicrotask(()=>onStored(c.sessionId));
        if(byteOffset!==null)db.prepare('INSERT INTO interview_audio_storage(user_id,bytes) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET bytes=bytes+excluded.bytes').run(c.userId,frame.pcm.length);
      })();
      }finally{release?.();}
    });
    c.lastFrames.set(frame.track, frame); c.lastMs = Math.max(c.lastMs, frame.startMs + frame.sampleCount / 16);
    return true;
  }
  async function finalize(c, drain = true, reason = '') {
    if (c.finalizing) return c.finalizing;
    c.stopping = true; clearTimeout(c.startTimer);
    c.finalizing = (async () => {
      await c.chain.catch(() => {});
      if (drain) {
        const results = await Promise.allSettled([...c.tasks.values()].map(task => task.finish()));
        const rejected=results.find(result=>result.status==='rejected');
        if(rejected)reason ||= rejected.reason?.message ? `语音识别尾段未完成：${rejected.reason.message}` : '语音识别尾句等待失败，记录可能存在缺口';
      }
      for (const task of c.tasks.values()) task.close();
      c.tasks.clear(); c.finalized=true; connections.delete(c.id);
      if (reason) gap(c.sessionId, null, c.lastMs || null, null, reason);
      const otherLive = [...connections.values()].some(x => x.sessionId === c.sessionId && x.mode === 'live' && !x.stopping);
      if (!otherLive && c.mode === 'live') status(c.sessionId, reason ? 'interrupted' : 'offline', reason || null, c.mode);
      send(c, { type: 'audio.stopped', sessionId: c.sessionId, ...(reason ? { error: reason } : {}) });
      if (c.ws.readyState === WebSocket.OPEN) c.ws.close(1000, 'audio stopped');
    })();
    return c.finalizing;
  }
  const breakConnection = (c, message) => {
    if (c.stopping) return;
    status(c.sessionId, 'error', message, c.mode);
    send(c, { type: 'audio.error', sessionId: c.sessionId, error: message });
    // Never await the same chain from its own rejection callback.
    void finalize(c, false, message).catch(() => {});
    c.ws.close(1008, 'audio rejected');
  };
  server.on('upgrade', (request, socket, head) => {
    let url; try { url = new URL(request.url, 'http://local'); } catch { return socket.destroy(); }
    if (url.pathname === '/ws') return;
    if (url.pathname !== '/audio' || closed) return socket.destroy();
    if (publicOrigin && request.headers.origin && request.headers.origin !== publicOrigin) return socket.destroy();
    let ticket;
    try {
      const token = url.searchParams.get('ticket'); if (!token || token.length > 256) return socket.destroy();
      ticket = db.transaction(() => { const found = db.prepare('SELECT * FROM interview_audio_tickets WHERE token_hash=?').get(hash(token)); db.prepare('DELETE FROM interview_audio_tickets WHERE token_hash=?').run(hash(token)); return found; })();
      if (!ticket || ticket.expires_at <= now() || !valid({ sessionId: ticket.session_id, userId: ticket.user_id, deviceId: ticket.device_id, mode: ticket.mode })) return socket.destroy();
      if ([...connections.values()].filter(c => c.userId === ticket.user_id).length >= 4) return socket.destroy();
    } catch { return socket.destroy(); }
    wss.handleUpgrade(request, socket, head, ws => {
      const c = { id: randomUUID(), sessionId: ticket.session_id, userId: ticket.user_id, deviceId: ticket.device_id, mode: ticket.mode, ws, tasks: new Map(), lastFrames: new Map(), replayed:new Set(), chain: Promise.resolve(), started: false, starting: false, stopping: false, alive: true, queuedBytes: 0, rateBytes: 0, rateMessages:0, rateAt: Date.now(), lastMs: 0 };
      for (const prior of connections.values()) if (prior.sessionId === c.sessionId && prior.mode === c.mode) { void finalize(prior, true, '录音连接已被新连接替代'); }
      connections.set(c.id, c);
      c.startTimer = setTimeout(() => breakConnection(c, '未及时开始音频传输'), 15000);
      ws.on('pong', () => { c.alive = true; });
      ws.on('message', (bytes, binary) => {
        if (c.stopping) return;
        if (!valid(c)) return breakConnection(c, '录音设备或账号已失效');
        if (Date.now() - c.rateAt > 1000) { c.rateBytes = 0; c.rateMessages=0; c.rateAt = Date.now(); }
        c.rateBytes += bytes.length;
        if (++c.rateMessages>200 || c.rateBytes > 256 * 1024 || c.queuedBytes + bytes.length > 512 * 1024) return breakConnection(c, '音频发送过快或网络积压，请保持实时发送节奏');
        if (!binary) {
          let event; try { event = JSON.parse(bytes.toString()); } catch { return breakConnection(c, '音频控制消息无效'); }
          if (event.type === 'audio.start') {
            if (c.started || c.starting || event.sampleRate !== 16000 || event.format !== 'pcm_s16le' || !Array.isArray(event.tracks) || event.tracks.length !== 2 || !event.tracks.includes('remote') || !event.tracks.includes('self')) return breakConnection(c, '音频启动参数不正确或已启动');
            c.starting = true; c.asrEnabled=asrEnabled(c.sessionId); c.asrRequired=asrRequired(c.sessionId);status(c.sessionId, 'connecting', null, c.mode);
            const hotwords = JSON.parse(db.prepare('SELECT hotwords FROM interviews WHERE id=?').get(c.sessionId).hotwords);
            const starts = (c.asrEnabled?['remote', 'self']:[]).map(async track => {
              const task = await asrFactory({ track, sessionId: c.sessionId, mode: c.mode, hotwords,
                onResult: result => { if (!c.finalized && (!c.stopping || c.finalizing)) {recordSegment(c.sessionId, track, `${c.id}:${result.segmentId}`, result, c.mode === 'replay');if(c.asrWarning){c.asrWarning=false;status(c.sessionId,c.mode==='live'?'recording':'backfilling',null,c.mode);}} },
                onWarning: warning => {if(!c.finalized){c.asrWarning=true;gap(c.sessionId,track,warning.startMs,warning.endMs,warning.message,{warning:true});}},
                onError: error => { if (!c.stopping) { if(c.asrRequired)breakConnection(c,error?.message || '语音识别连接中断');else{c.tasks.get(track)?.close();c.tasks.delete(track);status(c.sessionId,'transcription_warning','后台转写中断，音频仍继续保存',c.mode);} } }
              });
              if (c.stopping) { task.close(); return; } c.tasks.set(track, task);
            });
            c.chain = c.chain.then(async () => {
              const results = await Promise.allSettled(starts);
              if (results.some(r => r.status === 'rejected') && c.asrRequired) throw Object.assign(new Error('无法启动双路语音识别，请检查服务端配置、认证和网络'), { status: 503 });
              if (c.stopping || !valid(c)) { for (const task of c.tasks.values()) task.close(); return; }
              c.started = true; c.starting = false; clearTimeout(c.startTimer); status(c.sessionId, c.mode === 'live' ? 'recording' : 'backfilling', null, c.mode);
              send(c, { type: 'audio.ready', sessionId: c.sessionId, mode: c.mode });
              if(results.some(r=>r.status==='rejected')||(!c.asrEnabled&&asrRequested(c.sessionId)))status(c.sessionId,'transcription_warning','后台转写未能启动，音频继续保存，直答仍可使用',c.mode);
            }).catch(error => breakConnection(c, error.message));
          } else if (event.type === 'audio.stop') { void finalize(c, true).catch(() => breakConnection(c, '结束录音失败')); }
          else if (event.type === 'ping') send(c, { type: 'pong' });
          else breakConnection(c, '未知音频控制消息');
          return;
        }
        if (!c.started) return breakConnection(c, '请等待音频就绪后再发送数据');
        let frame; try { frame = parseAudioFrame(bytes, c.mode); } catch (error) { return breakConnection(c, error.message); }
        c.queuedBytes += bytes.length;
        c.chain = c.chain.then(async () => {
          if (c.stopping && !c.finalizing) return;
          const accepted = await acceptFrame(c, frame);
          if (accepted && c.tasks.has(frame.track)) {
            try{
            db.transaction(()=>{const day=now().slice(0,10),used=db.prepare('SELECT samples FROM interview_audio_usage WHERE user_id=? AND day=?').get(c.userId,day)?.samples||0;if(used+frame.sampleCount>maxDailyMinutes*60*16000)fail(429,'已达到今日音频识别额度，请明日继续或调整云端额度');db.prepare('INSERT INTO interview_audio_usage(user_id,day,samples) VALUES(?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET samples=samples+excluded.samples').run(c.userId,day,frame.sampleCount);})();
            await c.tasks.get(frame.track).write(frame.pcm, frame.startMs); db.prepare('UPDATE interview_audio_frames SET asr_submitted=1 WHERE session_id=? AND track=? AND seq=?').run(c.sessionId,frame.track,frame.seq);
            }catch(error){if(c.asrRequired)throw error;c.tasks.get(frame.track)?.close();c.tasks.delete(frame.track);status(c.sessionId,'transcription_warning','后台转写失败或额度不足，音频继续保存，直答仍可使用',c.mode);}
          }
          send(c, { type: 'audio.ack', track: frame.track, seq: frame.seq });
        }).catch(error => breakConnection(c, error.message || '音频保存失败')).finally(() => { c.queuedBytes -= bytes.length; });
      });
      ws.on('close', () => { if (!c.stopping) void finalize(c, true, '录音连接中断，请检查并补传本地缓存').catch(() => {}); });
      ws.on('error', () => { if (!c.stopping) breakConnection(c, '录音网络连接失败'); });
    });
  });
  const heartbeat = setInterval(() => {
    for (const c of connections.values()) {
      if (!valid(c) || !c.alive) { c.ws.terminate(); continue; }
      c.alive = false; c.ws.ping();
    }
    db.prepare('DELETE FROM interview_audio_tickets WHERE expires_at<?').run(now());
  }, 15000); heartbeat.unref();
  return {
    async flushSession(sessionId) {
      // Snapshot accepted frames before flushing; new frames continue to be archived normally.
      await Promise.all([...connections.values()].filter(c => c.sessionId === sessionId && c.mode === 'live' && !c.stopping).map(async c => {
        await c.chain;
        await Promise.all([...c.tasks.values()].map(task => task.flush?.()));
      }));
    },
    async stopSession(sessionId, { drain = true, reason = '' } = {}) { await Promise.all([...connections.values()].filter(c => c.sessionId === sessionId).map(c => finalize(c, drain, reason))); },
    revokeDevice(deviceId) { for (const c of connections.values()) if (c.deviceId === deviceId) { c.ws.terminate(); void finalize(c, false, '设备配对已撤销，录音已停止').catch(() => {}); } },
    revokeUser(userId) { for (const c of connections.values()) if (c.userId === userId) { c.ws.terminate(); void finalize(c, false, '账号不可用，录音已停止').catch(() => {}); } },
    async removeFiles(interview) { await serialArchive(interview.user_id,async()=>{await rm(path.join(dataDir, 'users', interview.user_id, 'interviews', interview.id), { recursive: true, force: true });db.transaction(()=>{const removed=db.prepare('SELECT COALESCE(sum(byte_count),0) AS n FROM interview_audio_frames WHERE session_id=? AND byte_offset IS NOT NULL').get(interview.id).n;db.prepare('UPDATE interview_audio_storage SET bytes=max(0,bytes-?) WHERE user_id=?').run(removed,interview.user_id);db.prepare('UPDATE interview_audio_frames SET byte_offset=NULL WHERE session_id=?').run(interview.id);})();}); },
    async close() { closed = true; clearInterval(heartbeat); await Promise.all([...connections.values()].map(c => finalize(c, true, '服务器停止，录音已暂停'))); for (const c of wss.clients) c.terminate(); await new Promise(r => wss.close(r)); await Promise.allSettled([...archiveChains.values()]); }
  };
}

export async function downloadInterviewAudio({ db, dataDir, interview, track, res }) {
  if (!['remote', 'self'].includes(track)) fail(404, '录音轨道不存在');
  const rows = db.prepare('SELECT * FROM interview_audio_frames WHERE session_id=? AND track=? AND byte_offset IS NOT NULL ORDER BY start_ms,seq').all(interview.id, track);
  if (!rows.length) fail(404, '原始录音未保留或已经过期');
  const filePath = path.join(dataDir, 'users', interview.user_id, 'interviews', interview.id, `${track}.pcm`);
  try { await stat(filePath); } catch { fail(404, '原始录音未保留或已经过期'); }
  const totalSamples = Math.ceil(rows.reduce((maximum,row)=>Math.max(maximum,row.start_ms*16+row.sample_count),0));
  const length = totalSamples * 2; const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(length + 36, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(length, 40);
  res.set({ 'Content-Type': 'audio/wav', 'Content-Length': String(length + 44), 'Content-Disposition': `attachment; filename="interview-${interview.id}-${track}.wav"` });
  const write = async bytes => { if (res.destroyed) throw new Error('download closed'); if (!res.write(bytes)) await once(res, 'drain'); };
  await write(header); let cursor = 0; const silence = Buffer.alloc(64000);
  for (const row of rows) {
    const target = Math.round(row.start_ms * 16) * 2;
    while (cursor < target) { const size = Math.min(silence.length, target - cursor); await write(silence.subarray(0, size)); cursor += size; }
    const skip = Math.max(0, cursor - target); if (skip >= row.byte_count) continue;
    for await (const bytes of createReadStream(filePath, { start: row.byte_offset + skip, end: row.byte_offset + row.byte_count - 1 })) { await write(bytes); cursor += bytes.length; }
  }
  while (cursor < length) { const size = Math.min(silence.length, length - cursor); await write(silence.subarray(0,size)); cursor += size; }
  res.end();
}
