// 对照测试：对比「扫描文件」和「内存数组」两种检索结果是否一致
// 用法：node tools/mem-bench.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SESSIONS = path.join(ROOT, 'memory', 'sessions');

// ---------- 1) 加载全部条目（模拟内存索引） ----------
function loadAll() {
  const out = [];
  for (const d of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(SESSIONS, d.name);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const content = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          out.push({ key: String(e.key || ''), name: String(e.name || ''), text: String(e.text || ''), t: String(e.t || ''), id: Number(e.id) || 0, file: f });
        } catch { }
      }
    }
  }
  return out;
}

// ---------- 2) 旧方式：扫文件 ----------
function searchByFiles(terms, days, limit, excludePrivate) {
  const hits = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const day = new Date(now.getTime() - i * 86400000);
    const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    for (const d of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = path.join(SESSIONS, d.name, `${dayKey}.jsonl`);
      if (!fs.existsSync(f)) continue;
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (excludePrivate && String(e.key || '').startsWith('private:')) continue;
        const low = `${e.name || ''} ${e.text || ''}`.toLowerCase();
        let score = 0;
        for (const t of terms) if (low.includes(t.toLowerCase())) score += 1;
        if (score > 0) hits.push({ score, key: e.key, name: e.name, text: e.text, t: e.t });
      }
    }
  }
  hits.sort((a, b) => (b.score - a.score) || (Date.parse(b.t) - Date.parse(a.t)));
  return hits.slice(0, limit);
}

// ---------- 3) 新方式：内存数组 ----------
function searchByCache(all, terms, days, limit, excludePrivate) {
  const cutoff = Date.now() - days * 86400000;
  const hits = [];
  for (const e of all) {
    if (excludePrivate && String(e.key || '').startsWith('private:')) continue;
    const ts = Date.parse(e.t);
    if (Number.isFinite(ts) && ts < cutoff) continue;
    const low = `${e.name || ''} ${e.text || ''}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (low.includes(t.toLowerCase())) score += 1;
    if (score > 0) hits.push({ score, key: e.key, name: e.name, text: e.text, t: e.t });
  }
  hits.sort((a, b) => (b.score - a.score) || (Date.parse(b.t) - Date.parse(a.t)));
  return hits.slice(0, limit);
}

// ---------- 跑对照 ----------
const all = loadAll();
console.log(`索引加载：${all.length} 条\n`);

const cases = ['烤牛奶', '晴天', '晚安', '减肥', '管理员', '大肥鱼', '唱歌', '抖音', '截图', '记忆'];
const days = 90, limit = 6;

let pass = 0, fail = 0;
for (const q of cases) {
  const terms = [q];
  const t0 = performance.now();
  const a = searchByFiles(terms, days, limit, false);
  const t1 = performance.now();
  const b = searchByCache(all, terms, days, limit, false);
  const t2 = performance.now();

  const aKeys = a.map((x) => `${x.key}|${x.t}|${x.text.slice(0, 20)}`).join('§');
  const bKeys = b.map((x) => `${x.key}|${x.t}|${x.text.slice(0, 20)}`).join('§');
  const same = aKeys === bKeys;
  if (same) pass++; else fail++;

  console.log(`「${q}」 文件 ${a.length} 条/${(t1 - t0).toFixed(1)}ms   内存 ${b.length} 条/${(t2 - t1).toFixed(2)}ms   ${same ? '✓ 一致' : '✗ 不一致'}`);
  if (!same) {
    console.log(`   文件: ${a.slice(0, 2).map((x) => x.text.slice(0, 20)).join(' / ')}`);
    console.log(`   内存: ${b.slice(0, 2).map((x) => x.text.slice(0, 20)).join(' / ')}`);
  }
}

console.log(`\n结果：一致 ${pass} / 不一致 ${fail}`);
console.log(fail === 0 ? '[PASS] 两种方式结果一致，可以切换' : '[FAIL] 有差异，切换前必须修正');

// 隐私规则检查
const gp = searchByCache(all, ['烤牛奶'], 90, 6, true);
const leaked = gp.filter((x) => String(x.key || '').startsWith('private:'));
console.log(`隐私检查（群聊排除私聊）：泄露 ${leaked.length} 条 ${leaked.length === 0 ? '✓' : '✗'}`);
