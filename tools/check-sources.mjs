// 校验记忆来源：统计日记/档案里有 sources 的比例
// 用法：node tools/check-sources.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIARY = path.join(ROOT, 'data', '日记', '日记.jsonl');
const PROFILE_DIR = path.join(ROOT, 'data', '群友档案');

function pct(a, b) {
  return b === 0 ? '—' : `${Math.round((a / b) * 100)}%`;
}

// 日记
let diaryTotal = 0, diaryWith = 0, recent = [];
try {
  const lines = fs.readFileSync(DIARY, 'utf8').split('\n').filter(Boolean);
  diaryTotal = lines.length;
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      if (Array.isArray(e.sources) && e.sources.length) {
        diaryWith++;
        recent.push(e);
      }
    } catch { }
  }
} catch { }

console.log('=== 记忆来源校验 ===');
console.log(`日记：${diaryTotal} 条，带 sources ${diaryWith} 条（${pct(diaryWith, diaryTotal)}）`);
if (recent.length) {
  for (const e of recent.slice(-3)) {
    console.log(`  ✓ ${e.ts}  [${e.sources.join('-')}] ${String(e.text).slice(0, 40)}`);
  }
}

// 档案
let profTotal = 0, profWith = 0;
try {
  for (const f of fs.readdirSync(PROFILE_DIR).filter((x) => x.endsWith('.md'))) {
    const txt = fs.readFileSync(path.join(PROFILE_DIR, f), 'utf8');
    const recs = (txt.match(/^- \d{4}-\d{2}-\d{2} \d{2}:\d{2}/gm) || []).length;
    const withSrc = (txt.match(/^\s+- 依据：/gm) || []).length;
    profTotal += recs;
    profWith += withSrc;
  }
} catch { }
console.log(`档案：${profTotal} 条记录，带依据 ${profWith} 条（${pct(profWith, profTotal)}）`);

if (diaryTotal > 0 && diaryWith / diaryTotal < 0.5) {
  console.log('\n⚠ 带来源比例偏低：她可能忘了传 sources，或 DSH 还没重启（新字段未加载）');
}
