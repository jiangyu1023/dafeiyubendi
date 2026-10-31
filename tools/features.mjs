// 功能开关面板：分类 → 二级详情（开关 + 参数）
// 在 console-panel.mjs 中 import { FEATURES, readFeatures, writeFeature } 使用
import fs from 'node:fs';
import { TOOL_GROUPS, TOOL_GROUP_OF, TOOL_PARAMS } from './tool-groups.mjs';
import path from 'node:path';

const ROOT = process.env.FEISHU_ROOT || path.resolve(import.meta.dirname, '..');
const CONFIG = path.join(ROOT, 'config.json');



// 工具中文名（人工维护，优先于自动标签）
const TOOL_CN = {
  diary_write: '写日记', diary_recent: '看最近的日记',
  profile_save: '记档案', profile_get: '看某人的档案', profile_list: '看所有档案',
  memory_search: '搜记忆', mood_set: '改情绪',
  qq_send_message: '发消息', qq_send_group_message: '发群消息', qq_send_private_message: '发私聊',
  qq_reply: '引用回复', qq_send_burst: '分条连发', qq_wait_for_messages: '等对方说',
  qq_mark_read: '标记已读', qq_set_wake_config: '设置唤醒', qq_social_state: '看自身状态',
  qq_send_poke: '拍一拍', qq_report_feedback: '反馈问题',
  qq_get_prompt: '读人设', qq_get_unread_messages: '看未读', qq_get_recent_messages: '看最近消息',
  qq_get_my_recent_messages: '看自己说过', qq_get_message_detail: '看消息详情',
  qq_get_active_members: '看活跃成员', qq_get_group_members: '看群成员',
  qq_get_group_history: '看群历史', qq_list_groups: '看群列表',
  qq_get_message_images: '看图/表情', qq_get_forward_msg: '看转发',
  qq_memory_append: '记轻量记忆', qq_memory_query: '查轻量记忆',
  qq_memory_remove: '删轻量记忆', qq_memory_clear: '清轻量记忆',
  qq_slang_query: '查黑话', qq_slang_submit: '提交黑话',
  qq_collect_sticker: '收藏表情', qq_get_sticker_image: '看表情',
  qq_list_stickers: '表情列表', qq_sticker_note: '记表情含义', qq_send_sticker: '发表情',
  qq_set_sticker_remark: '改表情备注',
  qq_send_image: '发图片', qq_list_images: '图片列表', qq_get_library_image: '看图片',
  qq_download_image: '下载图片', qq_get_self_image: '看自己照片', qq_set_avatar: '换头像',
  qq_send_voice: '发语音', qq_list_voices: '语音列表',
  qq_request_learning: '申请学习',
  web_search: '联网搜索', web_fetch: '读网页', web_quota: '搜索额度',
  qq_status: '看网关状态', qzone_comment: '补说说评论', qq_voice_confirm: '确认音色存档', qq_voice_tune: '调音色参数',
  qq_qzone_comment: '补说说评论', role_append: '追加人设', snowluma_status: '网关探活',
  voice_say: '说一句话', voice_voices: '看音色列表',

};

// 动态分类：所有 MCP 工具里没被手工分类覆盖的，自动出现在「其他工具」
function dynamicToolFeatures() {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'tool-registry.json'), 'utf8'));
    const tools = Array.isArray(reg.tools) ? reg.tools : [];
    if (!tools.length) return [];
    const byGroup = new Map();
    for (const t of tools) {
      const gid = TOOL_GROUP_OF[t.name] || 'g_misc';
      if (!byGroup.has(gid)) byGroup.set(gid, []);
      byGroup.get(gid).push(t);
    }
    const out = [];
    for (const g of TOOL_GROUPS) {
      const list = byGroup.get(g.id);
      if (!list || !list.length) continue;
      const fields = [];
      for (const t of list) {
        fields.push({
          path: 'socialV2.toolFlags.' + t.name + '.enabled',
          label: (TOOL_CN[t.name] || t.label || t.name).slice(0, 16),
          type: 'bool',
        });
        for (const p of (TOOL_PARAMS[t.name] || [])) fields.push(p);
      }
      out.push({ id: 'grp_' + g.id, name: g.name, icon: g.icon, desc: list.length + ' 个工具', fields });
    }
    return out;
  } catch { return []; }
}

