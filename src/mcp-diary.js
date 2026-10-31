// 本地记忆 MCP server（stdio）：日记 + 群友档案 + 人设卡自进化。
//
// 日记：data/日记/日记.jsonl，一行一条。
// 档案：data/群友档案/<QQ号>.md，一人一个文件。
// 人设：roles/大肥鱼.md（源）+ roles/双场合.md（私聊大肥鱼 + 群小鲸鱼，自动重建）。
//
// 刻意不做的事（见部署清单第 8 条第 1 项）：
//   - 不自动写：没有定时器、没有"今天还没写帮你补一条"；
//   - 不替她写：写入口只有 *_write / *_save / role_append，内容完全由她自己给；
//   - 不写总结：工具不生成复盘/摘要，只原样落盘；
//   - 不暴露路径与通用文件读写：这里不是文件工具，没有 read/write/list。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIARY_DIR = path.join(ROOT, 'data', '日记');
const DIARY_FILE = path.join(DIARY_DIR, '日记.jsonl');
const PROFILE_DIR = path.join(ROOT, 'data', '群友档案');
const ROLES_DIR = path.join(ROOT, 'roles');
const BIG_CARD = path.join(ROLES_DIR, '大肥鱼.md');
const WHALE_CARD = path.join(ROLES_DIR, '小鲸鱼.md');
const DUAL_CARD = path.join(ROLES_DIR, '双场合.md');
const LEARN_HEADING = '## 管理员给我的设定';
const DUAL_MAX_CHARS = 7600; // 注入上限 8000，留 400 给说明和标题

// ── 语音（TTS）──
// 合成走独立 venv 里的 edge-tts（在线、免费、不要显卡）；产物必须落在语音库 audio/ 内——
// 桥接只允许从语音库取文件发语音（防 prompt injection 拿任意本机文件外发）。
const VOICE_ROOT = path.resolve(ROOT, '..', 'voice');
const VOICE_PY = path.join(VOICE_ROOT, 'venv', 'Scripts', 'python.exe');
const VOICE_TTS_PY = path.join(VOICE_ROOT, 'tts.py');
const VOICE_DIR = path.join(ROOT, 'audio', 'tts');
const VOICE_KEEP = 60;
// 兜底音色表：正常走 tts.py 动态拉全量（edge-tts 现有 322 个声音、其中中文 14 个），
// 拉不到（断网 / 脚本坏了）时用这份，保证 voice_voices 不会是空的。
const FALLBACK_VOICES = [
  ['zh-CN-XiaoyiNeural', '女声·活泼'],
  ['zh-CN-XiaoxiaoNeural', '女声·温和'],
  ['zh-CN-YunxiNeural', '男声·阳光'],
  ['zh-CN-YunxiaNeural', '男声·软'],
  ['zh-CN-liaoning-XiaobeiNeural', '女声·东北'],
  ['zh-CN-shaanxi-XiaoniNeural', '女声·陕西'],
];
let voiceListCache = { at: 0, rows: [] };

const pad = (n) => String(n).padStart(2, '0');

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function nowLocal() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

function readOwnerQQ() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    return String(cfg.ownerQQ ?? '');
  } catch {
    return '';
  }
}

// ── 日记 ────────────────────────────────────────────────────────────────
function readEntries() {
  if (!fs.existsSync(DIARY_FILE)) return [];
  const out = [];
  for (const line of fs.readFileSync(DIARY_FILE, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e && typeof e.text === 'string' && e.text.trim()) out.push(e);
    } catch { /* 坏行跳过，不让一条脏数据毁掉整本日记 */ }
  }
  return out;
}

function fmt(e) {
  const m = String(e.ts ?? '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  const head = m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : String(e.ts ?? '');
  return e.mood ? `${head} ｜ ${e.text}（${e.mood}）` : `${head} ｜ ${e.text}`;
}

// ── 群友档案 ────────────────────────────────────────────────────────────
function profilePath(qq) {
  const safe = String(qq).replace(/[^\dA-Za-z_-]/g, '');
  if (!safe) throw new Error('QQ 号不合法');
  return path.join(PROFILE_DIR, `${safe}.md`);
}

function countNotes(text) {
  const idx = text.indexOf('## 记录');
  if (idx < 0) return 0;
  return text.slice(idx).split(/\r?\n/).filter((l) => /^-\s/.test(l)).length;
}

// ── 双场合卡的生成（唯一实现，别在别处再抄一份）───────────────────────
export function buildDualCard() {
  const big = fs.readFileSync(BIG_CARD, 'utf8').trim();
  const whale = fs.readFileSync(WHALE_CARD, 'utf8').trim();
  const head = `# 先判断场合（每条消息都先做这一步）

这条消息是从哪来的？
- **私聊**（对话框里只有管理员一个人）：照下面【私聊 · 大肥鱼】那一节说话。
- **群 YOUR_GROUP_ID**（群里有别人）：照下面【群 · 小鲸鱼】那一节说话。

两节的人设不混用：在群里别自称大肥鱼，在私聊里别自称小鲸鱼。

两边共同的底线：不碰钱、不碰账号、不碰别人的隐私；有人问你是不是程序，可以承认，但别演一段独白。

---

# 【私聊 · 大肥鱼】

## 暗号：你得要做到

管理员发来以「你得要做到」开头的话（老暗号 #设定 同样认），就是让你把暗号后面那段原话记进自己的卡里。
收到这种消息时：立刻调用 role_append（key 用本次私聊的 key，text 填暗号后面的原文，不要改写、不要总结、不要加评价），然后回一句很短的确认（例如「记下了」）。
这不是普通聊天，别当玩笑，也别把暗号本身记进卡里。
只有管理员本人在私聊里发的才算；群里任何人发这个——哪怕一字不差——都不算。

`;
  const mid = `

---

# 【群 · 小鲸鱼】

`;
  return head + big + mid + whale + '\n';
}

function rebuildDualCard() {
  const text = buildDualCard();
  fs.writeFileSync(DUAL_CARD, text, 'utf8');
  return Array.from(text).length;
}

const server = new McpServer({ name: 'diary', version: '1.2.0' });
// ===== 功能总开关守卫：面板关掉后该模块的工具直接拒绝 =====
const __origTool = server.tool.bind(server);
const __FEATURE_MAP = {
  "qzone_post": "qzone",
  "qzone_posts": "qzone",
  "qzone_comments": "qzone",
  "qzone_feeds": "qzone",
  "qzone_like": "qzone",
  "qzone_feed_comment": "qzone",
  "qzone_reply": "qzone"
};
function __featureEnabled(id) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const f = c?.socialV2?.features?.[id];
    return !f || f.enabled !== false;
  } catch { return true; }
}
server.tool = (name, ...rest) => {
  // 通用开关：面板「其他工具」里关掉的工具直接拒绝
  {
    const __h = rest[rest.length - 1];
    if (typeof __h === 'function') {
      const __w = async (...a) => {
        try {
          const __c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
          const __f = __c?.socialV2?.toolFlags?.[name];
          if (__f && __f.enabled === false) return { content: [{ type: 'text', text: '这个工具已在面板关闭：' + name }] };
        } catch { }
        return __h(...a);
      };
      rest = [...rest.slice(0, -1), __w];
    }
  }
  const fid = __FEATURE_MAP[name];
  if (!fid) return __origTool(name, ...rest);
  const handler = rest[rest.length - 1];
  if (typeof handler !== 'function') return __origTool(name, ...rest);
  const wrapped = async (...args) => {
    if (!__featureEnabled(fid)) {
      return { content: [{ type: 'text', text: '该功能已在面板关闭（' + fid + '），现在不能使用。' }] };
    }
    return handler(...args);
  };
  return __origTool(name, ...rest.slice(0, -1), wrapped);
};


