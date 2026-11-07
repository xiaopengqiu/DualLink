import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openDatabase } from './db.mjs';
import { createUser, passwordHash } from './auth.mjs';
import { readSecret } from './admin-input.mjs';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'admin' }, 'daily-limit': { type: 'string', default: '100' }, 'reset-password': { type: 'boolean', default: false } } });
if (!values.email) { console.error('Usage: npm run admin -- --email admin@example.com --name 管理员 [--reset-password]\nPassword: hidden interactive input, stdin, or temporary DUALLINK_ADMIN_PASSWORD. No default password.'); process.exitCode = 1; }
else {
  let password = process.env.DUALLINK_ADMIN_PASSWORD || (!process.stdin.isTTY ? readFileSync(0, 'utf8').replace(/[\r\n]+$/, '') : '');
  if (!password && process.stdin.isTTY) {
    try { password = await readSecret('请输入密码（至少 10 个字符，不显示）：'); const confirm = await readSecret('请再次输入密码：'); if (password !== confirm) throw new Error('两次密码不一致'); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
  if (!password) { console.error('Provide password with stdin or DUALLINK_ADMIN_PASSWORD (at least 10 characters).'); process.exitCode = 1; }
  else {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const db = openDatabase(path.resolve(root, process.env.DATA_DIR || 'data'));
    try {
      if (process.exitCode) throw new Error('未修改账号');
      if (values['reset-password']) {
        const user = db.prepare('SELECT * FROM users WHERE email=?').get(values.email.trim().toLowerCase());
        if (!user) throw new Error('账号不存在');
        db.transaction(() => { db.prepare('UPDATE users SET password_hash=?,disabled=0 WHERE id=?').run(passwordHash(password), user.id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id); db.prepare('DELETE FROM devices WHERE user_id=?').run(user.id); db.prepare('DELETE FROM ws_tickets WHERE user_id=?').run(user.id); })();
        console.log(`Reset password: ${user.email}. Sessions and paired devices revoked.`);
      } else {
        const user = createUser(db, { email: values.email, name: values.name, password, role: values.role, dailyLimit: Number(values['daily-limit']) }); console.log(`Created ${user.role}: ${user.email}`);
      }
    }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { db.close(); }
  }
}
