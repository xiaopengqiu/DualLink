import type { InterviewDetail, InterviewEvent, InterviewState } from './interview-types';
export function createInterviewState(sessionId: string): InterviewState;
export function mergeInterviewSnapshot(state: InterviewState, snapshot: Partial<InterviewDetail> & { interview: InterviewDetail['interview'] }, options?: {earlier?: boolean}): InterviewState;
export function applyInterviewEvent(state: InterviewState, event: InterviewEvent): InterviewState;
export class InterviewEventHub {
  subscribe(ownerId: string, callback: (event: InterviewEvent) => void): () => void;
  publish(ownerId: string, event: InterviewEvent): void;
}
