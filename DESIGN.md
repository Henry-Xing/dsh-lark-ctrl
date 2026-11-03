# dsh-lark-ctrl 设计稿：用飞书手机端操控 DeepSeek Harness

> 状态：**已实现，当前版本 0.2.5**
> 目标运行环境：DSH `0.2.0-rc.2` + lark-cli `>=1.0.98`
> 插件形态：Host-only bundle（无 Client 半），安装后常驻 DSH Host 进程
> 本文是架构与设计记录；安装和使用以 [README](README.md) 为准。

---

## 1. 需求拆解

| # | 需求 | 对应能力 |
|---|---|---|
| 1 | 会话结束、或需要用户反馈时，通过飞书发摘要消息 | 监听 `agent/status` / `turn/end` / `user-questions/request` / `approval/request`，主动推送卡片 |
| 2 | 需要反馈时，发飞书卡片，用户选择后以「和 Client 侧一样的方式」回复 | 嵌入 `user-questions/request` waterfall，构造标准 `AskUserQuestionAnswer`；审批同理返回 `ApprovalOutcome` |
| 3 | 会话开始时发 hash + 摘要；用户用 hash 定位会话后发 prompt 或 `/btw` 查状态 | 稳定的短会话码（hash）；`im.message.receive_v1` 入站；`sessionController.prompt` / 状态快照 / 可选 LLM 旁问 |

一句话架构：

> **DSH Host 插件** + **两个 lark-cli 常驻事件消费者** + **飞书机器人私聊/群聊**。
> 出站走 `lark-cli im +messages-send / +messages-reply / messages.patch`；
> 入站走 `lark-cli event consume im.message.receive_v1` 与 `card.action.trigger`。

---

## 2. 可行性结论（已核实）

| 机制 | 结论 |
|---|---|
| 拦截用户反馈 | `user-questions/request` 是 Cordis **waterfall** 事件；插件可用 `ctx.on(..., { prepend: true })` 插到最前，返回标准 `AskUserQuestionAnswer` 即「认领」该问题。答案结构与 Web Client 完全一致（`{answers:[{id, selected, custom?}]}`） |
| 与 Web 端共存 | Web 的 answerer 是 `api-remotes` 的 waterfall listener。插件先 `next()` 再与飞书答案 race：两端谁先答谁生效 |
| 超时后仍可答 | `ask_user_question` 若配置为 timed，超时后问题进入 `continued`；插件可 `sessionController.resolveAgent()` + `userQuestions.answer(agent, callId, answer)` 把答案作为后续消息注入 |
| 审批 | `approval/request` 同一套 waterfall，返回 `'allowed-once' / 'rejected'` |
| 向会话发 prompt | `ctx.sessionController.prompt({ requestId, sessionId, mode:'queue'|'steer', content })`；冷会话会自动 resume |
| 会话列表/标题 | `sessionController.list()` 返回 `projections.values.title`；`sessionQuery.readTitle()` 可读冷会话标题 |
| 发卡片 | `lark-cli im +messages-send --msg-type interactive --content <card>`；发送响应含 `message_id` |
| 更新卡片 | `lark-cli im messages patch --message-id <om_...> --data '{"content":"..."}'`（14 天内有效），比 callback token 更稳，可用于「已在 Web 端回答」等状态回写 |
| 收消息 | `lark-cli event consume im.message.receive_v1 --as bot`，事件含 `sender_id / chat_id / message_id / reply_to / root_id / content` |
| 收卡片回调 | `lark-cli event consume card.action.trigger --as bot`，含 `operator_id / message_id / action_tag / action_value / form_value` |
| 机器人身份 | 默认目标 = `lark-cli auth status` 的当前登录账号；app/open_id 等环境信息不写入仓库 |
| LLM 旁问（软依赖） | 已安装的 `dsh-btw` 在 `ctx.connection.fetch` 注册了 `POST /api/btw.ask`（SSE：`start/delta/done/error`）。Host 插件可通过 `ctx.connection.createSharedFetchHandler('/api')` 直接调用该路由，无需公网/浏览器鉴权；未安装时 404，降级为状态快照 |

### 两个必须提前说明的外部约束

