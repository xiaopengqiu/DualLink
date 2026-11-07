import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { ApiClient } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const isAbort = error => error instanceof DOMException && error.name === 'AbortError';

test('drops delayed successful data after changing from account A to account B', async t => {
  const response = deferred();
  t.mock.method(globalThis, 'fetch', () => response.promise);
  const client = new ApiClient();
  client.setCsrfToken('session-A');
  const request = client.request('/knowledge');
  client.setCsrfToken('');
  client.setCsrfToken('session-B');
  response.resolve(new Response(JSON.stringify({ files: [{ name: 'A-private-file.md' }] }), { status: 200 }));
  await assert.rejects(request, isAbort);
});

test('drops delayed unauthorized responses so account A cannot log out account B', async t => {
  const response = deferred();
  t.mock.method(globalThis, 'fetch', () => response.promise);
  const client = new ApiClient();
  client.setCsrfToken('session-A');
  const request = client.request('/captures');
  client.setCsrfToken('session-B');
  response.resolve(new Response(JSON.stringify({ error: 'A expired' }), { status: 401 }));
  await assert.rejects(request, isAbort);
});

test('checks the session again after asynchronously reading the response body', async t => {
  const body = deferred();
  const reading = deferred();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: () => { reading.resolve(); return body.promise; } }));
  const client = new ApiClient();
  client.setCsrfToken('session-A');
  const request = client.request('/knowledge');
  await reading.promise;
  client.setCsrfToken('session-B');
  body.resolve({ files: ['A-private-file'] });
  await assert.rejects(request, isAbort);
});

test('preserves an active request when the same session token is set again', async t => {
  const response = deferred();
  t.mock.method(globalThis, 'fetch', () => response.promise);
  const client = new ApiClient();
  client.setCsrfToken('session-A');
  const request = client.request('/knowledge');
  client.setCsrfToken('session-A');
  response.resolve(new Response(JSON.stringify({ files: [] }), { status: 200 }));
  assert.deepEqual(await request, { files: [] });
});
