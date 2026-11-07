export function normalizeOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('服务地址必须是 http(s)://主机:端口，不包含路径或凭据');
  return url.origin;
}
export function deploymentSettings(value) {
  if (!value?.trim()) throw new Error('请提供服务地址，例如 http://203.0.113.8:3000');
  const origin = normalizeOrigin(value.includes('://') ? value : `https://${value}`);
  const url = new URL(origin), secureCookies = url.protocol === 'https:';
  return {origin, host: secureCookies ? '127.0.0.1' : url.hostname.startsWith('[') ? '::' : '0.0.0.0', port: secureCookies ? 3000 : Number(url.port || 80), secureCookies, trustProxy: secureCookies ? 1 : 0};
}