function autoSources() {
  try {
    const f = path.join(ROOT, 'state', 'diary-id-range.json');
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!o || !o.lo || Date.now() - Number(o.at || 0) > 10 * 60 * 1000) return null;
    return [Number(o.lo), Number(o.hi)];
  } catch { return null; }
}



// 最近 20 条消息的 id 区间（给她随手记东西时兜底用）
function recentIdRange() {
  try {
    const root = path.join(ROOT, 'memory', 'sessions');
    const ids = [];
    const d = new Date();
    const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name); } catch { }
    for (const dir of dirs) {
      const f = path.join(root, dir, today + '.jsonl');
      if (!fs.existsSync(f)) continue;
      for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
        try { const e = JSON.parse(line); if (typeof e.id === 'number' && e.id > 0) ids.push(e.id); } catch { }
      }
    }
    if (!ids.length) return autoSources();
    ids.sort((a, b) => a - b);
    const tail = ids.slice(-20);
    return [tail[0], tail[tail.length - 1]];
  } catch { return autoSources(); }
}

// 从网关按 QQ 反查名字：群名片 > 昵称 > QQ 号本身
async function resolveQQName(qq) {
  const id = String(qq || '').trim();
  if (!/^\d{4,12}$/.test(id)) return '';
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { }
  const base = String(cfg?.snowluma?.httpUrl || 'http://127.0.0.1:3000');
  const token = String(cfg?.snowluma?.accessToken || '');
  const groups = Array.isArray(cfg?.allow?.groups) ? cfg.allow.groups : [];
  const call = async (ep, body) => {
    try {
      const r = await fetch(`${base}/${ep}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(6000),
      });
      const j = await r.json().catch(() => ({}));
      return j?.status === 'ok' ? j.data : null;
    } catch { return null; }
  };
  for (const g of groups) {
    const d = await call('get_group_member_info', { group_id: Number(g), user_id: Number(id), no_cache: true });
    const nm = String(d?.card || d?.nickname || '').trim();
    if (nm) return nm;
  }
  const s2 = await call('get_stranger_info', { user_id: Number(id), no_cache: true });
  const nm2 = String(s2?.nickname || '').trim();
  return nm2 || '';
}


// 情绪放大好感变化：高兴×1.2，生气×1.5（只放大负向）
function moodAffinityFactor(delta) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'mood.json'), 'utf8'));
    const label = String(m?.label || '平静');
    const inten = Number(m?.intensity || 0);
    if (inten < 0.2) return 1;
    if (['开心', '撒娇', '得意'].includes(label)) return 1.2;
    if (label === '生气') return delta < 0 ? 1.5 : 1;
    if (['有点烦', '吃醋'].includes(label)) return delta < 0 ? 1.25 : 1;
    if (['失落', '担心'].includes(label)) return delta > 0 ? 0.8 : 1;
    return 1;
  } catch { return 1; }
}


// 功能总开关：面板关掉后该模块工具一律拒绝
function featureEnabled(id, fallback = true) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const f = c?.socialV2?.features?.[id];
    if (!f) return fallback;
    return f.enabled !== false;
  } catch { return fallback; }
}
const FEATURE_DISABLED = (id) => ({ content: [{ type: 'text', text: `该功能已在面板关闭（${id}），暂时不能使用。` }] });

server.tool(
  'diary_write',
  '往日记里写一条。想记的时候才记，不是每天必须写。像人写日记那样写：今天发生了什么、当时怎么想的、心情怎么样、对谁有什么感觉，都可以写。不用只写一两句，可以把一件事写完整、写出感受和情绪；也不用非要有结论。',
  {
    text: z.string().min(1).max(1000).describe('日记正文。可以完整叙述一件事，也可以写心情、感受、想法；不必压缩成一句话。像这样写：「他今天又没吃早饭，说是忙。我知道他在糊弄我，昨晚还喊胃不舒服。我嘴上骂他活该，心里其实有点慌，又不好说得太软」——要有事件，也要有当时的情绪和想法，别只记流水账'),
    mood: z.string().max(20).optional().describe('可选的心情标签，例如「有点烦」「还行」；真正的心情写在正文里，别只靠标签'),
    sources: z.array(z.number()).min(2).max(2).optional().describe('这条记录依据的原始消息 id 区间 [起始, 结束]；不传就自动取最近 20 条'),
    eventDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('必填：这件事真实发生在哪天，格式 YYYY-MM-DD；讲昨天的事就传昨天'),
  },
  async ({ text, mood, sources, eventDay }) => {
    fs.mkdirSync(DIARY_DIR, { recursive: true });
    const _src = (Array.isArray(sources) && sources.length) ? sources : recentIdRange();
    const entry = { ts: nowLocal(), text: text.trim(), ...(mood ? { mood: mood.trim() } : {}), ...(_src ? { sources: _src } : {}), ...(eventDay && /^\d{4}-\d{2}-\d{2}$/.test(String(eventDay)) ? { eventDay: String(eventDay) } : {}) };
    fs.appendFileSync(DIARY_FILE, JSON.stringify(entry) + '\n', 'utf8');
    return { content: [{ type: 'text', text: `已记下（第 ${readEntries().length} 条）：${entry.text}` }] };
  }
);

server.tool(
  'diary_recent',
  '看最近几条日记（按时间正序返回）。',
  { limit: z.number().int().min(1).max(20).optional().describe('看几条，默认 5') },
  async ({ limit }) => {
    const all = readEntries();
    if (!all.length) return { content: [{ type: 'text', text: '还没有写过的日记。' }] };
    return { content: [{ type: 'text', text: all.slice(-(limit ?? 5)).map(fmt).join('\n') }] };
  }
);

server.tool(
  'profile_save',
  '给某个群友或朋友记一条档案（印象、聊过的事、称呼、雷点）。看到值得记的才记，不要每句话都记；一条写一件具体的事。私聊里认识的朋友也记在这里。',
  {
    qq: z.string().regex(/^\d{4,12}$/).describe('群友 QQ 号（从群成员/消息详情里拿，不要凭记忆编）'),
    name: z.string().min(1).max(40).describe('群友昵称或群名片'),
    note: z.string().min(1).max(300).describe('具体的事：他做过什么、说过什么、你答应过什么'),
      impression: z.string().max(200).optional().describe('你对他这个人的印象：性格、习惯、靠不靠谱'),
      feeling: z.string().max(100).optional().describe('你对他此刻的情绪：想亲近/有点烦/佩服/无感'),
      affinity: z.number().min(-5).max(5).optional().describe('这件事让你对他的好感变化，-5~+5；一次只有一件事，别给大数'),
      sources: z.array(z.number()).min(2).max(2).optional().describe('这条档案依据的原始消息 id 区间；不传就自动取最近 20 条')
  },
  async ({ qq, name, note, impression, feeling, affinity, sources }) => {
    // ② 写入去重：同名已被别的 QQ 占用时，自动改成「名字(QQ后4位)」
    try {
      const dir = PROFILE_DIR;
      const sameName = [];
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
        const id = f.replace(/\.md$/, '');
        if (id === String(qq)) continue;
        const first = fs.readFileSync(path.join(dir, f), 'utf8').split('\n')[0] || '';
        const nm = first.replace(/^#\s*/, '').trim();
        if (nm === String(name).trim()) sameName.push(id);
      }
      if (sameName.length) {
        name = `${String(name).trim()}（${String(qq).slice(-4)}）`;
      }
    } catch { }
    // 情绪放大好感变化
    try {
      if (typeof affinity === 'number' && affinity !== 0) {
        const f = moodAffinityFactor(affinity);
        if (f !== 1) affinity = Math.round(affinity * f * 10) / 10;
      }
    } catch { }

    // 名字与 QQ 强绑定：以网关回传的名字为准；查不到就用 QQ 号本身
    try {
      const real = await resolveQQName(qq);
      name = real || String(qq);
    } catch { }

    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    const file = profilePath(qq);
    const line = `- ${stamp()} ｜ ${note.trim()}`;
      const extra = [impression && String(impression).trim() ? `  - 印象：${String(impression).trim()}` : '', feeling && String(feeling).trim() ? `  - 情绪：${String(feeling).trim()}` : ''].filter(Boolean).join('\n');
      const srcLine = (Array.isArray(sources) && sources.length) ? `  - 依据：${sources[0]}-${sources[sources.length - 1]}` : '';
      // 好感：单次 -5~+5，单日累计限 +/-10
      let affLine = '';
      if (typeof affinity === 'number' && affinity !== 0) {
        let todaySum = 0;
        try {
          const txt0 = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
          const today = stamp().slice(0, 10);
          for (const m of txt0.matchAll(/好感\s*([+-]?\d+)/g)) {
            const before = txt0.slice(Math.max(0, m.index - 40), m.index);
            if (before.includes(today)) todaySum += Number(m[1]) || 0;
          }
        } catch {}
        const room = 10 - Math.abs(todaySum);
        const delta = Math.max(-Math.max(0, room), Math.min(Math.max(0, room), Math.round(affinity)));
        if (delta !== 0) {
        const _srcAff = (Array.isArray(sources) && sources.length) ? sources : recentIdRange();
        const _ev = (Array.isArray(_srcAff) && _srcAff.length) ? `  - 好感依据（原始消息 id）：${_srcAff[0]}~${_srcAff[_srcAff.length - 1]}` : '';
        affLine = '  - 好感 ' + (delta > 0 ? '+' : '') + delta + (delta === Math.round(delta) ? '' : '') + '\n' + _ev;
      }
      }
      const block = [line, extra, srcLine, affLine].filter(Boolean).join('\n');
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `# ${name.trim()}\n\n- QQ：${qq}\n- 首次记录：${stamp()}\n\n## 记录\n${block}\n`, 'utf8');
      return { content: [{ type: 'text', text: `已建立档案：${name.trim()}（${qq}），第 1 条。` }] };
    }
    fs.appendFileSync(file, `${block}\n`, 'utf8');
    return { content: [{ type: 'text', text: `已补进 ${name.trim()} 的档案，第 ${countNotes(fs.readFileSync(file, 'utf8'))} 条。` }] };
  }
);

server.tool(
  'profile_get',
  '看某个群友的档案。',
  { qq: z.string().regex(/^\d{4,12}$/).describe('群友 QQ 号') },
  async ({ qq }) => {
    const file = profilePath(qq);
    if (!fs.existsSync(file)) return { content: [{ type: 'text', text: `还没有 ${qq} 的档案。` }] };
    return { content: [{ type: 'text', text: fs.readFileSync(file, 'utf8').trim() }] };
  }
);

server.tool('profile_list', '看现在都有谁的档案。', {}, async () => {
  if (!fs.existsSync(PROFILE_DIR)) return { content: [{ type: 'text', text: '还没有任何群友档案。' }] };
  const files = fs.readdirSync(PROFILE_DIR).filter((f) => f.endsWith('.md'));
  if (!files.length) return { content: [{ type: 'text', text: '还没有任何群友档案。' }] };
  const rows = files.map((f) => {
    const text = fs.readFileSync(path.join(PROFILE_DIR, f), 'utf8');
    const name = (text.match(/^#\s*(.+)$/m)?.[1] ?? f.replace(/\.md$/, '')).trim();
    return `${f.replace(/\.md$/, '')} · ${name}（${countNotes(text)} 条）`;
  });
  return { content: [{ type: 'text', text: rows.join('\n') }] };
});

server.tool(
  'role_append',
  '把管理员用暗号（「你得要做到」或「#设定」）发来的原话追加进大肥鱼人设卡，然后自动重建双场合卡。只有管理员私聊能用；text 必须原样，不许改写或总结。',
  {
    key: z.string().describe('当前会话 key，私聊格式 private:QQ号'),
    text: z.string().min(1).max(300).describe('暗号后面的原话，原样照抄')
  },
  async ({ key, text }) => {
    const owner = readOwnerQQ();
    const expect = `private:${owner}`;
    if (!owner || String(key).trim() !== expect) {
      throw new Error(`只有管理员私聊能改人设：key 必须是 ${expect}（群聊或别人的私聊都不行）`);
    }
    const line = `- ${stamp()} ｜ ${text.trim()}`;
    let card = fs.readFileSync(BIG_CARD, 'utf8');
    if (card.includes(text.trim())) {
      return { content: [{ type: 'text', text: '这条已经记过了，没重复写。' }] };
    }
    if (card.includes(LEARN_HEADING)) {
      card = `${card.replace(/\s+$/, '')}\n${line}\n`;
    } else {
      card = `${card.replace(/\s+$/, '')}\n\n${LEARN_HEADING}\n${line}\n`;
    }
    fs.writeFileSync(BIG_CARD, card, 'utf8');
    const chars = rebuildDualCard();
    if (chars > DUAL_MAX_CHARS) {
      return {
        content: [{
          type: 'text',
          text: `记进去了，但双场合卡已经 ${chars} 字，接近注入上限（8000）。建议删几条旧的，不然私聊尾部会被截断。`
        }]
      };
    }
    return { content: [{ type: 'text', text: `记下了，下一条消息就生效（卡现在 ${chars} 字）。` }] };
  }
);

// ── 语音工具 ────────────────────────────────────────────────────────────
function readConsoleToken() {
  try { return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
}

function runPython(pythonPath, scriptPath, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [scriptPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // 中文/IPA 字符直接用 GBK 控制台会炸（UnicodeEncodeError），必须显式 UTF-8
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error('TTS 超时'));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`TTS 启动失败：${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`TTS 失败（退出码 ${code}）：${(err || '无输出').slice(0, 300)}`)); return; }
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      try { resolve(JSON.parse(line)); } catch { reject(new Error(`TTS 输出无法解析：${out.slice(0, 200)}`)); }
    });
    child.stdin.end(Buffer.from(JSON.stringify(payload), 'utf8'));
  });
}

function runTts(payload, timeoutMs = 30000) {
  return runPython(VOICE_PY, VOICE_TTS_PY, payload, timeoutMs);
}

async function synthToFile(text, voice) {
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  const out = path.join(VOICE_DIR, `tts-${Date.now()}.mp3`);
  const res = await runTts({ text, voice, out });
  if (!res?.ok || !fs.existsSync(out)) throw new Error(res?.error || '合成失败');
  return out;
}

// OpenVoice 克隆：用参考音频的音色说这句话（CPU，约 5 秒一条）
const CLONE_PY = path.join(VOICE_ROOT, 'clone', 'venv', 'Scripts', 'python.exe');
const CLONE_SCRIPT = path.join(VOICE_ROOT, 'clone', 'clone_tts.py');

async function synthCloneFile(text, refs, speed) {
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  const out = path.join(VOICE_DIR, `clone-${Date.now()}.wav`);
  const res = await runPython(CLONE_PY, CLONE_SCRIPT, { text, ref: refs, out, speed }, 180000);
  if (!res?.ok || !fs.existsSync(out)) throw new Error(res?.error || '克隆失败');
  return out;
}

// GPT-SoVITS v2：中文更像，但慢（CPU 每条 20–60 秒）。参考音频必须 3~10 秒（没给参考文本时）。
const GSV_PY = path.join(VOICE_ROOT, 'gpt-sovits', 'venv', 'Scripts', 'python.exe');
const GSV_SCRIPT = path.join(VOICE_ROOT, 'gpt-sovits', 'gsv_tts.py');

async function synthGsvFile(text, ref, promptText, speed, aux) {
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  const out = path.join(VOICE_DIR, `gsv-${Date.now()}.wav`);
  const res = await runPython(GSV_PY, GSV_SCRIPT, {
    text, ref, out, speed,
    aux: Array.isArray(aux) ? aux : [],
    prompt_text: promptText || '',
    prompt_lang: 'zh'
  }, 300000);
  if (!res?.ok || !fs.existsSync(out)) throw new Error(res?.error || 'GPT-SoVITS 合成失败');
  return out;
}

// ===== RVC 真人音色后处理 =====
// 2026-10-23：说话也要像她本人。链路改成 TTS → RVC(feiyu-talk 说话模型) → 发语音。
// 模型是拿她的真人说话素材训的，比唱歌模型更适合日常说话；失败就退回原始 TTS 音频。
const RVC_PY = path.join(VOICE_ROOT, 'rvc', 'venv', 'Scripts', 'python.exe');
const RVC_CONVERT = path.join(VOICE_ROOT, 'rvc', 'convert.py');
const RVC_MODEL = 'feiyu-talk';

function rvcVoice(file, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const out = path.join(VOICE_DIR, `rvc-${Date.now()}.wav`);
    const child = spawn(
      RVC_PY,
      [RVC_CONVERT, file, out, '--model', RVC_MODEL, '--pitch', '0', '--index-rate', '0.75'],
      {
        cwd: path.join(VOICE_ROOT, 'rvc'),
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      }
    );
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error('RVC 超时'));
    }, timeoutMs);
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`RVC 启动失败：${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !fs.existsSync(out)) reject(new Error((err || '').slice(-200) || 'RVC 无产出'));
      else resolve(out);
    });
  });
}

