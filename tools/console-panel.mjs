// 大肥鱼 · 只读控制台（独立进程，不碰 bridge.js）
// 启动：node tools\console-panel.mjs  →  http://127.0.0.1:3200
// 只读：不写任何文件，不调任何会改状态的接口。
import http from 'node:http';
import fs from 'node:fs';
import { readFeatures, writeFeature } from './features.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 每张功能卡 → 自己的开关字段（互相独立）
const FEATURE_SWITCH = {
  draw:   'socialV2.imageGen.enabled',
  qzone:  'qzone.enabled',
  learn:  'slang.enabled',
  quota:  'socialV2.plugins.groupQuota.enabled',
  report: 'dailyReport.enabled',
  persona:'socialV2.mood.fadeEnabled',
  sing:   'socialV2.voice.enabled',
  voice:  'socialV2.voice.enabled',
  signature: 'socialV2.signature.enabled',
};
function readSwitch(cfgObj, id) {
  const p = FEATURE_SWITCH[id];
  if (!p) return true;
  const v = p.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), cfgObj);
  return v !== false;
}
function writeSwitch(cfgObj, id, on) {
  const p = FEATURE_SWITCH[id];
  if (!p) return false;
  const keys = p.split('.');
  let cur = cfgObj;
  for (let k = 0; k < keys.length - 1; k++) {
    if (!cur[keys[k]] || typeof cur[keys[k]] !== 'object') cur[keys[k]] = {};
    cur = cur[keys[k]];
  }
  cur[keys[keys.length - 1]] = !!on;
  return true;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3200;
const readJson = (p, fb) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return fb; }
};
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

const names = () => readJson(path.join(ROOT, 'state', 'channel-names.json'), {});
const social = () => readJson(path.join(ROOT, 'state', 'social-v2.json'), { conversations: {} });
const cfg = () => readJson(path.join(ROOT, 'config.json'), {});


// ===== 白名单名字解析（群名 / 好友昵称）=====
const NAME_CACHE = path.join(ROOT, 'state', 'allow-names.json');
function readNames() { return readJson(NAME_CACHE, {}); }
function saveName(key, name) {
  const m = readNames();
  if (name) m[key] = name;
  try { fs.writeFileSync(NAME_CACHE, JSON.stringify(m, null, 2), 'utf8'); } catch { }
  return m;
}
async function gwPost(action, body) {
  const base = String(cfg()?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = cfg()?.snowluma?.accessToken || '';
  const r = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {})
  });
  const j = await r.json().catch(() => null);
  return j?.data ?? j;
}
async function resolveName(kind, id) {
  try {
    if (kind === 'group') {
      const list = await gwPost('get_group_list', {});
      const hit = Array.isArray(list) ? list.find((g) => String(g.group_id) === String(id)) : null;
      return hit ? String(hit.group_name || '') : '';
    }
    const friends = await gwPost('get_friend_list', {});
    const f = Array.isArray(friends) ? friends.find((x) => String(x.user_id) === String(id)) : null;
    if (f) return String(f.remark || f.nickname || '');
    const info = await gwPost('get_stranger_info', { user_id: Number(id) });
    return info ? String(info.nickname || info.remark || '') : '';
  } catch { return ''; }
}

function statsLastSeen(key) {
  const memRoot = path.join(ROOT, 'memory', 'sessions');
  let best = 0;
  try {
    for (const dir of fs.readdirSync(memRoot, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      for (const f of fs.readdirSync(path.join(memRoot, dir.name)).filter((x) => x.endsWith('.jsonl'))) {
        const full = path.join(memRoot, dir.name, f);
        let lines = [];
        try { lines = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean).slice(-5); } catch { continue; }
        const hit = lines.some((l) => { try { return String(JSON.parse(l).key || '') === key; } catch { return false; } });
        if (hit) { const m = fs.statSync(full).mtimeMs; if (m > best) best = m; }
      }
    }
  } catch { }
  return best;
}


