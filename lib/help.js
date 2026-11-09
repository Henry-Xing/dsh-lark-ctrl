/**
 * Help topics for `/help <command>`.
 *
 * This module is data-only so both the card builders and the router can read
 * it without creating a dependency cycle.
 */

/** @typedef {{
 *   id: string,
 *   command: string,
 *   aliases?: string[],
 *   summary: string,
 *   usage: string[],
 *   description: string[],
 *   examples: Array<{ command: string, note: string }>,
 *   notes?: string[],
 *   related?: string[],
 * }} HelpTopic */

/** @type {HelpTopic[]} */
export const HELP_TOPICS = [
  {
    id: 'help',
    command: '/help',
    summary: '查看命令总览或单个命令的详细用法',
    usage: ['/help', '/help /sessions', '/help /workspaces'],
    description: [
      '不带参数时发送命令总览；带命令名时展示该命令的用法、示例、限制和相关命令。',
      '命令名带不带前导 `/` 都可以，例如 `/help sessions` 与 `/help /sessions` 等价。',
    ],
    examples: [
      { command: '/help', note: '命令总览' },
      { command: '/help /sessions', note: '查看 /sessions 的详细用法' },
      { command: '/help /workspaces', note: '查看 /workspaces 的详细用法' },
    ],
    notes: ['未知命令会返回提示，不会执行任何操作。'],
    related: ['/sessions', '/workspaces', '/level', '/btw'],
  },
  {
    id: 'sessions',
    command: '/sessions',
    aliases: ['sessions'],
    summary: '筛选、查看并打开最近的会话',
    usage: ['/sessions', '/sessions 1d', '/sessions 12h', '/sessions 30m'],
    description: [
      '按更新时间倒序列出最近 10 个**未归档**会话，点「打开」进入会话详情卡。',
      '时间范围支持 `30m`、`12h`、`1d`、`2w`；不传表示不过滤。',
    ],
    examples: [
      { command: '/sessions', note: '最近的全部会话' },
      { command: '/sessions 1d', note: '最近一天有更新的会话' },
      { command: '/sessions 12h', note: '最近 12 小时有更新的会话' },
    ],
    notes: [
      '已归档 session 不显示；仍可用 hash 直接访问。',
      '最多展示 10 个；会话详情卡里可直接输入 prompt。',
      '详情卡表单的「旁问」会把 prompt 交给 /btw，不写入会话。',
    ],
    related: ['/workspaces', '/status', '#code'],
  },
  {
    id: 'workspaces',
    command: '/workspaces',
    aliases: ['workspaces'],
    summary: '按工作区分组，打开会话或新建会话/工作区',
    usage: ['/workspaces', '/workspaces 1d', '/workspaces 1h'],
    description: [
      '按工作区分组展示会话；每个会话有「打开」，每个工作区有「新建会话」，底部有「新建工作区」。',
      '不带时间过滤时，没有会话的空工作区也会显示；带过滤时只显示指定时间内有会话的工作区。',
    ],
    examples: [
      { command: '/workspaces', note: '查看全部工作区和空工作区' },
      { command: '/workspaces 1d', note: '只看最近一天有更新的工作区/会话' },
      { command: '/workspaces 1h', note: '只看最近一小时有更新的工作区/会话' },
    ],
    notes: [
      '已归档 session 不显示。',
      '默认最多 10 个工作区、20 条会话；超出会截断并提示。',
      '新建会话时可选择 Agent 模式、模型、Thinking effort、权限并填写首条 prompt。',
    ],
    related: ['/workspace-create', '/sessions', '/help'],
  },
  {
    id: 'workspace-create',
    command: '/workspace-create',
    aliases: ['workspace-create', 'workspacecreate'],
    summary: '用绝对路径创建并注册一个新工作区',
    usage: [
      '/workspace-create /home/you/projects/demo',
      '/workspace-create /tmp/demo | 演示工作区',
    ],
    description: [
      '给定绝对路径；目录不存在时自动 `mkdir -p`，然后注册为工作区。',
      '标题可选，用 `|` 分隔；不写标题时默认使用目录名。',
      '创建后直接出现工作区详情卡，可继续「新建会话」。',
    ],
    examples: [
      { command: '/workspace-create /home/you/projects/demo', note: '创建或复用该路径的工作区' },
      { command: '/workspace-create /tmp/demo | 演示', note: '创建并指定标题' },
    ],
    notes: [
      '路径必须是绝对路径（支持 `~/`）。',
      '没有文件系统写权限时 `mkdir` 会失败并返回错误。',
      '路径已注册时直接打开已有工作区，不会重复创建。',
      '也可以从 `/workspaces` 卡片点「新建工作区」使用表单。',
    ],
    related: ['/workspaces', '/sessions', '/help'],
  },
  {
    id: 'level',
    command: '/level',
    aliases: ['level', 'push'],
    summary: '控制飞书主动推送的级别：静默 / 仅阻塞 / 全部',
    usage: ['/level', '/level 0', '/level 1', '/level 2', '/push 1'],
    description: [
      '`/level` 查看当前级别并显示 0/1/2 按钮；带参数直接切换并持久化。',
      '0 = 不主动推送；1 = 只推送提问和审批卡；2 = 全部（提问/审批 + 开始/结束摘要）。',
      '`/push` 是 `/level` 的别名。',
    ],
    examples: [
      { command: '/level', note: '查看级别和切换按钮' },
      { command: '/level 0', note: '静默：不主动推送，提问/审批交给 Web' },
      { command: '/level 1', note: '只推送阻塞类卡片' },
      { command: '/level 2', note: '恢复全部推送' },
    ],
    notes: [
      '命令回复始终发送，L0 也能用 /level 切回来。',
      '从 L0 切到 L1/L2 时，会补发 Web 尚未处理的提问/审批。',
      '级别是全局单值，持久化到 state.json。',
    ],
    related: ['/help', '/status', '/sessions'],
  },
  {
    id: 'status',
    command: '/status',
    aliases: ['status'],
    summary: '查看会话状态、模式/模型/Thinking/权限，并直接修改',
    usage: ['/status', '/status #abc123', '/status abc123'],
    description: [
      '展示运行状态、目录、模式、模型、Thinking effort、权限、最近输入/回复、待处理交互、排队数量和最近工具。',
      '卡片内提供权限、模型、Thinking effort 的修改选择框；不传 code 时使用当前回复或最近一次操作的会话。',
    ],
    examples: [
      { command: '/status', note: '查看最近会话的状态' },
      { command: '/status #abc123', note: '查看指定会话' },
    ],
    notes: [
      '权限修改立即生效；模型/Thinking effort 在下一轮请求生效；模式在首轮后锁定。',
      '图片同样会从飞书卡片中省略。',
    ],
    related: ['/sessions', '/btw', '/stop'],
  },
  {
    id: 'btw',
    command: '/btw',
    aliases: ['btw'],
    summary: '旁问：不写入会话、不打断当前轮次的额外回答',
    usage: [
      '/btw',
      '/btw #abc123 现在在做什么？',
      '/btw 解释一下当前状态',
    ],
    description: [
      '不传问题：返回会话状态快照。',
      '传问题：调用已安装的 `dsh-btw` 生成自然语言回答；不会写入会话上下文，也不会调用工具。',
      '不传 code 时使用当前回复的会话或最近一次操作的会话。',
    ],
    examples: [
      { command: '/btw #abc123 现在在做什么？', note: '对指定会话旁问' },
      { command: '/btw 解释一下当前状态', note: '对最近会话旁问' },
      { command: '/btw', note: '只看状态快照' },
    ],
    notes: [
      '问题上限 4000 字。',
      '`dsh-btw` 不存在或不可用时自动降级为状态快照，不会报错。',
      '会话详情卡表单里的「旁问」按钮也会走这里。',
    ],
    related: ['/status', '/sessions', '/help'],
  },
  {
    id: 'stop',
    command: '/stop',
    aliases: ['stop'],
    summary: '停止指定会话当前正在跑的轮次',
    usage: ['/stop', '/stop #abc123', '/stop abc123'],
    description: [
      '取消该会话当前轮次；不删除会话，也不清除历史。',
      '不传 code 时使用当前回复的会话或最近一次操作的会话。',
    ],
    examples: [
      { command: '/stop', note: '停止最近会话的当前轮次' },
      { command: '/stop #abc123', note: '停止指定会话' },
    ],
    notes: ['只能停止正在运行的轮次；空闲会话不会受影响。'],
    related: ['/status', '/sessions'],
  },
  {
    id: 'hash',
    command: '#code',
    aliases: ['code', 'hash'],
    summary: '用会话 hash 直接发送内容，不需要先打开会话',
    usage: [
      '#abc123 继续实现登录页',
      '#abc123 /steer 先补测试',
      '#abc123 /btw 现在在做什么？',
      '#abc123',
    ],
    description: [
      '`#code 内容`：把内容作为普通 prompt 发送给该会话。',
      '`#code /steer 内容`：以 steer 模式发送。',
      '`#code /btw 问题`：对该会话旁问。',
      '单独发送 `#code`：查看该会话状态。',
      '也可以直接回复任意一条会话通知，内容会发给对应会话。',
    ],
    examples: [
      { command: '#abc123 继续实现登录页', note: '发送普通 prompt' },
      { command: '#abc123 /steer 先补测试', note: 'steer 模式' },
      { command: '#abc123 /btw 现在在做什么？', note: '旁问' },
      { command: '#abc123', note: '状态' },
    ],
    notes: [
      'hash 可通过 `/sessions` 详情卡的「发送 hash」获取，长按复制。',
      'hash 不是会话 ID，只是 dsh-lark-ctrl 的短标识。',
    ],
    related: ['/sessions', '/btw', '/status'],
  },
  {
    id: 'archive',
    command: '/archive',
    aliases: ['archive'],
    summary: '把长回答归档到飞书文档，并按日期清理旧归档',
    usage: [
      '/archive',
      '/archive delete-before 2026-11-01',
    ],
    description: [
      '配置 `archiveParentUrl` 后，长回答完成卡会出现「归档完整回答到飞书文档」按钮。',
      '归档父文档按日期（`YYYY-MM-DD`）和会话码（`#code`）组织，每个回答是父文档下的子文档链接。',
      '插件不保存归档结构；每次归档/清理都会重新读取父文档并按最新 revision 写入。',
    ],
    examples: [
      { command: '/archive', note: '查看归档父文档配置和状态' },
      { command: '/archive delete-before 2026-11-01', note: '预览并确认删除该日期之前的归档回答' },
    ],
    notes: [
      '归档父文档必须是 docx 类型的 Wiki 节点。',
      '删除只处理带 [dsh-lark] 标记的链接及其子文档，不删除用户手动添加的内容。',
      '长回答按钮只在回答被卡片截断时出现。',
    ],
    related: ['/status', '/workspaces', '/help'],
  },
]

/** @type {Map<string, HelpTopic>} */
const TOPIC_INDEX = new Map()
for (const topic of HELP_TOPICS) {
  TOPIC_INDEX.set(topic.id, topic)
  TOPIC_INDEX.set(topic.command.replace(/^[\/#]+/, '').toLowerCase(), topic)
  for (const alias of topic.aliases ?? []) TOPIC_INDEX.set(alias.toLowerCase(), topic)
}

/**
 * @param {unknown} value - `/sessions`, `sessions`, `/push 1`, ...
 * @returns {HelpTopic | undefined}
 */
export function findHelpTopic(value) {
  const text = String(value ?? '').trim()
  if (text === '') return undefined
  const first = text.split(/\s+/, 1)[0]
  const key = first.replace(/^[\/#]+/, '').toLowerCase()
  return TOPIC_INDEX.get(key)
}

/** @returns {HelpTopic[]} */
export function helpTopics() {
  return HELP_TOPICS
}
