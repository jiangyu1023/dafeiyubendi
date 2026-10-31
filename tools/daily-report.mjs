// 每日小报：真实余额差 + token 明细 + 误差对比
// 用法：node tools/daily-report.mjs [YYYY-MM-DD]  （默认昨天）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE = path.join(ROOT, 'state');
const OUT_DIR = path.join(ROOT, 'data', '小报');
const USAGE = path.join(STATE, 'token-usage.jsonl');
const BAL_HIST = path.join(STATE, 'balance-history.jsonl');

// ---------- 官方价格（元/百万 token） ----------
const PRICE = {
  peak: { miss: 2, hit: 0.04, out: 8 },
  idle: { miss: 1, hit: 0.02, out: 4 },
};
function isPeak(d) {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  const h = d.getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

// ---------- 读 API key ----------
function apiKey() {
  try {
    const t = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8');
    const m = t.match(/sk-[A-Za-z0-9]{20,}/);
    return m ? m[0] : '';
  } catch { return ''; }
}

// ---------- 余额 ----------
async function fetchBalance() {
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

function loadBalanceHistory() {
  try {
    return fs.readFileSync(BAL_HIST, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function saveBalanceSnapshot(bal, tag) {
  if (bal === null) return;
  try {
    fs.appendFileSync(BAL_HIST, JSON.stringify({ at: Date.now(), day: new Date().toLocaleDateString('sv-SE'), balance: bal, tag }) + '\n', 'utf8');
  } catch { }
}

// ---------- token 统计（按天） ----------
function tokenStats(day) {
  const out = { n: 0, miss: 0, hit: 0, output: 0, cost: 0, peakN: 0, idleN: 0, peakCost: 0, idleCost: 0, byKey: {}, byHour: {} };
  let lines = [];
  try { lines = fs.readFileSync(USAGE, 'utf8').split('\n').filter(Boolean); } catch { return out; }
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.k !== 'turn') continue;
    const d = new Date(e.t);
    if (d.toLocaleDateString('sv-SE') !== day) continue;
    const b = e.b || {};
    const peak = isPeak(d);
    const p = peak ? PRICE.peak : PRICE.idle;
    const c = (b.cacheMiss || 0) / 1e6 * p.miss + (b.cacheHit || 0) / 1e6 * p.hit + (b.output || 0) / 1e6 * p.out;
    out.n++; out.miss += b.cacheMiss || 0; out.hit += b.cacheHit || 0; out.output += b.output || 0; out.cost += c;
    if (peak) { out.peakN++; out.peakCost += c; } else { out.idleN++; out.idleCost += c; }
    const k = String(e.key || 'other');
    out.byKey[k] = out.byKey[k] || { n: 0, cost: 0, hit: 0 };
    out.byKey[k].n++; out.byKey[k].cost += c; out.byKey[k].hit += b.cacheHit || 0;
    const hh = String(d.getHours()).padStart(2, '0');
    out.byHour[hh] = (out.byHour[hh] || 0) + c;
  }
  return out;
}

// ---------- 消息统计 ----------
function msgStats(day) {
  const dir = path.join(ROOT, 'memory', 'sessions');
  const res = { total: 0, user: 0, bot: 0, byChannel: {}, bySpeaker: {} };
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = path.join(dir, d.name, `${day}.jsonl`);
      if (!fs.existsSync(f)) continue;
      let c = { total: 0, user: 0, bot: 0 };
      for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
        try {
          const e = JSON.parse(line);
          c.total++; res.total++;
          if (e.who === 'bot') { c.bot++; res.bot++; } else { c.user++; res.user++; }
          const nm = String(e.name || '').trim();
          if (nm && e.who !== 'bot') res.bySpeaker[nm] = (res.bySpeaker[nm] || 0) + 1;
        } catch { }
      }
      res.byChannel[d.name] = c;
    }
  } catch { }
  return res;
}