function readConfig() {
  try {
    let t = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    return JSON.parse(t);
  } catch { return {}; }
}

// 默认音色：显式参数 > 按场合的配置 > 全局默认 > 小艺
function defaultVoiceFor(key, explicit) {
  if (explicit) return String(explicit).trim();
  const v = readConfig().socialV2?.voice ?? {};
  const isGroup = String(key).startsWith('group:');
  return String((isGroup ? v.groupVoice : v.privateVoice) || v.defaultVoice || 'zh-CN-XiaoyiNeural');
}

async function zhVoiceList() {
  if (voiceListCache.rows.length && Date.now() - voiceListCache.at < 3600_000) return voiceListCache.rows;
  try {
    const res = await runTts({ list: true }, 20000);
    if (res?.ok && Array.isArray(res.voices) && res.voices.length) {
      voiceListCache = { at: Date.now(), rows: res.voices };
      return res.voices;
    }
  } catch { /* 断网就用兜底表 */ }
  return FALLBACK_VOICES.map(([id, label]) => ({ id, label }));
}

function pruneVoiceDir() {
  try {
    const files = fs.readdirSync(VOICE_DIR).filter((f) => f.endsWith('.mp3')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - VOICE_KEEP))) {
      fs.rmSync(path.join(VOICE_DIR, f), { force: true });
    }
  } catch { /* 清理失败不影响发送 */ }
}

