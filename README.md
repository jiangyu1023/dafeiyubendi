# 大肥鱼 · QQ 情感陪伴系统

> 基于 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 修改的 QQ AI 陪伴机器人。
> 在她之上加了记忆、情绪、好感、语音、唱歌、空间动态、管理面板和一整套运维脚本。

**License: MIT**

---

## 这是什么

一个跑在你自己电脑上的 QQ AI 陪伴机器人。她能：

- 在群里/私聊里像人一样聊天，会潜水、会主动开口、会接梗
- **记住**聊过的事（原文永久保存 + 日记 + 每人一份档案）
- 有**情绪**（10 种，会随时间淡出）和**好感度**（对每个人的态度不同）
- 会**发语音**（edge-tts / GPT-SoVITS）、会**唱歌**（RVC 换音色）
- 会发**说说**、点赞、评论
- 有一套**网页管理面板**（本机 3200 端口）

底层架构没变：**QQ 消息 → SnowLuma 网关 → 桥接 → DeepSeek Harness → 回复**。

---

## 架构

```
QQ ←→ SnowLuma（OneBot v11 网关，3000/3001）
        ↕
     桥接 bridge.js（3100）
        ↕  Cookie 鉴权 / 斜杠 RPC / 远程事件流
     DeepSeek Harness（模型、会话、工具循环）
        ↕
     记忆库 / 日记 / 档案 / 控制面板（3200）
```

| 组件 | 作用 | 端口 |
| --- | --- | --- |
| **SnowLuma** | QQ 登录与 OneBot 协议 | 3000 / 3001 / 5099 |
| **桥接 bridge.js** | 调度、记忆、情绪、工具、面板 API | 3100 |
| **DeepSeek Harness** | 模型推理与会话管理 | 动态 |
| **控制面板** | 网页管理 | 3200 |
| **ASR（可选）** | 语音转文字 | 9881 |

---

## 依赖清单

### 必需

