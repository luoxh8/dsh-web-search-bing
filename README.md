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
DeepSeek 额度照样被扣。这个插件把搜索后端换成 Bing 的公开接口，从而把这条路径
彻底切断。

## 它怎么工作

| seam 契约 | 实现 |
|---|---|
| `id` | `bing` |
| `available()` | 本地检查（至少一个候选 URL 合法、超时为正），**不看任何凭据** |
| `search({query,maxResults})` | 依次尝试候选主机 × 传输方式，返回 `{sources:[{url,title,snippet,publishedAt}],truncated:false}` |

尝试顺序（第一个产出非空结果的就返回）：

1. `baseURL`（默认 `https://www.bing.com/search`）+ `format=rss` —— 免 API key、免登录、国内可直连，实测 ~0.8s / 10 条
2. 同一主机的 HTML 结果页（解析 `li.b_algo`）
3. `fallbackBaseURL`（默认 `https://cn.bing.com/search`）+ RSS
4. 备用主机的 HTML 结果页

其他行为：

- 只发 `GET`，不改写重定向，`AbortSignal` 全程透传，内部超时兜底 20s。
- **返回空结果的响应被视为"这次尝试失败"**，而不是"没有结果"——Bing 被限流时会回
  一个格式正确但没有 `<item>` 的文档，把它当答案会把故障藏起来。
- 全部尝试都失败时抛带 `code` 的 `WebError`（`WEB_PROVIDER_ERROR`，取消是 `WEB_ABORTED`）。
- 无第三方依赖；`@deepseek-ai/dsh-web` 只用来取 `WebError` 类，取不到就退回带 `code` 的原生 `Error`。

## 安装

**依赖声明（推荐，一次做完）**：在 DSH profile 的 `package.json` 里加一行
（`%APPDATA%\dsh-desktop\harness\profiles\web\package.json`）：

```json
"dependencies": {
  "dsh-web-search-bing": "link:D:/codex_proj/dev/projects/dsh-web-search-bing"
}
```

这样 pnpm 在 profile 里做任何 install 都会保留它；包通过 `node_modules` 里的链接解析到本仓库。

**兜底（`install.ps1`）**：如果那一行被插件市场重写掉了、或者链接被删了，
`.\install.ps1` 用目录联接（junction）直接把本目录挂回 profile 的 `node_modules`，幂等可重跑。

**然后**在 profile 的 `cordis.patch.yml` 里注册 provider 并指向它：

```yaml
- insert:
    - id: web-search-bing
      name: dsh-web-search-bing
      config:
        baseURL: https://www.bing.com/search
        fallbackBaseURL: https://cn.bing.com/search
        market: zh-CN
        count: 10
        timeoutMs: 20000
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: bing
    fetchProvider: http        # 覆盖会替换整个 config，必须一并写出
```

改完由 profile HMR 热应用（若未生效则重启 DSH Desktop）。

## 配置项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `baseURL` | `https://www.bing.com/search` | 首选搜索端点 |
| `fallbackBaseURL` | `https://cn.bing.com/search` | 备用主机；设成空串可关掉回退 |
| `market` | `zh-CN` | 传给 Bing 的 `mkt` |
| `count` | `10` | 请求条数（会被 `maxResults` 抬高，上限 50） |
| `timeoutMs` | `20000` | 单次请求超时 |
| `userAgent` | Chrome/Win64 UA | 请求头 |

## 验证

```powershell
# 18 项：真打 Bing + 回退链路 + 两个解析器的离线用例
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
  `WEB_PROVIDER_ERROR`，**不会**回退到 DeepSeek——这是刻意的，宁可搜索失败也不偷偷计费。
- Bing RSS 结果质量弱于专用搜索 API（长查询匹配差、约 10 条上限）。
- 无搜索深度、时间范围、站点过滤等参数——seam 的请求类型本身只有 `query` 与 `maxResults`。

## 许可

MIT。
