// 余额快照 + 每日小报发送
// 用法：node tools/balance-snapshot.mjs          记录一次余额
//      node tools/daily-report-send.mjs          生成昨天的报并发 QQ
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE = path.join(ROOT, 'state');
const BAL = path.join(STATE, 'balance-history.jsonl');

function apiKey() {
  try {
    const t = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8');
    const m = t.match(/sk-[A-Za-z0-9]{20,}/);
    return m ? m[0] : '';
  } catch { return ''; }
}

export async function fetchBalance() {
  const key = apiKey();
  if (!key) return null;
  try {
    const r = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    const info = (j.balance_infos || [])[0];
    return info ? Number(info.total_balance) : null;
  } catch { return null; }
}

export function recordBalance(tag = 'snapshot') {
  return fetchBalance().then((b) => {
    if (b === null) return null;
    fs.appendFileSync(BAL, JSON.stringify({ at: Date.now(), day: new Date().toLocaleDateString('sv-SE'), balance: b, tag }) + '\n', 'utf8');
    return b;
  });
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('balance-snapshot.mjs')) {
  const b = await recordBalance('cli');
  console.log(b === null ? '余额读取失败' : `余额 ¥${b.toFixed(2)} 已记录`);
}
