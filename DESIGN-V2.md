# dsh-lark-ctrl 二期设计：推送分级、工作区、创建会话/工作区

> 状态：**已实现（0.2.7，含会话详情表单旁问、归档过滤、飞书图片剥离、单项帮助与运行中配置）**
> 基线：`dsh-lark-ctrl 0.1.2`，DSH `>=0.2.1-rc.5`
> 目标：在现有 `/sessions`、会话详情卡、提问/审批闭环之上，增加「推送分级 + 工作区维度 + 创建会话/工作区」。

---

## 1. 现状与约束

现有能力：

- `/sessions [1d|12h|...]`：平铺最近会话，支持时间过滤；
- 每个会话有「打开」→ 会话详情卡（prompt 表单、发送 hash、状态、旁问）；
- 提问/审批卡通过 `user-questions/request` / `approval/request` waterfall 回流；
- 开始/结束摘要、`/btw`、`/status`、`/help`；
- 配置存在 `$DSH_HOME/storages/lark/state.json`。

二期要新增：

1. 推送 level（0/1/2），飞书消息控制；
2. `/workspaces [1d]`：按工作区分组，只显示指定时间内有更新 session 的工作区；
3. 在 workspace 下创建 session：卡片内选「权限/模式」+ prompt；
4. 创建 workspace：给定绝对路径，不存在则 `mkdir -p`，之后可在其中创建 session。

**一个关键平台事实**：飞书 Card 2.0 没有 clipboard/copy 行为，机器人也不能写入飞书输入框；所以「创建/选择」都走卡片按钮 + 表单，不依赖剪贴板。

---

## 2. 总体新增

### 2.1 新命令

| 命令 | 作用 |
|---|---|
| `/level` | 查看当前推送级别，附 0/1/2 按钮 |
| `/level 0` / `/level 1` / `/level 2` | 直接设置并持久化 |
| `/push` | `/level` 的别名 |
| `/workspaces [30m\|1h\|1d\|2w]` | 按工作区展示；带时间过滤 |
| `/workspace-create <绝对路径> [标题]` | 可选快捷命令；主入口是 `/workspaces` 卡片按钮 |
| `/sessions [range]` | 保持现有平铺视图不变 |

### 2.2 新卡片

| 卡片 | 入口 | 主要元素 |
|---|---|---|
| 推送级别卡 | `/level` | 当前级别 + 0/1/2 按钮 |
| 工作区总览卡 | `/workspaces [range]` | 工作区折叠面板、会话行、每区「新建会话」、底部「新建工作区」 |
| 工作区详情卡 | 创建工作区后 / 工作区按钮 | 路径、会话列表、「新建会话」 |
| 新建工作区卡 | 工作区总览「新建工作区」 | 绝对路径输入、标题输入、提交 |
| 新建会话卡 | 工作区「新建会话」 | 模式（Agent preset）、权限（Permission preset）、prompt、提交 |
| 创建结果卡 | 创建成功后 patch | 新会话 code/title、「打开」「继续输入」等 |

### 2.3 新持久化

```jsonc
{
  "version": 1,
  "pushLevel": 2,                 // 0 | 1 | 2
  "links": {
    "om_xxx": {
      "kind": "session-create",
      "workspaceId": "ws_xxx",
      "requestId": "uuid",
      "createdSessionId": "session-xxx",
      "promptSent": true
    }
  }
}
```

- `pushLevel` 缺省 2（保持现有行为）；
- `links` 增加 `workspaceId` / `requestId` / `createdSessionId` / `promptSent`，用于创建卡片的重试幂等；
- 现有 `sanitizeLinks` 需要保留这些字段。

### 2.4 新配置

```yaml
defaultPushLevel: 2          # 首次运行/无持久值时的默认级别
maxWorkspaces: 10            # 总览卡最多展示的工作区数
maxWorkspaceSessions: 20     # 总览卡最多展示的会话行数
```

---

## 3. 功能一：推送 level

### 3.1 语义

