// 给历史记忆补 tags（写入时抽的 3 个关键词），并保持其余字段不变
// 用法：node tools/backfill-tags.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SESSIONS = path.join(ROOT, 'memory', 'sessions');
const DRY = process.argv.includes('--dry');

function extractTags(text) {
  try {
    const t = String(text || "").replace(/^@\S+\s*/, "");
    // 按标点/空格切段，只保留 >=2 字的段；优先取最长的（更像"一句话里的实词块"）
    const segs = t.split(/[\s,，。、；;!！?？~～…\-—:：()（）\[\]【】"'"'']+/).filter((x) => x.length >= 2);
    const seen = [];
    for (const s of segs) {
      if (s.length > 24) {
        for (let i = 0; i + 8 <= s.length && seen.length < 3; i += 8) seen.push(s.slice(i, i + 8));
        continue;
      }
      seen.push(s);
      if (seen.length >= 3) break;
    }
    const out = [];
    for (const s of seen) {
      if (out.some((x) => x.includes(s) || s.includes(x))) continue;
      out.push(s);
      if (out.length >= 3) break;
    }
    return out;
  } catch { return []; }
}

let files = 0, lines = 0, changed = 0;
const samples = [];

for (const d of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const dir = path.join(SESSIONS, d.name);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const fp = path.join(dir, f);
    const raw = fs.readFileSync(fp, 'utf8');
    const out = [];
    let touched = false;
    for (const line of raw.split('\n')) {
      if (!line.trim()) { out.push(line); continue; }
      try {
        const e = JSON.parse(line);
        if (!Array.isArray(e.tags) || !e.tags.length) {
          e.tags = extractTags(e.text || '');
          touched = true;
          changed++;
          if (samples.length < 5) samples.push(`${String(e.text || '').slice(0, 24)} → ${e.tags.join('/')}`);
        }
        out.push(JSON.stringify(e));
      } catch {
        out.push(line);
      }
      lines++;
    }
    if (touched && !DRY) fs.writeFileSync(fp, out.join('\n'), 'utf8');
    files++;
  }
}

console.log(`扫描 ${files} 个文件 / ${lines} 行`);
console.log(`补 tags：${changed} 条${DRY ? '（dry run，未写入）' : ''}`);
console.log('样例：');
for (const s of samples) console.log('  ' + s);