1. **需要在飞书开发者后台开通 `card.action.trigger`**。用 `lark-cli event consume card.action.trigger --dry-run` 检查；未开通时按 CLI 输出的 launcher 链接配置「事件与回调 → 回调配置」。
   - 未开通时：**消息收发、开始/结束通知、hash 发 prompt、文字回复答题**仍然可用；
   - 只有「点按钮/表单提交」不可用。插件会检测并给出明确告警。
2. `card.action.trigger` 在 lark-cli 中是 `single_consumer: true`：**全局只能有一个消费者**。插件运行期间，其他会话不要同时 `event consume card.action.trigger`；否则后启动者会失败。

---

## 3. 总体架构

```text
┌──────────────────────────── 飞书 (手机 App / 桌面) ────────────────────────────┐
│  DM / 群聊                                                                     │
│   ├─ 会话开始卡  「#k3f9zq · <标题> · <摘要>」                                  │
│   ├─ 提问卡      [选项按钮 / 表单 + 其他输入]  ← 与 Web Client 同一套选项        │
│   ├─ 完成卡      「#k3f9zq · 已完成 · <摘要>」+ 继续对话输入框                   │
│   └─ 用户消息    「#k3f9zq 继续实现 X」 / 直接回复某条消息 / `/btw ...`          │
└───────────────▲───────────────────────────────────────────────┬────────────────┘
                │ 卡片/消息                                      │ 事件
┌───────────────┴───────────────────────────────────────────────▼────────────────┐
│ lark-cli                                                                       │
│   out: im +messages-send / +messages-reply / messages.patch                    │
│   in : event consume im.message.receive_v1  +  card.action.trigger             │
└───────────────▲───────────────────────────────────────────────┬────────────────┘
                │ child_process (NDJSON)                         │ execFile
┌───────────────┴───────────────────────────────────────────────▼────────────────┐
│ dsh-lark-ctrl Host plugin（运行在 DSH Host 进程内）                                  │
│                                                                                │
│  LarkTransport     CLI 调用、重试、限流、idempotency-key                        │
│  EventBridge       两个常驻 consumer、ready marker、断线重连、去重              │
│  SessionRegistry   hash ↔ session、message_id ↔ session、持久化                 │
│  Notifier          run start / idle / error → 摘要卡                            │
│  Answerer          user-questions/request + approval/request（prepend + race）  │
│  CommandRouter     #hash prompt / /btw / /sessions / /status / reply 路由       │
│  CardFactory       开始卡、结束卡、提问卡、审批卡、状态卡                        │
│  Btw               deterministic snapshot；可选 ctx.llm 旁问                    │
└───────────────▲───────────────────────────────────────────────┬────────────────┘
                │ Cordis events / services                      │
┌───────────────┴───────────────────────────────────────────────▼────────────────┐
│ DSH Host                                                                       │
│  session/event (turn/start,end)  agent/status  agent/created/disposed          │
│  user-questions/request  approval/request                                     │
│  sessions / agents / sessionController / sessionQuery / sessionProjections / llm│
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. 关键机制设计

### 4.1 会话码（hash）

- 展示形式：`#k3f9zq`（小写 base32，6 位；冲突时自动延长到 7/8 位并持久化覆盖）。
- 生成：`sha256(sessionId)` → base32 → 取前 6 位；**同一 session 永远得到同一码**。
- 内容：码只用于定位，不是权限凭证；权限由 `allowUsers` 的 open_id 白名单保证。
- 每条通知/卡片都带码；`/sessions` 可列出最近会话的码。
- 解析顺序：
  1. 回复的消息属于某会话 → 该会话；
  2. 文本以 `#code` 开头 → 按码查；
  3. `/btw`/`/status` 可带码，也可省略；
  4. 都没有 → 默认最近活跃会话（可配置为必须带码）。

### 4.2 生命周期通知

`session/event` + `agent/status` 驱动，定义「一次 run」：

