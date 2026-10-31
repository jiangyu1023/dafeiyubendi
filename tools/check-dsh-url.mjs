// 校验 config.json 里的 dsh.baseUrl 是否指向真正的 DSH
// 用法：node tools/check-dsh-url.mjs [--quiet]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const cfgPath = path.join(ROOT, 'config.json');
const quiet = process.argv.includes('--quiet');

let base = '';
try {
  base = String(JSON.parse(fs.readFileSync(cfgPath, 'utf8'))?.dsh?.baseUrl || '');
} catch { }

if (!base) {
  console.error('[dsh-url] config.json 里没有 dsh.baseUrl');
  process.exit(1);
}

async function probe(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 3000);
    const r = await fetch(`${url}/api/version`, { signal: c.signal });
    clearTimeout(t);
    // DSH 的 /api/version 未带凭据时返回 401；200 也表示服务在
    return r.status === 401 || r.status === 200;
  } catch { return false; }
}

const ok = await probe(base);
if (!ok) {
  console.error(`[dsh-url] ${base} 没有响应（DSH 没开，或端口变了）`);
  console.error('[dsh-url] 打开 DeepSeek Harness 后，把 config.json 的 dsh.baseUrl 改成它当前的端口');
  process.exit(1);
}
if (!quiet) console.log(`[dsh-url] OK ${base}`);
process.exit(0);
