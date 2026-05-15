# ConnectMulti -> New API Token 统计接入方案

## 目标

把 `www.connectmulti.cc` / `.cc proxy` 继续作为唯一模型请求入口，同时把请求结束后得到的 token usage 写入 New API，让 New API 只承担中文统计后台和用量展示职责。

核心原则：

```txt
客户端 / App
  -> .cc proxy
      -> OpenAI / Gemini / Ark / Micu / Claude / 未来模型
      -> 异步写 usage 到 New API
```

不采用：

```txt
客户端 / App
  -> .cc proxy
      -> New API
          -> 上游模型
```

原因：

- 不希望请求多转一层。
- 不希望 New API 参与模型协议适配。
- 不希望 New API 故障影响 `.cc` 正常返回。
- `.cc` 已经完成 provider 分发、流式透传、usage normalizer，New API 只需要展示和统计。

## 当前判断

New API 很适合做中文统计后台，但它默认不是“外部 usage 日志接收器”。

它现有路径更像：

```txt
请求经过 New API -> New API 转发上游 -> New API 内部写 logs/quota_data/users/tokens
```

我们需要改造成旁路写入：

```txt
请求经过 .cc -> .cc 提取 usage -> 写入 New API 统计数据
```

## 已确认的 New API 相关数据结构

### `logs`

主要服务于“使用日志”页面。

关键字段：

- `user_id`
- `username`
- `created_at`
- `type`
- `content`
- `token_name`
- `model_name`
- `quota`
- `prompt_tokens`
- `completion_tokens`
- `use_time`
- `is_stream`
- `channel_id`
- `token_id`
- `group`
- `request_id`
- `upstream_request_id`
- `other`

New API 内部写入函数：

```go
model.RecordConsumeLog(...)
```

其中消费日志类型是：

```go
LogTypeConsume = 2
```

### `quota_data`

主要服务于 Dashboard 趋势图。

关键字段：

- `user_id`
- `username`
- `model_name`
- `created_at`
- `token_used`
- `count`
- `quota`

New API 内部通过：

```go
model.LogQuotaData(...)
model.SaveQuotaDataCache()
```

来聚合写入。

注意：`LogQuotaData` 默认按小时归档：

```txt
created_at = created_at - created_at % 3600
```

### `users`

Dashboard 账户卡片和总请求数依赖：

- `used_quota`
- `request_count`

内部更新函数：

```go
model.UpdateUserUsedQuotaAndRequestCount(userId, quota)
```

### `tokens`

Token 用量查询和 token 维度统计依赖：

- `remain_quota`
- `used_quota`
- `accessed_time`

内部更新函数：

```go
model.DecreaseTokenQuota(tokenId, tokenKey, quota)
model.IncreaseTokenQuota(tokenId, tokenKey, quota)
```

如果我们只是做统计，不希望 New API 管控额度，可以考虑给统计 token 设置无限额度，或者只更新 `used_quota`，不扣 `remain_quota`。这个需要 POC 验证 UI 是否符合预期。

## 当前 POC 状态

本地 POC 已经验证通过：

```txt
.cc /api/proxy-stats
  -> 真实上游模型
  -> usage-normalizers
  -> stats-writer
  -> New API POST /api/usage/ingest
  -> logs / quota_data / users
```

当前固定统计用户：

```txt
username: connectmulti
password: connectmulti
user_id: 2
```

当前本地端口：

```txt
.cc proxy:        http://127.0.0.1:11000
New API frontend: http://127.0.0.1:11001
New API backend:  http://127.0.0.1:11002
```

已经确认：

- New API `logs` 会出现 consume 记录。
- New API `users.used_quota` 和 `users.request_count` 会增长。
- New API 首页的“统计Tokens / 统计次数 / 统计额度”依赖 `quota_data`，因此 ingest 端需要同步 upsert `quota_data`。
- `.cc` 请求链路仍然直接打真实上游，New API 只做旁路统计。
- New API ingest 失败不应该影响模型响应。

## 推荐方案

### 推荐方案 A：给 New API 增加 usage ingest API

新增一个内部接口，例如：

