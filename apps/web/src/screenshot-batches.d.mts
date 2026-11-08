import type { Capture, Task } from './types';
export function taskCaptureIds(task: Task | null | undefined): string[];
export function latestCaptureTask(tasks: Task[], captureId: string | null | undefined): Task | undefined;
export function taskCaptures(task: Task | null | undefined, captures: Capture[]): Capture[];
