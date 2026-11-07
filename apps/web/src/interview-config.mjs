export function modeReady(config, mode = 'transcript') {
  return !!(mode === 'audio' ? config?.audioConfigured : config?.configured);
}
export function interviewPreferences(config = {}, saved = config.defaults || {}) {
  return {mode:saved.mode === 'audio' ? 'audio' : 'transcript',provider:saved.provider || config.defaultProvider || 'codex',textModels:{codex:saved.textModels?.codex||'',claude:saved.textModels?.claude||'',bailian:saved.textModels?.bailian||''},asrModel:saved.asrModel||config.asrModel||'',transcribe:saved.transcribe !== false,audioModel:saved.audioModel || config.audioModels?.[0] || 'qwen3.8-omni-flash-realtime',audioWindowSeconds:Math.max(15,Math.min(180,Number(saved.audioWindowSeconds)||120))};
}
