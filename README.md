# dsh-web-search-bing

给 DeepSeek Harness 的 web 能力 seam（`ctx.web`）用的**免密钥 Bing 搜索 provider**。

## 为什么有这个东西

DSH 的 base bundle 把联网搜索固定成了 DeepSeek 官方：

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-official
    fetchProvider: http
- id: web-search-deepseek
  name: '@deepseek-ai/dsh-web-search-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY     # 与聊天共用同一把 key
```

DSH 源码注释写得很直白：搜索是 *"a full auxiliary model request with
server-side retrieval"*——**每次 `web_search` 都是一次独立的、直连 DeepSeek 的模型
请求**，只认 `DEEPSEEK_API_KEY`，与你在模型选择器里选的模型（WorkBuddy 的
hy3 / hy4-preview、GLM、Kimi…）**毫无关系**。

结果就是：把聊天模型全换成 WorkBuddy 之后，只要模型触发一次联网搜索，你的
DeepSeek 额度照样被扣。这个插件把搜索后端换成 Bing 的公开 RSS 接口，从而把
这条路径彻底切断。

## 它怎么工作

| seam 契约 | 实现 |
|---|---|
| `id` | `bing` |
| `available()` | 本地检查（URL 合法、超时为正），**不看任何凭据** |
| `search({query,maxResults})` | 请求 `https://www.bing.com/search?q=…&format=rss`，解析 `<item>` → `{sources:[{url,title,snippet,publishedAt}],truncated:false}` |

- 主通道是 Bing 的 RSS 输出（免 API key、免登录、国内可直连；实测 ~0.8s / 10 条）。
- RSS 返回 0 条或失败时，回退抓同一端点的 HTML 结果页（解析 `li.b_algo`）。
- 只发 `GET`，不做重定向外的任何改写，`AbortSignal` 全程透传，内部超时兜底 20s。
- 无第三方依赖、无宿主包硬依赖（`@deepseek-ai/dsh-web` 仅用于错误类型，取不到就退回带 `code` 的原生 `Error`）。

## 安装

```powershell
# 1) 把包挂进 DSH profile 的 node_modules（幂等）
.\install.ps1

# 2) profile 的 cordis.patch.yml 里插入 provider 行并把 web 指过去
#    见下方“配置”一节
```

`install.ps1` 之所以必要：DSH profile 用 pnpm，`node_modules` 里没被
`package.json` 依赖声明的条目会在任何一次 `pnpm install`（插件市场装/升/删插件
时都会跑）后被清掉。那时重跑一次脚本即可。

## 配置

在 `%APPDATA%\dsh-desktop\harness\profiles\web\cordis.patch.yml` 里加：

```yaml
- insert:
    - id: web-search-bing
      name: dsh-web-search-bing
      config:
        baseURL: https://www.bing.com/search   # 可换 https://cn.bing.com/search
        market: zh-CN
        count: 10
        timeoutMs: 20000
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: bing
    fetchProvider: http        # 覆盖会替换整个 config，必须一并写出
```

改完由 profile HMR 热应用，无需重启（若未生效则重启 DSH Desktop）。

## 验证

```powershell
# 离线 + 真打 Bing 的契约测试（15 项）
node test\search.test.mjs
```

端到端判据：在 DSH 里触发一次 `web_search`，
`%APPDATA%\dsh-desktop\harness\.dsh-usage-ledger.json` 的 `searchCalls` / `cost`
**不应有任何增长**；返回的 sources 若带 RFC822 日期（如 `周五, 09 10月 2026 22:46:00 GMT`）
即本 provider 的输出特征。

## 回退

删掉 `cordis.patch.yml` 里的 `- insert:` 与 `- id: web` 两块即可恢复 DeepSeek 搜索
（原文件备份在 `%APPDATA%\dsh-desktop\harness\backups\`）。

## 已知限制

- 依赖 Bing 私有端点（RSS 与结果页 HTML），上游改版可能使其失效；失效时报
  `WEB_PROVIDER_ERROR`，**不会**回退到 DeepSeek。
- Bing RSS 结果质量弱于专用搜索 API（长查询匹配差、约 10 条上限）。
- 无搜索深度、时间范围、站点过滤等参数——seam 的请求类型本身只有
  `query` 与 `maxResults`。

## 许可

MIT。
