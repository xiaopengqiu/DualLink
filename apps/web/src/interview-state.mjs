export function createInterviewState(sessionId) {
  return { sessionId, interview: null, segments: [], questions: [], answers: [], gaps: [], audioStatus: {}, contextSummary: null, segmentsTruncated: false, nextCursor: null, earlierPagesLoaded: false };
}

const terminal = status => ['completed', 'failed', 'cancelled'].includes(status);
function prefer(current, incoming) {
  if (!current) return incoming;
  const currentRevision = current.revision ?? current.questionRevision ?? 0;
  const incomingRevision = incoming.revision ?? incoming.questionRevision ?? 0;
  if (incomingRevision < currentRevision) return current;
  if (incomingRevision > currentRevision) return incoming;
  if (current.final === true && incoming.final === false) return current;
  if (terminal(current.status) && !terminal(incoming.status)) return current;
  if (terminal(incoming.status) && !terminal(current.status)) return incoming;
  if (incoming.updatedAt && current.updatedAt && incoming.updatedAt < current.updatedAt) return current;
  if (current.status === 'running' && incoming.status === 'queued' && (!incoming.updatedAt || incoming.updatedAt <= current.updatedAt)) return current;
  if (current.status === 'running' && incoming.status === 'running' && (current.text || '').length > (incoming.text || '').length) return { ...incoming, text: current.text };
  return incoming;
}
function merge(items, incoming, sort) {
  const mapped = new Map(items.map(item => [item.id, item]));
  for (const item of incoming || []) if (item && typeof item.id === 'string') mapped.set(item.id, prefer(mapped.get(item.id), item));
  return [...mapped.values()].sort(sort || ((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))));
}
const segmentOrder = (a, b) => a.startMs - b.startMs || String(a.id).localeCompare(String(b.id));

export function mergeInterviewSnapshot(state, snapshot, { earlier = false } = {}) {
  if (!snapshot?.interview || snapshot.interview.id !== state.sessionId) return state;
  const paginationKnown = snapshot.segmentsTruncated !== undefined || snapshot.nextCursor !== undefined;
  const updatePagination = paginationKnown && (earlier || !state.earlierPagesLoaded);
  return {
    ...state,
    interview: prefer(state.interview, snapshot.interview),
    segments: merge(state.segments, snapshot.segments, segmentOrder),
    questions: merge(state.questions, snapshot.questions),
    answers: merge(state.answers, snapshot.answers),
    gaps: merge(state.gaps, snapshot.gaps),
    contextSummary: snapshot.contextSummary ?? state.contextSummary,
    segmentsTruncated: updatePagination ? !!snapshot.segmentsTruncated || !!snapshot.nextCursor : state.segmentsTruncated,
    nextCursor: updatePagination ? snapshot.nextCursor ?? null : state.nextCursor,
    earlierPagesLoaded: earlier || state.earlierPagesLoaded,
  };
}

export function applyInterviewEvent(state, event) {
  const sessionId = event?.sessionId || event?.interview?.id;
  if (!sessionId || sessionId !== state.sessionId) return state;
  switch (event.type) {
    case 'interview.updated': return event.interview ? { ...state, interview: prefer(state.interview, event.interview) } : state;
    case 'interview.segment': return event.segment ? { ...state, segments: merge(state.segments, [event.segment], segmentOrder) } : state;
    case 'interview.question': return event.question ? { ...state, questions: merge(state.questions, [event.question]) } : state;
    case 'interview.answer': return event.answer ? { ...state, answers: merge(state.answers, [event.answer]) } : state;
    case 'interview.answer.delta':
      if (typeof event.delta !== 'string' || event.delta.length > 100000) return state;
      return { ...state, answers: state.answers.map(answer => answer.id === event.answerId && !terminal(answer.status) ? { ...answer, text: (answer.text || '') + event.delta } : answer) };
    case 'interview.audio.status': return {
      ...state,
      audioStatus: { ...state.audioStatus, [event.track || 'session']: { status: event.status, error: event.error || null } },
      gaps: event.gap ? merge(state.gaps, [event.gap]) : state.gaps,
    };
    default: return state;
  }
}

export class InterviewEventHub {
  listeners = new Set();
  subscribe(ownerId, callback) {
    const listener = { ownerId, callback }; this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  publish(ownerId, event) { for (const listener of this.listeners) if (listener.ownerId === ownerId) listener.callback(event); }
}
