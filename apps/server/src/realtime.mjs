import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { hash, now } from './auth.mjs';

export function attachRealtime({ server, db, publicOrigin, devicesFor }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const peers = new Map();
  const view = p => ({ id: p.id, kind: p.kind, ...(p.deviceId ? { deviceId: p.deviceId } : {}), name: p.name });
  const send = (p, obj) => { if (p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(obj)); };
  const valid = p => {
    const user = db.prepare('SELECT disabled FROM users WHERE id=?').get(p.userId);
    return user && !user.disabled && (p.kind === 'desktop' ? db.prepare('SELECT id FROM devices WHERE id=? AND user_id=?').get(p.deviceId, p.userId) : db.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>?').get(p.sessionHash, now()));
  };
  function publish(userId, event) { for (const p of peers.values()) if (p.userId === userId && valid(p)) send(p, event); }
  function deviceUpdate(userId) { publish(userId, { type: 'devices.updated', devices: devicesFor(userId) }); }
  function remove(p) {
    if (!peers.delete(p.id)) return;
    publish(p.userId, { type: 'peer.left', peerId: p.id }); deviceUpdate(p.userId);
  }
  server.on('upgrade', (request, socket, head) => {
    let ticket;
    try {
      const url = new URL(request.url, 'http://local');
      if (url.pathname === '/audio') return;
      if (url.pathname !== '/ws') return socket.destroy();
      if (publicOrigin && request.headers.origin && request.headers.origin !== publicOrigin) return socket.destroy();
      const token = url.searchParams.get('ticket');
      if (!token || token.length > 256) return socket.destroy();
      ticket = db.transaction(() => {
        const row = db.prepare('SELECT t.*,u.disabled,u.name AS user_name,d.name AS device_name FROM ws_tickets t JOIN users u ON u.id=t.user_id LEFT JOIN devices d ON d.id=t.device_id WHERE t.token_hash=?').get(hash(token));
        db.prepare('DELETE FROM ws_tickets WHERE token_hash=?').run(hash(token));
        return row;
      })();
      if (!ticket || ticket.disabled || ticket.expires_at < now() || (ticket.kind === 'desktop' && !ticket.device_name) || (ticket.kind === 'web' && !db.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>?').get(ticket.session_hash, now()))) return socket.destroy();
    } catch { return socket.destroy(); }
    wss.handleUpgrade(request, socket, head, ws => {
      const p = { id: randomUUID(), userId: ticket.user_id, deviceId: ticket.device_id, sessionHash: ticket.session_hash, kind: ticket.kind, name: ticket.device_name || ticket.user_name, ws, alive: true, messages: 0, windowAt: Date.now() };
      peers.set(p.id, p);
      if (p.deviceId) db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(now(), p.deviceId);
      send(p, { type: 'hello', peerId: p.id, kind: p.kind, peers: [...peers.values()].filter(x => x.userId === p.userId && x.id !== p.id).map(view), devices: devicesFor(p.userId) });
      for (const other of peers.values()) if (other.userId === p.userId && other.id !== p.id) send(other, { type: 'peer.joined', peer: view(p) });
      deviceUpdate(p.userId);
      ws.on('pong', () => { p.alive = true; });
      ws.on('message', raw => {
        if (!valid(p)) return ws.close(1008, 'revoked');
        if (Date.now() - p.windowAt > 60000) { p.messages = 0; p.windowAt = Date.now(); }
        if (++p.messages > 240) return ws.close(1008, 'rate limited');
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'ping') return send(p, { type: 'pong' });
          if (msg.type !== 'signal' || typeof msg.targetPeerId !== 'string' || !msg.payload || typeof msg.payload !== 'object') return;
          const target = peers.get(msg.targetPeerId);
          if (!target || target.userId !== p.userId || target.kind === p.kind || !valid(target)) return;
          const payload = msg.payload;
          if (!['offer', 'answer', 'ice', 'request'].includes(payload.kind)) return;
          if ((payload.kind === 'offer' || payload.kind === 'answer') && (typeof payload.sdp !== 'string' || payload.sdp.length > 200000)) return;
          send(target, { type: 'signal', fromPeerId: p.id, payload, ...(p.deviceId ? { deviceId: p.deviceId } : {}) });
        } catch { /* Ignore malformed frames without broadcasting them. */ }
      });
      ws.on('close', () => remove(p)); ws.on('error', () => {});
    });
  });
  const heartbeat = setInterval(() => {
    for (const p of peers.values()) {
      if (!p.alive || !valid(p)) { p.ws.terminate(); continue; }
      p.alive = false; p.ws.ping();
      if (p.deviceId) db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(now(), p.deviceId);
    }
    db.prepare('DELETE FROM ws_tickets WHERE expires_at<?').run(now());
  }, 30000); heartbeat.unref();
  return {
    publish, deviceUpdate,
    isOnline: deviceId => [...peers.values()].some(p => p.deviceId === deviceId && p.ws.readyState === WebSocket.OPEN),
    revokeDevice(id) { for (const p of peers.values()) if (p.deviceId === id) p.ws.terminate(); },
    revokeSession(id) { for (const p of peers.values()) if (p.sessionHash === id) p.ws.terminate(); },
    revokeUser(id) { for (const p of peers.values()) if (p.userId === id) p.ws.terminate(); },
    async close() { clearInterval(heartbeat); for (const p of peers.values()) p.ws.terminate(); await new Promise(r => wss.close(r)); },
  };
}