| 时机 | 判定 | 动作 |
|---|---|---|
| Run 开始 | agent `idle → running`（或该会话首个 `turn/start`） | 立即发送**开始卡**：码、标题、触发本轮的用户 prompt 摘要、cwd、模型 |
| Run 结束 | agent 进入 **真正 idle**：`status === 'idle'` 且 `inbox.nextTurn/nextStep` 为空，并保持 3s 宽限；期间又开跑则取消。goal 连续轮次不会触发结束卡 | 发送**结束卡**：码、标题、整个 run 的最后一条 assistant 文本（截断）、结束原因（completed/error/aborted）、总耗时、工具调用数、token 用量 |
| 需要反馈 | `user-questions/request` | 立即发送**提问卡**（见 4.3） |
| 需要审批 | `approval/request` | 立即发送**审批卡**（见 4.4） |
| 会话销毁 | `session/disposed` | 可选发「会话已关闭」，默认不发 |

- 「开始」按 run 发，「结束」只在真正 idle 发；一次 run 可包含多个 turn（goal 续跑），统计按整个 run 聚合。
- 去重键：`sessionId + runId`；`--idempotency-key` 用同一键，防止重试导致重复消息。
- 子会话（`header.origin === 'subagent'`）默认不通知。

摘要来源（默认确定性，不调模型）：

- 标题：`sessionProjections.snapshot(session).values.title`，冷会话用 `sessionQuery.readTitle()`；
- 本轮用户输入：最后一个 `user/message` 的 text block；
- 最后回复：最后一个 `assistant/message` 的 text block（跳过 reasoning）；
- 统计：`tool/call` 数量、`usage` 累计、`turn/start`→`turn/end` 耗时、结束原因；
- 错误：`turn/end.reason.kind === 'error'` 时展示 `error.message`。

v1 不额外调用 LLM 生成摘要，避免第二条模型链路和额外成本；摘要全部来自 session log。

### 4.3 提问：与 Client 完全一致的答案回流

这是整个插件最关键的部分。

```text
Agent
  └─ ask_user_question
       └─ ctx.userQuestions.ask(request)
            └─ waterfall('user-questions/request')
                 ├─ [prepend] dsh-lark-ctrl listener
                 │     ├─ 发飞书提问卡
                 │     ├─ const downstream = next()   // 交给 Web Client
                 │     └─ return race(larkAnswer, downstream)
                 └─ api-remotes → Web Client 卡片
```

- **答案形状**（与 Web 完全一致）：
  ```ts
  { answers: [
      { id, selected: [label, ...], custom?: string }
  ] }
  ```
  - 单选 + 自定义：`selected: []`，`custom: "..."`；
  - 多选：`selected` 可同时带 `custom`；
  - 跳过：`selected: []`、无 `custom`。
- **卡片**（默认 form 模式，兼容批量问题）：
  - 每个问题一个 `select_static`（单选）或 `multi_select_static`（多选）；
  - 一个 `input` 作为「其他（可选）」；
  - 一个提交按钮；`form_value` 一次回传全部答案；
  - 选项只显示 label；description 放在上方 markdown 里；
  - plan-review（`intent.kind === 'plan-review'`）：折叠面板展示计划正文，选项按 `intent.approve` 原样呈现，回答仍是 label 列表。
- **回调处理**：
  1. 校验 `operator_id ∈ allowUsers`；
  2. 由 `message_id` 找到挂起的 `callId/question`；
  3. 解析 `form_value` → 标准 answer；
  4. 若问题仍在 waterfall 中 → resolve；
  5. 若已超时进入 `continued` → `sessionController.resolveAgent(sessionId)` + `userQuestions.answer(agent, callId, answer)`；
  6. 若已结束 → patch 卡片「该问题已失效」；
  7. patch 原卡片为「已回复」，不重复发消息。
- **超时/中断**：
  - timed 问题超时：waterfall 以 `ASK_TIMED_OUT` 结束，卡片改为「已超时，仍可回复（将作为后续消息）」；后续点击走第 5 步；
  - turn 被取消：卡片改为「提问已取消」；
  - 若问题在 Web 端先答：下游 promise 先返回，插件 patch 飞书卡为「已在 Web 端回答」，避免用户重复操作。
- **降级：文字回复**（无需卡片回调权限）：
  - 提问卡正文附带 `也可直接回复本条消息：1=... 2=...`；
  - 入站消息若 `reply_to` 命中提问卡，按序号/label 解析；单问题可直接把整段文本当作自定义答案；
  - 审批卡同理：`1/允许`、`2/拒绝`。

### 4.4 审批

