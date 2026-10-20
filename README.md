# dsh-web-search-bing

给 DeepSeek Harness 的 web 能力 seam（`ctx.web`）用的**免密钥 Bing 搜索 provider**。

> **为什么需要它：DSH 默认的联网搜索要花钱**——`searchProvider: deepseek-official` 每搜一次都是一次
> 付费的 DeepSeek 请求（按额度扣费，与聊天用哪个模型无关）。这个插件把搜索换成 Bing 的公开接口，
> **免密钥、不计费**，失败时报错也不回退到付费后端。

> **国际版优先**：默认先打 `www.bing.com`，连不上或没结果才回退 `cn.bing.com`。
> 注意 `www` 在部分网络会被上游 302 到 `cn.bing.com`，那是 Bing 的按 IP 分流，不是配置问题。

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

尝试顺序（**第一个产出非空结果的就返回**，所以国内网络下第一步就命中）：

| 顺序 | 主机 | 传输 | 说明 |
|---|---|---|---|
| 1 | `cn.bing.com` | RSS（`format=rss`） | **默认首选**——国内直连，免 key、免登录，实测 ~0.8s / 10 条 |
| 2 | `cn.bing.com` | 结果页 HTML（解析 `li.b_algo`） | RSS 挂了或没条目时兜底 |
| 3 | `www.bing.com` | RSS | 前两步都失败时才走国际站 |
| 4 | `www.bing.com` | 结果页 HTML | 最后一道 |

其他行为：

- 只发 `GET`，不改写重定向，`AbortSignal` 全程透传，内部超时兜底 20s。
- **返回空结果的响应被视为"这次尝试失败"**，而不是"没有结果"——Bing 被限流时会回
  一个格式正确但没有 `<item>` 的文档，把它当答案会把故障藏起来。
- 全部尝试都失败时抛带 `code` 的 `WebError`（`WEB_PROVIDER_ERROR`，取消是 `WEB_ABORTED`）。
- 无第三方依赖；`@deepseek-ai/dsh-web` 只用来取 `WebError` 类，取不到就退回带 `code` 的原生 `Error`。

## 在插件管理页看到的描述

插件管理页（侧栏 **插件**）显示的标题与描述来自 `locale/zh.json` 与 `locale/en.json`
的 `meta.title` / `meta.description`，由 DSH 的 `readPluginMeta()` 通过 Node
`exports` 读取（所以 `package.json` 里有 `"./locale/*.json": "./locale/*.json"`）。
缺少这两个字段时才回退到 `package.json` 的 `description`——那行是英文、且面向
npm 索引而非界面，所以界面文案一律写在 locale 文件里。`en.json` 必须有：
它同时是其他语言的英文兜底。

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
`.\install.ps1` 用目录联接（junction）直接把本目录挂回 profile 的 `node_modules`，幂等可重跑，
并会顺带报告 `package.json` 里的声明还在不在。

**然后**在 profile 的 `cordis.patch.yml` 里注册 provider 并指向它：

```yaml
- insert:
    - id: web-search-bing
      name: dsh-web-search-bing
      config:
        baseURL: https://www.bing.com/search        # 国际版优先（2026-10-21 起的默认）
        fallbackBaseURL: https://cn.bing.com/search # 国内站兜底
        market: zh-CN
        count: 20        # 目标条数：不足时自动翻续页
        pages: 5         # 最多翻几页
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
| `baseURL` | `https://www.bing.com/search` | **首选端点（国际版）**；`www` 在部分网络会被 302 到 `cn.bing.com`，这是上游行为 |
| `fallbackBaseURL` | `https://cn.bing.com/search` | 备用端点；设成空串可关掉回退，只用一个主机 |
| `market` | `zh-CN` | 传给 Bing 的 `mkt` |
| `count` | `10` | 目标条数（会被 `maxResults` 抬高，上限 50） |
| `pages` | `5` | 最多翻几页续页（1–10）；翻页只沿结果页自己给出的 `first=` 链接走，因为手拼 `first=` 会被无视 |
| `timeoutMs` | `20000` | 单次请求超时 |
| `userAgent` | Chrome/Win64 UA | 请求头 |

想让国内站优先（例如网络到国际站更差），把前两个字段的值对调即可。

## 验证

```powershell
# 21 项：真打 Bing + 回退链路 + 分页链接 + 两个解析器的离线用例
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
- Bing RSS 结果质量弱于专用搜索 API（长查询匹配差）。
- **实测上限（2026-10-21，大陆网络）**：`www.bing.com` 会 302 到 `cn.bing.com`；该端点每次只给
  **8–10 条**，并且**无视 `first` / `count` / `mkt` / 日期筛选**（续页链接返回同一批结果，连同 Cookie
  回放也一样），`ensearch=1` 只是同一批结果的一个子集。所以 `count: 20` 在这条网络上拿不到 20 条；
  翻页代码是为"上游真给多页"的网络准备的，且**绝不编造结果**。另外 DSH 的 `web_search` 工具
  自身还有 `searchMaxResults`（默认 8）的截断，属于 preset 内建，不在本插件控制范围。
- 无搜索深度、时间范围、站点过滤等参数——seam 的请求类型本身只有 `query` 与 `maxResults`。

## 许可

MIT。