| 事件 | L0 静默 | L1 仅阻塞 | L2 全部 |
|---|---|---|---|
| 提问卡 | 否 | **是** | 是 |
| 审批卡 | 否 | **是** | 是 |
| 开始摘要卡 | 否 | 否 | 是 |
| 结束摘要卡 | 否 | 否 | 是 |
| 启动消息 / 卡片回调权限提示 | 否 | 否 | 是 |
| 命令回复（`/sessions`、`/status`、`/level`、`/btw`、创建卡等） | **始终回复** | 始终回复 | 始终回复 |
| 已有卡片的 patch（已回答/失效） | 允许 | 允许 | 允许 |

- **L0**：不产生任何“主动推送”。用户在工作时间用 Web；问题/审批由 Web 处理。
  - 提问/审批 answerer 在 L0 直接 `return next()`，不生成飞书卡；
  - 如果此时没有 Web 客户端，问题可能让会话等待（这是 L0 的预期代价）；
  - 命令回复仍然发送，否则无法用 `/level 2` 切回来。
- **L1**：仅提问/审批卡；开始/结束摘要不发。
- **L2**：现有全量行为。
- level 是**运行时总开关**，叠加在现有 `notifySessionStart/End/Question/Approval` 配置之上：两者都允许才会推送。

### 3.2 控制方式

**文字命令**

```text
/level
/level 0
/level 1
/level 2
```

回复示例：

```text
当前推送级别：1（仅提问/审批）
0 静默 · 1 仅阻塞 · 2 全部
```

**级别卡**

`/level` 不带参数时发送一张卡：

```text
需要推送哪些消息？
[ 0 静默 ] [ 1 仅阻塞 ] [ 2 全部 ]
当前：1
```

按钮 value：

```json
{ "op": "set_level", "level": 1 }
```

点击后：
- `store.setPushLevel(level)`；
- patch 当前卡片为「已切换到 L1」；
- 发送一条短文本确认（可选）。

### 3.3 落地实现

- `lib/store.js`
  - 增加 `pushLevel` 读写；默认 `config.defaultPushLevel`；
  - `setPushLevel` 持久化（debounced flush）。
- `lib/notifier.js`
  - `sendStart` / `sendEnd` 开头：`if (store.pushLevel() < 2) { mark sent; return }`；
  - 不改变 run 统计/去抖逻辑。
- `lib/answerer.js`
  - `onQuestion` / `onApproval` 开头：`if (store.pushLevel() < 1) return next()`；
  - 已有卡片回调/回答不受影响。
- `index.js`
  - `sendStartupMessage` / `onBridgeState` 的权限提示：`pushLevel < 2` 时跳过；
  - `createAnswerer` / `createNotifier` 注入 `store`。
- `lib/cards.js`
  - `buildLevelCard({ current })`；
  - `buildLevelChangedCard` 或复用 patch。
- `lib/router.js`
  - `/level` / `/push` 命令；
  - `handleCardAction` 的 `op:'set_level'`；
  - `/help`、`/status` 显示当前级别。

### 3.4 L0 → L1 的补发（review 确认要实现）

L0 时 answerer 仍然会**观察**提问/审批请求，只是不发卡：

- `onQuestion` / `onApproval` 在 L0 不发送卡片，但仍然调用 `next()` 把请求交给 Web，并把请求缓存在内存（`suppressed` 状态）；
- 如果 Web 先回答，缓存清理，不补发；
- 当 `/level 1` 或 `/level 2` 把级别从 0 提升时，遍历仍处于 `open` / `continued` 的缓存请求：
  - 发送对应的提问卡/审批卡；
  - 后续飞书回答走正常 waterfall / `userQuestions.answer()` 路径；
  - Web 卡片仍在时，飞书先答会 abort Web 转发请求（现有 0.1.1 的取消逻辑）；
- 已被取消/已失效的请求不补发；超过 TTL 的 `continued` 不补发；
- L0 时如果 Web 没处理，提升级别后用户会收到补发卡；这就是“切到 L1 后把 Web 没处理完的提问/审批重新推送到飞书”。

### 3.5 边界

- 级别切换立即生效于**后续**事件；不补发历史开始/结束摘要。
- L0 时已有提问卡仍然可以回答；只是不再产生新卡。
- L0 时如果 Web 没开，提问/审批可能无人回答；在 `/help` 和文档中说明。
- 级别全局单值，不按工作区/会话区分（二期不做）。