export const FEATURES = [
  {
    id: 'draw', name: '画图', icon: '🎨', desc: '让她能自己画画',
    fields: [
      { path: 'socialV2.imageGen.enabled', label: '允许画图', type: 'bool' },
      { path: 'socialV2.imageGen.maxPerDay', label: '每天最多画几张', type: 'number', min: 0, max: 50, step: 1 },
      { path: 'socialV2.imageGen.allowFreeDraw', label: '允许画别的东西（无需授权）', type: 'bool' },
      { path: 'socialV2.imageGen.model', label: '画图模型', type: 'text' },
    ],
  },
  {
    id: 'qzone', name: '空间动态', icon: '💬', desc: '发说说、点赞、评论',
    fields: [
      { path: 'qzone.maxPerDay', label: '每天最多发几条说说', type: 'number', min: 0, max: 10, step: 1 },
      { path: 'qzone.minGapMs', label: '两条说说最少间隔（小时）', type: 'number', min: 0, max: 24, step: 0.5, scale: 3600000 },
      { path: 'qzone.maxCommentsPerPost', label: '每条说说最多补几条评论', type: 'number', min: 0, max: 20, step: 1 },
      { path: 'qzone.minCommentGapMs', label: '两条评论间隔（分钟）', type: 'number', min: 0, max: 120, step: 1, scale: 60000 },
      { path: 'qzone.minReplyGapMs', label: '两条回复间隔（分钟）', type: 'number', min: 0, max: 120, step: 1, scale: 60000 },
    ],
  },
  {
    id: 'learn', name: '学习系统', icon: '📚', desc: '黑话、上网查资料',
    fields: [
      { path: 'slang.enabled', label: '允许学黑话', type: 'bool' },
      { path: 'slang.autoResearch', label: '自动联网查证黑话', type: 'bool' },
      { path: 'slang.extractMinMessages', label: '积累多少条消息后提取一次', type: 'number', min: 2, max: 100, step: 1 },
      { path: 'slang.injectMax', label: '每次最多注入几个黑话', type: 'number', min: 0, max: 30, step: 1 },
      { path: 'webSearch.maxUses', label: '每天联网搜索次数', type: 'number', min: 0, max: 100, step: 1 },
    ],
  },

  {
    id: 'signature', name: '个性签名', icon: '✍', desc: '她可以按心情改签名，有每日上限',
    fields: [
      { path: 'socialV2.signature.enabled', label: '允许改签名', type: 'bool' },
      { path: 'socialV2.signature.dailyLimit', label: '每天最多改几次', type: 'number', min: 0, max: 20, step: 1 },
    ],
  },
  {
    id: 'report', name: '每日小报', icon: '📰', desc: '每天早上发昨日总结（时间由 Windows 计划任务控制）',
    fields: [
      { path: 'dailyReport.enabled', label: '开启每日小报', type: 'bool' },
      { path: 'dailyReport.hour', label: '几点发送（0-23，改完要同步计划任务）', type: 'number', min: 0, max: 23, step: 1 },
      { path: 'dailyReport.to', label: '发给谁（private:QQ号）', type: 'text' },
    ],
  },
  {
    id: 'persona', name: '情绪', icon: '🫧', desc: '情绪怎么变、多久淡出',
    fields: [
      { path: 'socialV2.mood.fadeEnabled', label: '情绪会自己淡出', type: 'bool' },
      { path: 'socialV2.mood.minHoldMs', label: '最短保鲜（分钟）', type: 'number', min: 1, max: 240, step: 1, scale: 60000 },
      { path: 'socialV2.mood.rates.生气', label: '生气每小时降多少', type: 'number', min: 0.01, max: 1, step: 0.01 },
      { path: 'socialV2.mood.rates.失落', label: '失落每小时降多少', type: 'number', min: 0.01, max: 1, step: 0.01 },
      { path: 'socialV2.mood.fadeThreshold', label: '低于多少算平静', type: 'number', min: 0, max: 1, step: 0.05 },
      { path: 'socialV2.mood.checkIntervalMs', label: '多久检查一次淡出（分钟）', type: 'number', min: 1, max: 120, step: 1, scale: 60000 },
    ],
  },
  {
    id: 'sing', name: '唱歌', icon: '🎤', desc: 'rvc=换成她的音色（需 RVC）；original=不换音色、直接用原唱（没装 RVC 也能用）',
    fields: [
      { path: 'socialV2.voice.singEngine', label: '唱歌方式', type: 'select', options: ['rvc', 'original'] },
      { path: 'socialV2.voice.singRvcModel', label: '唱歌音色（RVC 模型）', type: 'select', options: ['feiyu', 'feiyu-talk'] },
      { path: 'socialV2.voice.maxSeconds', label: '语音最长几秒', type: 'number', min: 5, max: 300, step: 5 },
      { path: 'socialV2.voice.maxPerHour', label: '每小时最多发几条语音', type: 'number', min: 1, max: 120, step: 1 },
      { path: 'socialV2.voice.defaultVolume', label: '默认音量', type: 'number', min: 0, max: 2, step: 0.1 },
    ],
  },

];