```txt
POST /api/usage/ingest
```

由 `.cc stats-writer` 异步 POST 标准 usage event。

New API 接口内部负责：

1. 校验 ingest secret。
2. 第一阶段固定写到 `connectmulti` 用户。
3. 写 `logs`。
4. 同步写或更新 `quota_data`。
5. 更新 `users.used_quota` 和 `users.request_count`。
6. 第二阶段再考虑按 `source_app` 映射 New API token。

优点：

- 数据一致性由 New API 自己维护。
- `.cc` 只需要 HTTP POST，不耦合 New API 数据库 schema。
- 后续 New API 升级时，适配面更小。
- 可以集中做鉴权、幂等、防重和字段映射。

缺点：

- 需要改 New API 源码。
- New API 是 AGPLv3，若公开提供修改版服务，需要注意开源义务或商业授权。

### 可选方案 B：`.cc` 直接写 New API 数据库

`.cc stats-writer` 直接连接 New API 的 Postgres/MySQL/SQLite，写入：

- `logs`
- `quota_data`
- `users`
- `tokens`

优点：

- New API 可以不改源码。
- 最快验证 New API 页面是否能吃到数据。

缺点：

- `.cc` 强耦合 New API schema。
- 需要非常小心事务一致性。
- New API 升级后 schema 变动可能导致写入器失效。
- 直接写库绕开 New API 业务逻辑，不适合长期维护。

建议：可以作为 POC，不建议作为正式长期方案。

## `.cc` 需要改动的地方

### 1. 保持现有 proxy 主逻辑不变

不要把 New API 放到请求转发链路里。

保持：

```txt
api/proxy-stats.js
  -> 上游 provider
  -> response / stream passthrough
  -> usage-normalizers
  -> stats-writer
```

### 2. 扩展 `lib/stats-writer.js`

当前 `stats-writer` 主要负责本地统计写入。

后续改成可插拔写入器：

```txt
stats-writer
  -> local json / jsonl
  -> console debug
  -> New API ingest
```

当前 POC 已经直接在 `lib/stats-writer.js` 中加入 New API ingest writer：

- 本地 `.usage-stats.json` 继续写。
- `NEWAPI_INGEST_ENABLED=true` 时额外 POST New API。
- 写 New API 失败只打印警告。
- 不存完整 prompt/response。

后续如果逻辑继续变大，再拆成 `lib/newapi-writer.js`。

### 3. 继续使用 `lib/usage-normalizers.js`

未来 `.cc` 新增模型 provider 时，只需要在 normalizer 层把原始 usage 转为统一结构。

New API 不需要知道每个 provider 的原始协议。

### 4. 新增环境变量

当前实际使用：

```txt
NEWAPI_INGEST_ENABLED=true
NEWAPI_INGEST_URL=http://127.0.0.1:11002/api/usage/ingest
NEWAPI_INGEST_SECRET=...
NEWAPI_INGEST_USER_ID=2
```

说明：

- `NEWAPI_INGEST_ENABLED=false` 时只写本地 JSON。
- `NEWAPI_INGEST_USER_ID=2` 对应本地固定用户 `connectmulti`。
- 生产环境 secret 必须换成强随机值。

New API 侧需要：

```txt
USAGE_INGEST_SECRET=...
USAGE_INGEST_DEFAULT_USER_ID=2
```

## 标准 usage event

建议 `.cc` 内部统一落成这个结构，作为长期稳定协议。

```json
{
  "version": "connectmulti.usage.v1",
  "event_id": "uuid-or-hash",
  "provider": "gemini",
  "model": "gemini-3.1-flash-preview",
  "source_app": "my-app",
  "api_key_id": "optional-key-id",
  "request_count": 1,
  "input_tokens": 123,
  "output_tokens": 456,
  "total_tokens": 579,
  "cached_input_tokens": 20,
  "cache_miss_tokens": 103,
  "reasoning_tokens": 0,
  "quota": 0,
  "success": true,
  "error_code": null,
  "is_stream": false,
  "duration_ms": 1200,
  "request_id": "connectmulti-request-id",
  "upstream_request_id": "provider-request-id",
  "created_at": 1710000000
}
```