---

## 4. 功能二：`/workspaces`

### 4.1 目标

按工作区分组展示会话；支持时间过滤；每个会话仍可「打开」，每个工作区可「新建会话」，底部可「新建工作区」。

### 4.2 数据来源

| 数据 | API |
|---|---|
| 工作区列表 | `ctx.workspaceRegistry.list()`（同步，按注册顺序） |
| 工作区下的 session ID | `workspace.sessionIds`（header 校验过） |
| 会话摘要（标题/状态/更新时间/cwd） | `ctx.sessionController.list({}, signal)` |
| 已归档 session | `ctx.workspaceRegistry.archivedSessionIds` |
| 目录状态（可选） | `workspace.status()` → `ok` / `missing-dir` |
| 时间过滤 | 复用现有 `parseSessionRange()` |

### 4.3 分组算法

```text
summaries = sessionController.list()
byId = Map(summary.sessionId -> summary)
archived = Set(workspaceRegistry.archivedSessionIds)

for each workspace in workspaceRegistry.list():
  sessions = workspace.sessionIds
    .map(id => byId.get(id))
    .filter(Boolean && !archived.has(id))
    .filter(s => includeSubagents || s.origin !== 'subagent')
    .filter(summary => cutoff === undefined || summary.updatedAt >= cutoff)
    .sort(updatedAt desc)

ungrouped = summaries
  .filter(s => s.origin !== 'subagent')
  .filter(s => !anyWorkspace.sessionIds.includes(s.sessionId))
  .filter(time)
  .sort(updatedAt desc)
```

- **带时间过滤**：
  - 只显示「至少有一个 session 在范围内」的工作区；
  - 空工作区（没有任何 session）默认隐藏，避免“空区刷屏”；
  - 未分组会话单独一节「未分组」，同样按时间过滤。
- **不带时间过滤**：
  - 显示所有工作区，包括空工作区（空区显示「暂无会话」+「新建会话」）；
  - 显示未分组会话。
- 显示上限：`maxWorkspaces`（默认 10）+ `maxWorkspaceSessions`（默认 20），超出显示「还有 N 个，发送 /workspaces 查看全部」。
- 工作区按 `workspaceRegistry.list()` 顺序；会话按 `updatedAt` 倒序。
- 工作区目录缺失（`status === 'missing-dir'`）时加 ⚠️ 提示，但仍显示其历史会话。

### 4.4 卡片结构

```text
最近工作区 · 最近 1 天 · 3 个工作区
┌─ dsh-lark-ctrl（2） ────────────────────────────┐
│ /home/you/dsh-plugin/dsh-lark-ctrl           │
│ 🟢 #axzcbf  飞书集成与交互插件  10:21 [打开] │
│ ⚪ #objyfq  MPU sharding...     10:33 [打开] │
│ [新建会话]                                   │
└─────────────────────────────────────────────┘
┌─ hmcc（1） ─────────────────────────────────┐
│ /home/you/projects/example-b                           │
│ ...                                          │
│ [新建会话]                                   │
└─────────────────────────────────────────────┘
未分组（可选）
  ⚪ #...  [打开]
[新建工作区]
```

Card 2.0 实现：

- 每个工作区一个 `collapsible_panel`（默认展开第一个）；
- panel 内：
  - `markdown` 路径 + 可选 ⚠️；
  - 每个会话一个 `column_set`：左列 markdown，右列「打开」按钮；
  - `button`「新建会话」（primary，value `{op:'workspace_new_session', workspaceId}`）。
- 底部 `button`「新建工作区」（value `{op:'workspace_new'}`）。
- 未分组一节用 markdown + 会话行。
- `collapsible_panel` 内不能放 `form`/`table`；这里不需要。
- 空工作区：panel 内 note「暂无会话」+「新建会话」。
- `fitCard` 截断；超过上限时提示。

### 4.5 实现位置

- 新增 `lib/workspaces.js`：
  - `listWorkspaceGroups({ timeRange, now })` → `{ groups, ungrouped, truncated }`；
  - `findWorkspace(workspaceId)`；
  - `createWorkspace(path, title)`（mkdir + registry）；
  - `workspaceLabel(workspace)`。
