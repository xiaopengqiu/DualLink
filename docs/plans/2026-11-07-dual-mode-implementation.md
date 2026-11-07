# Dual interview mode implementation plan

**Goal:** Configurable audio-native and transcript→text modes with explicit hotkey answer generation.
**Architecture:** Preserve desktop dual-track PCM/upload and server authoritative history. Add Qwen manual audio adapter with fresh per-answer context and account defaults/session fields; manual trigger snapshots accepted audio/text. Full contract is docs/DUAL-MODE-CONTRACT.md.
**Tech stack:** Existing Electron/Node/SQLite/React/ws; no new SDK dependency.

1. Root: write failing native-wire tests, implement bounded/cancellable Qwen adapter with source-labelled audio, text-only response. Test mock upstream protocol (not production fake).
2. Server: write failing migration/default/trigger/native selection tests; extend DB/API/audio capture path and worker. Read PCM with quota, ownership and watermark bounds; support ASR-independent recording and async optional transcripts. Preserve HTTP support and old APIs.
3. Desktop: write failing hotkey/conflict and live-flush trigger tests; add mode inputs, account defaults, preload IPC and Worklet flush handshake, explicit answer button/global shortcut.
4. Web: write failing config/mode/manual trigger tests; add per-account defaults, session controls, no-transcript/audio state and native provider labels. Verify compact iPad layouts and auth cache reset.
5. Root integrate/review: run full tests/build, native and text manual trigger E2E, packaged EXE checks. Update guides/env, bump1.2.0, create installer/portable/source/web archives and hashes, push main and release per established authorization.
