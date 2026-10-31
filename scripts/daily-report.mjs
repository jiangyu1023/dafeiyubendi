// 每日小报：把当天 token 花费、会话数、网关状态发到管理员私聊。
// 由计划任务每天 23:30 调用；也可以手动 node daily-report.mjs
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const QB = process.env.QB_ROOT || path.resolve(import.meta.dirname, '..', 'qq-bridge');
const OWNER = process.env.OWNER_QQ || 'YOUR_QQ';

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

const cfg = readJson(path.join(QB, 'config.json')) ?? {};
const consoleToken = (() => {
  try { return readFileSync(path.join(QB, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
})();

async function bridgeApi(p) {
  const res = await fetch(`http://127.0.0.1:3100${p}`, { headers: { 'x-console-token': consoleToken } });
  return res.json();
}

async function sendQQ(text) {
  const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg.snowluma?.accessToken || '');
  const res = await fetch(`${httpUrl}/send_private_msg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ user_id: Number(OWNER), message: text })
  });
  const body = await res.json().catch(() => null);
  return Boolean(body && body.retcode === 0);
}

async function main() {
  const now = new Date();
  const lines = [`【${now.getMonth() + 1}月${now.getDate()}日 小报】`];

  let status = null;
  let tokens = null;
  try { status = await bridgeApi('/api/status'); } catch {}
  try { tokens = await bridgeApi('/api/tokens/summary'); } catch {}

  if (tokens?.totals) {
    const t = tokens.totals;
    lines.push(
      `花费 ¥${t.cost.toFixed(2)}（今天累计，未拆日）`,
      `对话 ${t.turns} 轮 / ${t.conversations} 个会话`,
      `token ${(t.totalTokens / 1e6).toFixed(1)}M，缓存命中 ${(t.cacheHitRate * 100).toFixed(0)}%`
    );
  } else {
    lines.push('花费：读不到（桥接控制台没响应）');
  }

  if (status) {
    lines.push(
      `SnowLuma：${status.snowluma?.connected
        ? (status.snowluma?.good === false ? '已连接（上游退化）'
          : status.snowluma?.good === true ? '已连接' : '已连接（心跳停了）')
        : '断开'}`,
      `模式：${status.mode}｜人设：${status.role ?? '未设置'}`
    );
  } else {
    lines.push('桥接：没响应，可能挂了');
  }

  // 昨天的备份有没有做
  const backupRoot = path.resolve(QB, '..', 'backup');
  const latest = existsSync(backupRoot)
    ? (await import('node:fs')).readdirSync(backupRoot).sort().pop()
    : null;
  lines.push(latest ? `最近备份：${latest}` : '最近备份：还没有');

  const text = lines.join('\n');
  const ok = await sendQQ(text);
  console.log(ok ? '已发送' : '发送失败');
  console.log(text);
}

main().catch((error) => {
  console.error('小报失败：', error?.message ?? error);
  process.exit(1);
});
