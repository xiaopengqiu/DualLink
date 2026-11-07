# Voice / Interview v1.1 contract

Extend the existing app without breaking screenshot/auth/pairing APIs. All IDs UUID, ISO dates UTC. All routes `/api`. Existing browser cookie+CSRF / device bearer authenticate ownership. No public audio or transcripts. No production fake ASR/AI.

## ASR and text runner interfaces
Server owns ASR implementation; root owns `text-providers.mjs` and existing `providers.mjs`.
`createTextRunner(cliOptions)` -> async `run({provider,prompt,jobDir,sessionId,userId,signal,onDelta})` -> `{answer,usage?}`. Text only, no fake screenshot; same CLI/native/docker options. Default supports Codex/Claude; optional Codex app-server warm transport. Caller creates private per-job directory. `runner.closeSession?.(id)` and `runner.close?.()` optional lifecycle cleanup.
ASR factory injectable only by tests: `asrFactory({track,sessionId,onResult,onError,onStatus})` -> `{write(pcm,startMs),finish(),close()}` (may be async factory). Real DashScope WebSocket, two tasks remote/self, await task-started before audio, bounded queue and explicit timeout. Use current Qwen Streaming protocol with API key in server only. `onResult({segmentId,text,startMs,endMs,final})`; timestamps normalized to interview session clock.

## Interviews
- `GET /interviews/config` authenticated -> `{configured:boolean,model,region,sampleRate:16000,maxSessionMinutes:120,rawAudioRetentionDays:number,autoAnswerAvailable:boolean}`. No secrets. Missing ASR key is explicit unavailable state.
- `POST /interviews {title?,provider?,promptId?,autoAnswer?:boolean,hotwords?:string[]}` -> `{interview}`. Browser or paired device allowed; deviceId inferred for PC. Account may have max 1 recording interview; server rejects concurrent recording sessions. Browser-created session may later be attached by an owned device.
- Interview `{id,title,status:'recording'|'paused'|'ended',provider,promptId?,promptName,autoAnswer,deviceId:null|string,createdAt,endedAt:null|string,updatedAt,recordingStatus?,summary?,error?}`.
- `GET /interviews?limit=50` -> `{interviews}`.
- `GET /interviews/:id` -> `{interview,segments,questions,answers,gaps,contextSummary?}`. Segments chronological; historical recordings remain available after devices revoked. Bound list paging or include cursor if > 2000 records. All terminal transcripts retained in DB; download exports complete history.
- `PATCH /interviews/:id {title?,autoAnswer?,provider?}` -> `{interview}`; changing provider cancels active answer first. Prompt snapshot taken at interview start; style not silently modified by later prompt edits.
- `POST /interviews/:id/pause`, `/resume`, `/end` -> `{interview}`; stop ASR cleanly, flush pending final results before final end state where possible; mark interruption/gap on failure. Paused audio rejected; resume creates new track tasks and offsets.
- `DELETE /interviews/:id` cancels work, closes capture sockets, deletes DB/audio files -> `{ok:true}`.
- `GET /interviews/:id/export?format=json|md` authenticated complete transcript, actual spoken text separated from AI suggestions; no source truncation in export.
- Optional `GET /interviews/:id/audio/:track` authenticated private WAV/PCM download if retained. Explicit rawAudioRetentionDays env, default 7; transcript retention independent.

## Segments, questions and answers
Segment `{id,sessionId,track:'remote'|'self',segmentId,text,startMs,endMs:null|number,final:boolean,revision:number,createdAt,updatedAt}`. Upsert by ASR epoch+track+provider segmentId, not append every partial. Keep revisions/audit records if final text changes. Remote vs self identifies source, not individual remote speaker.
Question `{id,sessionId,text,segmentIds:string[],revision,status:'pending'|'answering'|'answered'|'cancelled'|'failed',createdAt,updatedAt}`.
Answer `{id,sessionId,questionId,questionRevision,provider,status:'queued'|'running'|'completed'|'failed'|'cancelled',text,error?,contextSnapshotId?,createdAt,updatedAt,usage?}`.
- `POST /interviews/:id/questions {text?,segmentIds?:string[]}` -> `{question,answer}`. Explicit selection/manual text can trigger answer even autoAnswer false. If segmentIds used, all must be owned session, final remote segments. Never treat self-transcript or previous AI suggestion as interviewer question.
- `POST /interviews/:id/questions/:qid/answer` -> `{question,answer}` regenerate current question.
- `POST /interviews/:id/answers/:aid/cancel` -> `{answer}`.
- Auto-question assembly: collect consecutive final remote segments with debounce, known pause and question intent; don't spawn on each partial. Support requests like “介绍一下你的项目” without question mark. Bound waiting; user can explicitly trigger. Merge continuing remote sentences during debounce. New question prioritizes latest; cancel stale answer; immutable answer is tied to question revision and context snapshot. Replay/backfill segments are stored but never auto-answer.
- Context: style snapshot + relevant knowledge + facts summary / relevant prior turns + recent verbatim remote/self history + current question. Exclude unspoken AI suggestions from factual history. Preserve full transcript in DB, use bounded prompt context. Summarization/context selection may be deterministic extractive with clear label; never claim a summary includes omitted facts. Save context snapshot and transcript watermark for traceability.
- Reuse daily quota_events for answer submissions; per-user queue/timeout caps. A resumed upload doesn't duplicate questions/answers.

