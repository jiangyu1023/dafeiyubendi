// 工具分组 + 可调参数（真实绑定到 config.json 里已有字段）
// 说明：只有“代码里真的会读”的字段才放参数，避免面板改了不生效。

export const TOOL_GROUPS = [
  { id: 'g_msg', name: '消息收发', icon: '✉' },
  { id: 'g_read', name: '看消息', icon: '👀' },
  { id: 'g_group', name: '群与成员', icon: '👥' },
  { id: 'g_mem', name: '记忆与档案', icon: '🧠' },
  { id: 'g_emoji', name: '表情与图片', icon: '😀' },
  { id: 'g_voice', name: '说话', icon: '🔊' },
  { id: 'g_learn', name: '学习与搜索', icon: '🌐' },
  { id: 'g_misc', name: '其他', icon: '🧩' },
];

// 工具 → 分组
export const TOOL_GROUP_OF = {
  qq_send_message: 'g_msg', qq_send_group_message: 'g_msg', qq_send_private_message: 'g_msg',
  qq_reply: 'g_msg', qq_send_burst: 'g_msg', qq_wait_for_messages: 'g_msg',
  qq_mark_read: 'g_msg', qq_set_wake_config: 'g_msg', qq_send_poke: 'g_msg',
  qq_report_feedback: 'g_msg', qq_social_state: 'g_msg', qq_get_prompt: 'g_msg',
  qq_get_unread_messages: 'g_read', qq_get_recent_messages: 'g_read',
  qq_get_my_recent_messages: 'g_read', qq_get_message_detail: 'g_read',
  qq_get_message_images: 'g_read', qq_get_forward_msg: 'g_read',
  qq_get_active_members: 'g_group', qq_get_group_members: 'g_group',
  qq_get_group_history: 'g_group', qq_list_groups: 'g_group',
  diary_write: 'g_mem', diary_recent: 'g_mem', profile_save: 'g_mem',
  profile_get: 'g_mem', profile_list: 'g_mem', memory_search: 'g_mem',
  qq_memory_append: 'g_mem', qq_memory_query: 'g_mem', qq_memory_remove: 'g_mem',
  qq_memory_clear: 'g_mem', mood_set: 'g_mem',
  qq_collect_sticker: 'g_emoji', qq_list_stickers: 'g_emoji', qq_get_sticker_image: 'g_emoji',
  qq_sticker_note: 'g_emoji', qq_send_sticker: 'g_emoji', qq_set_sticker_remark: 'g_emoji',
  qq_send_image: 'g_emoji', qq_list_images: 'g_emoji', qq_get_library_image: 'g_emoji',
  qq_download_image: 'g_emoji', qq_get_self_image: 'g_emoji', qq_set_avatar: 'g_emoji',
  qq_send_voice: 'g_voice', qq_list_voices: 'g_voice', voice_say: 'g_voice',
  voice_voices: 'g_voice', qq_voice_tune: 'g_voice', qq_voice_confirm: 'g_voice',
  qq_request_learning: 'g_learn', web_search: 'g_learn', web_fetch: 'g_learn', web_quota: 'g_learn',
};

// 每个工具的可调参数（path 必须是代码真的读的字段）
export const TOOL_PARAMS = {
  qq_send_voice: [
    { path: 'socialV2.voice.enabled', label: '允许发语音', type: 'bool' },
    { path: 'socialV2.voice.backend', label: '合成引擎', type: 'select', options: ['gptsovits', 'edge'] },
    { path: 'socialV2.voice.gsvSpeed', label: '语速（1.0-1.5）', type: 'number', min: 0.8, max: 1.6, step: 0.05 },
    { path: 'socialV2.voice.maxSeconds', label: '语音最长几秒', type: 'number', min: 5, max: 300, step: 5 },
    { path: 'socialV2.voice.maxPerMinute', label: '每分钟最多几条', type: 'number', min: 1, max: 30, step: 1 },
    { path: 'socialV2.voice.maxPerHour', label: '每小时最多几条', type: 'number', min: 1, max: 120, step: 1 },
  ],

  qq_wait_for_messages: [
    { path: 'socialV2.wait.defaultMs', label: '默认等待（秒）', type: 'number', min: 5, max: 300, step: 5, scale: 1000 },
    { path: 'socialV2.wait.defaultQuietMs', label: '静默判定（秒）', type: 'number', min: 3, max: 60, step: 1, scale: 1000 },
  ],
  qq_send_message: [
    { path: 'socialV2.send.maxMessageChars', label: '群聊单条上限（字）', type: 'number', min: 50, max: 2000, step: 10 },
    { path: 'socialV2.send.privateMaxMessageChars', label: '私聊单条上限（字）', type: 'number', min: 50, max: 2000, step: 10 },
  ],
  qq_send_burst: [
    { path: 'socialV2.send.burstMaxMessages', label: '群聊最多分几条', type: 'number', min: 1, max: 30, step: 1 },
    { path: 'socialV2.send.privateBurstMaxMessages', label: '私聊最多分几条', type: 'number', min: 1, max: 30, step: 1 },
  ],
  qq_send_sticker: [
    { path: 'socialV2.sticker.groupAutoSendChance', label: '群聊自动发表情概率', type: 'number', min: 0, max: 1, step: 0.05 },
  ],
  qq_collect_sticker: [
    { path: 'socialV2.sticker.collect.maxPerHour', label: '每小时最多收藏几个', type: 'number', min: 1, max: 60, step: 1 },
  ],
  qq_send_image: [
    { path: 'socialV2.media.maxBytes', label: '图片最大（MB）', type: 'number', min: 1, max: 20, step: 1, scale: 1048576 },
  ],
  memory_search: [
    { path: 'socialV2.searchLimit', label: '每次返回几条', type: 'number', min: 1, max: 20, step: 1 },
  ],
  web_search: [
    { path: 'webSearch.maxUses', label: '每天搜索次数', type: 'number', min: 0, max: 100, step: 1 },
    { path: 'webSearch.maxResults', label: '每次结果条数', type: 'number', min: 1, max: 20, step: 1 },
  ],
  qq_request_learning: [
    { path: 'slang.extractMinMessages', label: '积累多少条提取一次', type: 'number', min: 2, max: 100, step: 1 },
  ],
};
