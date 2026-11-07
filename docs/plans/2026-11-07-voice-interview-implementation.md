# Voice Interview Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Windows dual-track capture, real DashScope streaming ASR, persistent whole-interview transcripts, contextual AI suggestions, multi-device live viewing and v1.1 Windows/cloud deliverables.

**Architecture:** Keep audio media on an authenticated dedicated WebSocket. The backend owns real ASR task lifecycles, durable chronological transcripts and a per-interview answer pipeline. Both sides' actual speech and AI suggestions have distinct data types. Existing screenshot functionality remains intact. Credentials stay on the Linux service, PC credentials stay encrypted in Electron main.

**Tech Stack:** Existing Node/Express/ws/SQLite, Electron45 AudioWorklet/getDisplayMedia loopback/getUserMedia, React, DashScope native WebSocket, existing Codex/Claude plus text-only runner.

---

User approved the design in this chat. Reuse current checkout and branch. Full interface is `docs/VOICE-CONTRACT.md`; components own disjoint directories, root integrates and verifies. First write meaningful failing tests, then implementation, then actual verification. No fake production answers, no claims of measured ASR latency without a key/real audio test.

### Task 1: ASR protocol and lifecycle
Files: `apps/server/src/asr.mjs`, `apps/server/test/asr.test.mjs`.
Write tests using a real local mock upstream WS server: auth header, model/PCM run-task, task-started gate, split partial/final results, timestamp offsets, silence heartbeat, finish tail drain, startup/finish timeout, upstream failure and bounded buffers. Run and observe missing behavior, implement native ws adapter, pass tests. All mock injection stays test-only.

### Task 2: Session persistence and audio ownership
Files: `apps/server/src/interviews.mjs`, `audio.mjs`, DB/app/realtime integration; tests `interviews.test.mjs`.
Test two users, two devices, one-use audio tickets, paused/ended/revoked rejection, independent live/replay tracks, malformed/duplicate/out-of-order frames, timestamped segment revisions, full JSON/MD exports and recording cleanup. Implement durable session/transcript/question/answer/context/gap tables and migration. Verify complete history survives app restart.

### Task 3: Context and answer execution
Files: `apps/server/src/interview-context.mjs`, worker integration; root `text-providers.mjs` and `providers.mjs`.
Test text-only Codex and Claude subprocess inputs before enabling them; retain image behavior. Add optional warm Codex app-server transport if feasible with schema verified from installed CLI. Context tests prove prior actual user answers and relevant knowledge are included, unspoken AI suggestions excluded, budgets respected, prompt and transcript snapshot saved. Test auto question grouping, latest-question cancellation, revision replacement, manual triggers, quota and timeout, no auto-answer on backfill. Verify meaningful answer streaming.

### Task 4: Windows capture and spool
Files: desktop main/preload, audio window/AudioWorklet, PCM/spool helpers and tests.
Test resampler continuity and framing, bounded append journal, ACK/replay and account-generation invalidation. Implement shared system loopback + selected microphone without feeding input back to speakers, two meters and explicit start/pause/end. Add narrowly scoped local permissions, device-change recovery and local disk bounds. Preserve screenshot tests. Verify real capture using synthetic local audio or hardware preflight; do not claim microphone accuracy from synthetic tests.

### Task 5: Interview website
Files: `apps/web/src/InterviewPanel.tsx` / associated types/CSS and App/Realtime integration.
Implement session management, chronological transcripts, question selection, separate AI suggestions, recording indicators, partial revision, auto/manual controls, export/delete, error/missing-key states and multi-device restore. UI tests cover account switch, stale events, session filter and reconnect. Verify desktop and tablet layouts visually.

### Task 6: Integration and delivery
Root writes end-to-end tests: PC frame pipeline -> mocked real ASR wire -> durable transcript -> contextual test AI -> browser; plus actual text-only Codex check. Update `.env.example`, cloud instructions and retention/network notes; bump v1.1.0. Run all existing and new tests, web build, interview UI E2E, existing screenshot E2E, packaged executable smoke/full flow. Build Windows setup + portable and source archive, inspect source exclusions and EXE/ASAR/source consistency, regenerate checksums.

### Task 7: Independent review
After spec compliance, review actual authorization/CSRF/audio ticket boundaries, resource bounds, half-start capture cleanup, user/session changes, no-playback-muting/echo, ASR partial ordering, stop drains, timestamp mapping, queue replay behavior, recording deletion, AI context grounding and docs/deploy correctness. Fix material findings with regression tests. Clearly state real DashScope credential/network and physical interview audio validation boundaries in final verification record.
