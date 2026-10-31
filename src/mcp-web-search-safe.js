// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` / `web_fetch` / `web_quota`：查网络用语/梗/黑话、抓网页正文、看额度。
// - 不暴露任何本地文件、命令执行、写操作。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
// - 搜索：优先走 **DSH 同一路 DeepSeek 联网搜索**（src/web-search.js：同一端点/模型/
//   服务端 web_search 工具，凭据取 config/env/DSH 的 .credentials.yaml），
//   不可用时回退 Bing（RSS 优先）。搜索词不再默认发给 Bing。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
// - 搜索结果/抓取结果仅作为“候选解释”，最终是否入库仍由控制台人工确认。
//
// 2026-10-20 加的额度（见 web-quota.js）：每天 15 次搜索（学习轮 + 好奇搜索共用）、
// 好奇搜索单独 ≤2 次、学习话题 ≤5 个、当日 token ≤3000 万、单次抓正文只留 3000 字。
// 额度按**本地日期**归零；超了就直接拒绝，不靠提示词自觉。
import fs from 'node:fs';
import path from 'node:path';
import { safeFetch } from './safe-fetch.js';
import { webSearch } from './web-search.js';
import {
  loadQuota,
  saveQuota,
  checkSearchAllowed,
  recordSearch,
  recordFetch,
  estimateTokens,
  quotaView,
  limitsFromConfig,
} from './web-quota.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * 项目根目录（用于读 config.json 的 webSearch 段）。
 *
 * 不能用 `import.meta.url`：离线测试会把本文件塞进 vm 上下文执行（那里没有 import.meta，
 * 直接是语法错误）。DSH 以 `node <本文件绝对路径>` 启动 MCP，所以 argv[1] 就是本文件；
 * 取它的上一级 `src/` 的父目录即可。取不到时退回 cwd（测试环境正好从仓库根运行）。
 */
function projectRoot() {
  try {
    const entry = String(process.argv[1] ?? '');
    if (entry) {
      const dir = path.dirname(path.resolve(entry));
      if (path.basename(dir) === 'src') return path.dirname(dir);
    }
  } catch {}
  return process.cwd();
}

/** 每次调用都重读 config：额度数字改了要能立刻生效，不用重启 MCP。 */
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot(), 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function quotaLine(quota, limits) {
  const v = quotaView(quota, limits);
  return `今日额度：搜索 ${v.searches}｜好奇 ${v.curiosity}｜学习话题 ${v.learningTopics}｜token ${v.tokens}`;
}

const server = new McpServer({ name: 'web-search-safe', version: '0.3.0' });

server.tool(
  'web_search',
  '只读联网搜索：优先使用与 DSH 相同的 DeepSeek 联网搜索（结果更准、不把群里的词发给搜索引擎广告网络），不可用时自动回退 Bing。返回标题/URL/摘要，不执行任何本地操作。有每日额度（默认 15 次/天，学习轮与好奇搜索共用）；purpose="learning" 时必须带 topic，且每天最多 5 个话题；purpose="curiosity" 每天最多 2 次。学习聊天里没出现过的东西，topicSource 必须用 "approved"（且先用 qq_request_learning 问管理员）。',
  {
    query: z.string().describe('要搜索确认的网络用语/黑话/梗/事实性问题'),
    purpose: z.enum(['chat', 'learning', 'curiosity']).optional().describe('这次搜索属于哪种：chat=聊天里顺手查证（默认）；learning=学习轮；curiosity=自己好奇想查'),
    topic: z.string().optional().describe('purpose=learning 时必填：这个话题的名字（同一个话题只算一个，最多 5 个/天）'),
    topicSource: z.enum(['chat', 'approved']).optional().describe('purpose=learning 时：chat=最近聊天里出现过的；approved=自己想的、且管理员已经同意（默认 chat）'),
  },
  async ({ query, purpose, topic, topicSource }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    const root = projectRoot();
    const limits = limitsFromConfig(readConfig());
    const quota = loadQuota(root);
    const wanted = purpose || 'chat';
    const check = checkSearchAllowed(quota, limits, { purpose: wanted, topic, source: topicSource || 'chat' });
    if (!check.ok) {
      return { content: [{ type: 'text', text: `搜索被拒绝：${check.error}\n${quotaLine(quota, limits)}` }], isError: true };
    }
    try {
      const result = await webSearch(clean, { root });
      const text = JSON.stringify(result, null, 2);
      recordSearch(quota, { purpose: wanted, topic, query: clean, tokens: estimateTokens(text) });
      saveQuota(root, quota);
      return {
        content: [
          { type: 'text', text: quotaLine(quota, limits) },
          { type: 'text', text },
        ],
      };
    } catch (error) {
      // 搜索失败不扣次数（只有拿到结果才记账）
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页正文，**默认只返回前 3000 字符**（可用 maxChars 调小，不能调大）。禁止访问内网/本机地址，不执行任何本地操作。抓正文也计入当日 token 额度。',
  {
    url: z.string().describe('要抓取的 http(s) URL'),
    maxChars: z.number().optional().describe('想看多少字符（上限由每日额度决定，默认 3000）'),
  },
  async ({ url, maxChars }) => {
    const root = projectRoot();
    const limits = limitsFromConfig(readConfig());
    const quota = loadQuota(root);
    if (quota.tokens >= limits.maxTokensPerDay) {
      return { content: [{ type: 'text', text: `抓取被拒绝：今日 token 已用满（${quota.tokens}/${limits.maxTokensPerDay}）。` }], isError: true };
    }
    try {
      const result = await safeFetch(url);
      const cap = Math.max(200, Math.min(Number(maxChars) || limits.fetchMaxChars, limits.fetchMaxChars));
      const body = String(result.body ?? '');
      const sliced = body.length > cap ? body.slice(0, cap) : body;
      const payload = {
        url: result.url,
        statusCode: result.statusCode,
        truncated: Boolean(result.truncated) || body.length > cap,
        chars: sliced.length,
        sourceChars: body.length,
        body: sliced,
      };
      const text = JSON.stringify(payload, null, 2);
      recordFetch(quota, { url: result.url, chars: sliced.length, tokens: estimateTokens(text) });
      saveQuota(root, quota);
      return {
        content: [
          { type: 'text', text: quotaLine(quota, limits) },
          { type: 'text', text },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_quota',
  '查看今天联网搜索还剩多少额度（搜索次数、好奇次数、学习话题、token）。想知道还能不能查东西时先看它。',
  {},
  async () => {
    const root = projectRoot();
    const limits = limitsFromConfig(readConfig());
    const quota = loadQuota(root);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ ...quotaView(quota, limits), learningTopicsUsed: quota.learningTopics }, null, 2),
      }],
    };
  }
);

await server.connect(new StdioServerTransport());