// ---------- 日记/档案 ----------
function diaryStats(day) {
  const res = { diary: 0, longest: 0, profile: 0, affinity: 0, sources: 0 };
  try {
    for (const line of fs.readFileSync(path.join(ROOT, 'data', '日记', '日记.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      const e = JSON.parse(line);
      if (String(e.ts || '').slice(0, 10) === day) {
        res.diary++;
        res.longest = Math.max(res.longest, String(e.text || '').length);
        if (Array.isArray(e.sources) && e.sources.length) res.sources++;
      }
    }
  } catch { }
  try {
    const pd = path.join(ROOT, 'data', '群友档案');
    for (const f of fs.readdirSync(pd).filter((x) => x.endsWith('.md'))) {
      const t = fs.readFileSync(path.join(pd, f), 'utf8');
      const recs = t.split('\n').filter((l) => l.includes(day));
      res.profile += recs.length;
      res.affinity += (t.match(new RegExp(day + '[^\\n]*\\n(?:\\s+- [^\\n]*\\n)*?\\s+- 好感', 'g')) || []).length;
      res.affinity += (t.match(/好感/g) || []).length ? 0 : 0;
    }
    // 简单统计：所有好感行（累计）
    for (const f of fs.readdirSync(pd).filter((x) => x.endsWith('.md'))) {
      const t = fs.readFileSync(path.join(pd, f), 'utf8');
      res.affinity += (t.match(/- 好感/g) || []).length;
    }
  } catch { }
  return res;
}

// ---------- 主流程 ----------
// 面板关掉每日小报 → 直接退出
try {
  const _c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  if (_c?.dailyReport?.enabled === false) { console.log('每日小报已在面板关闭，跳过。'); process.exit(0); }
} catch { }

const day = process.argv[2] || new Date(Date.now() - 86400000).toLocaleDateString('sv-SE');
const now = await fetchBalance();
const hist = loadBalanceHistory();
saveBalanceSnapshot(now, 'report-run');

// 找 day 当天开始前最后一个余额快照（作为起点）
const dayStartMs = new Date(day + 'T00:00:00').getTime();
const before = [...hist].filter((h) => h.at < dayStartMs).sort((a, b) => b.at - a.at)[0];
const dayEndMs = dayStartMs + 86400000;
const after = [...hist].filter((h) => h.at > dayStartMs && h.at <= Math.min(Date.now(), dayEndMs)).sort((a, b) => b.at - a.at)[0];

const tok = tokenStats(day);
const msg = msgStats(day);
const dia = diaryStats(day);

// 真实消耗：把当天余额序列的“下降”累加（充值造成的上升不计）
let realCost = null;
try {
  const dayRows = hist.filter((h) => h.at >= dayStartMs && h.at <= Math.min(Date.now(), dayEndMs));
  const seq = [...(before ? [before] : []), ...dayRows].sort((a, b) => a.at - b.at);
  let spent = 0;
  for (let i = 1; i < seq.length; i++) {
    const d = seq[i - 1].balance - seq[i].balance;
    if (d > 0) spent += d;   // 只在余额下降时累加，充值(上升)忽略
  }
  realCost = seq.length >= 2 ? spent : null;
} catch { realCost = null; }
const estCost = tok.cost;
const diff = realCost !== null ? (estCost - realCost) : null;

const topSpeakers = Object.entries(msg.bySpeaker).sort((a, b) => b[1] - a[1]).slice(0, 3);
const topKeys = Object.entries(tok.byKey).sort((a, b) => b[1].cost - a[1].cost).slice(0, 4);
const peakHours = Object.entries(tok.byHour).sort((a, b) => b[1] - a[1]).slice(0, 2);

const lines = [];
lines.push(`【${day} 小报】`);
lines.push('');
lines.push('■ 花费');
if (realCost !== null) {
  lines.push(`  真实扣费 ¥${realCost.toFixed(2)}（余额差）`);
  lines.push(`  估算 ¥${estCost.toFixed(2)}（按官方分时价）`);
  lines.push(`  误差 ¥${diff.toFixed(2)}（估算${diff >= 0 ? '偏高' : '偏低'} ${Math.abs(diff) > 0 && realCost > 0 ? (Math.abs(diff) / realCost * 100).toFixed(0) : 0}%）`);
} else {
  lines.push(`  估算 ¥${estCost.toFixed(2)}（余额差数据不足，需跑满两天）`);
}
lines.push(`  高峰 ¥${tok.peakCost.toFixed(2)}（${tok.peakN}次）/ 空闲 ¥${tok.idleCost.toFixed(2)}（${tok.idleN}次）`);
lines.push(`  当前余额 ¥${now === null ? '?' : now.toFixed(2)}`);
lines.push('');
lines.push('■ 流量');
lines.push(`  消息 ${msg.total} 条（他/群友 ${msg.user}，她 ${msg.bot}）`);
if (topSpeakers.length) lines.push(`  最活跃：${topSpeakers.map(([n, c]) => `${n} ${c}句`).join('、')}`);
lines.push(`  token 未命中 ${tok.miss.toLocaleString()} / 命中 ${tok.hit.toLocaleString()} / 输出 ${tok.output.toLocaleString()}`);
lines.push('');
lines.push('■ 记忆');
lines.push(`  日记 ${dia.diary} 篇${dia.longest ? `（最长 ${dia.longest} 字）` : ''}，带来源 ${dia.sources} 条`);
lines.push(`  档案更新 ${dia.profile} 条，好感记录 ${dia.affinity} 条`);
lines.push('');
lines.push('■ 系统');
try {
  const bd = path.join(ROOT, 'backup');
  const last = fs.readdirSync(bd).filter((x) => x.endsWith('.zip')).sort().pop();
  lines.push(`  最近备份 ${last || '无'}`);
} catch { lines.push('  最近备份 无'); }
if (topKeys.length) lines.push(`  最贵会话：${topKeys.map(([k, v]) => `${k} ¥${v.cost.toFixed(2)}`).join('、')}`);
if (peakHours.length) lines.push(`  最贵的两小时：${peakHours.map(([h, c]) => `${h}:00 ¥${c.toFixed(2)}`).join('、')}`);

const text = lines.join('\n');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, `${day}.md`), text + '\n', 'utf8');
fs.appendFileSync(path.join(OUT_DIR, 'index.jsonl'), JSON.stringify({
  day, realCost, estCost, diff, balance: now,
  msgs: msg.total, user: msg.user, bot: msg.bot,
  diary: dia.diary, profile: dia.profile,
  peakCost: tok.peakCost, idleCost: tok.idleCost, calls: tok.n,
}) + '\n', 'utf8');

console.log(text);
