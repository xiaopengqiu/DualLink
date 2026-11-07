import { api, ApiError } from './api';
import type { AppConfig, Capture, CaptureResult, Device, Peer, Task } from './types';
import { CaptureAssembler, shouldAnalyze } from './transfer.mjs';
import type { CaptureMetadata } from './transfer.mjs';
import type { InterviewEvent } from './interview-types';

interface Callbacks {
  config: AppConfig;
  autoAnalyze: () => boolean;
  onConnection: (state: 'connecting' | 'online' | 'offline') => void;
  onDirectCount: (count: number) => void;
  onCapture: (capture: Capture) => void;
  onTask: (task: Task) => void;
  onDelta: (taskId: string, delta: string) => void;
  onDevices: (devices: Device[]) => void;
  onError: (error: Error) => void;
  onRestore: () => void;
  onPreview: (blob: Blob, metadata: CaptureMetadata) => void;
  onUploaded: (result: CaptureResult) => void;
  onInterviewEvent?: (event: InterviewEvent) => void;
}
interface RtcPeer { connection: RTCPeerConnection; deviceId?: string; pendingIce: RTCIceCandidateInit[]; chain: Promise<void>; channel?: RTCDataChannel; resetTransfer?: () => void; }

export class RealtimeClient {
  private disposed = false;
  private socket?: WebSocket;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private attempts = 0;
  private abort = new AbortController();
  private peers = new Map<string, RtcPeer>();
  private knownPeers = new Map<string, Peer>();
  private stagedIce = new Map<string, { createdAt: number; candidates: RTCIceCandidateInit[] }>();
  private peerRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastPeerRequest = new Map<string, number>();
  private uploaded = new Set<string>();
  private uploading = new Map<string, Promise<void>>();
  constructor(private callbacks: Callbacks) {}

  start() { void this.connect(); window.addEventListener('online', this.handleOnline); }
  private handleOnline = () => { if (this.socket?.readyState !== WebSocket.OPEN) { clearTimeout(this.retryTimer); void this.connect(); } };

  stop() {
    this.disposed = true;
    this.abort.abort();
    clearTimeout(this.retryTimer); clearInterval(this.pingTimer);
    window.removeEventListener('online', this.handleOnline);
    this.socket?.close();
    this.clearPeers();
  }

