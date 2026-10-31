// 生成小报并发送到 QQ 私聊
// 用法：node tools/daily-report-send.mjs [YYYY-MM-DD]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const day = process.argv[2] || new Date(Date.now() - 86400000).toLocaleDateString('sv-SE');

// 1) 先生成（复用 daily-report.mjs，它会写 data/小报/<day>.md）
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'daily-report.mjs'), day], { stdio: 'inherit' });

const md = path.join(ROOT, 'data', '小报', `${day}.md`);
if (!fs.existsSync(md)) { console.error('小报文件没生成'); process.exit(1); }
const text = fs.readFileSync(md, 'utf8').trim();

// 2) 发送
const consoleToken = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
const sv = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const to = String(cfg.socialV2?.alerts?.to || 'private:YOUR_QQ');
const userId = to.split(':')[1];
const agentToken = sv.conversations[to]?.agentToken || '';

const res = await fetch(`http://127.0.0.1:3100/api/send/private?token=${encodeURIComponent(consoleToken)}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-agent-token': agentToken },
  body: JSON.stringify({ userId, message: text, token: agentToken }),
  signal: AbortSignal.timeout(20000),
});
const j = await res.json().catch(() => ({}));
console.log(j.ok ? `已发送到 ${to}（${j.sent} 条）` : `发送失败：${JSON.stringify(j)}`);