- `lib/cards.js`：
  - `buildWorkspacesCard({ groups, ungrouped, rangeLabel, truncated })`；
  - `buildWorkspaceDetailCard(...)`；
  - 复用 `buildSessionDetailCard`。
- `lib/router.js`：
  - `/workspaces` 命令；
  - `op:'workspace_new_session'` → `sendCreateSessionCard(workspaceId)`；
  - `op:'workspace_new'` → `sendCreateWorkspaceCard()`；
  - `op:'session_open'` 已有。

---

## 5. 功能三：在 workspace 下创建 session

### 5.1 入口

工作区总览/详情里的「新建会话」按钮 → 发送**新建会话卡**：

```text
新建会话 · dsh-lark-ctrl
/home/you/dsh-plugin/dsh-lark-ctrl

模式（Agent 预设）
  [standard ▼]       # 来自 agentPresets.list()
模型
  [provider / model ▼] # 来自 sessionController.modelCatalog()
权限
  [workspace-write ▼] # 来自 permissionPresets.catalog()
Prompt
  [ 多行输入框 ]
  [创建并发送]
```

### 5.2 DSH API 映射

| 用途 | API |
|---|---|
| 可选的 Agent 预设 | `ctx.agentPresets.list()`（过滤 `broken`；`defaultId` 作默认） |
| 可选模型 | `ctx.sessionController.modelCatalog()`；`default` 作默认 |
| 可选的权限预设 | `ctx.permissionPresets.catalog().options`；`defaultPreset` 作默认 |
| 创建会话 | `ctx.sessionController.create({ workspaceId, agentPreset })` |
| 模型选择 | `ctx.sessionController.selectModel({ sessionId, provider, model })` |
| 权限应用 | `ctx.permissionPresets.set(session, permissionName)` |
| 启动会话 | `ctx.sessionController.prompt({ requestId, sessionId, mode:'queue', content:[{type:'text',text:prompt}] })` |

**执行顺序**（关键）：

```text
1. 校验表单：prompt 非空、preset 在 catalog 内；
2. create({ workspaceId, agentPreset }) -> sessionId
3. session = ctx.sessions.get(sessionId)   // create 后是 live
4. permissionPresets.set(session, permission)  // 必须在首个 turn 之前
5. sessionController.selectModel({ sessionId, provider, model })
6. sessionController.prompt(sessionId, prompt) // 启动第一轮
7. patch 创建卡为“已创建 #code” + 打开按钮
```

- 第 4 步失败：会话已创建但权限未设置。**不要**用默认权限偷偷启动；返回错误，卡片保留一个「打开会话」按钮，让用户手动处理。
- 第 5 步失败：会话已创建但 prompt 未发出；卡片同样保留「打开」，并允许重试发送 prompt（见幂等）。
- 若 `permissionPresets` 服务不存在：不显示权限选择，直接创建；文档注明。
- 若 `agentPresets` 服务不存在：不显示模式选择，使用默认；文档注明。
- `auto` 权限若在 catalog 中，允许选择；`set` 失败则按错误处理。

### 5.3 表单与默认值

- **模式（Agent preset）**：`select_static`，选项来自 `agentPresets.list()`；value=preset id，text=name/description；默认 `defaultId` 或第一个未 broken 的。
- **模型**：`select_static`，选项来自 `sessionController.modelCatalog()` 的 `groups[].models[]`；value=`provider::model`，text=`provider · model name`；默认 `catalog.default`。
- **权限**：`select_static`，选项来自 `permissionPresets.catalog().options`；value=preset key；默认 `catalog.defaultPreset`。
- **Prompt**：`input` multiline，max_length 1000（Lark input 上限）；超过 1000 的 prompt 仍可通过 `#code <内容>` 发送（文档注明）。
- 表单 name：`agent_preset`、`model`、`permission`、`prompt`；提交按钮 `form_action_type: 'submit'`。
- 若某个选择只有 0 个选项：省略该 select。

### 5.4 幂等与重复提交

新建会话卡发送时，在 `links[messageId]` 写入：

```json
{ "kind": "session-create", "workspaceId": "...", "requestId": "uuid" }
```

