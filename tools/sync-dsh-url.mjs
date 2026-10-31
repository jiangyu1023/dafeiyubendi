// 找出本机正在运行的 DSH Web 端口，并写回 config.json 的 dsh.baseUrl。
// 为什么需要：DSH 桌面端每次重启会换一个随机端口，写死的地址下次就失效，
// 表现是“QQ 上毫无反应”，日志里却是连不上 127.0.0.1:老端口。
//
// 判定方式：netstat 找 LISTENING 的端口 → 看占用进程名是不是 DeepSeek Harness →
// 对候选端口请求 /api/version，返回 401（未带 Cookie）即认定为 DSH。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(here, '..', 'config.json');

function netstatListening() {
  const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 << 20 });
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
    if (m) rows.push({ addr: m[1], port: Number(m[2]), pid: Number(m[3]) });
  }
  return rows;
}

function procName(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const m = out.match(/^"([^"]+)"/m);
    return m ? m[1] : '';
  } catch { return ''; }
}

const NON_DSH_PORTS = new Set([3000, 3001, 3100, 3200, 5099, 5100, 5101, 9881]);

async function isDsh(port) {
  if (NON_DSH_PORTS.has(port)) return false;   // 排除网关/桥接/面板/ASR，避免把 SnowLuma WebUI 当成 DSH
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: c.signal });
    clearTimeout(t);
    return r.status === 401;
  } catch { return false; }
}

const rows = netstatListening();
const pids = [...new Set(rows.map((r) => r.pid))];
const dshPids = new Set(pids.filter((p) => /deepseek/i.test(procName(p))));

const candidates = [...new Set(
  rows.filter((r) => (r.addr === '127.0.0.1' || r.addr === '0.0.0.0' || r.addr === '[::]' || r.addr === '[::1]')
    && (dshPids.size === 0 || dshPids.has(r.pid)))
    .map((r) => r.port),
)].sort((a, b) => a - b);

let found = null;
for (const port of candidates) {
  if (await isDsh(port)) { found = port; break; }
}

if (!found) {
  console.error('[dsh-url] 没找到正在运行的 DSH Web 端口。');
  console.error('[dsh-url] 先确认 DSH 桌面端已经打开，然后重试；这一步没成功桥接不会工作。');
  process.exit(2);
}

if (!existsSync(configPath)) {
  console.error(`[dsh-url] 找不到 ${configPath}`);
  process.exit(2);
}

const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
const next = `http://127.0.0.1:${found}`;
const changed = cfg.dsh.baseUrl !== next;
cfg.dsh.baseUrl = next;
writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log(`[dsh-url] DSH 端口 ${found}，config.json 的 dsh.baseUrl = ${next}${changed ? '（已更新）' : '（没变）'}`);