function getByPath(obj, p) {
  return p.split('.').map((k) => (/^\d+$/.test(k) ? Number(k) : k))
    .reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}
function setByPath(obj, p, val) {
  const keys = p.split('.').map((k) => (/^\d+$/.test(k) ? Number(k) : k));
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = typeof keys[i + 1] === 'number' ? [] : {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = val;
}

export function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
}

export function readFeatures() {
  const cfg = readConfig();
  return [...FEATURES, ...dynamicToolFeatures()].map((f) => ({
    id: f.id, name: f.name, icon: f.icon, desc: f.desc,
    fields: f.fields.map((fd) => {
      let v = getByPath(cfg, fd.path);
      if (fd.scale && typeof v === 'number') v = Math.round(v / fd.scale);
      if (v === undefined) v = fd.type === 'bool' ? true : '';
      return { ...fd, value: v };
    }),
  }));
}

export function writeFeature(pathStr, rawValue) {
  const all = [...FEATURES, ...dynamicToolFeatures()].flatMap((f) => f.fields);
  const fd = all.find((x) => x.path === pathStr);
  if (!fd) return { ok: false, error: '未知配置项' };
  const cfg = readConfig();
  let val = rawValue;
  if (fd.type === 'bool') val = rawValue === true || rawValue === 'true' || rawValue === 1;
  else if (fd.type === 'number') {
    val = Number(rawValue);
    if (!Number.isFinite(val)) return { ok: false, error: '必须是数字' };
    if (fd.min !== undefined) val = Math.max(fd.min, val);
    if (fd.max !== undefined) val = Math.min(fd.max, val);
    if (fd.scale) val = val * fd.scale;
  } else if (fd.type === 'select') {
    if (!fd.options.includes(String(rawValue))) return { ok: false, error: '取值不合法' };
    val = String(rawValue);
  } else val = String(rawValue);
  setByPath(cfg, pathStr, val);

  // 生图多套 API：始终把「当前使用的那套」同步到 imageGen.model / imageGen.apiKey
  try {
    const ig = cfg?.socialV2?.imageGen;
    if (ig && Array.isArray(ig.slots)) {
      const idx = Math.max(1, Math.min(ig.slots.length, Number(ig.activeSlot) || 1)) - 1;
      const cur = ig.slots[idx] || {};
      if (cur.model) ig.model = cur.model;
      if (cur.apiKey) ig.apiKey = cur.apiKey;
    }
  } catch { }

  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { ok: true, path: pathStr, value: val };
}