提交时：

1. 若 `link.createdSessionId` 已存在：
   - 若 `promptSent === true` → 直接回复「已创建 #code」，不重复创建；
   - 若 `promptSent === false` → 只重试 `prompt`；
2. 否则创建，写入 `createdSessionId`；
3. prompt 成功 → `promptSent = true`；
4. patch 卡片为结果卡。

> 需要扩展 `store.sanitizeLinks` 保留 `workspaceId/requestId/createdSessionId/promptSent`。

### 5.5 结果卡片

创建成功后 patch 原卡片：

```text
已创建会话 · #abc123
dsh-lark-ctrl · 最近更新 ...
提示：已发送首条 prompt
[打开会话] [继续输入]
```

- 「打开会话」= `op:'session_open'`，进入现有会话详情卡；
- 「继续输入」可复用会话详情卡的 prompt 表单；
- 新会话自己的开始摘要卡由 notifier 在 L2 发送；L0/L1 时只有这张结果卡作为确认。

---

## 6. 功能四：创建 workspace

### 6.1 入口

- `/workspaces` 底部「新建工作区」按钮 → 新建工作区卡；
- 可选快捷命令 `/workspace-create /abs/path [标题]`。

### 6.2 表单

```text
新建工作区
绝对路径
  [ /home/you/projects/demo ]   # 必填
标题（可选）
  [ my-project ]
[创建]
```

- 路径必须绝对；支持 `~` 展开（可选）；
- 不存在则 `mkdir -p`；存在但不是目录则报错；
- 标题空则默认目录名；
- 若路径已注册工作区，直接返回现有工作区并提示；
- 不设路径白名单：默认允许任意绝对路径；路径不可创建时 `mkdir` 会报错（权限/父路径是文件等），错误原样返回。

### 6.3 执行流程

```text
1. path = expand/normalize(input)
2. 校验绝对路径 + 可选 roots
3. await mkdir(path, { recursive: true })
4. workspace = await ctx.workspaceRegistry.create(path, title)
5. 发送/更新“工作区已创建”卡片：
   - 工作区标题/路径
   - 会话列表（可能为空）
   - [新建会话] [查看工作区]
6. patch 原来的新建工作区卡
```

- `workspaceRegistry.create` 本身要求目录已存在；所以 `mkdir` 必须在它之前。
- `mkdir` 失败（权限、父路径是文件）→ 报错，不注册。
- `create` 失败 → 报错；目录可能已经被创建（这是可接受的副作用，文档说明）。
- 创建成功后，工作区会出现在 `/workspaces`；如果带时间过滤且暂无 session，它会被隐藏，所以**创建结果卡必须直接给「新建会话」按钮**，不要只依赖 `/workspaces`。
- 安全：允许任意绝对路径等于允许从飞书在 Host 上 mkdir；默认按你的使用场景开放，没有白名单，路径不可创建时 mkdir 会报错。所有操作仍受 `allowUsers` 白名单保护。

### 6.4 工作区详情卡

```text
工作区 · my-project
/home/you/projects/demo
[新建会话]
会话（按更新时间）
  🟢 #abc123 ... [打开]
  ⚪ #def456 ... [打开]
暂无会话（如果为空）
```

- 复用工作区总览里的 panel 内容；
- 创建成功后直接发这张卡，用户可马上新建会话。

---

## 7. 卡片与表单汇总

### 7.1 工作区总览

- Header：`最近工作区 · <range> · N 个`；
- 每个工作区 `collapsible_panel`；
- panel 内会话行：`column_set` + `[打开]`；
- panel 内 `[新建会话]`；
- 底部 `[新建工作区]`；
- footer note：`/workspaces 1d` 筛选；`/workspaces` 查看全部。

### 7.2 新建会话

- Header：`新建会话 · <workspace title>`；
- `select_static` 模式 / 权限；
- `input` prompt；
- submit；
- 结果 patch。

### 7.3 新建工作区

- Header：`新建工作区`；
- `input` 绝对路径；
- `input` 标题（可选）；
- submit；
- 结果 patch + 工作区详情卡。

### 7.4 推送级别