| 依赖 | 说明 |
| --- | --- |
| **Node.js 20+** | 运行桥接 |
| **[DeepSeek Harness](https://github.com/deepseek-ai)** | 桌面版，负责模型与工具循环（需要图形界面） |
| **[SnowLuma](https://github.com/SnowLuma/SnowLuma)** | QQ 网关，需扫码登录 |
| **DeepSeek API Key** | DSH 调用模型用 |

### 可选（按功能）

| 功能 | 额外依赖 | 大小 |
| --- | --- | --- |
| **发语音（edge）** | Python 3 + `pip install edge-tts` | ~32 MB |
| **画图** | 图片生成 API Key（如阿里云百炼） | — |
| **联网搜索** | DeepSeek API Key / Bing | — |
| **唱歌（原唱）** | ffmpeg + demucs（含 PyTorch） | ~3 GB |
| **唱歌（换音色）** | 再加 RVC 环境 + 音色模型（.pth/.index） | +1–2 GB |
| **听语音（ASR）** | funasr / whisper | ~1–2 GB |
| **语音克隆** | GPT-SoVITS 环境 | ~2 GB |

**核心功能（聊天、记忆、面板）零额外依赖。**

---

## 安装

### 1. 装 Node.js 20+

从 [nodejs.org](https://nodejs.org/) 下载 LTS 版。

### 2. 装 DeepSeek Harness

安装桌面版，登录并配置 API Key。

### 3. 装 SnowLuma（**需你手动完成**）

> ⚠️ **本程序不会代你安装或启动 SnowLuma。**
> 其 EULA §5.4 规定：并入第三方安装包、Docker 镜像或**通过自动化脚本部署**，须先取得书面授权。
> 所以本程序**只检测、不部署**。

1. 打开 <https://github.com/SnowLuma/SnowLuma/releases>
2. 自己下载对应平台压缩包（Windows 选 `win-x64.zip`）
3. **自己解压**到任意目录，确认里面有 `index.mjs` 和 `launcher.bat`
4. **自己双击** `launcher.bat`
5. 打开 WebUI（默认 `http://127.0.0.1:5099`），**手机 QQ 扫码登录**
6. 记下 WebUI 里的 **access token**，下一步要用

📖 完整图文步骤见 **[docs/安装指南.md](docs/安装指南.md)**

### 4. 配置

```powershell
Copy-Item config.example.json config.json
```

编辑 `config.json`，**至少填这几项**：

| 字段 | 说明 |
| --- | --- |
| `dsh.baseUrl` | DSH 的端口，如 `http://127.0.0.1:56789` |
| `snowluma.accessToken` | SnowLuma 的 OneBot access token |
| `ownerQQ` | 你的 QQ 号（管理员） |
| `allow.groups` | 允许的群号数组 |
| `allow.private` | 允许私聊的 QQ 号数组 |
| `socialV2.imageGen.apiKey` | 要画图才填 |

### 5. 启动

```powershell
# 一键启动全部服务
scripts\一键恢复.bat
```

打开 <http://127.0.0.1:3200> 查看控制面板。

### 6.（可选）装语音

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-voice.ps1
```

---

## 功能一览

### 聊天

| 能力 | 说明 |
| --- | --- |
| 群聊 / 私聊 | 白名单控制，其他一律不理 |
| 唤醒判断 | @、名字、提问、关键词、熟人、概率 |
| 潜水 / 活跃 | 可自动切换，也可由她自主决定 |
| 分条发送 | 群聊最多 8 条、私聊最多 20 条，间隔随机 |
| 主动开口 | 冷场一段时间后有概率主动说话 |
| 被叫必应 | @ 她的消息永不丢弃 |

### 记忆

| 层 | 存在哪 | 寿命 |
| --- | --- | --- |
| **原文** | `memory/sessions/<会话>/<日期>.jsonl` | 永久，不删 |
| **日记** | `data/日记/日记.jsonl` | 永久 |
| **档案** | `data/群友档案/<QQ>.md` | 永久 |
| **索引** | 进程内存（启动时加载） | 随进程 |

- 检索：**标签优先 → 全文匹配**，不做模糊兜底
- 归档：上下文超过阈值或每天 4 点，她先写日记/档案，再重置会话
- 日记必带 `eventDay`（事情真正发生的日期）和 `sources`（原始消息 id）

### 情绪与好感

| 项 | 说明 |
| --- | --- |
| 情绪 | 10 种 + 强度，会随时间线性淡出 |
| 好感 | 每人 0–100，基线 50，单日变化上限 ±10 |
| 联动 | 好感影响说话态度；情绪放大好感变化（开心 ×1.2 / 生气 ×1.5） |
| 留痕 | 每条好感变化都附原始消息 id 区间 |

### 语音

| 功能 | 链路 |
| --- | --- |
| **说话** | edge-tts（微软音色）或 GPT-SoVITS 克隆 |
| **唱歌（rvc）** | 网易云下载 → demucs 分离 → RVC 换音色 → 混音 |
| **唱歌（original）** | 同上但不换音色（没装 RVC 也能用） |
| **听语音** | 本地 ASR 转文字（可选） |

### 其他

- **空间动态**：发说说、点赞、评论（有每日限额）
- **表情包**：会发表情、会收藏、记备注
- **画图**：接入图片生成 API，多套 Key 可切换
- **黑话学习**：自动积累群里的梗
- **每日小报**：每天早上 7 点把昨天的数据发给你

---

## 控制面板

<http://127.0.0.1:3200>（仅本机）

| 页面 | 内容 |
| --- | --- |
| 总览 | 服务状态、消息量、情绪、备份 |
| 会话 / 消息 | 看聊天记录，按会话筛选 |
| 功能 | 15 个分类卡片，开关 + 参数（改完立即生效） |
| 人设 | 直接编辑人设卡，保存即生效（自动备份） |
| 网关 | 内嵌 SnowLuma 界面（反代，可扫码/看状态） |
| 白名单 / 黑名单 | 增删允许的群和好友 |
| 记忆 / 关系 | 记忆索引、好感排行 |
| 日志 / 任务 | 实时日志、后台任务 |

**特性**：浅色/深色切换、所有工具中文名、新工具自动上架。

---

## 目录结构

```
qq-bridge/
├─ src/                 # 桥接与 MCP 服务
│  ├─ bridge.js         # 主程序（调度、记忆、情绪、工具）
│  ├─ mcp-*.js          # MCP 工具服务
│  └─ group-quota.mjs   # （示例）可插拔的功能模块
├─ tools/               # 面板、备份、小报、验证脚本
│  ├─ console-panel.mjs # 控制面板服务
│  └─ panel/index.html  # 面板前端
├─ roles/               # 人设卡
├─ scripts/             # 启动/安装/维护脚本
├─ docs/                # 设计文档
├─ config.example.json  # 配置模板
└─ README.md
```

**运行时目录（不进仓库）**：`state/`、`memory/`、`data/`、`audio/`、`backup/`

---

## 常用操作

| 要做的事 | 命令 |
| --- | --- |
| 启动全部服务 | `scripts\一键恢复.bat` |
| 只重启桥接 | `qq-bridge\restart.bat` |
| 全接口体检 | `node tools\verify-all.mjs` |
| 手动备份 | `powershell -File tools\backup.ps1` |
| 校验备份 | `powershell -File tools\verify-backup.ps1` |
| 看今日小报 | `node tools\daily-report.mjs` |

---

## 安全与隐私

- **所有数据都在本地**：聊天记录、日记、档案不上传任何服务器
- **API Key 只在本地配置文件里**，不要提交到仓库
- **面板只监听 127.0.0.1**，外网访问不到
- **白名单机制**：不在名单里的群和人不理

> 备份默认保留 30 天（每 8 小时一个），磁盘损坏时最多回滚 30 天。

---

## 常见问题

**Q：没有 DSH 能用吗？**
不能，DSH 是"大脑"，没有它桥接无法生成回复。

**Q：一定要显卡吗？**
不用。聊天和语音都是云端 API；只有唱歌（demucs/RVC）会吃 CPU/内存。

**Q：能装在服务器上吗？**
DSH 是桌面应用需要图形界面，纯命令行服务器跑不起来。

**Q：支持多账号吗？**
当前版本单账号。要多开需要复制整套实例（网关+桥接+面板各占端口）。

---

## 致谢

- **[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)** —— 本项目的基础，QQ ↔ DSH 的桥接与鉴权、工具协议都来自这里
- **[SnowLuma](https://github.com/SnowLuma/SnowLuma)** —— QQ 网关
- **[DeepSeek Harness](https://github.com/deepseek-ai)** —— agent 运行时
- edge-tts / RVC / demucs / ffmpeg 等开源项目

本项目基于 Derpyu520/qq-bridge 修改，同样以 **MIT** 协议开源。

---

## 合规提醒

SnowLuma 是独立第三方项目，与腾讯/QQ 无隶属关系，仅供学习与技术研究；使用前请阅读其 EULA 与《QQ 用户协议》。