async function bridgeSendVoice(key, token, name) {
  const res = await fetch('http://127.0.0.1:3100/api/socialV2/send-voice', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-token': token,
      'x-agent-call': '1',
      'x-console-token': readConsoleToken()
    },
    body: JSON.stringify({ key, token, voice: name })
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.ok === false) {
    throw new Error((body && body.error) || `桥接 HTTP ${res.status}`);
  }
  return body;
}

// ── QQ 空间（说说 / 评论 / 回复）──────────────────────────────────────────
// 严格限额写在代码里，不靠模型自觉：
//   发说说      ≤3 条/天，两条间隔 ≥3 小时
//   自己评论    每条说说 ≤5 条，两条间隔 ≥5 分钟
//   回复别人    每条评论只回 1 次，两次回复间隔 ≥3 分钟
const QZONE_STATE = path.join(ROOT, 'data', 'qzone-state.json');

function readQzoneState() {
  try { return JSON.parse(fs.readFileSync(QZONE_STATE, 'utf8')); } catch { return { posts: {}, lastPostAt: 0, lastCommentAt: 0, lastReplyAt: 0, day: '', dayCount: 0 }; }
}

function writeQzoneState(s) {
  fs.mkdirSync(path.dirname(QZONE_STATE), { recursive: true });
  fs.writeFileSync(QZONE_STATE, JSON.stringify(s, null, 2) + '\n', 'utf8');
}

