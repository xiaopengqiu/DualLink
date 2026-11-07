import { fail } from './auth.mjs';

export function modelId(value, { empty = true } = {}) {
  if (typeof value !== 'string' || (!empty && !value) || (value && !/^[A-Za-z0-9][A-Za-z0-9._:/+\[\]-]{0,99}$/.test(value))) fail(400, '模型 ID 需为最多100个字母、数字或常用模型分隔符，不能包含空格或命令参数');
  return value;
}
export function modelMap(value, current = {}, providers = ['codex', 'claude', 'bailian']) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !providers.includes(k))) fail(400, '模型配置无效');
  const result = Object.fromEntries(providers.map(k => [k, current[k] || '']));
  for (const [provider, model] of Object.entries(value)) result[provider] = modelId(model);
  return result;
}
export const defaultTextModel = (provider, cli = {}) => provider === 'codex' ? cli.codexModel || process.env.CODEX_MODEL || '' : provider === 'claude' ? cli.claudeModel || process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || '' : process.env.INTERVIEW_TEXT_MODEL || 'qwen-flash';
