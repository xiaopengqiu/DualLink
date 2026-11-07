import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { extractKnowledge } from '../src/knowledge.mjs';
import { makeDocx } from './document-fixtures.mjs';

function compressedArchive(data, declaredSize = data.length, truncate = 0) {
  const filename = Buffer.from('word/document.xml');
  const full = deflateRawSync(data); const compressed = full.subarray(0, full.length - truncate);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(declaredSize, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(declaredSize, 24); central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + compressed.length, 16);
  return Buffer.concat([local, filename, compressed, central, filename, end]);
}

test('DOCX validates actual inflated length instead of trusting a smaller ZIP directory size', async () => {
  const archive = compressedArchive(Buffer.from('Actual uncompressed content is longer than its claimed length'), 1);
  await assert.rejects(() => extractKnowledge(archive, 'false-size.docx'), error => error.status === 400 && /实际.*长度.*不一致/.test(error.message));
});

test('DOCX stops inflated streams at the actual per-entry cap before reaching a corrupt tail', async () => {
  const pattern = Buffer.alloc(2048); let seed = 12345;
  for (let i = 0; i < pattern.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; pattern[i] = seed & 255; }
  const expanded = Buffer.alloc(17 * 1024 * 1024).fill(pattern);
  // The advertised size passes directory preflight. Actual data exceeds the cap;
  // the truncated DEFLATE tail would fail only if the validator read to the end.
  const archive = compressedArchive(expanded, 16 * 1024 * 1024, 1);
  assert.ok(archive.length < 10 * 1024 * 1024);
  await assert.rejects(() => extractKnowledge(archive, 'actual-limit.docx'), error => error.status === 400 && /实际解压体积过大/.test(error.message));
});

test('DOCX rejects a claimed size larger than the actual stream and corrupt archive lengths', async () => {
  await assert.rejects(() => extractKnowledge(compressedArchive(Buffer.from('short'), 50), 'short.docx'), error => error.status === 400 && /实际.*长度.*不一致/.test(error.message));
  const truncated = makeDocx().subarray(0, -5);
  await assert.rejects(() => extractKnowledge(truncated, 'truncated.docx'), error => error.status === 400 && /DOCX/.test(error.message));
});

test('DOCX rejects modified contents with an invalid checksum', async () => {
  const archive = makeDocx('Unchanged text');
  const index = archive.indexOf(Buffer.from('Unchanged text')); assert.ok(index > 0);
  archive[index] = 'X'.charCodeAt(0);
  await assert.rejects(() => extractKnowledge(archive, 'corrupt-crc.docx'), error => error.status === 400 && /校验/.test(error.message));
});