- 同样 prepend 到 `approval/request`，发审批卡：
  - header：`需要授权 · #code`
  - 正文：工具名、`reason/displayReason`、代码片段（如有）
  - 按钮：`允许一次`（primary）/ `拒绝`（danger）
- 返回 `'allowed-once'` 或 `'rejected'`；Web 端先答则 patch 卡片。
- 配置 `approvalMode`：
  - `always`（默认）：全部发；
  - `no-live-client`：只有没有 Web 页面在线时才发并接管（避免桌面端重复打扰）；
  - `off`：不发。

### 4.5 手机发 prompt

入站消息路由：

```text
消息
 ├─ sender_type=bot / 非 allowUsers → 忽略
 ├─ reply_to/root_id 命中会话消息 → 目标会话；正文=prompt（除非以 /btw 开头）
 ├─ 以 #code 开头 → 目标会话；去掉 #code 后作为 prompt；只有 #code → 状态卡
 ├─ /sessions /status /btw /stop /help → 命令
 └─ 其他 → defaultTarget=last 时发最近会话；否则回帮助
```

发送：

```ts
await ctx.sessionController.prompt({
  requestId: randomUUID(),          // 幂等
  sessionId,
  mode: 'queue' | 'steer',          // 默认 queue；/steer 前缀或配置切换
  content: [{ type: 'text', text: prompt }],
}, signal)
```

- 成功：给用户消息加一个 OK 表情（比文字回复安静）；失败：文字回复错误原因。
- 冷会话会自动 resume；如果会话已被归档/找不到，回复明确错误 + `/sessions`。
- `/stop` → `sessionController.cancel({ sessionId })`。

### 4.6 `/btw` 状态查询与 LLM 旁问

`/btw`（不带问题）→ 确定性状态卡，零模型调用、不写入会话：

- 码、标题、cwd、运行状态、当前 turn/step、已运行时长；
- 最后一个用户 prompt / 最后一条 assistant 文本；
- 最近工具调用（名称 + 成功/失败 + 时间）；
- 挂起的问题/审批数量；
- 排队消息数（`agent.inbox`）；
- 本轮/最近 turn 的 token、模型。

`/btw <自然语言问题>` → **软依赖已安装的 `dsh-btw` 插件**：

1. 优先走 `dsh-btw` 的 LLM 旁问，**不重复实现第二条模型链路**；
2. `dsh-btw` 把 `POST /api/btw.ask`（JSON `{sessionId, question}`，SSE 返回 `start/delta/done/error`）注册在 `ctx.connection.fetch` 路由表里；
3. 本插件在 Host 内通过 **`ctx.connection.createSharedFetchHandler('/api')`** 直接调用该路由（不经过公网/浏览器鉴权，不占用端口），解析 SSE：
   - `start` → 建立「旁问生成中」卡片；
   - `delta` → 可节流 patch 卡片（或结束一次性写）；
   - `done.entry.answer` → 返回最终答案卡；
   - `error` → 返回错误卡（不抛到用户对话）。
4. 冷会话先 `sessionController.resolveAgent(sessionId)` 让它 live，否则 dsh-btw 会返回 `session-not-live`；
5. 同一 session 同一时间只允许一个旁问（dsh-btw 会返回 `busy`，直接提示稍后再试）；
6. **未安装 dsh-btw / 路由 404 / 契约不匹配**：不报错、不 fail，自动降级为上面的确定性状态卡，并附一句「LLM 旁问需安装 dsh-btw」；
7. `dsh-btw` 返回 `model-unavailable` 等业务错误时，展示错误并附状态卡。

配置：`btwMode: auto | snapshot | off`（默认 `auto`），`btwTimeoutMs`、`btwRoute`（默认 `/api/btw.ask`，仅用于探活与诊断）。
模型/上下文预算完全由 `dsh-btw` 自己的配置决定（`provider/model/contextChars`），本插件不重复配置。

> 这样 `/btw` 的能力与 Web 端 `dsh-btw` 完全一致：不调用工具、不打断会话、不写入 session。未安装时只是少了自然语言回答，状态查询仍然可用。

---

## 5. 飞书侧交互设计

### 5.1 卡片类型