  private async connect() {
    if (this.disposed || this.socket?.readyState === WebSocket.CONNECTING || this.socket?.readyState === WebSocket.OPEN) return;
    this.callbacks.onConnection('connecting');
    try {
      const { ticket } = await api.request<{ ticket: string }>('/ws-ticket', { method: 'POST', body: { kind: 'web' }, signal: this.abort.signal });
      if (this.disposed) return;
      const url = new URL('/ws', window.location.href);
      url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('ticket', ticket);
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.onopen = () => {
        if (this.disposed) { socket.close(); return; }
        this.attempts = 0; this.callbacks.onConnection('online'); this.callbacks.onRestore();
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 20000);
      };
      socket.onmessage = event => {
        if (this.disposed || typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024) return;
        try { this.handleMessage(JSON.parse(event.data)); } catch { /* Ignore malformed or unknown events. */ }
      };
      socket.onclose = () => {
        if (this.socket === socket) this.socket = undefined;
        clearInterval(this.pingTimer);
        this.clearPeers();
        if (!this.disposed) { this.callbacks.onConnection('offline'); this.scheduleRetry(); }
      };
      socket.onerror = () => { /* onclose schedules recovery without repeated alerts. */ };
    } catch (error) {
      if (this.disposed) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.callbacks.onConnection('offline');
      if (error instanceof ApiError && error.status === 401) this.callbacks.onError(error);
      else this.scheduleRetry();
    }
  }

  private scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), Math.min(15000, 1000 * 2 ** this.attempts++));
  }
  private send(value: unknown) { if (!this.disposed && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value)); }
  private signal(targetPeerId: string, payload: unknown) { this.send({ type: 'signal', targetPeerId, payload }); }
  private directCount() { if (!this.disposed) this.callbacks.onDirectCount([...this.peers.values()].filter(peer => peer.channel?.readyState === 'open').length); }
  private schedulePeerRecovery(id: string) {
    if (this.disposed || !this.knownPeers.has(id) || this.peerRetryTimers.has(id)) return;
    const delay = Math.max(1000, (this.lastPeerRequest.get(id) || 0) + 5000 - Date.now());
    const timer = setTimeout(() => {
      this.peerRetryTimers.delete(id);
      if (this.disposed || !this.knownPeers.has(id) || this.peers.has(id) || this.socket?.readyState !== WebSocket.OPEN) return;
      this.stagedIce.delete(id);
      this.lastPeerRequest.set(id, Date.now());
      this.signal(id, { kind: 'request' });
    }, delay);
    this.peerRetryTimers.set(id, timer);
  }
  private dropPeer(id: string, peer: RtcPeer, recover = false) {
    if (this.peers.get(id) !== peer) return;
    this.peers.delete(id);
    this.stagedIce.delete(id);
    peer.resetTransfer?.();
    if (peer.channel) {
      peer.channel.onopen = null; peer.channel.onmessage = null; peer.channel.onclose = null; peer.channel.onerror = null;
      if (peer.channel.readyState !== 'closed') peer.channel.close();
    }
    peer.connection.onicecandidate = null; peer.connection.onconnectionstatechange = null; peer.connection.ondatachannel = null;
    peer.connection.close();
    this.directCount();
    if (recover) this.schedulePeerRecovery(id);
  }
  private clearPeers() {
    for (const timer of this.peerRetryTimers.values()) clearTimeout(timer);
    this.peerRetryTimers.clear(); this.lastPeerRequest.clear(); this.knownPeers.clear(); this.stagedIce.clear();
    for (const [id, peer] of this.peers) this.dropPeer(id, peer);
    this.directCount();
  }

  private handleMessage(event: { type?: string; [key: string]: unknown }) {
    if (event.type?.startsWith('interview.')) { this.callbacks.onInterviewEvent?.(event as InterviewEvent); return; }
    switch (event.type) {
      case 'hello': {
        if (Array.isArray(event.devices)) this.callbacks.onDevices(event.devices as Device[]);
        if (Array.isArray(event.peers)) for (const peer of event.peers as Peer[]) { this.knownPeers.set(peer.id, peer); }
        break;
      }
      case 'devices.updated': if (Array.isArray(event.devices)) this.callbacks.onDevices(event.devices as Device[]); break;
      case 'capture.created': if (event.capture) this.callbacks.onCapture(event.capture as Capture); break;
      case 'task.updated': if (event.task) this.callbacks.onTask(event.task as Task); break;
      case 'task.delta': if (typeof event.taskId === 'string' && typeof event.delta === 'string') this.callbacks.onDelta(event.taskId, event.delta); break;
      case 'peer.joined': { const peer = event.peer as Peer; if (peer?.id) { this.knownPeers.set(peer.id, peer); } break; }
      case 'peer.left': {
        const id = String(event.peerId); this.knownPeers.delete(id);
        const timer = this.peerRetryTimers.get(id); if (timer) clearTimeout(timer);
        this.peerRetryTimers.delete(id); this.lastPeerRequest.delete(id);
        this.stagedIce.delete(id);
        const peer = this.peers.get(id); if (peer) this.dropPeer(id, peer);
        break;
      }
      case 'signal': {
        if (typeof event.fromPeerId !== 'string' || !event.payload || typeof event.payload !== 'object') break;
        this.receiveSignal(event.fromPeerId, event.payload as Record<string, unknown>, typeof event.deviceId === 'string' ? event.deviceId : undefined);
        break;
      }
    }
  }

  private receiveSignal(id: string, payload: Record<string, unknown>, deviceId?: string) {
    if (typeof RTCPeerConnection === 'undefined' || !['offer', 'ice'].includes(String(payload.kind))) return;
    if (payload.kind === 'offer' && (typeof payload.sdp !== 'string' || !payload.sdp)) return;
    if (payload.kind === 'ice' && (!payload.candidate || typeof payload.candidate !== 'object')) return;
    const retryTimer = this.peerRetryTimers.get(id);
    if (payload.kind === 'offer' && retryTimer) { clearTimeout(retryTimer); this.peerRetryTimers.delete(id); }
    let peer = this.peers.get(id);
    if (!peer && payload.kind === 'ice') {
      // ICE can precede its offer, including delayed candidates from a retired peer.
      // Keep it outside the active peer map so it cannot suppress recovery requests.
      const candidate = payload.candidate as RTCIceCandidateInit;
      if (typeof candidate.candidate !== 'string' || candidate.candidate.length > 4096) return;
      const now = Date.now();
      for (const [peerId, staged] of this.stagedIce) if (now - staged.createdAt > 30000) this.stagedIce.delete(peerId);
      let staged = this.stagedIce.get(id);
      if (!staged) {
        if (this.stagedIce.size >= 32) this.stagedIce.delete(this.stagedIce.keys().next().value!);
        staged = { createdAt: now, candidates: [] }; this.stagedIce.set(id, staged);
      }
      if (staged.candidates.length < 32) staged.candidates.push(candidate);
      return;
    }
    if (!peer) {
      const staged = this.stagedIce.get(id); this.stagedIce.delete(id);
      const connection = new RTCPeerConnection({ iceServers: this.callbacks.config.iceServers || [] });
      peer = { connection, pendingIce: staged && Date.now() - staged.createdAt <= 30000 ? staged.candidates : [], chain: Promise.resolve(), deviceId: deviceId || this.knownPeers.get(id)?.deviceId };
      this.peers.set(id, peer);
      const createdPeer = peer;
      connection.onicecandidate = event => { if (event.candidate) this.signal(id, { kind: 'ice', candidate: event.candidate.toJSON() }); };
      connection.onconnectionstatechange = () => {
        this.directCount();
        if (connection.connectionState === 'failed' || connection.connectionState === 'closed') this.dropPeer(id, createdPeer, true);
      };
      connection.ondatachannel = event => this.acceptChannel(id, createdPeer, event.channel);
    }
    const current = peer;
    current.chain = current.chain.then(async () => {
      if (this.disposed || this.peers.get(id) !== current) return;
      if (payload.kind === 'offer' && typeof payload.sdp === 'string') {
        await current.connection.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
        for (const candidate of current.pendingIce.splice(0)) {
          try { await current.connection.addIceCandidate(candidate); } catch { /* Ignore stale ICE from the previous negotiation. */ }
        }
        const answer = await current.connection.createAnswer();
        await current.connection.setLocalDescription(answer);
        this.signal(id, { kind: 'answer', sdp: answer.sdp });
      } else if (payload.kind === 'ice' && payload.candidate && typeof payload.candidate === 'object') {
        const candidate = payload.candidate as RTCIceCandidateInit;
        if (current.connection.remoteDescription) {
          try { await current.connection.addIceCandidate(candidate); } catch { /* A late candidate must not tear down the new connection. */ }
        }
        else if (current.pendingIce.length < 100) current.pendingIce.push(candidate);
      }
    }).catch(() => this.dropPeer(id, current, true));
  }

  private acceptChannel(id: string, peer: RtcPeer, channel: RTCDataChannel) {
    if (this.disposed || this.peers.get(id) !== peer || channel.label !== 'dual-link-captures') { channel.close(); return; }
    if (peer.channel && peer.channel !== channel) { channel.close(); this.dropPeer(id, peer, true); return; }
    peer.channel = channel;
    channel.binaryType = 'arraybuffer';
    const assembler = new CaptureAssembler({ expectedDeviceId: peer.deviceId, maxBytes: this.callbacks.config.maxUploadBytes });
    peer.resetTransfer = () => assembler.reset();
    channel.onopen = () => this.directCount();
    channel.onclose = () => this.dropPeer(id, peer, true);
    channel.onerror = () => this.dropPeer(id, peer, true);
    this.directCount();
    channel.onmessage = event => {
      if (this.disposed || this.peers.get(id) !== peer || peer.channel !== channel) return;
      try {
        const capture = assembler.push(event.data);
        if (!capture) return;
        const ack = () => { if (channel.readyState === 'open' && !this.disposed) channel.send(JSON.stringify({ type: 'capture.ack', captureId: capture.metadata.captureId })); };
        if (this.uploaded.has(capture.metadata.captureId)) { ack(); return; }
        let pending = this.uploading.get(capture.metadata.captureId);
        if (!pending) {
          const blob = new Blob([capture.bytes.slice().buffer as ArrayBuffer], { type: capture.metadata.mime });
          this.callbacks.onPreview(blob, capture.metadata);
          pending = this.uploadCapture(blob, capture.metadata).then(() => { this.uploaded.add(capture.metadata.captureId); if (this.uploaded.size > 200) this.uploaded.delete(this.uploaded.values().next().value!); }).finally(() => this.uploading.delete(capture.metadata.captureId));
          this.uploading.set(capture.metadata.captureId, pending);
        }
        void pending.then(ack).catch(error => {
          if (!this.disposed && !(error instanceof DOMException && error.name === 'AbortError')) this.callbacks.onError(error instanceof Error ? error : new Error('局域网图片上传失败，客户端将尝试云端上传'));
        });
      } catch (error) { this.callbacks.onError(error instanceof Error ? error : new Error('图片传输失败')); this.dropPeer(id, peer, true); }
    };
  }

  private async uploadCapture(blob: Blob, metadata: CaptureMetadata) {
    const form = new FormData();
    form.append('image', blob, metadata.name); form.append('captureId', metadata.captureId);
    form.append('deviceId', metadata.deviceId); form.append('analyze', String(shouldAnalyze(metadata, this.callbacks.autoAnalyze())));
    if (metadata.provider) form.append('provider', metadata.provider);
    if (metadata.promptId) form.append('promptId', metadata.promptId);
    const result = await api.request<CaptureResult>('/captures', { method: 'POST', body: form, signal: this.abort.signal });
    if (!this.disposed) this.callbacks.onUploaded(result);
  }
}