## Audio upload WebSocket
- `POST /interviews/:id/audio-ticket {mode?:'live'|'replay'}` -> `{ticket,path:'/audio?ticket=...',expiresAt}`. Device only; same paired owner, recording session, assigned device or first owned attachment; ticket 30 seconds single use. Browser watches via existing /ws events. Revalidate device/user/session during audio messages and on revocation/disable/end.
- Audio socket is separate from existing `/ws` 240/min signaling limit. Both upgrade handlers must ignore each other's known paths (do not destroy `/audio` before auth); unknown upgrades are rejected safely.
- First JSON control `{type:'audio.start',sampleRate:16000,format:'pcm_s16le',tracks:['remote','self']}`; server `{type:'audio.ready',sessionId,mode:'live'|'replay'}` only after real ASR tasks ready. Bounded startup audio buffering on PC.
- Binary frame: 16-byte header + little-endian signed PCM16 payload. byte0 version=1; byte1 track 0 remote / 1 self; UInt16BE flags at2 (bit0 replay); UInt32BE seq at4 (per track monotonic, starts0); UInt32BE startMs at8 (relative to session capture clock); UInt32BE sampleCount at12. payload length == sampleCount*2, sampleCount <=3200 (200ms), >=1. Total frame <=6416. Max paced bytes/rate; reject malformed/foreign/oversized frames, bound bufferedAmount. Duplicate `(session,track,seq)` ignored and acked.
- Server sends `{type:'audio.ack',track,seq}` after frame accepted durably (raw append/index if retained). Client may remove spool data only after ack / keep export according to local retention. JSON `{type:'audio.stop'}` flushes/finishes tasks and sends `{type:'audio.stopped'}`. Socket close does not end the whole interview; record gaps/reconnect. End interview is explicit REST.
- Local spool is append-only PCM/frame journal with bounded disk use, not thousands of per-frame files; queue rejects overrun with visible error. Existing credentials only main process, renderer never receives secret. On revoke/unpair stop capture and clear account-scoped memory; preserve/delete local private unfinished recording via explicit recovery UI only, never upload to a newly paired different account.
- On reconnect, current live audio has priority. Prior PCM can be replayed on a separate authenticated mode='replay' socket/task with original timestamps; replay never blocks live nor triggers stale answers. Replay tracks task offset separately from live. If full automated replay cannot be completed, keep downloadable local recovery and mark incomplete recording/gaps explicitly instead of pretending complete.

## Broadcast events (existing authenticated /ws)
`{type:'interview.updated',interview}`
`{type:'interview.segment',sessionId,segment}`
`{type:'interview.question',sessionId,question}`
`{type:'interview.answer',sessionId,answer}`
`{type:'interview.answer.delta',sessionId,answerId,delta}`
`{type:'interview.audio.status',sessionId,track?,status,error?,gap?}`
Only owner receives events, UI filters active session. Reconnect refetches durable data; all connected owned devices can watch current recording.

## Windows / browser UI
PC adds 面试录音 panel: microphone selection, session title/provider, active session status, two level meters, preflight, Start/Pause/Resume/End, local backlog/recovery notice, explicit recording indicator. User starts/stops intentionally. System audio uses Electron `audio:'loopback'`, never loopbackWithMute; local media graph outputs silence (no replay/feedback). Microphone permission allowed only to trusted local audio page after user action; screenshot permissions remain restricted. User must choose same microphone as meeting. Support hot unplug / device changes with visible errors + gaps/restart. No claim current system loopback captures only selected external meeting app.
Renderer produces continuous resampled 16k PCM16 with AudioWorklet, bounded chunk IPC (100ms) and generation guards. Start both tracks atomically or stop both and surface failure, never silently label half-recorded interview complete. Read-only selected microphone names/device IDs cross preload, no credentials.
Web adds 面试会话 page: create/select/history, live timeline (远端/本人), separate AI suggestions, partial/final status, auto/manual answer controls, optional correction/manual question, answer cancellation, sources/context note, export and deletion. Observe recorder status; web itself need not request mic. Account switching clears all session caches and in-flight data.

## Environment and ownership
ASR vars: `DASHSCOPE_API_KEY`, `DASHSCOPE_WORKSPACE_ID`, `ASR_REGION=cn-beijing`, `ASR_MODEL=qwen-audio-3.1-asr-flash-streaming`, optional `ASR_WS_URL` restricted server config, `ASR_MAX_SESSION_MINUTES=120`, `ASR_DAILY_MINUTES=480` (both tracks combined, per account UTC day), `AUDIO_RETENTION_DAYS=7`, `INTERVIEW_AI_TIMEOUT_MS=90000`, `INTERVIEW_CONTEXT_CHARS=40000`, `INTERVIEW_AUTO_DEBOUNCE_MS=800`.
Root owns package/lock/version/release/docs/e2e and `apps/server/src/text-providers.mjs`, existing `providers.mjs`, tests `text-providers.test.mjs`/provider fixtures. Backend agent owns other apps/server/**, including ASR adapter and interviews integration. Web owns apps/web/**. Desktop owns apps/desktop/**. Don't modify other owners' files or commit. Coordinate schema changes immediately.
