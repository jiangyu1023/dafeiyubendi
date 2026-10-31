// 全接口交叉验证：网关 / 桥接 / DSH / 面板 / ASR / 记忆 / 备份
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/AICompanion/qq-bridge';
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const ct = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
const gw = cfg.snowluma.httpUrl;
const gwTok = cfg.snowluma.accessToken;

const rows = [];
const rec = (name, ok, detail = '') => rows.push({ name, ok, detail });

async function jfetch(url, opt = {}) {
  try {
    const r = await fetch(url, { ...opt, signal: AbortSignal.timeout(opt.timeout || 10000) });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { }
    return { status: r.status, data, text };
  } catch (e) { return { status: 0, error: e.message }; }
}

// ---------- 1. 网关 OneBot ----------
const gwApis = [
  ['get_login_info', {}],
  ['get_status', {}],
  ['get_version_info', {}],
  ['get_group_list', {}],
  ['get_friend_list', {}],
];
for (const [ep, body] of gwApis) {
  const r = await jfetch(gw + '/' + ep, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + gwTok },
    body: JSON.stringify(body),
  });
  const ok = r.data?.status === 'ok' || r.data?.retcode === 0;
  rec('网关 ' + ep, ok, ok ? '' : (r.error || JSON.stringify(r.data).slice(0, 60)));
}

// ---------- 2. 桥接 ----------
const br = 'http://127.0.0.1:3100';
const st = await jfetch(`${br}/api/status?token=${ct}`);
rec('桥接 /api/status', st.data?.dshReady === true, 'dshReady=' + st.data?.dshReady);
rec('桥接 connected', st.data?.snowluma?.connected === true);
rec('桥接 账号在线', st.data?.snowluma?.accountOnline === true);

// ---------- 3. 面板 ----------
const pn = 'http://127.0.0.1:3200';
const pnApis = ['/api/summary', '/api/sessions', '/api/features', '/api/memory-groups',
  '/api/msgstats', '/api/mood', '/api/persona', '/api/image-models', '/api/snow',
  '/api/relations', '/api/tools', '/api/allowlist', '/api/overview'];
for (const api of pnApis) {
  const r = await jfetch(pn + api, { timeout: 20000 });
  rec('面板 ' + api, r.status === 200, r.status !== 200 ? ('status=' + r.status + ' ' + (r.error || '')) : '');
}
// 反代
const px = await jfetch('http://127.0.0.1:3201/', { timeout: 15000 });
rec('SnowLuma 反代 3201', px.status === 200 && (px.text || '').includes('<html'), 'status=' + px.status);

// ---------- 4. ASR ----------
const asr = await jfetch('http://127.0.0.1:9881/asr', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', timeout: 10000 });
rec('ASR 9881 (/asr)', asr.status === 200 && asr.data && typeof asr.data === 'object', 'status=' + asr.status + ' ' + JSON.stringify(asr.data || {}).slice(0, 40));

// ---------- 5. DSH ----------
const dshApi = await jfetch(cfg.dsh.baseUrl + '/api/version', { timeout: 6000 });
rec('DSH /api/version', dshApi.status === 401 || dshApi.status === 200, 'status=' + dshApi.status);

// ---------- 6. 记忆读写 ----------
const mem = await jfetch(`${pn}/api/memory-groups`, { timeout: 20000 });
rec('记忆分组可读', Array.isArray(mem.data) && mem.data.length > 0, '会话数=' + (Array.isArray(mem.data) ? mem.data.length : 0));
const per = await jfetch(`${pn}/api/persona`, { timeout: 10000 });
rec('人设可读', (per.data?.text || '').length > 100, '字符=' + (per.data?.text || '').length);

// ---------- 7. 计划任务 ----------
const { execSync } = await import('node:child_process');
for (const t of ['FeiyuDailyReport', 'FeiyuBalance', 'FeiyuASR']) {
  try {
    const out = execSync(`schtasks /query /tn ${t} /fo LIST`, { encoding: 'utf8' });
    rec('计划任务 ' + t, /Ready|Running|就绪|正在运行/i.test(out));
  } catch { rec('计划任务 ' + t, false, '查询失败'); }
}

// ---------- 8. 备份 ----------
const bdir = path.join(ROOT, 'backup');
const zips = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter((x) => x.endsWith('.zip')) : [];
const newest = zips.sort().pop();
const ageH = newest ? (Date.now() - fs.statSync(path.join(bdir, newest)).mtimeMs) / 3600000 : 999;
rec('备份新鲜度(<10h)', ageH < 10, newest + ' ' + ageH.toFixed(1) + 'h前');

// ---------- 输出 ----------
const pass = rows.filter((r) => r.ok).length;
console.log(`\n=== 全接口验证 ${pass}/${rows.length} ===`);
for (const r of rows) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`);
process.exit(pass === rows.length ? 0 : 1);
