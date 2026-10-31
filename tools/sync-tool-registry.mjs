// 扫描所有 MCP 服务里注册的工具，生成 tools/tool-registry.json
// 用途：面板「其他工具」分类自动列出所有 MCP 工具（新增工具无需手写）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/AICompanion/qq-bridge';
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'tools', 'tool-registry.json');

// 已由「功能」页手工分类覆盖的工具，不再重复出现在「其他工具」
const CURATED = new Set([
  'qq_draw_image', 'qzone_post', 'qzone_posts', 'qzone_comments', 'qzone_feeds',
  'qzone_like', 'qzone_feed_comment', 'qzone_reply', 'qq_sing_song',
  'qq_set_signature',
]);

const files = fs.readdirSync(SRC).filter((f) => /^mcp-.*\.js$/.test(f));
const tools = [];
for (const f of files) {
  const text = fs.readFileSync(path.join(SRC, f), 'utf8');
  // server.tool(\n  'name',   或  server.tool('name',
  const nameRe = /server\.tool\(\s*\n?\s*'([a-zA-Z0-9_]+)'/g;
  let m;
  while ((m = nameRe.exec(text))) {
    const name = m[1];
    if (CURATED.has(name)) continue;
    if (tools.find((t) => t.name === name)) continue;
    // 尝试抓同一工具的描述首句，作为中文标签
    let label = '';
    try {
      const after = text.slice(m.index, m.index + 600);
      const dm = after.match(/server\.tool\(\s*\n?\s*'[a-zA-Z0-9_]+',\s*\n?\s*'([^']{2,120})'/);
      if (dm) {
        const first = String(dm[1]).split(/[。；;，,（(：:]/)[0].trim();
        if (first.length >= 2) label = first.slice(0, 16);
      }
    } catch { }
    tools.push({ name, label, file: f });
  }
}
tools.sort((a, b) => a.name.localeCompare(b.name));

const out = {
  generatedAt: new Date().toISOString(),
  count: tools.length,
  tools,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
console.log(`扫描 ${files.length} 个 MCP 文件，登记 ${tools.length} 个工具 -> ${path.basename(OUT)}`);
for (const t of tools) console.log('  ' + t.name + '  (' + t.file + ')');