| 卡片 | header | 内容 | 操作 |
|---|---|---|---|
| 开始卡 | 蓝 `会话开始` | 码、标题、触发 prompt、cwd、模型 | 「状态」「停止」按钮 |
| 结束卡 | 绿/红 `已完成` / `失败` / `已停止` | 码、标题、最后回复、耗时、工具数、tokens | 表单：`继续对话…` + 提交；「状态」 |
| 提问卡 | 橙 `需要你的确认` | 每个问题的 header/question/detail/选项说明 | form：选择 + 其他输入 + 提交 |
| 计划审核卡 | 橙 `计划待审` | 折叠的计划正文 | 通过/不通过按钮（或 form） |
| 审批卡 | 红 `需要授权` | 工具名、原因 | 允许一次 / 拒绝 |
| 状态卡 | 灰 `会话状态` | 运行信息 + 最近活动 | 「刷新」「停止」 |
| 会话列表 | 灰 `最近会话` | 最近 10 条的码/标题/状态 | 纯文本（复制码） |

卡片统一规范：

- Card 2.0（`schema: "2.0"`），`width_mode: default`；
- 码放在 header subtitle 或第一行，形如 `#k3f9zq`；
- 正文 markdown 截断，避免超过 30KB；
- 按钮回调 value 只放 `{op, sessionId, callId?, d?}`，不放长文本；
- 卡片状态变化优先 `messages.patch`（按 message_id），callback token 仅作兜底。

### 5.2 消息与卡片对应关系

- 每条出站消息记录 `message_id → { sessionId, kind, callId? }`，持久化；
- 用户回复任意一条带映射的消息 → 自动路由到对应会话（无需重复敲 hash）；
- 提问卡/审批卡的 `message_id` 同时作为「文字回复答题」的入口。

### 5.3 命令协议

| 输入 | 行为 |
|---|---|
| `#k3f9zq 继续实现登录页` | 向该会话 queue 一条 prompt |
| `#k3f9zq /steer 先写测试` | steer 模式发送 |
| `#k3f9zq` | 状态卡 |
| `#k3f9zq /btw 现在在做什么？` | 旁问该会话 |
| `/sessions` | 最近 10 个会话（码、标题、running/idle、最后活动） |
| `/status [code]` | 状态卡；省略 code 用最近会话 |
| `/btw [code] [问题]` | 旁问；省略 code 用最近/被回复会话 |
| `/stop [code]` | 取消当前 turn |
| `/help` | 帮助 |
| 直接回复某条通知 | 路由到该会话；正文作为 prompt |
| 直接回复提问卡 | 按序号/label 答题（无回调权限时的降级路径） |

### 5.4 群聊 vs 私聊

- 默认私聊机器人（`targetUserId`，空则用 `lark-cli auth status` 的当前用户 openId）；
- 支持 `targetChatId` 发到群；群内同样用 `allowUsers` 限制谁能操作；
- 群聊中只处理：`@机器人` 的消息、`#code` 开头的消息、`/` 命令、或回复机器人消息的线程回复；其余忽略，避免群里闲聊触发 Agent；
- v1 不做「一人一码/多用户隔离」；默认单用户使用。

---

## 6. 实现结构

```text
dsh-lark-ctrl/
├── package.json            # dsh-lark-ctrl, dsh.bundle.patch
├── cordis.patch.yml        # insert 行 + 默认配置
├── index.js                # apply(ctx, config): 组装各模块、注册监听/生命周期
├── lib/
│   ├── config.js           # 默认值、归一化、校验
│   ├── lark-cli.js         # execFile 封装、JSON 解析、错误分类、重试、限流
│   ├── transport.js        # 发消息/回复/更新卡片、出站队列、idempotency
│   ├── event-bridge.js     # 两个 consume 子进程、ready、NDJSON、重连、去重
│   ├── registry.js         # 会话码、message_id 映射、持久化
│   ├── store.js            # 原子 JSON 存储（$DSH_HOME/storages/lark）
│   ├── cards.js            # 所有卡片 JSON 构造 + patch 状态
│   ├── answerer.js         # user-questions/request + approval/request
│   ├── notifier.js         # run start/end 摘要与事件去抖
│   ├── router.js           # 入站消息解析、命令、回复路由
│   ├── summary.js          # run 级确定性摘要（不调 LLM）
│   ├── btw.js              # 状态快照 + 调用 dsh-btw 的 /api/btw.ask（软依赖）
│   ├── locale.js           # zh/en 文案
│   └── util.js
├── locale/zh.json, locale/en.json
├── icon.svg
├── README.md               # 安装、飞书后台配置、命令、安全边界、排障
└── test/                   # node --test：卡片、答案解析、路由、hash、摘要
```

