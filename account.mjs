import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export function localAccount(file) {
  async function load() {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  }
  return {
    async status() { return { needsSetup: !(await load()) }; },
    async setup(username, password) {
      if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(username) ||
          typeof password !== 'string' || password.length < 12 || password.length > 256) {
        throw new Error('账号需为 1-64 位字母、数字、点、下划线或横线；密码需为 12-256 个字符。');
      }
      const salt = randomBytes(16).toString('hex');
      const hash = (await scrypt(password, salt, 64)).toString('hex');
      await writeFile(file, JSON.stringify({ username, salt, hash }, null, 2), { flag: 'wx', mode: 0o600 });
    },
    async authenticate(username, password) {
      const account = await load();
      if (!account || typeof username !== 'string' || typeof password !== 'string' || password.length > 256) return false;
      const hash = await scrypt(password, account.salt, 64);
      const expected = Buffer.from(account.hash, 'hex');
      return username === account.username && expected.length === hash.length && timingSafeEqual(hash, expected);
    }
  };
}
