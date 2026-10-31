// 直接以 stdio 驱动 mcp-diary，验证 eventDay 与情绪放大好感
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/AICompanion/qq-bridge';
const TEST_QQ = '999999999';
const MOOD = path.join(ROOT, 'state', 'mood.json');
const DIARY = path.join(ROOT, 'data', '日记', '日记.jsonl');
const PROFILE = path.join(ROOT, 'data', '群友档案', TEST_QQ + '.md');

const moodBackup = fs.existsSync(MOOD) ? fs.readFileSync(MOOD, 'utf8') : null;
const diaryLenBefore = fs.existsSync(DIARY) ? fs.readFileSync(DIARY, 'utf8').split('\n').filter(Boolean).length : 0;

const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp-diary.js')], {
  cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const pending = new Map();
let id = 0;
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[mcp] ' + d.toString()));

function rpc(method, params) {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('timeout ' + method)); } }, 15000);
  });
}
const call = (name, args) => rpc('tools/call', { name, arguments: args });
const textOf = (r) => (r?.result?.content || []).map((c) => c.text || '').join(' ') || JSON.stringify(r).slice(0, 200);

const results = [];
const ok = (n, c, d = '') => results.push({ n, c: !!c, d });

try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // ── 测试 1：eventDay ──
  // 造一个“刚归档过”的区间，让 autoSources 能用
  const RANGE = path.join(ROOT, 'state', 'diary-id-range.json');
  const rangeBackup = fs.existsSync(RANGE) ? fs.readFileSync(RANGE, 'utf8') : null;
  fs.writeFileSync(RANGE, JSON.stringify({ key: 'group:0', lo: 100, hi: 200, at: Date.now() }), 'utf8');

  const r1 = await call('diary_write', { text: '【验证】测试 eventDay 字段是否落库', eventDay: '2026-10-30' });
  const lines = fs.readFileSync(DIARY, 'utf8').split('\n').filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  ok('eventDay 写入', last.eventDay === '2026-10-30', '实际=' + String(last.eventDay));
  ok('日记确实新增一条', lines.length === diaryLenBefore + 1, `${diaryLenBefore} → ${lines.length}`);

  // ── 测试 2：情绪放大好感 ──
  const moodNow = { label: '生气', intensity: 0.8, reason: '验证用', target: '', updatedAt: Date.now(), history: [] };
  fs.writeFileSync(MOOD, JSON.stringify(moodNow, null, 2), 'utf8');

  const r2 = await call('profile_save', {
    qq: TEST_QQ, name: '验证账号', note: '【验证】情绪放大好感测试', affinity: -2,
  });
  console.log('  profile_save 返回: ' + textOf(r2).slice(0, 300));
  console.log('  文件存在: ' + fs.existsSync(PROFILE));
  try { console.log('  档案目录: ' + fs.readdirSync(path.join(ROOT, 'data', '群友档案')).filter(x => x.includes('999')).join(',')); } catch {}
  const prof = fs.existsSync(PROFILE) ? fs.readFileSync(PROFILE, 'utf8') : '';
  const m = prof.match(/好感\s*([+-]?\d+(?:\.\d+)?)/);
  const applied = m ? Number(m[1]) : NaN;
  ok('生气时 -2 被放大到 -3', applied === -3, '实际=' + applied);
  ok('好感依据已写入', prof.includes('好感依据'), prof.includes('好感依据') ? '' : '未找到该行');

  // 还原情绪
  if (moodBackup !== null) fs.writeFileSync(MOOD, moodBackup, 'utf8');
} catch (e) {
  ok('执行异常', false, e.message);
} finally {
  child.kill();
  // 清理测试数据
  try {
    const l = fs.readFileSync(DIARY, 'utf8').split('\n').filter(Boolean);
    const kept = l.filter((x) => !x.includes('【验证】'));
    fs.writeFileSync(DIARY, kept.join('\n') + '\n', 'utf8');
  } catch { }
  try { if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE); } catch { }
  if (moodBackup !== null) { try { fs.writeFileSync(MOOD, moodBackup, 'utf8'); } catch { } }
  try { if (rangeBackup !== null) fs.writeFileSync(RANGE, rangeBackup, 'utf8'); else fs.unlinkSync(RANGE); } catch { }
}

const pass = results.filter((r) => r.c).length;
console.log(`\n=== 验证结果 ${pass}/${results.length} ===`);
for (const r of results) console.log(`  ${r.c ? '✅' : '❌'} ${r.n}${r.d ? '  (' + r.d + ')' : ''}`);
process.exit(pass === results.length ? 0 : 1);
