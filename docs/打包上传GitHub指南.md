# 打包上传 GitHub 指南

> 适用：把当前大肥鱼系统（qq-bridge + 记忆/情绪/面板）打包成开源仓库上传 GitHub。
> 核心原则：**先清钥匙和隐私，再推代码。**

---

## 一、绝对不要上传的内容

| 内容 | 位置 | 原因 |
| --- | --- | --- |
| **API Key** | `C:\Users\<你>\.dsh\.credentials.yaml` | DeepSeek / 平台凭据，绝不能进仓库 |
| **config.json 里的密钥** | `snowluma.accessToken`、`socialV2.imageGen.apiKey`、`webSearch.apiKey` | 泄露即被盗刷 |
| **聊天记录** | `memory\sessions\**` | 群友隐私，且无法撤回 |
| **日记 / 档案** | `data\日记`、`data\群友档案` | 真人信息（QQ、评价、好感） |
| **角色卡** | `roles\合一.md` | 含人设与私人细节，按需决定 |
| **运行状态** | `state\**`（console-token、mood、social-v2、balance） | 含会话令牌 |
| **备份包** | `backup\*.zip` | 把上面全部又打了一遍 |
| **依赖** | `node_modules/` | 体积巨大 |
| **媒体** | `audio\`、`images\`、`data\` 下的图片/音频 | 体积 + 隐私 |

---

## 二、标准流程

### 1. 建 `.gitignore`

```gitignore
node_modules/
backup/
state/
memory/
data/
audio/
images/
*.log
*.zip
config.local.json
.credentials*
```

### 2. 提供配置模板

```powershell
Copy-Item config.json config.example.json
```

然后把 `config.example.json` 里所有 `apiKey` / `accessToken` / `consoleToken` 清空成 `""`。

**README 里写明：复制 example 成 config.json，再自己填。**

### 3. 写 README

至少包含四件事：

1. 这是什么（一句话）
2. 依赖环境（Node 版本、DSH、SnowLuma、可选 ASR）
3. 安装步骤（装依赖 → 改配置 → 启动脚本）
4. 目录说明（哪些是代码、哪些是运行时数据）

### 4. 加 LICENSE

| 选择 | 含义 |
| --- | --- |
| **MIT** | 别人随便用、改、商用 |
| **AGPL-3.0** | 改过的也必须开源（保护性更强） |

### 5. 初始化并推送

```powershell
cd <你的目录>\qq-bridge
git init
git add .
git commit -m "init: 大肥鱼 QQ 陪伴系统"
```

**有 GitHub CLI：**

```powershell
gh repo create dafeiyu --public --source=. --push
```

**没有 gh：** 网页建仓库后

```powershell
git remote add origin https://github.com/你的用户名/仓库名.git
git branch -M main
git push -u origin main
```

---

## 三、推之前必做的检查

```powershell
# 搜密钥
git grep -n -E "sk-[A-Za-z0-9]{20,}"

# 搜令牌
git grep -n -E "accessToken|consoleToken|apiKey" -- config.example.json

# 搜聊天内容（应无结果）
git grep -n -l "私聊\|group:" -- memory data
```

**任何一条有输出 → 停下，先处理干净。**

---

## 四、注意事项

| 项 | 说明 |
| --- | --- |
| **第三方软件别打包** | DSH、SnowLuma 都是别人的桌面程序，README 写"需自行安装" |
| **聊天记录推上去就收不回** | 即使后续删掉，历史提交里仍在 |
| **先私有再公开** | 建私有仓库 → 确认干净 → 改 public |
| **大文件用 LFS** | 若要放示例音频，`git lfs track "*.wav"` |
| **不要放 cookie/token 截图** | 文档里贴图前先打码 |

---

## 五、推荐仓库结构

```
dafeiyu/
├─ README.md
├─ LICENSE
├─ .gitignore
├─ config.example.json
├─ bridge\                 # src/bridge.js、MCP 服务
│  ├─ src\
│  ├─ tools\               # 面板、备份、小报、测试脚本
│  └─ roles\               # 人设卡模板（可脱敏）
├─ scripts\                # 启动/恢复批处理
└─ docs\                   # 设计文档
```

---

## 六、一句话总结

**先删掉 `.credentials`、config 里的 key、memory/data/state/backup，再写 README + .gitignore，然后 `git init → push`；最稳是先开私有仓库，用 `git grep sk-` 扫一遍确认没漏，再转公开。**
