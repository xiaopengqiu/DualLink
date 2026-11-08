export function taskCaptureIds(task) {
  if (Array.isArray(task?.captureIds) && task.captureIds.length) return task.captureIds;
  return task?.captureId ? [task.captureId] : [];
}
export function latestCaptureTask(tasks, captureId) {
  if (!captureId) return undefined;
  return tasks.filter(task => taskCaptureIds(task).includes(captureId)).sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
}
export function taskCaptures(task, captures) {
  const lookup = new Map([...captures, ...(task?.captures || [])].map(capture => [capture.id, capture]));
  return taskCaptureIds(task).map(id => lookup.get(id)).filter(Boolean);
}
