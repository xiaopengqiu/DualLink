# Dual Link API contract (v1)

All JSON responses are objects; errors: `{error: string, code?: string}`. Dates are ISO UTC strings. IDs are UUIDs. HTTP base `/api`. Browser uses HttpOnly `dl_session` cookie and includes `X-CSRF-Token` returned by login/me on mutations. Device uses `Authorization: Bearer <deviceSecret>`. Browser and device cannot access another user's data. WebSocket uses short-lived one-use tickets, not permanent credentials in URLs.

## Accounts
- `POST /auth/login {email,password}` -> `{user,csrfToken}`. User `{id,email,name,role:'admin'|'user',disabled:boolean,dailyLimit:number}`.
- `GET /auth/me` -> `{user,csrfToken}`; `POST /auth/logout` -> `{ok:true}`.
- `POST /auth/password {currentPassword,newPassword}` -> `{ok:true}`.
- No public registration. CLI bootstrap `npm run admin -- --email <email> --name <name>` reads password from stdin (or DUALLINK_ADMIN_PASSWORD env); no default credentials.
- `GET /admin/users` -> `{users}`; `POST /admin/users {email,name,password,dailyLimit?}` -> `{user}`; `PATCH /admin/users/:id {name?,disabled?,dailyLimit?,password?}` -> `{user}`. Prevent disabling last admin / self. Disabled users lose sessions, device access and websocket access.
- `GET /config` authenticated -> `{providers:['codex','claude'],defaultProvider:'codex',iceServers:[],maxUploadBytes:number}`. Do not expose model secrets. Optional `GET /admin/diagnostics` -> non-secret CLI availability/version only.
- Config also includes account `autoAnalyze:boolean`. Browser `PUT /settings {autoAnalyze}` saves it; automatic capture analysis requires both the PC request flag and account setting to be true. Explicit Analyze remains available.

## Devices and pairing
- Unauthenticated but rate-limited `POST /pairings {name,deviceSecret}` (32+ random bytes, generated on PC) -> `{id,code,expiresAt}` (code 8 chars; 5 min). DB stores only secret hash. `GET /pairings/:id` with bearer deviceSecret -> `{status:'pending'|'approved'|'expired',device?:Device}`; browser cannot claim secret.
- Browser `POST /pairings/approve {code}` -> `{device}` assigns to current user, single use. Device `{id,name,lastSeenAt,createdAt,online:boolean}`.
- `GET /devices` -> `{devices}`; `DELETE /devices/:id` -> `{ok:true}` revokes token + active connections.
- `GET /device/me` device bearer -> `{device,user:{id,name},settings:{defaultProvider,defaultPromptId}}`.
- `DELETE /device/me` device bearer revokes its own device token and live connections.

## Prompts and knowledge
- `GET /prompts` -> `{prompts}`. Prompt `{id,name,content,isDefault:boolean,version:number,createdAt,updatedAt}`. Each new account gets a useful default Chinese prompt.
- `POST /prompts {name,content,isDefault?}` -> `{prompt}`; `PUT /prompts/:id {name,content,isDefault?}` -> `{prompt}`; `DELETE /prompts/:id` -> `{ok:true}`. Always one default if prompts remain.
- `GET /knowledge` -> `{files}`. KnowledgeFile `{id,name,size,status:'ready'|'error'|'processing',error?,characters,createdAt}`.
- `POST /knowledge` multipart `file` (TXT/MD/PDF/DOCX, max 10MiB) -> `{file}`. Parse text safely, store original privately; empty/scanned PDFs report actionable extraction error. `DELETE /knowledge/:id` -> `{ok:true}`; `GET /knowledge/:id/download` owned download.
- Knowledge excerpts selected with a total context budget; citations carry source filenames. No vector API dependency required.

