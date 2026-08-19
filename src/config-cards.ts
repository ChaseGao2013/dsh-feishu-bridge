/**
 * /config 交互卡（配置体验优化二，2026-08-18）
 *
 * 背景：用户反馈 `/config` 只回文字，"没法选或者填"。权限预设要手打
 * `/config remotePermissionPreset read-only` 这类命令，不直观。
 *
 * 方案：/config 无参数时发 Schema 2.0 交互卡：
 * - 显示当前权限预设/工作目录
 * - 权限预设：每个可用预设一个按钮（当前值高亮），点击即应用（card.action.trigger）
 * - "📁 修改工作目录"按钮：点击后进入等待输入态，用户下一条普通文本
 *   消息被消费为新的工作目录（与提问卡自由输入同模式）
 * - 等待输入超时（120s）自动退出等待态
 * - 所有操作即时生效（调 Bridge.applyRuntimeConfig 同一入口，含白名单校验）
 */

export interface ConfigCardStatus {
  /** 当前权限预设名（未设置时为 undefined）。 */
  preset?: string
  /** 当前工作目录。 */
  cwd: string
  /** 可用的权限预设名（含用户自定义，如 auto）。 */
  availablePresets: readonly string[]
}

export interface ConfigCardDeps {
  /** 发送交互卡到 chat，返回 message_id（失败返回 undefined）。 */
  sendCard: (chatId: string, card: Record<string, unknown>) => Promise<string | undefined>
  /** 普通文本消息（等待输入提示、操作确认等）。 */
  sendText: (chatId: string, text: string) => Promise<void>
  /** 读取当前配置状态（权限预设/工作目录/可用预设）。 */
  currentStatus: (chatId: string) => ConfigCardStatus
  /** 应用权限预设（白名单校验在 Bridge.applyRuntimeConfig 内）。返回确认文本。 */
  applyPreset: (chatId: string, preset: string) => Promise<string>
  /** 应用工作目录（新会话生效）。返回确认文本。 */
  applyCwd: (chatId: string, cwd: string) => Promise<string>
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void }
}

/** card.action.trigger 事件的最小形状（与 approval-cards.ts 同源）。 */
export interface ConfigCardActionEvent {
  action?: {
    value?: {
      action?: string
      preset?: string
    }
  }
  context?: { open_chat_id?: string }
}

/** 等待工作目录输入的默认超时（毫秒）。 */
export const DEFAULT_CWD_INPUT_TIMEOUT_MS = 120 * 1000 // 2 分钟

// ---------------------------------------------------------------------------
// 卡片构建
// ---------------------------------------------------------------------------

/**
 * 构建 /config 交互卡：当前配置 + 权限预设按钮组 + 修改工作目录按钮。
 * 按钮 value 携带 action（cfg-preset / cfg-cwd）与 preset。
 */
export function buildConfigCard(status: ConfigCardStatus): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: [
        `**当前权限预设**：\`${status.preset ?? '（默认 workspace-write）'}\``,
        `**工作目录**：\`${status.cwd}\``,
        '',
        '点击按钮即可修改：',
      ].join('\n'),
    },
  ]

  // 权限预设按钮：每 2 个一组 column_set
  const presets = status.availablePresets.length > 0 ? status.availablePresets : ['read-only', 'workspace-write', 'danger-full-access']
  for (let start = 0; start < presets.length; start += 2) {
    const columns = presets.slice(start, start + 2).map(preset => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'center',
      elements: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: preset === status.preset ? `✅ ${preset}` : preset },
          type: preset === status.preset ? 'primary' : 'default',
          size: 'medium',
          value: { action: 'cfg-preset', preset },
        },
      ],
    }))
    elements.push({
      tag: 'column_set',
      flex_mode: 'stretch',
      horizontal_spacing: '8px',
      margin: '8px 0 0 0',
      columns,
    })
  }

  elements.push({ tag: 'hr', margin: '12px 0 0 0' })
  elements.push({
    tag: 'column_set',
    flex_mode: 'stretch',
    horizontal_spacing: '8px',
    margin: '8px 0 0 0',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📁 修改工作目录' },
            type: 'default',
            size: 'medium',
            value: { action: 'cfg-cwd' },
          },
        ],
      },
    ],
  })

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: false,
      update_multi: true,
    },
    header: {
      title: { tag: 'plain_text', content: '🎯 远程配置' },
      subtitle: { tag: 'plain_text', content: '点按钮修改，即时生效' },
      template: 'blue',
      padding: '12px 12px 12px 12px',
      icon: { tag: 'standard_icon', token: 'settings_filled' },
    },
    body: { elements },
  }
}

