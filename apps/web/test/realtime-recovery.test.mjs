import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const encode = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText).toString('base64')}`;
const apiModule = encode(await readFile(new URL('../src/api.ts', import.meta.url), 'utf8'));
const realtimeSource = (await readFile(new URL('../src/realtime.ts', import.meta.url), 'utf8')).replace("from './api'", `from '${apiModule}'`).replace("from './transfer.mjs'", `from '${new URL('../src/transfer.mjs', import.meta.url).href}'`);
const { RealtimeClient } = await import(encode(realtimeSource));
const flush = () => new Promise(resolve => setImmediate(resolve));

async function createHarness(t) {
  const previous = { window: globalThis.window, WebSocket: globalThis.WebSocket, RTCPeerConnection: globalThis.RTCPeerConnection };
  const sockets = [], connections = [], delayed = [], counts = [];
  class FakeSocket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0; sent = [];
    constructor() { sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  class FakeConnection {
    connectionState = 'new'; remoteDescription = null; addedIce = [];
    constructor() { connections.push(this); }
    async setRemoteDescription(value) { this.remoteDescription = value; }
    async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; }
    async setLocalDescription() {}
    async addIceCandidate(candidate) { this.addedIce.push(candidate); }
    close() { this.connectionState = 'closed'; this.onconnectionstatechange?.(); }
  }
  const makeChannel = () => ({ label: 'dual-link-captures', readyState: 'connecting', close() { this.readyState = 'closed'; this.onclose?.(); }, send() {} });
  globalThis.window = { location: { href: 'https://dual-link.test/', protocol: 'https:' }, addEventListener() {}, removeEventListener() {} };
  globalThis.WebSocket = FakeSocket;
  globalThis.RTCPeerConnection = FakeConnection;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ticket: 'temporary-ticket' })));
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { const timer = { callback, delay }; delayed.push(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const client = new RealtimeClient({ config: { iceServers: [], maxUploadBytes: 12 * 1024 * 1024 }, onConnection() {}, onDirectCount: count => counts.push(count), onRestore() {}, onDevices() {}, onCapture() {}, onTask() {}, onDelta() {}, onError() {}, onPreview() {}, onUploaded() {}, autoAnalyze: () => true });
  t.after(() => { client.stop(); Object.assign(globalThis, previous); });
  client.start(); await flush();
  const socket = sockets[0]; socket.readyState = 1; socket.onopen();
  const send = message => socket.onmessage({ data: JSON.stringify(message) });
  send({ type: 'hello', peers: [{ id: 'pc-peer', kind: 'desktop', deviceId: 'pc-1' }], devices: [] });
  return { socket, send, connections, delayed, counts, makeChannel };
}

test('closed and errored data channels clear direct status and request rate-limited recovery', async t => {
  const { socket, send, connections, delayed, counts, makeChannel } = await createHarness(t);
  send({ type: 'signal', fromPeerId: 'pc-peer', deviceId: 'pc-1', payload: { kind: 'offer', sdp: 'offer-sdp' } });
  await flush();
  const connection = connections[0];
  connection.connectionState = 'connected'; connection.onconnectionstatechange();
  assert.equal(counts.at(-1), 0, 'a connected peer without an open data channel is not a working direct link');
  const channel = makeChannel(); connection.ondatachannel({ channel });
  channel.readyState = 'open'; channel.onopen?.();
  assert.equal(counts.at(-1), 1);
  channel.close();
  assert.equal(counts.at(-1), 0);
  assert.equal(connection.connectionState, 'closed');
  assert.equal(delayed.length, 1);
  delayed[0].callback();
  assert.equal(socket.sent.filter(event => event.type === 'signal' && event.payload.kind === 'request').length, 1);

  // A replacement offer can establish a new channel; an error recovers too.
  send({ type: 'signal', fromPeerId: 'pc-peer', deviceId: 'pc-1', payload: { kind: 'offer', sdp: 'replacement-offer' } });
  await flush();
  const nextConnection = connections[1], nextChannel = makeChannel();
  nextConnection.ondatachannel({ channel: nextChannel }); nextChannel.readyState = 'open'; nextChannel.onopen?.();
  assert.equal(counts.at(-1), 1);
  nextChannel.onerror?.({});
  assert.equal(counts.at(-1), 0);
  assert.equal(nextConnection.connectionState, 'closed');
  assert.ok(delayed[1].delay >= 4900, 'recovery requests for one peer must be rate limited');
});

test('late ICE after channel closure cannot create a ghost peer that suppresses recovery', async t => {
  const { socket, send, connections, delayed, makeChannel } = await createHarness(t);
  send({ type: 'signal', fromPeerId: 'pc-peer', payload: { kind: 'offer', sdp: 'first-offer' } });
  await flush();
  const channel = makeChannel(); connections[0].ondatachannel({ channel });
  channel.readyState = 'open'; channel.onopen?.(); channel.close();
  send({ type: 'signal', fromPeerId: 'pc-peer', payload: { kind: 'ice', candidate: { candidate: 'late-old-ice', sdpMid: '0' } } });
  await flush();
  delayed[0].callback();
  assert.equal(socket.sent.filter(event => event.type === 'signal' && event.payload.kind === 'request').length, 1, 'late ICE must not prevent the scheduled recovery request');
  assert.equal(connections.length, 1, 'an ICE candidate alone must not create a peer connection');

  send({ type: 'signal', fromPeerId: 'pc-peer', payload: { kind: 'offer', sdp: 'replacement-offer' } });
  await flush();
  assert.equal(connections.length, 2);
  assert.deepEqual(connections[1].addedIce, [], 'the recovery request discards ICE from the retired connection');
});

test('normal ICE arriving before its offer is bounded and applied after the offer', async t => {
  const { send, connections } = await createHarness(t);
  for (let index = 0; index < 150; index++) send({ type: 'signal', fromPeerId: 'pc-peer', payload: { kind: 'ice', candidate: { candidate: `early-ice-${index}`, sdpMid: '0' } } });
  assert.equal(connections.length, 0, 'pre-offer ICE must wait outside the active connection map');
  send({ type: 'signal', fromPeerId: 'pc-peer', payload: { kind: 'offer', sdp: 'new-offer' } });
  await flush();
  assert.equal(connections.length, 1);
  assert.ok(connections[0].addedIce.length > 0 && connections[0].addedIce.length <= 100, 'preserve useful early ICE within a strict queue bound');
  assert.equal(connections[0].addedIce[0].candidate, 'early-ice-0');
});
