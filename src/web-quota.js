// 联网搜索的每日配额（跨进程共享：桥接调度学习轮、web-search MCP 记账都读这一份）。
//
// 为什么要单独一个模块：配额必须由**执行搜索的那一方**（mcp-web-search-safe.js）扣减，
// 否则只是提示词里的君子协定；同时桥接要知道今天已经用掉多少（决定还要不要排学习轮）。
// 两边都 import 这个文件，格式与判日（本地时区）只有一套实现。
import fs from 'node:fs';
import path from 'node:path';

/** 本地时区的日期键，例如 2026-10-20。跨天=配额清零。 */
export function todayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 默认额度：用户 2026-10-20 定的那套。 */
export const DEFAULT_LIMITS = Object.freeze({
  maxSearchesPerDay: 15,      // 学习轮 + 好奇搜索共用
  maxCuriosityPerDay: 2,      // 「好奇就搜」单独的次数上限
  maxLearningTopicsPerDay: 5, // 学习轮当天最多碰几个话题
  maxTokensPerDay: 30_000_000,// 当日搜索相关 token 上限（按字符粗估）
  fetchMaxChars: 3000,        // 单次 web_fetch 只留这么多字
});

export function emptyQuota(date = todayKey()) {
  return {
    date,
    searches: 0,
    tokens: 0,
    curiosity: 0,
    learningTopics: [],
    learningRounds: 0,
    approvals: [], // [{ topic, status:'approved', at }]
    pending: [],   // [{ id, topic, at }]
    log: [],       // 最近 100 条
  };
}

export function quotaFile(root) {
  return path.join(root, 'state', 'web-quota.json');
}

/** 读当天配额；文件不存在/坏了/跨天都返回一份干净的空配额。 */
export function loadQuota(root, now = new Date()) {
  const date = todayKey(now);
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(quotaFile(root), 'utf8'));
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== 'object' || raw.date !== date) return emptyQuota(date);
  const q = { ...emptyQuota(date), ...raw, date };
  q.learningTopics = Array.isArray(q.learningTopics) ? q.learningTopics.filter(Boolean) : [];
  q.approvals = Array.isArray(q.approvals) ? q.approvals : [];
  q.pending = Array.isArray(q.pending) ? q.pending : [];
  q.log = Array.isArray(q.log) ? q.log.slice(-100) : [];
  q.searches = Number(q.searches) || 0;
  q.tokens = Number(q.tokens) || 0;
  q.curiosity = Number(q.curiosity) || 0;
  q.learningRounds = Number(q.learningRounds) || 0;
  return q;
}

export function saveQuota(root, quota) {
  const file = quotaFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(quota, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 粗估 token：中文差不多 1 字 1 token，英文/JSON 约 4 字符 1 token。
 * 取 chars/1.2 是**偏保守**的估算（宁可早点撞上限，也不要超支）。
 */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 1.2);
}

/** 当天还可以搜几次。 */
export function remainingSearches(quota, limits) {
  return Math.max(0, limits.maxSearchesPerDay - quota.searches);
}

/**
 * 统一准入判定。不在这里扣账——调用方搜成功后才记账（失败的请求不该吃额度）。
 * @returns {{ok:boolean, error?:string, limits:object}}
 */
export function checkSearchAllowed(quota, limits, { purpose, topic, source }) {
  if (quota.tokens >= limits.maxTokensPerDay) {
    return { ok: false, limits, error: `今日搜索 token 已用满（${quota.tokens}/${limits.maxTokensPerDay}），明天再来。` };
  }
  if (quota.searches >= limits.maxSearchesPerDay) {
    return { ok: false, limits, error: `今日搜索次数已用满（${quota.searches}/${limits.maxSearchesPerDay}），明天再来。` };
  }
  if (purpose === 'curiosity' && quota.curiosity >= limits.maxCuriosityPerDay) {
    return { ok: false, limits, error: `今日「好奇就搜」次数已用满（${quota.curiosity}/${limits.maxCuriosityPerDay}），明天再好奇。` };
  }
  if (purpose === 'learning') {
    const t = String(topic ?? '').trim();
    if (!t) return { ok: false, limits, error: '学习轮搜索必须带 topic（话题名）。' };
    if (!quota.learningTopics.includes(t) && quota.learningTopics.length >= limits.maxLearningTopicsPerDay) {
      return { ok: false, limits, error: `今日学习话题已达上限（${quota.learningTopics.length}/${limits.maxLearningTopicsPerDay}）。` };
    }
    if (source === 'approved') {
      const hit = quota.approvals.find((a) => a && a.status === 'approved' && a.topic === t);
      if (!hit) return { ok: false, limits, error: `话题「${t}」没有管理员的同意记录——想学聊天里没出现过的东西，先用 qq_request_learning 问他。` };
    }
  }
  return { ok: true, limits };
}

/** 记一次搜索（成功后调用）。 */
export function recordSearch(quota, { purpose = 'chat', topic = '', query = '', tokens = 0 }) {
  quota.searches += 1;
  quota.tokens += Math.max(0, Math.round(tokens));
  if (purpose === 'curiosity') quota.curiosity += 1;
  if (purpose === 'learning') {
    const t = String(topic ?? '').trim();
    if (t && !quota.learningTopics.includes(t)) quota.learningTopics.push(t);
  }
  quota.log.push({ at: Date.now(), kind: 'search', purpose, topic: String(topic ?? ''), query: String(query ?? '').slice(0, 120), tokens: Math.round(tokens) });
  if (quota.log.length > 100) quota.log = quota.log.slice(-100);
  return quota;
}

/** 记一次抓正文。 */
export function recordFetch(quota, { url = '', chars = 0, tokens = 0 }) {
  quota.tokens += Math.max(0, Math.round(tokens));
  quota.log.push({ at: Date.now(), kind: 'fetch', url: String(url).slice(0, 200), chars, tokens: Math.round(tokens) });
  if (quota.log.length > 100) quota.log = quota.log.slice(-100);
  return quota;
}

export function quotaView(quota, limits) {
  return {
    date: quota.date,
    searches: `${quota.searches}/${limits.maxSearchesPerDay}`,
    curiosity: `${quota.curiosity}/${limits.maxCuriosityPerDay}`,
    learningTopics: `${quota.learningTopics.length}/${limits.maxLearningTopicsPerDay}`,
    learningRounds: quota.learningRounds,
    tokens: `${quota.tokens}/${limits.maxTokensPerDay}`,
    remainingSearches: remainingSearches(quota, limits),
  };
}

/** 从 config.json 的 webSearch.quota 读，缺省用 DEFAULT_LIMITS。 */
export function limitsFromConfig(cfg) {
  const q = cfg?.webSearch?.quota ?? {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    maxSearchesPerDay: num(q.maxSearchesPerDay, DEFAULT_LIMITS.maxSearchesPerDay),
    maxCuriosityPerDay: num(q.maxCuriosityPerDay, DEFAULT_LIMITS.maxCuriosityPerDay),
    maxLearningTopicsPerDay: num(q.maxLearningTopicsPerDay, DEFAULT_LIMITS.maxLearningTopicsPerDay),
    maxTokensPerDay: num(q.maxTokensPerDay, DEFAULT_LIMITS.maxTokensPerDay),
    fetchMaxChars: num(q.fetchMaxChars, DEFAULT_LIMITS.fetchMaxChars),
  };
}
