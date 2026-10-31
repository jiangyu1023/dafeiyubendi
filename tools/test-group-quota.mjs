// 群聊限额插件交叉验证：时段判定 + 计数 + 封顶 + 私聊豁免
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = 'D:/AICompanion/qq-bridge';
process.chdir(ROOT);
const Q = await import('file:///D:/AICompanion/qq-bridge/src/group-quota.mjs');

const results = [];
const ok = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail });

// 用真实配置（limit=20, 9-12 / 14-18, 周一~周五）
Q.loadConfig();

const mk = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0);
// 2026-11-02 周一, 2026-11-07 周六
const mon = (h, min) => mk(2026, 11, 2, h, min);
const sat = (h, min) => mk(2026, 11, 7, h, min);

// ── 1. 时段判定 ──
ok('周一 09:00 属于时段0', Q.currentSlot(mon(9, 0)) === 0);
ok('周一 11:59 属于时段0', Q.currentSlot(mon(11, 59)) === 0);
ok('周一 12:00 不属于任何时段', Q.currentSlot(mon(12, 0)) === -1);
ok('周一 13:59 不属于任何时段', Q.currentSlot(mon(13, 59)) === -1);
ok('周一 14:00 属于时段1', Q.currentSlot(mon(14, 0)) === 1);
ok('周一 17:59 属于时段1', Q.currentSlot(mon(17, 59)) === 1);
ok('周一 18:00 不属于任何时段', Q.currentSlot(mon(18, 0)) === -1);
ok('周六 10:00 不属于任何时段', Q.currentSlot(sat(10, 0)) === -1);
ok('周日 10:00 不属于任何时段', Q.currentSlot(mk(2026, 11, 8, 10, 0)) === -1);

// ── 2. 私聊豁免 ──
ok('私聊不计入（noteSent 无效）', (() => {
  const before = JSON.stringify(Q.snapshot(mon(10, 0)).today);
  Q.noteSent('private:YOUR_QQ', mon(10, 0));
  const after = JSON.stringify(Q.snapshot(mon(10, 0)).today);
  return before === after;
})());
ok('私聊永不封顶', Q.isExhausted('private:YOUR_QQ', mon(10, 0)) === false);
ok('非时段内不封顶', Q.isExhausted('group:YOUR_GROUP', mon(12, 30)) === false);
ok('非工作日不封顶', Q.isExhausted('group:YOUR_GROUP', sat(10, 0)) === false);

// ── 3. 计数与封顶（用临时日期，避免污染今天）──
const testDay = mon(10, 0);
const KEY = 'group:999999';
for (let i = 1; i <= 19; i++) Q.noteSent(KEY, testDay);
ok('发到 19 条仍未封顶', Q.isExhausted(KEY, testDay) === false, 'count=19');
Q.noteSent(KEY, testDay);
ok('发到 20 条即封顶', Q.isExhausted(KEY, testDay) === true, 'count=20');
Q.noteSent(KEY, testDay);
ok('封顶后继续统计（第 21 条）', Q.isExhausted(KEY, testDay) === true);

// 同一群、另一个时段不受影响
ok('另一时段（14:00）不受影响', Q.isExhausted(KEY, mon(15, 0)) === false);

// 另一个群不受影响
ok('另一个群不受影响', (() => {
  for (let i = 0; i < 19; i++) Q.noteSent('group:888888', testDay);
  return Q.isExhausted('group:888888', testDay) === false;
})());

// ── 4. 清理测试数据 ──
const stFile = path.join(ROOT, 'state', 'group-quota.json');
try {
  const st = JSON.parse(fs.readFileSync(stFile, 'utf8'));
  for (const day of Object.keys(st.days || {})) {
    delete st.days[day]['group:999999'];
    delete st.days[day]['group:888888'];
  }
  delete st.days['2026-11-02'];
  fs.writeFileSync(stFile, JSON.stringify(st, null, 2), 'utf8');
  ok('测试数据已清理', true);
} catch (e) { ok('测试数据已清理', false, e.message); }

// ── 输出 ──
const pass = results.filter((r) => r.pass).length;
console.log(`\n=== 群聊限额交叉验证：${pass}/${results.length} 通过 ===`);
for (const r of results) {
  console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`);
}
process.exit(pass === results.length ? 0 : 1);
