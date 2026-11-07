import test from 'node:test';
import assert from 'node:assert/strict';

const implementation = await import('../src/interview-state.mjs').catch(() => ({}));
const ready = () => {
  assert.equal(typeof implementation.createInterviewState, 'function', 'interview state must be implemented');
  return implementation.createInterviewState('session-a');
};
const segment = (overrides = {}) => ({ id: 'seg-1', sessionId: 'session-a', track: 'remote', segmentId: 'provider-1', text: '介绍一下 Redis', startMs: 1000, endMs: null, final: false, revision: 1, createdAt: '2026-11-07T10:00:00Z', updatedAt: '2026-11-07T10:00:00Z', ...overrides });

test('revisions update a transcript sentence in place and reject stale partial text', () => {
  let state = ready();
  state = implementation.applyInterviewEvent(state, { type: 'interview.segment', sessionId: 'session-a', segment: segment() });
  state = implementation.applyInterviewEvent(state, { type: 'interview.segment', sessionId: 'session-a', segment: segment({ text: '介绍一下 Redis 的持久化机制。', final: true, endMs: 2000, revision: 2 }) });
  state = implementation.applyInterviewEvent(state, { type: 'interview.segment', sessionId: 'session-a', segment: segment() });
  assert.equal(state.segments.length, 1);
  assert.equal(state.segments[0].text, '介绍一下 Redis 的持久化机制。');
  assert.equal(state.segments[0].final, true);
});

test('the selected interview ignores other interview events and keeps actual speech separate from AI suggestions', () => {
  let state = ready();
  state = implementation.applyInterviewEvent(state, { type: 'interview.segment', sessionId: 'session-b', segment: segment({ sessionId: 'session-b' }) });
  assert.equal(state.segments.length, 0);
  state = implementation.applyInterviewEvent(state, { type: 'interview.answer', sessionId: 'session-a', answer: { id: 'answer-1', sessionId: 'session-a', questionId: 'q1', questionRevision: 1, status: 'running', text: '', provider: 'codex' } });
  state = implementation.applyInterviewEvent(state, { type: 'interview.answer.delta', sessionId: 'session-a', answerId: 'answer-1', delta: '建议回答' });
  assert.equal(state.answers[0].text, '建议回答');
  assert.equal(state.segments.length, 0);
  state = implementation.applyInterviewEvent(state, { type: 'interview.answer', sessionId: 'session-a', answer: { ...state.answers[0], status: 'completed', text: '最终建议' } });
  state = implementation.applyInterviewEvent(state, { type: 'interview.answer.delta', sessionId: 'session-a', answerId: 'answer-1', delta: '迟到数据' });
  assert.equal(state.answers[0].text, '最终建议');
});

test('a delayed REST snapshot cannot overwrite newer final transcript revisions', () => {
  let state = ready();
  state = implementation.applyInterviewEvent(state, { type: 'interview.segment', sessionId: 'session-a', segment: segment({ revision: 3, final: true, text: '本人实际说出的答案', track: 'self', endMs: 2500 }) });
  state = implementation.mergeInterviewSnapshot(state, { interview: { id: 'session-a' }, segments: [segment()], questions: [], answers: [], gaps: [] });
  assert.equal(state.segments.length, 1);
  assert.equal(state.segments[0].revision, 3);
  assert.equal(state.segments[0].track, 'self');
});

test('a delayed snapshot preserves longer streamed text, while completed snapshots remain authoritative', () => {
  let state = ready();
  const answer = { id: 'a1', sessionId: 'session-a', questionId: 'q1', questionRevision: 1, provider: 'claude', status: 'running', text: '第一段' };
  state = implementation.applyInterviewEvent(state, { type: 'interview.answer', sessionId: 'session-a', answer });
  state = implementation.applyInterviewEvent(state, { type: 'interview.answer.delta', sessionId: 'session-a', answerId: 'a1', delta: '第二段' });
  state = implementation.mergeInterviewSnapshot(state, { interview: { id: 'session-a' }, answers: [answer] });
  assert.equal(state.answers[0].text, '第一段第二段');
  state = implementation.mergeInterviewSnapshot(state, { interview: { id: 'session-a' }, answers: [{ ...answer, status: 'completed', text: '服务端最终回答' }] });
  assert.equal(state.answers[0].text, '服务端最终回答');
});

test('event subscriptions are account-scoped and disposed listeners cannot receive future private data', () => {
  ready();
  assert.equal(typeof implementation.InterviewEventHub, 'function');
  const hub = new implementation.InterviewEventHub();
  const seenA = [], seenB = [];
  const stop = hub.subscribe('a', event => seenA.push(event));
  hub.subscribe('b', event => seenB.push(event));
  hub.publish('a', { type: 'interview.segment', text: 'A私人内容' });
  assert.equal(seenA.length, 1); assert.equal(seenB.length, 0);
  stop(); hub.publish('a', { type: 'interview.segment', text: '迟到的A内容' });
  assert.equal(seenA.length, 1);
  hub.publish('b', { type: 'interview.restore' });
  assert.equal(seenB.length, 1);
});

test('partial setting responses retain the earlier-transcript pagination flag', () => {
  let state = ready();
  state = implementation.mergeInterviewSnapshot(state, { interview: { id: 'session-a' }, segments: [segment()], segmentsTruncated: true });
  state = implementation.mergeInterviewSnapshot(state, { interview: { id: 'session-a', status: 'paused' } });
  assert.equal(state.segmentsTruncated, true);
  state = implementation.mergeInterviewSnapshot(state, { interview: { id: 'session-a' }, segments: [], segmentsTruncated: false });
  assert.equal(state.segmentsTruncated, false);
});

test('loading older transcript pages keeps their composite cursor across current-state refreshes', () => {
  let state = ready();
  const page = (cursor, truncated = true) => ({ interview: { id: 'session-a' }, segments: [segment()], segmentsTruncated: truncated, nextCursor: cursor });
  state = implementation.mergeInterviewSnapshot(state, page('1000:8000'));
  assert.equal(state.nextCursor, '1000:8000');
  state = implementation.mergeInterviewSnapshot(state, page('1000:6000'), { earlier: true });
  state = implementation.mergeInterviewSnapshot(state, page('1000:8000'));
  assert.equal(state.nextCursor, '1000:6000');
  state = implementation.mergeInterviewSnapshot(state, page(null, false), { earlier: true });
  state = implementation.mergeInterviewSnapshot(state, page('1000:8000'));
  assert.equal(state.segmentsTruncated, false);
});

test('a delayed queued HTTP response does not regress a running answer when timestamps are equal', () => {
  let state = ready();
  const answer = { id: 'a1', questionRevision: 1, questionId: 'q1', status: 'running', text: '已经开始回答', updatedAt: '2026-11-07T10:00:00Z' };
  state = implementation.applyInterviewEvent(state, { type: 'interview.answer', sessionId: 'session-a', answer });
  state = implementation.applyInterviewEvent(state, { type: 'interview.answer', sessionId: 'session-a', answer: { ...answer, status: 'queued', text: '' } });
  assert.equal(state.answers[0].status, 'running');
  assert.equal(state.answers[0].text, '已经开始回答');
});