- Header：`推送级别`；
- 当前级别 + 三段说明；
- 三个按钮 `0 静默` / `1 仅阻塞` / `2 全部`；
- 点击 patch。

---

## 8. API 与依赖汇总

### 8.1 新增 Host 依赖（可选注入）

| 服务 | 用途 | 缺失时 |
|---|---|---|
| `ctx.workspaceRegistry` | 工作区列表/创建/会话归属 | `/workspaces` 报「未启用工作区」；创建会话不可用 |
| `ctx.agentPresets` | 模式列表 | 省略模式选择，使用默认 |
| `ctx.permissionPresets` | 权限列表与应用 | 省略权限选择，使用会话默认 |

现有硬依赖保持不变：`sessions/agents/sessionController/sessionProjections/userQuestions`。

### 8.2 关键调用

```js
// 工作区
const workspaces = ctx.workspaceRegistry.list()
const groups = workspaces.map(w => ({ workspace: w, sessionIds: w.sessionIds }))
await mkdir(path, { recursive: true })
await ctx.workspaceRegistry.create(path, title)
await workspace.status()

// 会话
const presets = await ctx.agentPresets.list()
const catalog = ctx.permissionPresets.catalog()
const created = await ctx.sessionController.create({ workspaceId, agentPreset })
const session = ctx.sessions.get(created.sessionId)
ctx.permissionPresets.set(session, permission)
await ctx.sessionController.prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] })
```

### 8.3 新模块拆分

```text
lib/
├── push-level.js       # 级别语义、卡片、gating 辅助
├── workspaces.js       # workspace 分组、路径校验、mkdir+create
├── session-create.js   # preset 目录、表单值校验、create+permission+prompt
├── cards.js            # 新增 level/workspaces/create 卡片
├── router.js           # 新命令/卡片 action
├── store.js            # pushLevel + 扩展 links
├── notifier.js         # level<2 跳过
└── answerer.js         # level<1 跳过
```

> `cards.js` 已较大；实现时可以把会话/工作区卡片拆到 `cards-workspaces.js`，避免单文件继续膨胀。

---

## 8.4 Web 端可见性

新建对象必须同时出现在 Web，不额外维护一份“飞书侧”数据：

- **workspace**：`workspaceRegistry.create()` → `domain/changed` → Web `workspaceController.follow()` 的 `upsert` 帧；Web 侧边栏直接更新。
- **session**：`sessionController.create({ workspaceId })` → `session/created` → `api-session/added`；`workspace.attachSession()` 更新 workspace 的 `sessionIds` → follow `upsert`。创建后额外 emit `api-session/activity` 让已打开的侧栏立即刷新排序/状态。
- Web 未打开时，下次打开读取 Host baseline；无需插件做额外持久化。
- 如果实现层改为“只在飞书侧记录”或绕过上述服务，Web 不会可见；本方案坚持使用同一套 Host 服务。

## 9. 失败、边界与安全

| 场景 | 行为 |
|---|---|
| `workspaceRegistry` 不存在 | `/workspaces` 回「当前部署未启用工作区」；创建会话入口不显示 |
| 新建工作区相对路径 | 表单错误，不 mkdir |
| 新建工作区路径已存在但不是目录 | 报错，不注册 |
| `mkdir` 权限失败 | 报错，不注册 |
| 工作区已注册 | 返回现有工作区，提示「已存在」 |
| 时间过滤无结果 | 卡片显示「该时间范围内没有工作区/会话」+ 新建工作区按钮 |
| 工作区目录被移动/删除 | 卡片 ⚠️；会话历史仍显示 |
| 会话创建后权限设置失败 | 不发送 prompt；结果卡给「打开会话」；文档提示手动设权限 |
| 会话创建后 prompt 发送失败 | 卡片保留；重试只补 prompt（`promptSent`） |
| 重复提交新建会话 | `createdSessionId` 幂等，不重复建会话 |
| L0 时提问/审批 | 不发卡，交 Web；无 Web 时会等待/失败，文档说明 |
| L0 时命令 | 仍回复（否则无法切回 L2） |
| 卡片超过 200 元素/30KB | 按 `maxWorkspaces`/`maxWorkspaceSessions` 截断；footer 提示 |
| 非白名单用户 | 现有 `allowUsers` 拒绝所有新操作 |
| 任意绝对路径创建 | 默认允许；依赖 Host 文件系统权限，`mkdir` 失败即报错 |