// ── 会话名称：按 QQ 号 / 群号向网关取真名，缓存到 state/channel-names.json ──
async function resolveSessionLabels(keys) {
  const cacheFile = path.join(ROOT, 'state', 'channel-names.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {}; } catch { }
  const cfgNow = cfg() || {};
  const base = String(cfgNow?.snowluma?.httpUrl || 'http://127.0.0.1:3000');
  const token = String(cfgNow?.snowluma?.accessToken || '');

  // 群名一次批量取
  let groupMap = null;
  const needGroup = keys.some((k) => k.startsWith('group:') && !cache[k]);
  if (needGroup) {
    try {
      const r = await fetch(`${base}/get_group_list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json().catch(() => ({}));
      const list = j?.data || [];
      groupMap = {};
      for (const g of list) groupMap[String(g.group_id)] = String(g.group_name || '');
    } catch { groupMap = {}; }
  }

  let changed = false;
  for (const key of keys) {
    if (cache[key]) continue;
    const [kind, id] = key.split(':');
    let label = '';
    if (kind === 'group') {
      label = groupMap?.[id] || '';
    } else if (kind === 'private') {
      try {
        const r = await fetch(`${base}/get_stranger_info`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ user_id: Number(id), no_cache: true }),
          signal: AbortSignal.timeout(6000),
        });
        const j = await r.json().catch(() => ({}));
        label = String(j?.data?.nickname || j?.data?.remark || '');
      } catch { }
    }
    if (label) { cache[key] = label; changed = true; }
  }
  if (changed) { try { fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf8'); } catch { } }
  return cache;
}

function listSessions() {
  const nm = names();
  const st = social();
  const stats = new Map(); // key -> {count, lastAt}
  const memRoot = path.join(ROOT, 'memory', 'sessions');
  let dirs = [];
  try { dirs = fs.readdirSync(memRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { }
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(memRoot, dir)).filter((f) => f.endsWith('.jsonl')).sort(); } catch { }
    for (const f of files) {
      const date = f.replace('.jsonl', '');
      let lines = [];
      try { lines = fs.readFileSync(path.join(memRoot, dir, f), 'utf8').split('\n').filter(Boolean); } catch { }
      for (const line of lines) {
        let e; try { e = JSON.parse(line); } catch { continue; }
        const key = String(e.key || '');
        if (!key) continue;
        const cur = stats.get(key) || { count: 0, lastAt: 0 };
        cur.count++;
        const t = Date.parse(`${date}T${(e.time || '00:00')}:00+08:00`) || 0;
        if (t > cur.lastAt) cur.lastAt = t;
        stats.set(key, cur);
      }
    }
  }
  const keys = new Set([...Object.keys(st.conversations || {}), ...stats.keys()]);
  const out = [];
  for (const key of keys) {
    const s = stats.get(key) || { count: 0, lastAt: 0 };
    if (!s.lastAt) s.lastAt = statsLastSeen(key);
    const fallback = key.startsWith('group:') ? ('群 ' + key.split(':')[1]) : ('QQ ' + key.split(':')[1]);
    out.push({ key, label: nm[key] || fallback, count: s.count, lastAt: s.lastAt });
  }
  return out.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}

function searchAll(dirName, key) {
  const memRoot = path.join(ROOT, 'memory', 'sessions');
  const dirs = (() => { try { return fs.readdirSync(memRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } })();
  const rows = [];
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(memRoot, dir)).filter((f) => f.endsWith('.jsonl')).sort(); } catch { }
    for (const f of files) {
      let lines = [];
      try { lines = fs.readFileSync(path.join(memRoot, dir, f), 'utf8').split('\n').filter(Boolean); } catch { }
      for (const line of lines) {
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (key && String(e.key || '') !== key) continue;
        rows.push({ dir, date: f.replace('.jsonl', ''), who: e.who, name: e.name || '', text: String(e.text || '').slice(0, 300) });
      }
    }
  }
  return rows.slice(-200).reverse();
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

const HTML_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'panel', 'index.html');
const readHtml = () => fs.readFileSync(HTML_PATH, 'utf8');


const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') return send(res, 200, readHtml(), 'text/html; charset=utf-8');
  if (url.pathname === '/api/overview') {
    let bridge = null;
    try {
      const token = readText(path.join(ROOT, 'state', 'console-token')).trim();
      const r = await fetchSync(`http://127.0.0.1:3100/api/status?token=${token}`);
      bridge = r;
    } catch { bridge = null; }
    const c = cfg();
    return send(res, 200, {
      bridge,
      mood: readJson(path.join(ROOT, 'state', 'mood.json'), {}),
      allow: { groups: c?.allow?.groups || [], private: c?.allow?.private || [] },
      modes: { reserved2: 'reserved2' }
    });
  }
    if (url.pathname === '/api/sessions') {
      const all = listSessions();
      const c = cfg() || {};
      const allowG = new Set((c?.allow?.groups || []).map(String));
      const allowP = new Set((c?.allow?.private || []).map(String));
      // 已移出白名单的会话不再显示
      const kept = all.filter((x) => {
        const [kind, id] = String(x.key).split(':');
        if (kind === 'group') return allowG.has(id);
        if (kind === 'private') return allowP.has(id);
        return true;   // internal:* 等保留
      });
      const labels = await resolveSessionLabels(kept.map((x) => x.key));
      for (const x of kept) {
        const nm2 = labels[x.key];
        if (nm2) x.label = x.key.startsWith('group:') ? nm2 : nm2;
      }
      return send(res, 200, kept);
    }
  if (url.pathname === '/api/messages') {
    const q = (url.searchParams.get('q') || '').trim();
    const date = (url.searchParams.get('date') || '').trim();
    const limit = Math.max(20, Math.min(500, Number(url.searchParams.get('limit')) || 200));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    let rows = searchAll('', url.searchParams.get('key') || '');
    if (date) rows = rows.filter((r) => r.date === date);
    if (q) rows = rows.filter((r) => r.text.includes(q) || (r.name || '').includes(q));
    const total = rows.length;
    return send(res, 200, { rows: rows.slice(offset, offset + limit), total, offset, limit });
  }
  if (url.pathname === '/api/tools' && req.method === 'GET') {
    const t = cfg()?.socialV2?.tools || {};
    return send(res, 200, t);
  }
  if (url.pathname === '/api/tools' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let b = {};
    try { b = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: '请求体不是 JSON' }); }
    const flag = String(b.flag || '').trim();
    if (!flag) return send(res, 400, { error: '缺少 flag' });
    const file = path.join(ROOT, 'config.json');
    const conf = readJson(file, null);
    if (!conf) return send(res, 500, { error: 'config.json 读不出来' });
    conf.socialV2 = conf.socialV2 || {};
    conf.socialV2.tools = conf.socialV2.tools || {};
    conf.socialV2.tools[flag] = b.enabled !== false;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(conf, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    let reload = null;
    try {
      const token = readText(path.join(ROOT, 'state', 'console-token')).trim();
      reload = await fetchSync(`http://127.0.0.1:3100/api/reload-config?token=${token}`, 'POST');
    } catch (e) { reload = { ok: false, error: String(e) }; }
    return send(res, 200, { ok: true, flag, enabled: conf.socialV2.tools[flag], reload });
  }

  if (url.pathname === '/api/allowlist' && req.method === 'GET') {
    const c = cfg()?.allow || {};
    const cache = readNames();
    const hydrate = async (kind, ids) => {
      const out = [];
      for (const id of ids) {
        const key = `${kind}:${id}`;
        let name = cache[key] || '';
        if (!name) { name = await resolveName(kind, id); if (name) saveName(key, name); }
        out.push({ id: String(id), name });
      }
      return out;
    };
    const groups = await hydrate('group', c.groups || []);
    const priv = await hydrate('private', c.private || []);
    return send(res, 200, { groups, private: priv });
  }
  if (url.pathname === '/api/allowlist' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let b = {};
    try { b = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: '请求体不是 JSON' }); }
    const kind = b.kind === 'private' ? 'private' : 'group';
    const id = String(b.id || '').trim();
    if (!/^\d{4,12}$/.test(id)) return send(res, 400, { error: '号码必须是 4-12 位数字' });
    const file = path.join(ROOT, 'config.json');
    const conf = readJson(file, null);
    if (!conf) return send(res, 500, { error: 'config.json 读不出来' });
    conf.allow = conf.allow || {};
    const field = kind === 'group' ? 'groups' : 'private';
    const list = new Set((conf.allow[field] || []).map(String));
    if (b.action === 'remove') list.delete(id); else list.add(id);
    conf.allow[field] = [...list];
    // 原子写：先写临时文件再替换
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(conf, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    // 通知桥接热加载
    let reload = null;
    try {
      const token = readText(path.join(ROOT, 'state', 'console-token')).trim();
      reload = await fetchSync(`http://127.0.0.1:3100/api/reload-config?token=${token}`, 'POST');
    } catch (e) { reload = { ok: false, error: String(e) }; }
    let name = '';
    if (b.action !== 'remove') { name = await resolveName(kind, id); if (name) saveName(`${kind}:${id}`, name); }
    return send(res, 200, { ok: true, field, id, name, list: conf.allow[field], reload });
  }

  // ---- 黑名单 ----
  if (url.pathname === '/api/blacklist' && req.method === 'GET') {
    const c = cfg()?.socialV2?.blacklist || {};
    const cache = readNames();
    const list = (Array.isArray(c) ? c : (c.keys || [])).map(String);
    const out = [];
    for (const k of list) {
      out.push({ key: k, name: cache['bl:' + k] || '' });
    }
    return send(res, 200, { keys: out });
  }
  if (url.pathname === '/api/blacklist' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let b = {};
    try { b = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: '请求体不是 JSON' }); }
    const kind = b.kind === 'private' ? 'private' : 'group';
    const id = String(b.id || '').trim();
    if (!/^\d{4,12}$/.test(id)) return send(res, 400, { error: '号码必须是 4-12 位数字' });
    const key = `${kind}:${id}`;
    const file = path.join(ROOT, 'config.json');
    const conf = readJson(file, null);
    if (!conf) return send(res, 500, { error: 'config.json 读不出来' });
    conf.socialV2 = conf.socialV2 || {};
    const cur = conf.socialV2.blacklist;
    const arr = Array.isArray(cur) ? cur.map(String) : (cur && Array.isArray(cur.keys) ? cur.keys.map(String) : []);
    const set = new Set(arr);
    if (b.action === 'remove') set.delete(key); else set.add(key);
    conf.socialV2.blacklist = [...set];
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(conf, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    let reload = null;
    try {
      const token = readText(path.join(ROOT, 'state', 'console-token')).trim();
      reload = await fetchSync(`http://127.0.0.1:3100/api/reload-config?token=${token}`, 'POST');
    } catch (e) { reload = { ok: false, error: String(e) }; }
    return send(res, 200, { ok: true, key, keys: conf.socialV2.blacklist, reload });
  }
  // ---- 手动发消息 ----
  if (url.pathname === '/api/send' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let b = {};
    try { b = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: '请求体不是 JSON' }); }
    const key = String(b.key || '').trim();
    const text = String(b.text || '').trim();
    if (!key || !text) return send(res, 400, { error: '需要 key 和 text' });
    const token = readText(path.join(ROOT, 'state', 'console-token')).trim();
    const base = String(cfg()?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const gw = cfg()?.snowluma?.accessToken || '';
    const [kind, id] = key.split(':');
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
    const payload = kind === 'group' ? { group_id: Number(id), message: text } : { user_id: Number(id), message: text };
    try {
      const r = await fetch(`${base}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(gw ? { authorization: `Bearer ${gw}` } : {}) },
        body: JSON.stringify(payload)
      });
      const j = await r.json().catch(() => null);
      return send(res, 200, { ok: j?.status !== 'failed', result: j });
    } catch (e) { return send(res, 500, { error: String(e) }); }
  }

  // ---- 日志尾 ----
  if (url.pathname === '/api/logs') {
    const n = Math.max(20, Math.min(500, Number(url.searchParams.get('lines')) || 200));
    let text = '';
    try {
      text = fs.readFileSync(path.join(ROOT, 'state', 'bridge.log'), 'utf8');
    } catch { }
    const lines = text.split('\n').filter(Boolean).slice(-n);
    return send(res, 200, { lines });
  }
  // ---- 状态总览 ----
  if (url.pathname === '/api/summary') {
    const c = cfg();
    const st = social();
    const sessions = listSessions();
    const today = new Date().toISOString().slice(0, 10);
    let todayMsgs = 0;
    try {
      for (const s of sessions) {
        // 只统计今天的记录条数
        const dirs = fs.readdirSync(path.join(ROOT, 'memory', 'sessions'), { withFileTypes: true }).filter((d) => d.isDirectory());
        for (const d of dirs) {
          const f = path.join(ROOT, 'memory', 'sessions', d.name, today + '.jsonl');
          if (!fs.existsSync(f)) continue;
          for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
            try { if (String(JSON.parse(line).key) === s.key) todayMsgs++; } catch { }
          }
        }
      }
    } catch { }
    let backups = [];
    try {
      backups = fs.readdirSync(path.join(ROOT, 'backup')).filter((f) => f.endsWith('.zip')).sort().slice(-3);
    } catch { }
    const portOk = (port) => new Promise((resolve) => {
      const s = http.request({ host: '127.0.0.1', port, path: '/', timeout: 800 }, () => { resolve(true); s.destroy(); });
      s.on('error', () => resolve(false));
      s.on('timeout', () => { resolve(false); s.destroy(); });
      s.end();
    });
    const ports = { bridge: 3100, gateway: 3000, dsh: Number(String(c?.dsh?.baseUrl || '').match(/:(\d+)/)?.[1] || 0) };
    const up = {
      bridge: await portOk(3100),
      gateway: await portOk(3000),
      asr: await portOk(9881),
      dsh: ports.dsh ? await portOk(ports.dsh) : false
    };
    return send(res, 200, {
      up,
      sessions: sessions.length,
      todayMsgs,
      mood: readJson(path.join(ROOT, 'state', 'mood.json'), {}),
      allow: (c?.allow?.groups || []).length,
      blacklist: (Array.isArray(c?.socialV2?.blacklist) ? c.socialV2.blacklist.length : 0),
      toolsOff: Object.entries(c?.socialV2?.tools || {}).filter(([, v]) => v === false).map(([k]) => k),
      backups
    });
  }
  // ---- 记忆概览 ----
  if (url.pathname === '/api/memory') {
    const memRoot = path.join(ROOT, 'memory', 'sessions');
    const out = [];
    try {
      for (const d of fs.readdirSync(memRoot, { withFileTypes: true }).filter((x) => x.isDirectory())) {
        const files = fs.readdirSync(path.join(memRoot, d.name)).filter((f) => f.endsWith('.jsonl')).sort();
        let total = 0, last = '', sample = [];
        for (const f of files) {
          const rows = fs.readFileSync(path.join(memRoot, d.name, f), 'utf8').split('\n').filter(Boolean);
          total += rows.length;
          last = f.replace('.jsonl', '');
          if (f === files[files.length - 1]) {
            for (const line of rows.slice(-3)) {
              try { const e = JSON.parse(line); sample.push({ who: e.who, name: e.name || '', text: String(e.text || '').slice(0, 60) }); } catch { }
            }
          }
        }
        out.push({ channel: d.name, days: files.length, total, last, sample });
      }
    } catch { }
    return send(res, 200, { channels: out, mood: readJson(path.join(ROOT, 'state', 'mood.json'), {}) });
  }

  // ---- 点歌任务（从日志解析）----
  if (url.pathname === '/api/tasks') {
    let text = '';
    try { text = fs.readFileSync(path.join(ROOT, 'state', 'bridge.log'), 'utf8'); } catch { }
    const lines = text.split('\n').filter((l) => l.includes('[sing]'));
    const tasks = [];
    let cur = null;
    for (const line of lines) {
      const m = line.match(/^(\d{2}:\d{2}:\d{2}).*\[sing\]\s*(.+)$/);
      if (!m) continue;
      const time = m[1];
      const msg = m[2];
      const start = msg.match(/\u5f00\u59cb\u300a(.+?)\u300b/);
      if (start) {
        cur = { song: start[1], start: time, end: '', stage: '准备', mode: msg.includes('整首') ? '整首' : '副歌', status: 'running' };
        tasks.push(cur);
        continue;
      }
      if (!cur) continue;
      if (msg.includes('下载完成')) cur.stage = '下载完成';
      else if (msg.includes('找到高潮')) {
        cur.stage = '定位副歌';
        const sm = msg.match(/取\s*(\d+)s/);
        if (sm) cur.mode = sm[1] + '秒';
        if (msg.includes('整首')) cur.mode = '整首';
      }
      else if (msg.includes('人声分离')) cur.stage = '分离人声';
      else if (msg.includes('RVC')) cur.stage = '换音色';
      else if (msg.includes('混音导出')) cur.stage = '混音';
      else if (msg.includes('封装')) cur.stage = '封装';
      else if (msg.includes('已发送')) { cur.status = 'done'; cur.end = time; cur.stage = '已发送'; }
      else if (msg.includes('失败')) { cur.status = 'failed'; cur.end = time; cur.stage = '失败'; }
    }
    // 卡死判定：running 且最后一条日志超过 20 分钟没更新 → 标记中断
    const nowMin = (() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); })();
    const toMin = (hhmm) => {
      const [h, m] = String(hhmm).split(':').map(Number);
      return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
    };
    for (const task of tasks) {
      if (task.status !== 'running') continue;
      const startMin = toMin(task.start);
      if (startMin === null) continue;
      let diff = nowMin - startMin;
      if (diff < 0) diff += 24 * 60; // 跨天
      task.elapsedMin = diff;
    }
    // 只返回"正在跑"的任务；超过预期时长太多的视为已死，不再显示
    const withP = tasks.map((x) => {
      const isFull = x.mode === '整首';
      const expect = isFull ? 18 : 6;          // 预计分钟
      const hardLimit = isFull ? 32 : 12;      // 超过预期太多就认为死了
      const pct = Math.max(3, Math.min(97, Math.round(((x.elapsedMin || 0) / expect) * 100)));
      return { ...x, percent: pct, dead: (x.elapsedMin || 0) > hardLimit };
    }).filter((x) => x.status === 'running' && !x.dead);
    return send(res, 200, { tasks: withP.slice(-5).reverse() });
  }

  // ---- 关系（好感度）----
  if (url.pathname === '/api/relations') {
    const dir = path.join(ROOT, 'data', '群友档案');
    const out = [];
    try {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
        const txt = fs.readFileSync(path.join(dir, f), 'utf8');
        const name = (txt.match(/^#\s*(.+)$/m) || [])[1] || f.replace('.md', '');
        let sum = 0;
        const recent = [];
        for (const m of txt.matchAll(/好感\s*([+-]?\d+)(?:（(.{0,40})）)?/g)) {
          sum += Number(m[1]) || 0;
          if (m[2]) recent.push({ delta: Number(m[1]), why: m[2] });
        }
        const score = Math.max(0, Math.min(100, 50 + sum));
        out.push({ qq: f.replace('.md', ''), name, score, records: (txt.match(/^- /gm) || []).length, recent: recent.slice(-3) });
      }
    } catch { }
    // 同名不同 QQ：显示时带上 QQ 尾号，避免看起来像同一个人
    const _nameCount = {};
    for (const r of out) _nameCount[r.name] = (_nameCount[r.name] || 0) + 1;
    for (const r of out) {
      if (_nameCount[r.name] > 1) r.name = r.name + '（' + String(r.qq).slice(-4) + '）';
    }
    return send(res, 200, { relations: out.sort((a, b) => b.score - a.score) });
  }

  if (url.pathname === '/api/sing-cancel' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let b = {};
    try { b = JSON.parse(raw || '{}'); } catch { }
    const token = readText(path.join(ROOT, 'state', 'console-token')).trim();
    try {
      const r = await fetchSync(`http://127.0.0.1:3100/api/socialV2/sing-cancel?token=${token}`, 'POST', { all: true });
      return send(res, 200, r || { ok: false });
    } catch (e) { return send(res, 500, { ok: false, error: String(e) }); }
  }

  // ---- 功能开关（分类 + 参数）----
  if (url.pathname === '/api/features' && req.method === 'GET') {
    try {
      const c0 = cfg() || {};
      const cats = readFeatures().map((x) => ({ ...x, enabled: readSwitch(c0, x.id) }));
      return send(res, 200, { categories: cats });
    }
    catch (e) { return send(res, 500, { error: String(e) }); }
  }
  if (url.pathname === '/api/features' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let b = {};
    try { b = JSON.parse(raw || '{}'); } catch { }
    const r = writeFeature(String(b.path || ''), b.value);
    if (!r.ok) return send(res, 400, r);
    // 写完让桥接热加载
    try {
      const token = readText(path.join(ROOT, 'state', 'console-token')).trim();
      await fetchSync(`http://127.0.0.1:3100/api/reload-config?token=${token}`, 'POST', {});
    } catch { }
    return send(res, 200, { ok: true, categories: readFeatures() });
  }

  // ── 生图模型管理：多套模型，只回 Key 尾 4 位 ──
  if (url.pathname === '/api/image-models') {
    const cfgPath = path.join(ROOT, 'config.json');
    const readCfg = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const list = (c) => {
      const ig = c?.socialV2?.imageGen || {};
      const models = ig.models || {};
      const rows = Object.entries(models).map(([name, v]) => ({
        name,
        model: v.model || '',
        keyTail: String(v.apiKey || '').slice(-4),
      }));
      // 兼容老配置：只有 imageGen.model 时也显示
      if (!rows.length && ig.model) rows.push({ name: '默认', model: ig.model, keyTail: String(ig.apiKey || '').slice(-4) });
      return { models: rows, active: ig.activeModel || rows[0]?.name || '' };
    };
    if (req.method === 'GET') {
      try { return send(res, 200, list(readCfg())); } catch (e) { return send(res, 500, { error: String(e) }); }
    }
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let b = {};
      try { b = JSON.parse(raw || '{}'); } catch { }
      const c = readCfg();
      const ig = (c.socialV2 = c.socialV2 || {}).imageGen = c.socialV2.imageGen || {};
      ig.models = ig.models || {};
      const action = String(b.action || '');
      if (action === 'save') {
        const name = String(b.name || '').trim();
        const model = String(b.model || '').trim();
        const apiKey = String(b.apiKey || '').trim();
        if (!name || !model) return send(res, 400, { error: '模型名称和模型 ID 都要填' });
        const prev = ig.models[name] || {};
        ig.models[name] = { model, apiKey: apiKey || prev.apiKey || '' };
      } else if (action === 'activate') {
        const name = String(b.name || '').trim();
        if (!ig.models[name]) return send(res, 400, { error: '没有这个模型' });
        ig.activeModel = name;
        ig.model = ig.models[name].model;
        if (ig.models[name].apiKey) ig.apiKey = ig.models[name].apiKey;
      } else if (action === 'delete') {
        const name = String(b.name || '').trim();
        delete ig.models[name];
        if (ig.activeModel === name) ig.activeModel = Object.keys(ig.models)[0] || '';
      }
      fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2) + '\n', 'utf8');
      try {
        const token = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
        await fetch(`http://127.0.0.1:3100/api/reload-config?token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      } catch { }
      return send(res, 200, { ok: true, ...list(readCfg()) });
    }
  }

  // ── 记忆分组合计：按 key 合并（同一群分成两个目录时也能对齐）──
  if (url.pathname === '/api/memory-groups') {
    const root = path.join(ROOT, 'memory', 'sessions');
    const acc = new Map();   // key -> {count,lastAt,names:{}}
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { }
    for (const dir of dirs) {
      let files = [];
      try { files = fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const date = f.replace('.jsonl', '');
        let lines = [];
        try { lines = fs.readFileSync(path.join(root, dir, f), 'utf8').split('\n').filter(Boolean); } catch { continue; }
        for (const line of lines) {
          let e; try { e = JSON.parse(line); } catch { continue; }
          const key = String(e.key || '');
          if (!key) continue;
          const cur = acc.get(key) || { count: 0, lastAt: 0, names: {} };
          cur.count++;
          const t = Date.parse(`${date}T${(e.time || '00:00')}:00+08:00`) || 0;
          if (t > cur.lastAt) cur.lastAt = t;
          const nm = String(e.name || '').trim();
          if (nm) cur.names[nm] = (cur.names[nm] || 0) + 1;
          acc.set(key, cur);
        }
      }
    }
    const labels = {};
    try { Object.assign(labels, JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'channel-names.json'), 'utf8')) || {}); } catch { }
    const out = [...acc.entries()].map(([key, v]) => {
      let label = labels[key] || '';
      if (!label) {
        const top = Object.entries(v.names).sort((a, b) => b[1] - a[1])[0];
        label = top ? top[0] : (key.startsWith('group:') ? '群 ' + key.split(':')[1] : 'QQ ' + key.split(':')[1]);
      }
      return { key, label, count: v.count, lastAt: v.lastAt };
    }).sort((a, b) => b.count - a.count);
    // 与「会话」页一致：只显示还在白名单里的会话
    try {
      const c0 = cfg() || {};
      const allowG = new Set((c0?.allow?.groups || []).map(String));
      const allowP = new Set((c0?.allow?.private || []).map(String));
      const kept = out.filter((x) => {
        const [kind, id] = String(x.key).split(':');
        if (kind === 'group') return allowG.has(id);
        if (kind === 'private') return allowP.has(id);
        return true;
      });
      return send(res, 200, kept);
    } catch { }
    return send(res, 200, out);
  }

  // ── 人设卡：读 / 写 roles/合一.md（写前自动备份）──
  if (url.pathname === '/api/persona') {
    const roleFile = path.join(ROOT, 'roles', '合一.md');
    if (req.method === 'GET') {
      try {
        const text = fs.readFileSync(roleFile, 'utf8');
        const st = fs.statSync(roleFile);
        return send(res, 200, { ok: true, text, mtime: new Date(st.mtimeMs).toLocaleString('zh-CN', { hour12: false }), bytes: st.size });
      } catch (e) { return send(res, 500, { ok: false, error: String(e) }); }
    }
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let b = {};
      try { b = JSON.parse(raw || '{}'); } catch { return send(res, 400, { ok: false, error: '请求体不是 JSON' }); }
      const text = String(b.text ?? '');
      if (text.length < 50) return send(res, 400, { ok: false, error: '人设卡太短（<50 字符），已拒绝保存' });
      try {
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
        const bak = path.join(ROOT, 'roles', '合一.md.bak-' + stamp);
        if (fs.existsSync(roleFile)) fs.copyFileSync(roleFile, bak);
        fs.writeFileSync(roleFile, text, 'utf8');
        return send(res, 200, { ok: true, bytes: Buffer.byteLength(text, 'utf8'), backup: path.basename(bak) });
      } catch (e) { return send(res, 500, { ok: false, error: String(e) }); }
    }
  }

  // ── 情绪系统：当前状态 + 全部参数 + 历史 ──
  if (url.pathname === '/api/mood') {
    const moodFile = path.join(ROOT, 'state', 'mood.json');
    const readMood = () => { try { return JSON.parse(fs.readFileSync(moodFile, 'utf8')); } catch { return null; } };
    if (req.method === 'GET') {
      const m = readMood() || {};
      const c = (cfg() || {}).socialV2?.mood || {};
      return send(res, 200, {
        current: {
          label: m.label || '平静',
          intensity: Number(m.intensity || 0),
          reason: m.reason || '',
          target: m.target || '',
          updatedAt: m.updatedAt || 0,
        },
        config: {
          fadeEnabled: c.fadeEnabled !== false,
          minHoldMs: c.minHoldMs || 1800000,
          checkIntervalMs: c.checkIntervalMs || 1800000,
          fadeThreshold: c.fadeThreshold ?? 0.2,
          rates: c.rates || {},
        },
        history: Array.isArray(m.history) ? m.history.slice(-30).reverse() : [],
      });
    }
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let b = {};
      try { b = JSON.parse(raw || '{}'); } catch { return send(res, 400, { ok: false, error: '请求体不是 JSON' }); }
      const label = String(b.label || '').trim();
      const intensity = Number(b.intensity);
      if (!label) return send(res, 400, { ok: false, error: '缺少情绪名' });
      const m = readMood() || {};
      const now = Date.now();
      m.history = Array.isArray(m.history) ? m.history : [];
      m.history.push({ at: now, label: m.label || '平静', intensity: Number(m.intensity || 0), reason: m.reason || '', target: m.target || '', key: 'console' });
      if (m.history.length > 200) m.history = m.history.slice(-200);
      m.label = label;
      m.intensity = Number.isFinite(intensity) ? Math.max(0, Math.min(1, intensity)) : 0.3;
      m.reason = String(b.reason || '面板手动设置');
      m.target = String(b.target || '');
      m.updatedAt = now;
      fs.writeFileSync(moodFile, JSON.stringify(m, null, 2) + '\n', 'utf8');
      return send(res, 200, { ok: true });
    }
  }

  // ── 功能总开关：关掉后该模块的工具/逻辑立即失效 ──
  if (url.pathname === '/api/feature-toggle' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let b = {};
    try { b = JSON.parse(raw || '{}'); } catch { return send(res, 400, { ok: false, error: '请求体不是 JSON' }); }
    const id = String(b.id || '').trim();
    const on = b.on === true;
    if (!id) return send(res, 400, { ok: false, error: '缺少 id' });
    try {
      const cfgPath2 = path.join(ROOT, 'config.json');
      const c = JSON.parse(fs.readFileSync(cfgPath2, 'utf8'));
      if (!writeSwitch(c, id, on)) return send(res, 400, { ok: false, error: '这个模块没有独立开关字段' });
      // 兼容：同时写一份 features 标记，供 MCP 守卫使用
      c.socialV2 = c.socialV2 || {};
      c.socialV2.features = c.socialV2.features || {};
      c.socialV2.features[id] = { enabled: on };
      fs.writeFileSync(cfgPath2, JSON.stringify(c, null, 2) + '\n', 'utf8');
      try {
        const token = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
        await fetch(`http://127.0.0.1:3100/api/reload-config?token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      } catch { }
      return send(res, 200, { ok: true, id, enabled: on });
    } catch (e) { return send(res, 500, { ok: false, error: String(e) }); }
  }

