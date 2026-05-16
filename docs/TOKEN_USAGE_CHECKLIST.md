# Token Usage 支持 Checklist

更新时间：2026-05-08

## 目标

所有需要统计 token 的调用都必须经过 `https://www.connectmulti.cc/api/proxy`。调用方可以不读取 token 字段；代理会从上游响应里解析 usage 并记录。

如果某个 App 直接请求模型厂商官方 API，而不是经过本代理，则本项目无法统计这次调用。

## Provider 覆盖

| Provider / 场景 | 当前路由 | 非流式 usage | 流式 usage | 当前状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| OpenAI 直连 | `provider=openai&path=chat/completions` | 已实测 | 已实测 | 可统计 | 流式需要 `stream_options.include_usage=true` 才能拿到最终 usage chunk |
| Gemini 直连 | `provider=gemini&path=...:generateContent` | 已支持 | 已支持 | 可统计 | 流式会自动把 `:generateContent` 改为 `:streamGenerateContent` |
| DeepSeek 火山 | `provider=deepseek` 或 `provider=deepseek_volcengine` | 已支持 | 待实测 | 基本可统计 | 使用火山 Ark endpoint 和 `DEEPSEEK_VOLCENGINE_API_KEY` |
| 豆包 / Ark | `provider=ark` 或 `provider=volcengine` | 已支持 | 待实测 | 基本可统计 | normalizer 支持 `doubao`，但路由目前还未接受 `provider=doubao` |
| Anthropic / Claude | `provider=claude`、`provider=anthropic`、`provider=claude-compatible` | 可从响应读取 | 可从流式读取 | 待补 normalizer | 当前 normalizer 没有 Anthropic 分支，token 可能被记为 0 |
| micu-gpt App 来源 | 请求头 `x-source-app: micu-gpt` | 已实测 | 待标记实测 | 可识别来源 | 这不是独立 provider，更像 source app / client 标识 |

## gpt-5.5 实测

测试入口：

```bash
https://www.connectmulti.cc/api/proxy?provider=openai&path=chat/completions
```

非流式请求使用 `model: "gpt-5.5"`，上游实际返回模型：

```text
gpt-5.5-2026-04-23
```

非流式响应包含标准 OpenAI usage：

```json
{
  "prompt_tokens": 13,
  "completion_tokens": 30,
  "total_tokens": 43
}
```

流式请求在 body 里加入：

```json
{
  "stream": true,
  "stream_options": {
    "include_usage": true
  }
}
```

最终 SSE chunk 包含完整 usage：

```json
{
  "prompt_tokens": 14,
  "completion_tokens": 59,
  "total_tokens": 73
}
```

使用 `x-source-app: micu-gpt` 再测非流式，请求成功，响应 usage：

```json
{
  "prompt_tokens": 8,
  "completion_tokens": 15,
  "total_tokens": 23,
  "completion_tokens_details": {
    "reasoning_tokens": 5
  }
}
```

## 发现的问题

- 公网 `/api/proxy?stats=1` 没查到刚刚的 `gpt-5.5` / `micu-gpt` 记录。说明生产环境不能依赖 Vercel 本地 JSON 文件做持久统计。
- OpenAI 流式如果调用方不传 `stream_options.include_usage=true`，最后不会有完整 usage；代理可以考虑自动补这个字段。
- Anthropic 能从上游拿 usage，但当前代码还没把 `claude` / `anthropic` 接到 normalizer。
- `provider=doubao` 在 normalizer 里存在，但路由还没开放；现在需要用 `provider=ark` 或 `provider=volcengine`。

## 下一步

- [ ] 给生产统计接入持久存储，例如数据库、KV、Blob、远端日志服务。
- [ ] 给 Anthropic 增加 `normalizeAnthropicUsage()`。
- [ ] OpenAI 流式代理自动补 `stream_options.include_usage=true`。
- [ ] 路由支持 `provider=doubao`，映射到 Ark/Volcengine。
- [ ] 补 DeepSeek 流式实测。
- [ ] 补 Ark / 豆包流式实测。
- [ ] 给 `x-source-app` / `x-client-app` / `x-app-id` 建议一套 App 接入规范。