---

## 10. 实现拆分与验收

### 10.1 里程碑（建议一次 review 后批量实现）

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | pushLevel 持久化、`/level`/`/push`、level 卡、notifier/answerer gating | L0 只回命令；L1 只有提问/审批；L2 全部 |
| M2 | `/workspaces [range]` 分组、时间过滤、会话行/打开按钮 | 分组正确；1h/1d 过滤正确；可打开会话 |
| M3 | 新建会话卡：agent preset + permission + prompt + 幂等 | 新会话出现在 workspace 下并开跑；权限/模式正确 |
| M4 | 新建工作区卡：mkdir + registry + 详情卡 | 不存在路径可创建；已有路径复用；之后可建会话 |
| M5 | 单测、真实卡片发送、集成验证、README | 全部验收项通过 |

### 10.2 验收清单

1. `/level` → 0/1/2 按钮；设置后持久化，重启仍生效；
2. L0：触发提问/审批，飞书无卡，Web 正常；
3. L1：提问/审批有卡；开始/结束无卡；
4. L2：开始/结束恢复；
5. `/workspaces 1h` / `1d`：只显示时间内有 session 的工作区；空工作区不带过滤时可见；
6. 点「新建会话」：卡片含模式/权限/prompt；提交后新会话出现并开始跑；
7. 选标准/其他 agent preset，验证 session 的 agent preset 正确；
8. 选不同权限 preset，验证 `permissions` 投影/审批策略变化；
9. 新建工作区：不存在的绝对路径自动 `mkdir -p`；已存在路径复用；相对路径报错；
10. 在新工作区创建 session，prompt 正常发送；
11. 重复提交创建会话不产生第二个 session；
12. 非白名单用户不能创建/切换。

### 10.3 测试方式

- 纯函数单测：level gating、workspace 分组/时间过滤、路径校验、表单值解析、幂等状态；
- 卡片结构单测：新增卡片 JSON、input `max_length <= 1000`、按钮 value；
- 真实发送校验：工作区卡、新建会话卡、新建工作区卡、level 卡；
- 集成：用 `/tmp/dsh-lark-ctrl-ws-test` 创建新工作区/会话；验证后删除注册（不删目录）或保留；
- 审批卡测试需要会话审批策略为 `ask`（当前实现会话是 `never`，会直接 reject，不会发卡）。

---

## 11. 开发流程与重启

当前 Host 源码改动需要重启 DSH 才加载（ESM 模块缓存）。为了后续不再反复重启，建议在 profile 的 `cordis.patch.yml` 启用 HMR 源码监听：

```yaml
- id: hmr
  disabled: false
  config:
    root:
      - /home/you/dsh-plugin/dsh-lark-ctrl
```

一次重启后，修改 Host 源码会自动热重载；`package.json`/依赖变更仍需重启。

本次二期实现会**批量完成 M1–M4**，先跑单测和真实卡片发送，再让你重启一次做最终验收，而不是每改一点重启一次。

---

## 12. 已确认的决策（review 结果）

| # | 决策 |
|---|---|
| 1 | 「模式」= Agent preset；**同时增加模型选择**，两者都用 `select_static` |
| 2 | 推送级别**全局单值**；默认 L2 |
| 3 | L0 完全不发卡，交给 Web；切换到 L1/L2 时**补发** Web 尚未处理的提问/审批（3.4） |
| 4 | 空工作区：`/workspaces 1d` 隐藏；`/workspaces` 无过滤时显示 |
| 5 | 工作区默认允许任意绝对路径；没有权限时 `mkdir` 失败即报错，不设白名单 |
| 6 | 新建会话 prompt 受飞书 input 1000 字限制；更长走 `#code` 文本路径 |
| 7 | **不启用 HMR**；本批 M1–M4 批量完成后只重启一次 |

剩余实现细节（不再阻塞）：模型选项的展示格式、L0 缓存的 TTL、创建工作区/会话的错误文案。实现后一次性验收。