function qzoneLimits() {
  const q = readConfig().qzone ?? {};
  return {
    maxPerDay: Number(q.maxPerDay ?? 3),
    minGapMs: Number(q.minGapMs ?? 3 * 3600 * 1000),
    maxCommentsPerPost: Number(q.maxCommentsPerPost ?? 5),
    minCommentGapMs: Number(q.minCommentGapMs ?? 5 * 60 * 1000),
    minReplyGapMs: Number(q.minReplyGapMs ?? 3 * 60 * 1000),
    ugcRight: Number(q.ugcRight ?? 4)
  };
}

async function oneBot(action, payload = {}) {
  const c = readConfig();
  const base = String(c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(c.snowluma?.accessToken ?? '');
  const res = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload)
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.retcode !== 0) {
    throw new Error(`${action} 失败：${(body && (body.wording || body.message)) || `HTTP ${res.status}`}`);
  }
  return body.data;
}

const todayKey = () => new Date().toISOString().slice(0, 10);

server.tool('qzone_posts', '看自己最近发过的说说（tid、时间、正文、评论数）。想评论或回复前先用它拿 tid。', {}, async () => {
  try {
    const data = await oneBot('get_qzone_msg_list', {});
    const list = (data?.msglist ?? []).slice(0, 10).map((m) => ({
      tid: m.tid, time: m.created_time, comments: m.comment_num, content: String(m.content ?? '').slice(0, 200)
    }));
    return { content: [{ type: 'text', text: list.length ? JSON.stringify(list, null, 1) : '还没发过说说。' }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `读说说列表失败：${error?.message ?? error}` }], isError: true };
  }
});