字段说明：

- `provider`：`.cc` 识别出来的真实上游，例如 `openai`、`gemini`、`ark`、`gpt-micu`、`claude-micu`。
- `model`：真实模型名。
- `source_app`：调用来源，后续用于“哪个项目用了多少”。
- `api_key_id`：不要存明文 key，存 fingerprint 或内部 id。
- `quota`：可以由 `.cc` 计算，也可以让 New API ingest 端按模型价格计算。
- `event_id`：用于幂等，避免重复写入。
- `other` 类字段建议放在 New API `logs.other` 中。

## 字段映射到 New API

| `.cc usage event` | New API |
|---|---|
| `model` | `logs.model_name`, `quota_data.model_name` |
| `input_tokens` | `logs.prompt_tokens` |
| `output_tokens` | `logs.completion_tokens` |
| `input_tokens + output_tokens` | `quota_data.token_used` |
| `quota` | `logs.quota`, `quota_data.quota`, `users.used_quota` |
| `source_app` | `logs.token_name` 或 `logs.group` 或 `logs.other.source_app` |
| `api_key_id` | `logs.token_id` 或 `logs.other.api_key_id` |
| `provider` | `logs.other.provider`，可选映射到 `channel_id` |
| `is_stream` | `logs.is_stream` |
| `duration_ms` | `logs.use_time`，单位需要转换为秒 |
| `request_id` | `logs.request_id` |
| `upstream_request_id` | `logs.upstream_request_id` |
| `created_at` | `logs.created_at`，`quota_data.created_at` |

## provider / channel 处理

New API 原生更偏 `channel` 和 `model`，而 `.cc` 更偏 `provider`。

建议第一阶段不要强行映射真实 `channel_id`，先把 provider 存到：

```json
{
  "provider": "gemini"
}
```

也就是 `logs.other.provider`。

第二阶段再考虑：

- 给每个 provider 建一个 New API channel。
- 或在 New API 前端增加 provider 展示。
- 或把 `group` 用作 provider/source_app 维度。

## source_app / api_key_id 设计

如果要统计“隔壁项目用了多少”，必须有来源标识。

建议优先级：

1. 请求头 `x-source-app`
2. 请求头 `x-client-app`
3. 子 API key fingerprint
4. 默认 `connectmulti`

不要记录明文 API key。

New API 侧可以有两种映射：

### 简单映射

所有 `.cc` 请求写到同一个 New API user/token。

source_app 放 `logs.other.source_app`。

优点：最简单。

缺点：New API 自带 token 维度页面无法直接按 source_app 分账。

### Token 映射

每个 source_app 对应一个 New API token。

优点：

- 能复用 New API token 使用量查询。
- 用户/项目维度更自然。

缺点：

- 需要管理 source_app -> token_id/token_name 映射。

推荐 POC 用简单映射，正式版用 Token 映射。

## quota / cost 策略

New API 的 `quota` 不是纯 token，它更像成本额度。

我们有两种选择：

### 策略 A：quota 等于 total_tokens

配置 New API 显示为 tokens。

优点：

- 简单直观。
- 适合第一阶段只看 token。

缺点：

- 不是真实成本。

### 策略 B：quota 按模型价格计算

`.cc` 或 New API ingest 根据 provider/model 的价格表计算 quota。

优点：

- Dashboard 的“花费”更接近真实成本。

缺点：

- 需要维护价格表。
- 不同 provider 价格规则不同，特别是 cache / reasoning / audio / image。

建议：

1. POC 先用 `quota = total_tokens` 或 `quota = 0`，验证页面链路。
2. 稳定后再引入模型价格表。

## 幂等与失败处理

`.cc` 写 New API 必须是旁路异步行为。

要求：

- New API 写入失败不能影响模型响应。
- 写入超时不能拖慢流式响应。
- 应有 `event_id` 防重复。
- 可以先本地 JSON 保底，后续补重放机制。

推荐：

```txt
主请求结束
  -> 写本地 stats
  -> fire-and-forget 写 New API
  -> 失败只打日志
```

如果要更稳：