### 6.1 依赖的 DSH 能力

`inject`（缺一不可）：

```js
['sessions', 'agents', 'sessionController', 'sessionQuery',
 'sessionProjections', 'userQuestions']
```

软依赖（用 `ctx.inject` 可选注入，缺失时降级）：

- `connection`：通过 `ctx.connection.createSharedFetchHandler('/api')` 调 `dsh-btw` 的 `/api/btw.ask`；没有它则 `/btw` 只返回状态快照；
- `typertGateway`：`hasLiveClient()` 用于 `answerMode: fallback` / `approvalMode: no-live-client`；没有它时按「无在线 Client」处理。

监听：

```js
ctx.on('agent/status', ...)              // run 起止
ctx.on('session/event', ...)             // turn 统计、assistant 文本、错误
ctx.on('user-questions/request', handler, { prepend: true })
ctx.on('approval/request', handler, { prepend: true })
```

不注册任何新工具、不新增 Remote 端点、不写 session event。

### 6.2 持久化状态

`$DSH_HOME/storages/lark/state.json`（原子写，200ms 去抖）：

```jsonc
{
  "version": 1,
  "codes": { "session-xxx": "k3f9zq" },          // 覆盖/冲突用
  "links": { "om_xxx": { "sessionId": "...", "kind": "question", "callId": "..." } },
  "seenEvents": ["...", "..."],                  // LRU，去重
  "lastSessionId": "session-xxx",
  "startedRuns": { "session-xxx": 3 },           // 去重
  "pendingCards": { "callId": "om_xxx" }         // 重启后继续可答的卡片
}
```

上限：links 1000、seenEvents 2000、pendingCards 500；超出按时间淘汰。

### 6.3 配置（cordis.patch.yml）

```yaml
- id: dsh-lark-ctrl
  name: dsh-lark-ctrl
  config:
    # --- lark-cli ---
    larkCli: lark-cli
    identity: bot

    # --- 目标 ---
    # 默认取 lark-cli 当前登录账号（auth status 的 identities.user.openId）
    targetUserId: ''        # 手动覆盖；空 = 自动发现
    targetChatId: ''        # 群聊 oc_xxx；设置后优先生效
    allowUsers: []          # 入站/卡片操作白名单；空 = 仅 targetUserId

    # --- 通知 ---
    notifySessionStart: true
    notifySessionEnd: true
    notifyQuestion: true
    notifyApproval: true
    approvalMode: always    # always | no-live-client | off
    includeSubagents: false
    startupMessage: true

    # --- 答题 ---
    answerMode: race        # race | fallback | exclusive | off
    allowTextReply: true

    # --- 摘要（确定性的 run 级摘要）---
    summaryMaxChars: 1500

    # --- 旁问（软依赖 dsh-btw）---
    btwMode: auto           # auto | snapshot | off
    btwRoute: /api/btw.ask  # 探活/诊断用；仅支持 dsh-btw 的既有契约
    btwTimeoutMs: 60000

    # --- 命令 ---
    defaultTarget: last     # last | require-hash
    maxPromptChars: 8000

    # --- 其他 ---
    language: zh-CN
    storeDir: ''            # 空 = $DSH_HOME/storages/lark
    debug: false
```

`answerMode` 语义：

| 值 | 行为 |
|---|---|
| `race`（推荐） | 飞书卡 + Web 卡同时存在，谁先答谁生效；另一边被 patch 成「已回答」 |
| `fallback` | 有 Web Client 在线时只发「通知卡」（无答题控件）并交给 Web；无在线 Client 时才发答题卡并接管 |
| `exclusive` | 飞书独占，不调用 `next()`；Web 端看不到问题（桌面端会失去答题入口） |
| `off` | 只通知，不接管（纯提醒模式） |

### 6.4 启动自检与降级

启动时：