// ---------------------------------------------------------------------------
// 配置卡服务
// ---------------------------------------------------------------------------

/**
 * /config 交互卡服务：发卡、处理按钮回调（改权限预设/进入工作目录输入态）、
 * 消费工作目录输入文本。注册方式：index.ts 构造；handleCardAction 挂在
 * card.action.trigger 分发；tryConsumeCwdInput 挂在入站文本分发。
 */
export class ConfigCardService {
  /** chatId → 等待工作目录输入的定时器。 */
  private readonly waitingCwd = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly timeoutMs: number

  constructor(
    private readonly deps: ConfigCardDeps,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CWD_INPUT_TIMEOUT_MS
  }

  /** 当前等待工作目录输入的 chat 数（测试/状态用）。 */
  waitingCount(): number {
    return this.waitingCwd.size
  }

  /**
   * 发送 /config 交互卡。发卡失败返回 false（调用方可降级为文本）。
   */
  async sendConfigCard(chatId: string): Promise<boolean> {
    const cardId = await this.deps.sendCard(chatId, buildConfigCard(this.deps.currentStatus(chatId)))
    if (cardId === undefined) {
      this.deps.logger.warn('[feishu-bridge] /config 交互卡发送失败')
      return false
    }
    this.deps.logger.info(`[feishu-bridge] /config 交互卡已发送 → chat ${chatId}`)
    return true
  }

  /**
   * card.action.trigger 回调入口：
   * - cfg-preset：应用权限预设（即时生效）
   * - cfg-cwd：进入等待输入态，提示用户回复路径
   * 返回飞书卡片回调的 toast 响应。
   */
  async handleCardAction(data: ConfigCardActionEvent): Promise<{ toast: { type: string; content: string } } | undefined> {
    const value = data.action?.value
    if (value?.action === undefined) return undefined

    if (value.action === 'cfg-preset') {
      const preset = value.preset
      if (!preset) return { toast: { type: 'warning', content: '预设名为空' } }
      // 需要 chatId 才能定位 —— cfg-preset 不携带 chatId，由调用方通过
      // context.open_chat_id 或由 index.ts 包装提供。这里通过 deps 的
      // 回调注入 chatId 解析（见 ConfigCardActionEventWithChat）。
      const chatId = this.resolveChatId(data)
      if (chatId === undefined) return { toast: { type: 'warning', content: '无法定位会话' } }
      const message = await this.deps.applyPreset(chatId, preset)
      await this.deps.sendText(chatId, message)
      return { toast: { type: 'info', content: `✅ 已设置为 ${preset}` } }
    }

    if (value.action === 'cfg-cwd') {
      const chatId = this.resolveChatId(data)
      if (chatId === undefined) return { toast: { type: 'warning', content: '无法定位会话' } }
      this.enterCwdInput(chatId)
      await this.deps.sendText(
        chatId,
        '📁 请回复新的工作目录绝对路径（如 `/path/to/workspace`），将用于之后新建的会话；当前会话不受影响。',
      )
      return { toast: { type: 'info', content: '请输入新的工作目录' } }
    }

    return undefined
  }

  /**
   * 入站文本消费：命中"等待工作目录输入"的 chat 时，把文本作为新路径并返回 true
   * （调用方应不再把该消息送入 DSH 会话/命令处理）。
   */
  tryConsumeCwdInput(chatId: string, text: string): boolean {
    const timer = this.waitingCwd.get(chatId)
    if (timer === undefined) return false
    clearTimeout(timer)
    this.waitingCwd.delete(chatId)
    void this.deps.applyCwd(chatId, text).then(
      (message) => void this.deps.sendText(chatId, message),
      (err) => void this.deps.sendText(chatId, `❌ ${String(err)}`),
    )
    return true
  }

  /** teardown：清空等待态。 */
  dispose(): void {
    for (const timer of this.waitingCwd.values()) clearTimeout(timer)
    this.waitingCwd.clear()
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  /** chatId 解析：card.action.trigger 回调携带 context.open_chat_id。 */
  private resolveChatId(data: ConfigCardActionEvent): string | undefined {
    return data.context?.open_chat_id
  }

  private enterCwdInput(chatId: string): void {
    const existing = this.waitingCwd.get(chatId)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      if (this.waitingCwd.delete(chatId)) {
        void this.deps.sendText(chatId, '⏰ 工作目录输入超时，已取消修改。可再次发送 `/config` 重新操作。')
      }
    }, this.timeoutMs)
    this.waitingCwd.set(chatId, timer)
  }
}
