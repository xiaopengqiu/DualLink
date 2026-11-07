# Dual Link Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a working self-hosted Windows screenshot assistant with iPad web UI, multi-user accounts, pairing, per-user prompts and knowledge, Codex/Claude execution, LAN transfer, Windows packages and Alibaba Linux deployment instructions.

**Architecture:** Electron owns local capture and credentials. Express serves the React website and authenticated APIs/WSS; SQLite and a private file directory persist state on one VPS. A bounded durable worker executes real model CLIs with per-job inputs and an optional Docker isolation backend. HTTPS cloud upload is reliable fallback for WebRTC direct transfer.

**Tech Stack:** Node.js 22.14+, React, TypeScript, Vite, Electron, Express, better-sqlite3, ws, sharp, mammoth, pdf-parse, built-in node:test and Playwright.

---

The user authorized implementation in this session. Reuse the empty checkout on branch `codex/dual-link`. API and transfer schemas are specified in `docs/CONTRACT.md`. Parallel components own disjoint directories; integration/review remains sequential.

### Task 1: Persistence and account isolation
Create `apps/server/src/db.mjs`, `auth.mjs`, `app.mjs`; tests `apps/server/test/auth.test.mjs`.
Write a failing integration test that bootstraps two users, logs each in and attempts foreign resource access; run `node --test apps/server/test/auth.test.mjs` and confirm missing behavior. Implement scrypt passwords, hashed sessions, CSRF, admin CLI, disabled-user revocation and last-admin protection. Verify correct login and cross-user rejection with real temporary SQLite databases.

### Task 2: Pairing and transport authentication
Create `apps/server/src/realtime.mjs` and pairing routes. Test code expiration, single use, secret hashing and one-use WS tickets before implementation. Verify owned PC token works and revoked/foreign device fails. Use ws clients in real local HTTP tests.

### Task 3: Private uploads, prompt snapshots and knowledge retrieval
Create `apps/server/src/knowledge.mjs`, storage helpers and routes. Tests cover path traversal, file size/type, Unicode knowledge retrieval, prompt defaults, snapshot consistency, image access and idempotent capture submission. Implement private files with random IDs; parse TXT/MD/PDF/DOCX and pass bounded source excerpts.

### Task 4: Durable AI jobs and CLI adapters
Create `apps/server/src/worker.mjs` and `providers.mjs`. First test subprocess argument separation, split JSONL chunks, Claude image blocks, Codex completed assistant messages, stderr limits, timeouts, cancellation, retries and restart recovery against fake executable fixtures. Implement adapters using spawn with `shell:false`; never substitute a mock provider in the deployed app. Provide native and per-job Docker execution. Verify task state persists and completes after browser disconnect.

### Task 5: iPad website
Create `apps/web/src/{App.tsx,api.ts,styles.css}`, `index.html`, Vite and TS config. Implement login, pairing, sidebar navigation, screenshot/answer workspace, safe Markdown, prompts, knowledge, devices, password and admin user management. Use WSS with reconnect and refetch persisted state. Test meaningful user flows with Playwright at desktop and iPad viewport sizes. Keyboard/focus, empty/error/loading states and accessible labels are required.

### Task 6: Windows client
Create `apps/desktop/{main.cjs,preload.cjs,lib,renderer,assets}` and node tests. First test URL validation, retry queue, capture metadata and bounded WebRTC transfer helpers. Implement system tray, configurable global shortcuts, full-screen and region capture, display selection, secure credential persistence, pairing QR/code, connection/retry states and auto-start preference. Preload exposes only named IPC methods; no Node integration in renderers or remote navigation.

### Task 7: LAN transfer with fallback
Implement the documented signal/data-channel protocol in web and desktop. Verify chunk reassembly and bounds, same-owner routing, backpressure, ack only after successful cloud submission, idempotent cloud fallback and preservation of manual review. Real iPad/Safari cannot be claimed verified without the physical device; run browser-to-browser WebRTC and Electron upload tests locally.

### Task 8: Deployment and Windows deliverables
Create `.env.example`, `deploy/{Dockerfile,compose.yaml,Caddyfile,dual-link.service,install.sh}`, AI-runner Dockerfile and Chinese `README.md` / `docs/DEPLOYMENT.md` / `docs/USER_GUIDE.md`. Existing native CLIs can run under a dedicated service user; explain credential homes and why root's CLI login is not automatically the service login. Configure public HTTPS, 80/443 security group, only loopback backend binding, file ownership, backup/restore and upgrades.
Run `npm run build`, `npm test`, `npm run test:e2e`, `npm run package:win`; inspect artifacts and test packaged Electron startup. Generate source archive excluding secrets/node_modules/data with `npm run release:source`.

### Task 9: Review and acceptance
Spec review: map every user requirement to working UI/API/deployment artifact. Quality review: focus tenant authorization, credential handling, image/prompt injection scope, worker cancellation, filesystem containment and Electron IPC. Fix findings with regression tests and rerun affected checks. Final response links the installer, source, quickstart and deployment guide and explicitly distinguishes local verification from unperformed remote deployment / actual iPad testing.