1. `lark-cli --version` 可执行；
2. `lark-cli auth status --json`：bot ready；
3. `event consume im.message.receive_v1 --dry-run`：precondition ok；
4. `event consume card.action.trigger --dry-run`：若 blocked，记录告警 + 可操作的 launcher 链接，卡片回调不可用但继续运行（走文字回复降级）；
5. 目标为空则由 auth status 推导；
6. 可选发一条「Lark 桥接已上线」的启动 DM（`startupMessage`）。

运行中：

- consumer 退出 → 指数退避重启（1s→60s），记录 last error；
- 卡片回调受限 → 不反复重试刷屏，按 10 分钟间隔探测并只告警一次；
- lark-cli 发送失败 → 分类（scope/权限/网络/限流），有限重试；问题卡发送失败且无 Web Client 时，快速失败而不是静默挂起；
- 插件 dispose → SIGTERM 子进程、flush 存储、拒绝未完成的挂起 promise。

---

## 7. 安全边界

- **只接受白名单 open_id**：消息 sender、卡片 operator 双重校验；
- 忽略 `sender_type=bot`，避免自问自答；
- 不提供任意 shell 执行入口；`/stop`、`/status`、发 prompt 都是 DSH 既有语义；
- 入站 prompt 走正常 Agent 流程，仍受 DSH 的权限/审批策略约束；
- 单条 prompt 限长（默认 8000 字符），入站限速（例如 30 条/分钟/用户）；
- 卡片/消息内容做长度截断，避免超过 30KB；
- 不在飞书消息中输出系统提示、密钥或完整工具参数；
- 日志不打印 lark-cli 的 token/凭据。

---

## 8. 前置条件与安装

1. 飞书开发者后台（你的 app）：
   - 事件订阅：`im.message.receive_v1`；
   - 回调配置：`card.action.trigger`（需要手动开启）；
   - 机器人可用范围内包含目标用户；如需群聊，把机器人拉进群。
2. 本机 lark-cli 已登录且 bot ready。
3. 安装（推荐 DSH Plugins 页面）：
   ```text
   github:kix6lj/dsh-lark-ctrl
   ```
   如需自定义目标/配置，在 profile 的 `cordis.patch.yml` 按 `dsh-lark-ctrl` 行 id 覆盖。
4. 安装后通过一次 DM 验证：在飞书给机器人发 `#<首次会话码> hello`，或在 DSH 里触发一个提问。

---

## 9. 测试与验收

### 自动化

- 单元测试（`node --test`）：
  - hash 稳定/冲突；
  - 命令解析（hash、回复、`/btw`、`/stop`、多行 prompt）；
  - `form_value` → `AskUserQuestionAnswer` 的单选/多选/自定义/跳过/批量；
  - 卡片 JSON schema 快照（开始/结束/提问/审批/状态）；
  - 摘要生成（completed/error/aborted、截断）。
- 假 lark-cli 集成测试：用可配置的 stub 二进制验证出站参数、入站 NDJSON 解析、重连/去重。

### 手工验收

| # | 步骤 | 期望 |
|---|---|---|
| 1 | DSH Web 新建会话并发送一条 prompt | 手机收到开始卡，含 `#code` + 摘要 |
| 2 | 会话跑完 | 收到结束卡，摘要/耗时/tokens 正确 |
| 3 | 在飞书回复 `#code 再改一下 X` | DSH 会话收到 prompt 并开跑；收到 OK 表情/确认 |
| 4 | 触发 `ask_user_question`（多选项） | 手机收到提问卡；选择后 Agent 收到**完全相同的 label**；Web 卡被标记为已回答 |
| 5 | 在 Web 端先答同一问题 | 飞书卡被 patch 为「已在 Web 端回答」 |
| 6 | timed 提问超时后再在手机答 | 答案作为后续消息进入会话，Agent 被唤醒 |
| 7 | `exit_plan_mode` 计划审核通过手机完成 | 计划被批准，plan mode 退出 |
| 8 | 审批请求 | 手机允许/拒绝生效 |
| 9 | `/sessions`、`/status`、`/btw` | 返回正确信息，且不写入会话 |
| 10 | 重启 DSH | 桥接自动重连；未答完的 continued 问题仍可答 |
| 11 | 非白名单用户私聊机器人 | 被忽略/拒绝，不触发任何操作 |

---

## 10. 里程碑

