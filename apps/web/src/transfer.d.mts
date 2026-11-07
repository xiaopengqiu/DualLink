export interface CaptureMetadata { type: 'capture.start'; captureId: string; name: string; mime: string; size: number; deviceId: string; analyze: boolean; provider?: 'codex' | 'claude'; promptId?: string; }
export class CaptureAssembler {
  constructor(options?: { maxBytes?: number; timeoutMs?: number; expectedDeviceId?: string });
  push(message: unknown, now?: number): { metadata: CaptureMetadata; bytes: Uint8Array } | null;
  reset(): void;
}
export function shouldAnalyze(metadata: Partial<CaptureMetadata>, webAutoAnalyze: boolean): boolean;
