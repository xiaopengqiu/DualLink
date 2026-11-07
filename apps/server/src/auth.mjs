import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const now = () => new Date().toISOString();
export const hash = value => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('hex');
export function fail(status, message, code) { const e = new Error(message); e.status = status; e.code = code; throw e; }
export function checkPasswordInput(value) { if (typeof value !== 'string' || value.length < 10 || value.length > 256) fail(400, '密码长度需为 10–256 个字符'); }
export function passwordHash(password) { checkPasswordInput(password); const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
export function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 256 || typeof encoded !== 'string') return false;
  const [salt, digest] = encoded.split(':');
  if (!salt || !digest) return false;
  const actual = scryptSync(password, salt, 64); const expected = Buffer.from(digest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function userView(row) { return { id: row.id, email: row.email, name: row.name, role: row.role, disabled: !!row.disabled, dailyLimit: row.daily_limit }; }
export function text(value, label, max = 500, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, `${label}格式不正确`);
  return value.trim();
}
export function createUser(db, input) {
  const email = text(input.email, '邮箱', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, '请输入有效邮箱');
  const name = text(input.name || email.split('@')[0], '名称', 80);
  const dailyLimit = input.dailyLimit ?? 100;
  if (!Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 100000) fail(400, '每日额度需为 0–100000 的整数');
  const id = randomUUID(); const date = now();
  const insert = db.transaction(() => {
    if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) fail(409, '该邮箱已存在');
    db.prepare('INSERT INTO users(id,email,name,password_hash,role,daily_limit,created_at) VALUES(?,?,?,?,?,?,?)').run(id, email, name, passwordHash(input.password), input.role === 'admin' ? 'admin' : 'user', dailyLimit, date);
    db.prepare('INSERT INTO prompts(id,user_id,name,content,is_default,created_at,updated_at) VALUES(?,?,?,?,1,?,?)').run(randomUUID(), id, '默认回答风格', '请用中文回答截图中的问题。先给结论，再分点说明理由；涉及代码时提供可运行的示例。根据知识库中可核实的内容回答，资料不足或截图看不清时明确说明，不编造个人经历。', date, date);
  }); insert();
  return userView(db.prepare('SELECT * FROM users WHERE id=?').get(id));
}