```txt
主请求结束
  -> 写本地 jsonl queue
  -> 后台 worker 重试写 New API
```

Serverless 环境下不建议依赖本地文件 queue 作为正式方案。

## New API 需要注意的地方

### 1. 不要开放公网无鉴权 ingest

ingest 接口至少需要：

- `Authorization: Bearer <secret>`
- 或 `X-ConnectMulti-Ingest-Secret`

### 2. 要有最小权限

ingest secret 只允许写 usage，不允许读用户、改配置、删日志。

### 3. 要保证事务一致性

如果写入 New API 后端接口，建议一次事件在一个事务中完成：

1. 插入 `logs`
2. upsert `quota_data`
3. 更新 `users`
4. 更新 `tokens`

如果中途失败，应该整体回滚。

### 4. 注意 AGPLv3

New API 是 AGPLv3。

如果我们修改 New API 源码并通过网络提供服务，需要遵守 AGPLv3 的源代码开放义务，或者考虑商业授权。

如果只作为内部自用，也仍建议确认你的使用边界。

### 5. 不存 prompt/response

本方案只写 usage、provider、model、source_app、错误码、耗时等结构化统计，不写完整 prompt/response。

## 最小 POC

### 第 1 步：本地启动 New API

建议本地端口：

```txt
.cc proxy:        11000
New API frontend: 11001
New API backend:  11002
```

New API 可以先用 SQLite，或者 Docker Compose 的 Postgres。

### 第 2 步：创建统计用户

在 New API 后台创建：

```txt
user: connectmulti
password: connectmulti
```

本地 POC 当前使用：

```txt
user_id: 2
```

### 第 3 步：手动或通过 ingest 写入一条 usage

先验证 New API 页面能否吃数据。

需要写入：

- `logs`
- `quota_data`
- `users.used_quota/request_count`

观察：

- 使用日志页是否出现记录。
- Dashboard 是否出现趋势。
- 首页“统计Tokens”是否变化。

### 第 4 步：确定映射策略

重点确认：

- `source_app` 放哪里最适合。
- provider 是否需要 channel。
- quota 显示 token 还是 cost。

### 第 5 步：接 `.cc stats-writer`

New API writer 默认关闭：

```txt
NEWAPI_INGEST_ENABLED=false
```

本地联调打开：

```txt
NEWAPI_INGEST_ENABLED=true
```

## 当前实现文件

New API:

- `controller/usage_ingest.go`
- `router/api-router.go`
- `model/usedata.go`

`.cc`:

- `lib/stats-writer.js`
- `api/proxy-stats.js`
- `api/claude-code-micu.js`
- `.env.example`

## 本地清理测试数据

如果只是清掉 POC smoke 数据，保留 `connectmulti` 用户：

```sql
delete from logs where user_id = 2;
delete from quota_data where user_id = 2;
update users set used_quota = 0, request_count = 0 where id = 2;
```

不建议删除 `users` 表里的 `connectmulti`，否则 `.cc` 的 `NEWAPI_INGEST_USER_ID` 需要重新调整。

## 推荐实施顺序

1. 写这份方案文档。
2. 本地启动 New API。
3. 手动写入 New API 数据，验证页面。
4. 确认 New API 最小数据写入集合。
5. 决定 `source_app` 映射策略。
6. 决定 `quota` 策略。
7. 新增 `.cc` New API writer。
8. 本地联调并观察 New API 页面指标。
9. 正式启用旁路写入。
10. 再考虑 Railway / Vercel 部署。

## 当前不做的事情

- 不让 `.cc` 请求经 New API 转发。
- 不重写 Dashboard。
- 不直接复制 Helicone 页面。
- 不存完整 prompt/response。
- 不把 New API 故障变成 `.cc` 请求失败。
- 不在未验证前改生产路由。

## 总结

这条路线的本质是：

```txt
.cc = 请求代理 + usage 采集器
New API = 中文统计后台 + token/key/usage 展示
```

最稳的长期方案是给 New API 增加一个内部 usage ingest API；最快的验证方案是先直接写 New API 本地数据库，确认页面展示链路成立。
