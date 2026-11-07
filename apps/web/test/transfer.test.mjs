import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureAssembler, shouldAnalyze } from '../src/transfer.mjs';

const id = '8d083586-0631-4c5e-91a8-b84c994312cc';
const start = (extra = {}) => JSON.stringify({ type: 'capture.start', captureId: id, name: 'screen.png', mime: 'image/png', size: 4, deviceId: 'pc-1', analyze: true, provider: 'codex', ...extra });

test('reassembles bounded ordered chunks and preserves capture metadata', () => {
  const receiver = new CaptureAssembler({ expectedDeviceId: 'pc-1' });
  receiver.push(start());
  receiver.push(new Uint8Array([1, 2]).buffer);
  receiver.push(new Uint8Array([3, 4]).buffer);
  const result = receiver.push(JSON.stringify({ type: 'capture.end', captureId: id }));
  assert.deepEqual([...result.bytes], [1, 2, 3, 4]);
  assert.equal(result.metadata.captureId, id);
  assert.equal(result.metadata.analyze, true);
});

test('rejects oversized transfers before allocation and foreign device metadata', () => {
  const receiver = new CaptureAssembler({ expectedDeviceId: 'pc-1', maxBytes: 10 });
  assert.throws(() => receiver.push(start({ size: 11 })), /大小/);
  assert.throws(() => receiver.push(start({ deviceId: 'other' })), /设备/);
});

test('rejects mismatched size and unexpected binary data', () => {
  const receiver = new CaptureAssembler();
  assert.throws(() => receiver.push(new Uint8Array([1]).buffer), /开始/);
  receiver.push(start());
  receiver.push(new Uint8Array([1, 2]).buffer);
  assert.throws(() => receiver.push(JSON.stringify({ type: 'capture.end', captureId: id })), /完整/);
});

test('expires abandoned transfers and allows a clean new transfer', () => {
  const receiver = new CaptureAssembler({ timeoutMs: 20 });
  receiver.push(start(), 100);
  assert.throws(() => receiver.push(new Uint8Array([1, 2]).buffer, 121), /超时/);
  receiver.push(start(), 122);
  receiver.push(new Uint8Array([1, 2, 3, 4]).buffer, 123);
  assert.equal(receiver.push(JSON.stringify({ type: 'capture.end', captureId: id }), 124).bytes.length, 4);
});

test('manual review cannot be overridden by web auto-analyze preference', () => {
  assert.equal(shouldAnalyze({ analyze: false }, true), false);
  assert.equal(shouldAnalyze({ analyze: true }, false), false);
  assert.equal(shouldAnalyze({ analyze: true }, true), true);
  assert.equal(shouldAnalyze({}, true), false);
});

test('a valid new screenshot replaces an interrupted transfer without closing the channel', () => {
  const receiver = new CaptureAssembler({ expectedDeviceId: 'pc-1', timeoutMs: 20 });
  const nextId = '0e1a4b68-fde5-4a13-a73b-c08e74cae51e';
  receiver.push(start(), 100);
  receiver.push(new Uint8Array([1, 2]).buffer, 101);
  // The sender abandoned the old screenshot after backpressure; no end arrives.
  receiver.push(start({ captureId: nextId, analyze: false }), 200);
  receiver.push(new Uint8Array([5, 6, 7, 8]).buffer, 201);
  const result = receiver.push(JSON.stringify({ type: 'capture.end', captureId: nextId }), 202);
  assert.equal(result.metadata.captureId, nextId);
  assert.equal(result.metadata.analyze, false);
  assert.deepEqual([...result.bytes], [5, 6, 7, 8]);
});

test('replacement starts still enforce the original device and maximum size', () => {
  const receiver = new CaptureAssembler({ expectedDeviceId: 'pc-1', maxBytes: 10 });
  receiver.push(start());
  receiver.push(new Uint8Array([1]).buffer);
  assert.throws(() => receiver.push(start({ deviceId: 'other' })), /设备/);
  receiver.push(start());
  assert.throws(() => receiver.push(start({ size: 11 })), /大小/);
});