// ── SnowLuma 反向代理：/snow/* → 127.0.0.1:<port>/*（含 WebSocket）──
const SNOW_CANDIDATES = [5099, 5100, 5101, 5102];
let snowPort = 0;
async function detectSnowPort() {
  if (snowPort && await pingSnow(snowPort)) return snowPort;
  for (const p of SNOW_CANDIDATES) {
    if (await pingSnow(p)) { snowPort = p; return p; }
  }
  snowPort = 0;
  return 0;
}
function pingSnow(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode > 0);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function proxySnow(req, res) {
  const port = await detectSnowPort();
  if (!port) { return send(res, 503, { error: 'SnowLuma 没在运行（5099-5102 都没响应）' }); }
  const target = String(req.url).replace(/^\/snow/, '') || '/';
  const headers = { ...req.headers, host: '127.0.0.1:' + port };
  delete headers['accept-encoding'];
  const up = http.request({ host: '127.0.0.1', port, path: target, method: req.method, headers, timeout: 20000 }, (r) => {
    const h = { ...r.headers };
    delete h['content-security-policy'];
    delete h['x-frame-options'];
    delete h['content-length'];
    res.writeHead(r.statusCode || 502, h);
    r.pipe(res);
  });
  up.on('error', () => { try { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('SnowLuma 代理失败'); } catch { } });
  up.on('timeout', () => { up.destroy(); });
  req.pipe(up);
}

  if (url.pathname === '/api/snow') {
    const port = await detectSnowPort();
    if (!port) return send(res, 200, { running: false });
    const c = cfg() || {};
    const base = String(c?.snowluma?.httpUrl || 'http://127.0.0.1:3000');
    const token = String(c?.snowluma?.accessToken || '');
    let info = null;
    try {
      const r = await fetch(base + '/get_login_info', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: '{}', signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      info = j?.data || null;
    } catch { }
    return send(res, 200, { running: true, port, login: info });
  }
  if (url.pathname === '/snow' || url.pathname.startsWith('/snow/')) {
    return proxySnow(req, res);
  }


  // 今日消息 / 累计消息（今日 = 本地时间 00:00 起）
  if (url.pathname === '/api/msgstats') {
    const root = path.join(ROOT, 'memory', 'sessions');
    const d = new Date();
    const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    let todayCount = 0, total = 0;
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name); } catch { }
    for (const dir of dirs) {
      let files = [];
      try { files = fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        let n = 0;
        try { n = fs.readFileSync(path.join(root, dir, f), 'utf8').split('\n').filter(Boolean).length; } catch { continue; }
        total += n;
        if (f.startsWith(today)) todayCount += n;
      }
    }
    return send(res, 200, { today: todayCount, total, day: today });
  }
  send(res, 404, { error: 'not found' });
});