## Captures and tasks
- Browser or device `POST /captures` multipart: `image` (PNG/JPEG/WebP max 12MiB), `captureId` UUID (idempotency key), optional `provider` codex|claude, `promptId`, `question` string, `analyze` 'true'|'false'. Device may only upload for itself; browser optional `deviceId` must be owned. -> `{capture,task:Task|null}`.
- Capture `{id,captureId,deviceId:null|string,deviceName?,createdAt,imageUrl:'/api/captures/:id/image'}`.
- Task `{id,captureId:internalCaptureId,provider,status:'queued'|'running'|'completed'|'failed'|'cancelled',answer,error:null|string,question,promptName,createdAt,updatedAt,sources:[{name,excerpt}],usage?:object}`. Task prompt is snapshotted at creation.
- `GET /captures?limit=50` -> `{captures}`; `GET /captures/:id/image` browser OR device owned image; `DELETE /captures/:id` cancels related work and removes file.
- `GET /tasks?limit=50` -> `{tasks}`; `GET /tasks/:id` -> `{task}`.
- `POST /captures/:id/analyze {provider?,promptId?,question?}` -> `{task}`. Dedup active job for same capture; completed captures may be reanalyzed by explicit action. Enforce per-user daily limit and max pending work.
- `POST /tasks/:id/cancel` -> `{task}`; `POST /tasks/:id/retry` -> `{task}` only failed/cancelled, resets answer and enqueues with quota check.
- Worker queue is durable SQLite, atomic claim, restart recovery, bounded concurrency and timeout. Native CLI first; Docker per-job execution configurable for multi-user cloud isolation. Tests inject fake runner; never silently serve fake answers in production.

## WebSocket
- Browser/device `POST /ws-ticket {kind:'web'|'desktop'}` -> `{ticket}`; auth determines kind; ticket TTL 30 seconds single use.
- Connect `/ws?ticket=...`; first event `{type:'hello',peerId,kind,devices:[...]}`. Peer IDs are connection IDs, ephemeral.
- Events `{type:'devices.updated',devices}`, `{type:'capture.created',capture}`, `{type:'task.updated',task}`, `{type:'task.delta',taskId,delta}`, `{type:'peer.joined',peer:{id,kind,deviceId?,name}}`, `{type:'peer.left',peerId}`; hello also includes `peers`.
- Client sends `{type:'signal',targetPeerId,payload}`; forwarded `{type:'signal',fromPeerId,payload,deviceId?}`. Only opposite kinds, same owner, bounded payload; no arbitrary messages routed to foreign account. JSON ping/pong and WS protocol heartbeat.
- Signaling payloads `{kind:'offer'|'answer',sdp}` / `{kind:'ice',candidate}`. PC initiates to each web peer; web requests reconnect with `{kind:'request'}`. Auto-answer direct channel label `dual-link-captures`.

## WebRTC screenshot protocol
- RTCDataChannel ordered/reliable. PC sends JSON `{type:'capture.start',captureId,name,mime,size,deviceId}` then ArrayBuffer chunks <= 48KiB and JSON `{type:'capture.end',captureId}`. One active transfer per channel; max 12MiB, receive timeout, verify cumulative size. Sender uses bufferedAmount backpressure.
- iPad creates Blob, previews and automatically uploads with same captureId if auto-analyze enabled (checkbox, default on), else stages pending screenshot and offers Analyze button. Cloud fallback upload by PC after 2 seconds uses same captureId; server deduplicates image and initial AI task. PC cloud default can upload immediately; LAN-first mode waits for receipt ACK `{type:'capture.ack',captureId}` only after cloud upload succeeds, then skips fallback. If web closes before upload PC still uploads.
- Explicit manual review mode (`analyze:false`) is sent from PC settings and must be preserved across direct and fallback routes. PC capture.start includes `analyze:boolean`, `provider`, optional `promptId`; web may make auto behavior stricter but never bypass PC manual review.

## Ownership and source files
- Root owns root package.json/lock, docs, deployment, release scripts, end-to-end tests.
- Server implementer owns apps/server/** only (package file precreated; communicate dependency changes).
- Web implementer owns apps/web/** only.
- Desktop implementer owns apps/desktop/** only.
- Work on current codex/dual-link branch, no separate worktree required (empty clean initial repository); do not commit while others implement.