| 阶段 | 内容 | 可验收结果 |
|---|---|---|
| M0 | bundle 脚手架、配置、存储、lark-cli wrapper、启动自检 | 安装后日志显示 bot ready；能发一条启动消息 |
| M1 | 会话码、开始/结束通知、`/sessions`、`/status` | 手机上能看到会话开始/结束摘要 |
| M2 | 入站消息 → prompt、回复路由、OK 表情、`/stop` | 手机能驱动会话继续跑 |
| M3 | 提问卡 + answerer + 卡片回调 + 文字回复降级 + 审批 | 手机完成 `ask_user_question` / plan review / 审批 |
| M4 | `/btw` 状态快照 + 调用 `dsh-btw` 的 LLM 旁问（缺失时降级） | 手机查询当前状态；装了 dsh-btw 时可自然语言旁问 |
| M5 | 重连/去重/限流/测试/README/排障 | 重启、弱网、重复事件下稳定 |

M0→M4 都在本次交付范围内；M5 随后补齐。

---

## 11. 已知限制（v1 接受）

1. `race` 模式下飞书先答时，插件会 abort 转发给 Web 的请求并 nudge 客户端清理，Web 面板随之关闭；极端网络/旧版客户端下仍可能短暂残留。`fallback` 模式可规避双卡。
2. 飞书卡片回调未开通时，无法点按钮；只能文字回复答题。
3. `card.action.trigger` 全局单消费者：不能与其它正在消费该事件的工具同时运行。
4. 插件重启前已经在进行中的**阻塞式**提问，若当时没有经过本插件的 answerer，插件无法补接管；timed/continued 问题可以补答。
5. 不支持图片/文件/语音作为 prompt（v1 只处理文本）；后续可加 `im +messages-resources-download` + 附件上传。
6. 不支持 Web 端会话深链（Web 无 session URL 路由）；卡片不提供「在 DSH 打开」按钮，除非配置 URL 模板。
7. 单用户/单目标为主，不做多租户映射。
8. 依赖 DSH Host 内部服务/事件契约；升级 DSH 版本需回归。
9. 卡片状态回写依赖 bot 的 `im:message:update` scope（`messages.patch`）；若 bot 无该 scope，会退化为 callback token 更新或纯文字确认，不影响答题主链路。
10. DSH Host 未运行时机器人不会响应；飞书事件走 lark-cli 的 WebSocket 长连接，**不需要公网回调地址/端口映射**。
11. `/btw` 的自然语言回答依赖 `dsh-btw` 的 `/api/btw.ask` 路由契约；这是同进程插件的软依赖，`dsh-btw` 升级若改路由会降级为状态快照（不影响其它功能）。
12. `dsh-btw` 只对 live session 提供旁问；插件会先 `resolveAgent` 唤醒冷会话，但若该会话无法 resume（模型不可用等），旁问会返回明确错误并保留状态卡。

---

## 12. 已确认的决策（review 结果）

| # | 决策 |
|---|---|
| 1 | **推送目标** = 当前 lark-cli 登录账号；启动时从 `auth status` 自动读取 `identities.user.openId`，`allowUsers` 默认同一账号；仍保留 `targetUserId/targetChatId` 手动覆盖 |
| 2 | **审批卡纳入 v1**；`approvalMode: always`。后续权限方案另行处理 |
| 3 | **必须有 LLM 旁问**，复用已安装的 `dsh-btw`；未安装/路由不可用时降级为状态快照，**不 fail** |
| 4 | **开始按 run 发；结束只在真正 idle 发**（inbox 空 + 3s 宽限，goal 连续轮次合并） |
| 5 | 假设后续会开启 `card.action.trigger`；**未开启时插件必须正常工作**（文字回复答题 + 明确告警） |
| 6 | v1 只做 Host 半；不做 Web UI 面板 |

剩余唯一待确认项：**是否同意通过 `ctx.connection.createSharedFetchHandler('/api')` 调用 dsh-btw 的私有路由**（这是复用其 LLM 旁问能力的最小侵入方式；若你希望改成「给 dsh-btw 提一个 Host service」也可以，但需要改 dsh-btw 本身）。

---

## 13. 实现启动条件

上述决策已明确；Review 通过后按 M0→M4 实现，并在本机安装、用当前飞书账号做真实收发验证（会实际发送飞书消息）。