// 同步取桥接状态用（避免引入依赖）
function fetchSync(u, method = 'GET', payload = null) {
  return new Promise((resolve, reject) => {
    const m = u.match(/^http:\/\/([^/]+)(\/.*)$/);
    const [, hostport, p] = m;
    const [host, port] = hostport.split(':');
    const hdr = method === 'POST' ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(JSON.stringify(payload || {})) } : {};
    const req2 = http.request({ host, port, path: p, method, headers: hdr, timeout: 3000 }, (r) => {
      let b = '';
      r.on('data', (d) => { b += d; });
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req2.on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
    req2.end(method === 'POST' ? JSON.stringify(payload || {}) : undefined);
  });
}


// WebSocket 升级转发（SnowLuma WebUI 实时通道）
server.on('upgrade', async (req, socket, head) => {
  try {
    if (!String(req.url || '').startsWith('/snow')) { socket.destroy(); return; }
    const port = await detectSnowPort();
    if (!port) { socket.destroy(); return; }
    const target = String(req.url).replace(/^\/snow/, '') || '/';
    const up = http.request({
      host: '127.0.0.1', port, path: target, method: 'GET',
      headers: { ...req.headers, host: '127.0.0.1:' + port },
    });
    up.on('upgrade', (r, upSocket, upHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
        Object.entries(r.headers).map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n');
      if (upHead && upHead.length) socket.write(upHead);
      upSocket.pipe(socket); socket.pipe(upSocket);
      socket.on('error', () => upSocket.destroy());
      upSocket.on('error', () => socket.destroy());
    });
    up.on('error', () => socket.destroy());
    up.end();
  } catch { socket.destroy(); }
});


// ── 独立反代端口：3201 → SnowLuma WebUI（整站透传，去掉禁止嵌入的头）──

// 顶层端口探测（给独立反代服务用，不依赖请求作用域）
let __snowPortCache = 0;
function __pingSnow(port) {
  return new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 1200 }, (rs) => { rs.resume(); resolve(rs.statusCode > 0); });
    rq.on('error', () => resolve(false));
    rq.on('timeout', () => { rq.destroy(); resolve(false); });
    rq.end();
  });
}
async function __detectSnowPort() {
  if (__snowPortCache && await __pingSnow(__snowPortCache)) return __snowPortCache;
  for (const p of [5099, 5100, 5101, 5102]) {
    if (await __pingSnow(p)) { __snowPortCache = p; return p; }
  }
  __snowPortCache = 0;
  return 0;
}
const SNOW_PORT = 3201;
const snowProxyServer = http.createServer(async (req, res) => {
  const port = await __detectSnowPort();
  if (!port) { res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }); res.end('SnowLuma 没在运行'); return; }
  const headers = { ...req.headers, host: '127.0.0.1:' + port };
  delete headers['accept-encoding'];
  const up = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers, timeout: 30000 }, (r) => {
    const h = { ...r.headers };
    delete h['x-frame-options'];
    delete h['content-security-policy'];
    delete h['content-length'];
    res.writeHead(r.statusCode || 502, h);
    r.pipe(res);
  });
  up.on('error', () => { try { res.writeHead(502); res.end('proxy error'); } catch { } });
  up.on('timeout', () => up.destroy());
  req.pipe(up);
});
snowProxyServer.on('upgrade', async (req, socket, head) => {
  try {
    const port = await __detectSnowPort();
    if (!port) { socket.destroy(); return; }
    const up = http.request({ host: '127.0.0.1', port, path: req.url, method: 'GET', headers: { ...req.headers, host: '127.0.0.1:' + port } });
    up.on('upgrade', (r, upSocket, upHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(r.headers).map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n');
      if (upHead && upHead.length) socket.write(upHead);
      upSocket.pipe(socket); socket.pipe(upSocket);
      socket.on('error', () => upSocket.destroy());
      upSocket.on('error', () => socket.destroy());
    });
    up.on('error', () => socket.destroy());
    up.end();
  } catch { socket.destroy(); }
});
snowProxyServer.listen(SNOW_PORT, '127.0.0.1', () => console.log('[panel] snow proxy http://127.0.0.1:' + SNOW_PORT));


// 启动时自动扫描 MCP 工具，刷新面板的「其他工具」清单
try {
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'sync-tool-registry.mjs')], { timeout: 15000, stdio: 'ignore' });
  console.log('[panel] 工具注册表已同步');
} catch (e) { console.warn('[panel] 工具注册表同步失败:', e && e.message); }

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[panel] http://127.0.0.1:${PORT}`);
});