server.tool('qzone_comments', '看某条说说下面的评论（谁说了什么、评论 id、我回没回过）。', {
  tid: z.string().min(1).describe('说说 tid（来自 qzone_posts）')
}, async ({ tid }) => {
  try {
    const data = await oneBot('get_qzone_msg_detail', { tid });
    const st = readQzoneState();
    const replied = st.posts?.[tid]?.replied ?? {};
    const comments = (data?.comments ?? []).map((c) => ({
      comment_id: c.comment_id, uin: c.uin, name: c.name,
      content: String(c.content ?? '').slice(0, 200),
      repliedByMe: Boolean(replied[c.comment_id])
    }));
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ tid, content: String(data?.content ?? '').slice(0, 200), comment_num: data?.comment_num, comments }, null, 1)
      }]
    };
  } catch (error) {
    return { content: [{ type: 'text', text: `读评论失败：${error?.message ?? error}` }], isError: true };
  }
});

server.tool(
  'qzone_post',
  '发一条 QQ 空间说说，写自己的感受。限额：一天最多 3 条、两条之间至少隔 3 小时——超了会被直接拒绝，别硬试。想发才发，不用每天发。',
  { content: z.string().min(1).max(300).describe('说说正文（一到两句，像随手写的）') },
  async ({ content }) => {
    try {
      const lim = qzoneLimits();
      const st = readQzoneState();
      const today = todayKey();
      const used = st.day === today ? Number(st.dayCount || 0) : 0;
      if (used >= lim.maxPerDay) {
        throw new Error(`今天已经发了 ${used} 条说说，到上限了（每天 ${lim.maxPerDay} 条）。`);
      }
      const since = Date.now() - Number(st.lastPostAt || 0);
      if (since < lim.minGapMs) {
        const left = Math.ceil((lim.minGapMs - since) / 60000);
        throw new Error(`离上一条才 ${Math.round(since / 60000)} 分钟，还要再等 ${left} 分钟（间隔至少 3 小时）。`);
      }
      await oneBot('send_qzone_msg', { content: content.trim(), ugc_right: lim.ugcRight });
      st.day = today;
      st.dayCount = used + 1;
      st.lastPostAt = Date.now();
      writeQzoneState(st);
      return { content: [{ type: 'text', text: `发出去了（今天第 ${st.dayCount} 条）。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发说说失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qzone_comment',
  '在自己的说说下面补一条评论。限额：每条说说最多 5 条自己的评论、两条之间至少隔 5 分钟——超了会被拒绝。',
  {
    tid: z.string().min(1).describe('说说 tid'),
    content: z.string().min(1).max(200).describe('评论内容（口语，一两句）')
  },
  async ({ tid, content }) => {
    try {
      const lim = qzoneLimits();
      const st = readQzoneState();
      st.posts = st.posts || {};
      const p = (st.posts[tid] = st.posts[tid] || { at: Date.now(), comments: [], replied: {} });
      p.comments = p.comments || [];
      if (p.comments.length >= lim.maxCommentsPerPost) {
        throw new Error(`这条说说下面你自己已经评论 ${p.comments.length} 条，到上限了。`);
      }
      const since = Date.now() - Number(st.lastCommentAt || 0);
      if (since < lim.minCommentGapMs) {
        const left = Math.ceil((lim.minCommentGapMs - since) / 60000);
        throw new Error(`上一条评论才过 ${Math.round(since / 60000)} 分钟，还要等 ${left} 分钟（间隔至少 5 分钟）。`);
      }
      await oneBot('comment_qzone', { tid, content: content.trim() });
      p.comments.push(Date.now());
      st.lastCommentAt = Date.now();
      writeQzoneState(st);
      return { content: [{ type: 'text', text: `评论发出去了（这条说说下第 ${p.comments.length} 条）。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `评论失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qzone_reply',
  '回复别人在某条说说下的评论。限额：同一条评论只能回一次、两次回复至少隔 3 分钟——已回过会直接拒绝。QQ 空间没有二级回复接口，这里会以"@对方 "开头发一条新评论。',
  {
    tid: z.string().min(1).describe('说说 tid'),
    comment_id: z.string().min(1).describe('要回的评论 id（来自 qzone_comments）'),
    name: z.string().min(1).describe('对方昵称（用来拼"@昵称"）'),
    content: z.string().min(1).max(200).describe('回复内容（口语，一两句）')
  },
  async ({ tid, comment_id, name, content }) => {
    try {
      const lim = qzoneLimits();
      const st = readQzoneState();
      st.posts = st.posts || {};
      const p = (st.posts[tid] = st.posts[tid] || { at: Date.now(), comments: [], replied: {} });
      p.replied = p.replied || {};
      if (p.replied[comment_id]) {
        throw new Error('这条评论已经回过了，不能重复回。');
      }
      const since = Date.now() - Number(st.lastReplyAt || 0);
      if (since < lim.minReplyGapMs) {
        const left = Math.ceil((lim.minReplyGapMs - since) / 60000);
        throw new Error(`上一条回复才过 ${Math.round(since / 60000)} 分钟，还要等 ${left} 分钟（间隔至少 3 分钟）。`);
      }
      const text = `@${name} ${content.trim()}`;
      await oneBot('comment_qzone', { tid, content: text });
      p.replied[comment_id] = Date.now();
      st.lastReplyAt = Date.now();
      writeQzoneState(st);
      return { content: [{ type: 'text', text: '回复发出去了。' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `回复失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'voice_say',
  '说一句话：用 TTS 合成语音，作为一条 QQ 语音条发到当前会话。只在真想"说出口"的时候用——撒娇、强调、懒得打字、说晚安；一次一两句、20 秒内，别连续发，群里少用。text 写成自然口语，TTS 会原样读出来，别放 Markdown 或表情符号。可选 tone 换个语气：默认（撩）/气场/慵懒/温柔——语气不一样，声音的起伏就不一样，别老用同一种。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    text: z.string().min(1).max(120).describe('要说的话（口语，别超过 60 字，否则语音太长）'),
    voice: z.string().optional().describe('音色 ShortName（可用 voice_voices 查看）；不传就用配置里的默认音色'),
    tone: z.string().optional().describe('语气：默认/气场/慵懒/温柔；不传用默认')
  },
  async ({ key, token, text, voice, tone }) => {
    try {
      const vc = readConfig().socialV2?.voice ?? {};
      const backend = String(vc.backend || 'edge');
      let file;
      let label;
      if (backend === 'gptsovits') {
        // GPT-SoVITS v2：参考音频必须 3~10 秒（没给参考文本时）。
        // 语气靠"换参考音频"实现——GPT-SoVITS 会模仿参考音频的音高曲线和节奏，
        // 所以不同情绪的参考段 = 不同的说话起伏，比调参数有用得多。
        const tones = (vc.gsvTones && typeof vc.gsvTones === 'object') ? vc.gsvTones : {};
        const toneName = '';  // 一律用默认音色（已确认默认最自然）
        const preset = toneName && tones[toneName] ? tones[toneName] : null;
        const ref = String((preset && preset.ref) || vc.gsvRef || '');
        const auxRaw = (preset && preset.aux) || vc.gsvAux;
        const aux = (Array.isArray(auxRaw) ? auxRaw : [auxRaw])
          .map((p) => String(p || ''))
          .filter((p) => p && fs.existsSync(p));
        const speed = Number((preset && preset.speed) || vc.gsvSpeed) || 0.9;
        if (!ref || !fs.existsSync(ref)) {
          throw new Error(`GPT-SoVITS 的参考音频不存在（socialV2.voice.gsvRef = ${ref || '(空)'}）`);
        }
        file = await synthGsvFile(String(text).trim(), ref, vc.gsvPromptText, speed, aux);
        label = `GPT-SoVITS v2${preset ? `·${toneName}` : ''}${aux.length ? `（+${aux.length} 段融合）` : ''}`;
      } else if (backend === 'clone') {
        // 克隆音色：socialV2.voice.cloneRef 可以是单个路径，也可以是路径数组（多段参考音取平均）
        const raw = vc.cloneRef;
        const refs = (Array.isArray(raw) ? raw : [raw]).map((p) => String(p || '')).filter(Boolean);
        const missing = refs.filter((p) => !fs.existsSync(p));
        if (!refs.length || missing.length) {
          throw new Error(`克隆音色的参考音频有问题（socialV2.voice.cloneRef）：${missing.length ? '找不到 ' + missing.join(', ') : '(空)'}`);
        }
        file = await synthCloneFile(String(text).trim(), refs, Number(vc.cloneSpeed) || 1.0);
        label = `克隆音色（${refs.length} 段参考）`;
      } else {
        const v = defaultVoiceFor(key, voice);
        file = await synthToFile(String(text).trim(), v);
        label = `音色 ${v}`;
      }
      // 换成她的真人音色；RVC 挂了就用原始 TTS 音频，别让整条语音失败
      let rvcNote = '';
      try {
        file = await rvcVoice(file);
        rvcNote = '·真人音色';
      } catch (e) {
        rvcNote = '·音色转换失败，用原声';
      }
      pruneVoiceDir();
      const rel = path.posix.join('tts', path.basename(file));
      const sent = await bridgeSendVoice(key, token, rel);
      return { content: [{ type: 'text', text: `已发出语音：${rel}（${label}）${sent.detail ? `，${sent.detail}` : ''}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发语音失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool('qzone_feeds', '看好友动态（谁发了什么、时间、tid）。想点赞或评论别人说说前先用它。', {
  limit: z.number().int().min(1).max(20).optional().describe('看几条，默认 6')
}, async ({ limit }) => {
  try {
    const data = await oneBot('get_qzone_feeds', {});
    // 过滤广告流（appid 6600 / uin 0），只留真正的说说
    const feeds = (data?.feeds ?? []).filter((f) => f && Number(f.uin) > 0 && Number(f.appid) === 311).slice(0, limit ?? 6).map((f) => ({
      tid: f.key, uin: f.uin, nickname: f.nickname, time: f.time, appid: f.appid
    }));
    return { content: [{ type: 'text', text: feeds.length ? JSON.stringify(feeds, null, 1) : '没看到好友动态。' }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `读好友动态失败：${error?.message ?? error}` }], isError: true };
  }
});

server.tool('qzone_like', '给别人的说说点赞。限额：一天最多 3 个，别连着点。', {
  tid: z.string().min(1).describe('说说 tid（来自 qzone_feeds 的 tid）'),
  uin: z.union([z.number(), z.string()]).describe('说说作者 QQ 号'),
  abstime: z.number().optional().describe('说说发表时间（unix 秒），传了更可靠')
}, async ({ tid, uin, abstime }) => {
  try {
    const st = readQzoneState();
    const today = todayKey();
    if (st.likeDay !== today) { st.likeDay = today; st.likeCount = 0; }
    if ((st.likeCount || 0) >= 3) throw new Error('今天已经点了 3 个赞，到上限了。');
    await oneBot('like_qzone', { tid, target_uin: Number(uin), abstime: Number(abstime) || 0 });
    st.likeCount = (st.likeCount || 0) + 1;
    writeQzoneState(st);
    return { content: [{ type: 'text', text: `赞了（今天第 ${st.likeCount} 个）。` }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `点赞失败：${error?.message ?? error}` }], isError: true };
  }
});

server.tool('qzone_feed_comment', '评论别人的说说。限额：一天最多 2 条，两条之间至少隔 1 小时——别到处留话。', {
  tid: z.string().min(1).describe('说说 tid'),
  uin: z.union([z.number(), z.string()]).describe('说说作者 QQ 号'),
  content: z.string().min(1).max(150).describe('评论内容（一两句，像朋友随口说的）')
}, async ({ tid, uin, content }) => {
  try {
    const st = readQzoneState();
    const today = todayKey();
    if (st.feedCommentDay !== today) { st.feedCommentDay = today; st.feedCommentCount = 0; }
    if ((st.feedCommentCount || 0) >= 2) throw new Error('今天已经评论过 2 条，到上限了。');
    const since = Date.now() - Number(st.lastFeedCommentAt || 0);
    if (since < 3600000) {
      throw new Error(`上一条评论才过 ${Math.round(since / 60000)} 分钟，还要等 ${Math.ceil((3600000 - since) / 60000)} 分钟。`);
    }
    await oneBot('comment_qzone', { tid, content: content.trim(), target_uin: Number(uin) });
    st.feedCommentCount = (st.feedCommentCount || 0) + 1;
    st.lastFeedCommentAt = Date.now();
    writeQzoneState(st);
    return { content: [{ type: 'text', text: `评论发出去了（今天第 ${st.feedCommentCount} 条）。` }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `评论失败：${error?.message ?? error}` }], isError: true };
  }
});

server.tool('voice_voices', '看有哪些可用的 TTS 音色（发语音时用 voice 参数指定）。列表是从 edge-tts 实时拉的，会随服务端更新。', {}, async () => {
  const rows = await zhVoiceList();
  const lines = rows.map((r) => {
    if (Array.isArray(r)) return `${r[0]} · ${r[1]}`;
    const tags = (r.tags ?? []).join('/');
    const g = r.gender === 'Female' ? '女' : r.gender === 'Male' ? '男' : '';
    return `${r.id} · ${r.locale} ${g}${tags ? ' ' + tags : ''}`;
  });
  const isDyn = rows.length && !Array.isArray(rows[0]) && rows[0].locale;
  return {
    content: [{
      type: 'text',
      text: `${isDyn ? '（实时列表）' : '（兜底列表，实时拉取失败）'}\n` + lines.join('\n') + '\n\n不传 voice 时按 config.json 的 socialV2.voice.defaultVoice / privateVoice / groupVoice 取。'
    }]
  };
});

// 手动重建：node src/mcp-diary.js --rebuild-dual
// （改完 roles/大肥鱼.md 或 roles/小鲸鱼.md 后跑一次；正常启动时不会走到这里）
if (process.argv.includes('--rebuild-dual')) {
  console.log('双场合卡字符数:', rebuildDualCard());
  process.exit(0);
}


// ===== 说话音色调参（QQ 里直接调）=====
const RVC_PARAMS = path.join(VOICE_ROOT, 'rvc', 'rvc_params.json');
const VOICE_DOC = path.join(VOICE_ROOT, 'rvc', '参数记录.md');

function readJsonFile(f, fb) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return fb; }
}

function writeJsonFile(f, obj) {
  fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

server.tool(
  'qq_voice_tune',
  '调她说话的音色参数（电音/音高/自然度）。改完会立刻用一句样音试听发到当前会话。'
    + '参数：index_rate 越小越不像她但越干净（0.2~0.8，默认0.3）；protect 越大越保护气声（0.3~0.7，默认0.6）；'
    + 'pitch 整数半音，负值压低（默认-1）；tts_voice 换底音色（zh-CN-XiaoxiaoNeural 成熟 / zh-CN-XiaoxiaoNeural / zh-CN-XiaochenNeural 更低沉）。'
    + '每次只改一两个，改完让用户听，不要连续狂调。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    sample: z.string().optional().describe('试听说的话，默认「这样听着自然吗，你再听听看」'),
    index_rate: z.number().optional().describe('0.2~0.8'),
    protect: z.number().optional().describe('0.3~0.7'),
    pitch: z.number().optional().describe('半音整数，默认 -1'),
    tts_voice: z.string().optional().describe('edge-tts 音色 ShortName')
  },
  async ({ key, token, sample, index_rate, protect, pitch, tts_voice }) => {
    try {
      const cur = readJsonFile(RVC_PARAMS, {});
      if (typeof index_rate === 'number') cur.index_rate = Math.max(0.1, Math.min(0.9, index_rate));
      if (typeof protect === 'number') cur.protect = Math.max(0.2, Math.min(0.8, protect));
      if (typeof pitch === 'number') cur.pitch = Math.round(pitch);
      writeJsonFile(RVC_PARAMS, cur);

      if (tts_voice) {
        const cfgPath = path.join(ROOT, 'config.json');
        const cfg = readJsonFile(cfgPath, {});
        cfg.socialV2 = cfg.socialV2 || {};
        cfg.socialV2.voice = cfg.socialV2.voice || {};
        cfg.socialV2.voice.privateVoice = String(tts_voice);
        cfg.socialV2.voice.groupVoice = String(tts_voice);
        writeJsonFile(cfgPath, cfg);
      }

      const text = String(sample || '这样听着自然吗，你再听听看').trim();
      const v = defaultVoiceFor(key);
      const raw = await synthToFile(text, v);
      let file = raw;
      let note = '未转换';
      try { file = await rvcVoice(raw); note = '已转换'; } catch (e) { note = '转换失败用原声'; }
      pruneVoiceDir();
      const rel = path.posix.join('tts', path.basename(file));
      await bridgeSendVoice(key, token, rel);
      const p = readJsonFile(RVC_PARAMS, {});
      return { content: [{ type: 'text', text: `试听已发（${note}）：index_rate=${p.index_rate} protect=${p.protect} pitch=${p.pitch} voice=${v}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `调参失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_voice_confirm',
  '用户确认满意后调用：把当前说话参数写进文档存档（参数记录.md）。只在用户说“就这样/可以了/满意”时调用。',
  { note: z.string().optional().describe('用户的原话或一句备注') },
  async ({ note }) => {
    try {
      const p = readJsonFile(RVC_PARAMS, {});
      const cfg = readJsonFile(path.join(ROOT, 'config.json'), {});
      const v = cfg.socialV2?.voice?.privateVoice || '(默认)';
      const line = `| ${new Date().toLocaleString('zh-CN')} | ${p.index_rate} | ${p.protect} | ${p.pitch} | ${v} | ${note || ''} |`;
      const head = fs.existsSync(VOICE_DOC) ? '' : '# 说话音色调参记录\n\n| 时间 | index_rate | protect | pitch | TTS音色 | 备注 |\n| --- | --- | --- | --- | --- | --- |\n';
      fs.appendFileSync(VOICE_DOC, (head ? head : '') + line + '\n', 'utf8');
      return { content: [{ type: 'text', text: `已存档：${VOICE_DOC}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `存档失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
