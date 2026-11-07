export type Provider = 'codex' | 'claude';
export interface User { id: string; email: string; name: string; role: 'admin' | 'user'; disabled: boolean; dailyLimit: number; }
export interface Device { id: string; name: string; createdAt: string; lastSeenAt: string | null; online: boolean; }
export interface Prompt { id: string; name: string; content: string; isDefault: boolean; version: number; createdAt: string; updatedAt: string; }
export interface KnowledgeFile { id: string; name: string; size: number; status: 'ready' | 'error' | 'processing'; error?: string; characters: number; createdAt: string; }
export interface Capture { id: string; captureId: string; deviceId: string | null; deviceName?: string; createdAt: string; imageUrl: string; }
export interface Task { id: string; captureId: string; provider: Provider; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; stage?: string; retrievalWarning?: string | null; answer: string; error: string | null; question: string; promptName: string; createdAt: string; updatedAt: string; sources: { name: string; excerpt: string }[]; usage?: Record<string, unknown>; }
export interface AppConfig { providers: Provider[]; defaultProvider: Provider; autoAnalyze?: boolean; iceServers: RTCIceServer[]; maxUploadBytes: number; }
export interface CaptureResult { capture: Capture; task: Task | null; }
export interface Peer { id: string; kind: 'web' | 'desktop'; deviceId?: string; name?: string; }
