/**
 * DSH 会话桥接核心（本插件自有实现，基于 t3 报告确认的 DSH 扩展点）。
 *
 * 职责：
 * - chatId → DSH session 映射（持久化到 stateDir/sessions.json，重启可 resume）
 * - 飞书用户消息 → ctx.agents.create/resume + followup() 注入 user 消息
 * - 订阅 session/event，把 assistant/chunk（文本增量、reasoning 增量）、
 *   tool/call、tool/result、turn/end 路由到对应 chat 的 StreamingCard
 * - 订阅 agent/error，错误时 abort 卡片
 *
 * 依赖全部注入（agents/logger/事件源/卡片工厂），单元测试无需真实 DSH 环境。
 */

import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type * as Lark from '@larksuiteoapi/node-sdk'
import { StreamingCard } from './feishu/streaming-card.js'

// ---------------------------------------------------------------------------
// 注入接口（结构子类型，测试可 mock）
// ---------------------------------------------------------------------------

/** ctx.agents 的最小使用面。 */
export interface BridgeAgents {
  create(options: {
    sessionId: SessionId
    meta?: { cwd?: string; parentSession?: SessionId; agentPreset?: string }
    agentOptions?: { provider?: string; model?: string; maxTokens?: number }
    setup?: (agentCtx: unknown) => Promise<void> | void
  }): Promise<AgentHandle>
  resume(options: {
    resumeSessionId: SessionId
    agentOptions?: { provider?: string; model?: string; maxTokens?: number }
  }): Promise<AgentHandle>
  get(id: SessionId): Agent | undefined
}

/** Cordis ctx.on 的最小使用面。 */
export interface BridgeEventSource {
  on(name: 'session/event', handler: (session: Session, event: SessionEvent) => void): () => void
  on(name: 'agent/error', handler: (payload: { agent: Agent; turn: number; step: number; error: unknown }) => void): () => void
}

export interface BridgeLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** chatId → DSH sessionId 的持久化映射。 */
export interface SessionMapping {
  [chatId: string]: { sessionId: string; cwd?: string }
}

export interface BridgeOptions {
  /** 新会话的工作目录（SessionHeader.cwd，创建时固化）。 */
  defaultCwd: string
  /** 状态目录（sessions.json 落在这里）。 */
  stateDir: string
  agents: BridgeAgents
  logger: BridgeLogger
  larkClient: Lark.Client
  /** 普通文本消息发送（配对提示/兜底提示用）。 */
  sendText: (chatId: string, text: string) => Promise<void>
  /** 流式卡片工厂；默认用 StreamingCard 真实实现，测试可注入 fake。 */
  createStreamingCard?: (chatId: string, replyToMessageId?: string) => StreamingCard
  /** 新建 agent 的默认模型选择（provider/model；{{model}} 系统变量依赖它）。 */
  agentOptions?: { provider: string; model: string; reasoningEffort?: string }
  /** 新建 agent 的 agent preset id（工具装配；缺省 'standard'，与 GUI 会话一致）。 */
  agentPreset?: string
  /** 远程会话权限预设（缺省 'workspace-write'：工作区内自由、工作区外审批卡）。 */
  remotePermissionPreset?: string
  /** 工作区注册表（可选）：新建会话后登记到 cwd 对应工作区，避免落在 GUI「未分组」。 */
  workspaceRegistry?: {
    resolveByPath(path: string): Promise<{ attachSession(sessionId: unknown): Promise<void> } | undefined>
    create(path: string): Promise<{ attachSession(sessionId: unknown): Promise<void> }>
  }
  /** agent-presets 服务（可选）：新建会话时把预设装配进 agent 作用域（工具集依赖它）。 */
  agentPresets?: {
    resolve(id?: string): Promise<{ id: string }>
    mount(agentCtx: unknown, id?: string): Promise<{ id: string }>
  }
  /** permission-presets 服务（可选）：新建会话后强制 workspace-write（工作区外操作走飞书审批卡）。 */
  permissionPresets?: {
    set(session: { events: unknown }, name: string): void
    /** DSH 运行时已注册的预设名（含用户自定义，如 auto）。 */
    readonly names?: readonly string[]
  }
  /** 远程配置存储（/config 命令）：运行时覆盖 defaultCwd / remotePermissionPreset。 */
  runtimeConfig?: {
    load(): { remotePermissionPreset?: string; sessionCwd?: string }
    set(key: string, value: string, allowedPermissionPresets?: readonly string[]): string | null
    describe(allowedPermissionPresets?: readonly string[]): string
  }
  /** 远程会话装配钩子（可选）：preset mount 之后调用，注册远程专用工具（如 ask_user_question 飞书版）。 */
  registerRemoteTools?: (agentCtx: unknown) => void
}

/** /config 命令返回的运行时配置状态。 */
export interface RuntimeConfigStatus {
  ok: boolean
  /** 错误文本（校验失败）或成功提示。 */
  message: string
}

interface ChatEntry {
  chatId: string
  sessionId: SessionId
  /** 会话工作目录（创建时固化；/new 可换）。 */
  cwd: string
  handle?: AgentHandle
  /** 当前活跃的流式卡片（一个 turn 一张）。 */
  card?: StreamingCard
}

/** /status 命令返回的会话状态快照。 */
export interface BridgeStatus {
  hasSession: boolean
  sessionId?: string
  cwd?: string
  agentStatus?: 'idle' | 'running'
  cardActive: boolean
}

export class Bridge {
  private readonly mappingPath: string
  private mapping: SessionMapping = {}
  private readonly entries = new Map<string, ChatEntry>()
  /** sessionId → chatId 反向索引，事件回调 O(1) 路由。 */
  private readonly sessionToChat = new Map<string, string>()
  private disposers: (() => void)[] = []

  constructor(private readonly opts: BridgeOptions) {
    this.mappingPath = path.join(opts.stateDir, 'sessions.json')
    this.mapping = this.loadMapping()
  }

  /** 订阅 DSH 会话/agent 事件。返回后事件开始路由。 */
  attach(source: BridgeEventSource): void {
    this.disposers.push(
      source.on('session/event', (session, event) => this.onSessionEvent(session, event)),
      source.on('agent/error', (payload) => this.onAgentError(payload)),
    )
  }

  /**
   * 处理一条飞书用户文本消息：
   * 1. 确保该 chat 有活 agent（复用 → resume → 新建）
   * 2. 收尾上一张未完成的卡片
   * 3. 创建新流式卡（reply 到用户消息）
   * 4. followup() 注入 user 消息
   */
  async handleUserMessage(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    console.log('[FB-DEBUG] handleUserMessage:', JSON.stringify({ chatId, text: text.slice(0, 100), replyToMessageId }))
    const agent = await this.ensureAgent(chatId)
    const entry = this.entries.get(chatId)!

    // 上一条消息的卡片还没收尾（用户在生成中连发）→ 先收尾
    if (entry.card) {
      const previous = entry.card
      entry.card = undefined
      try {
        await previous.finalize()
      } catch (err) {
        this.opts.logger.warn(`[feishu-bridge] 收尾上一张卡片失败: ${String(err)}`)
      }
    }

    const card = this.opts.createStreamingCard
      ? this.opts.createStreamingCard(chatId, replyToMessageId)
      : new StreamingCard({ larkClient: this.opts.larkClient, chatId, replyToMessageId })
    entry.card = card
    try {
      await card.ensureCreated()
    } catch (err) {
      // 卡片创建失败（飞书 API 不可用等）→ 降级为纯文本提示，消息继续提交
      entry.card = undefined
      this.opts.logger.warn(`[feishu-bridge] 卡片创建失败，降级纯文本: ${String(err)}`)
      await this.opts.sendText(chatId, '⚠️ 卡片创建失败（飞书 API 不可用？），消息已继续处理。')
    }

    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    agent.followup(message)
  }

  /** 摘除事件订阅、收尾卡片、dispose 本桥接创建的 agent。 */
  async dispose(): Promise<void> {
    for (const disposer of this.disposers.splice(0)) {
      try { disposer() } catch { /* 忽略单个订阅摘除失败 */ }
    }
    for (const entry of this.entries.values()) {
      if (entry.card) {
        try { await entry.card.finalize() } catch { /* 忽略 */ }
        entry.card = undefined
      }
      if (entry.handle) {
        try { await entry.handle.dispose() } catch { /* 忽略 */ }
      }
    }
    this.entries.clear()
    this.sessionToChat.clear()
  }

  // ------------------------------------------------------------------
  // 远程命令（/clear /new /stop /status）
  // ------------------------------------------------------------------

  /**
   * 重置 chat 的会话：收尾/中止进行中的卡片，dispose 旧 AgentHandle，
   * 删除持久化映射与内存 entry。下次消息会新建会话。
   */
  async resetSession(chatId: string): Promise<void> {
    const entry = this.entries.get(chatId)
    if (entry) {
      if (entry.card) {
        const card = entry.card
        entry.card = undefined
        try { await card.finalize() } catch { /* 忽略 */ }
      }
      if (entry.handle) {
        const handle = entry.handle
        entry.handle = undefined
        try { await handle.dispose() } catch { /* 忽略 */ }
      }
      this.sessionToChat.delete(String(entry.sessionId))
      this.entries.delete(chatId)
    }
    if (this.mapping[chatId]) {
      delete this.mapping[chatId]
      this.saveMapping()
    }
  }

  /**
   * /new（或 /clear）的核心：先 resetSession 拆除旧会话，再立即新建
   * 会话（可用 cwd 指定工作目录，缺省沿用默认工作目录）。返回新会话信息。
   */
  async recreateSession(
    chatId: string,
    cwd?: string,
  ): Promise<{ sessionId: SessionId; cwd: string }> {
    await this.resetSession(chatId)
    const agent = await this.ensureAgent(chatId, cwd)
    const entry = this.entries.get(chatId)!
    return { sessionId: agent.session.id, cwd: entry.cwd }
  }

  /** /status：chat 的会话状态快照（真实读 entries + 活 agent）。 */
  status(chatId: string): BridgeStatus {
    const entry = this.entries.get(chatId)
    if (!entry) {
      const rec = this.mapping[chatId]
      if (!rec) return { hasSession: false, cardActive: false }
      return {
        hasSession: false,
        sessionId: rec.sessionId,
        cwd: rec.cwd ?? this.opts.defaultCwd,
        cardActive: false,
      }
    }
    const agent = this.opts.agents.get(entry.sessionId)
    return {
      hasSession: true,
      sessionId: String(entry.sessionId),
      cwd: entry.cwd,
      agentStatus: agent?.status ?? (entry.handle ? 'idle' : undefined),
      cardActive: entry.card !== undefined,
    }
  }

  /** /stop：中断当前生成。返回是否有一个 running agent 被取消。 */
  stop(chatId: string): boolean {
    const entry = this.entries.get(chatId)
    if (!entry) return false
    const agent = this.opts.agents.get(entry.sessionId) ?? entry.handle?.agent
    if (!agent) return false
    if (agent.status !== 'running') return false
    agent.cancel({ kind: 'user' })
    return true
  }

  /** sessionId → chatId 反查（审批卡需要把请求路由回归属 chat）。 */
  chatIdOf(sessionId: string): string | undefined {
    return this.sessionToChat.get(sessionId)
  }

  /**
   * 确保 chat 有活 agent（复用 → resume → 新建），返回其 sessionId 与工作目录。
   * 附件下载等需要"先拿到会话身份、再注入消息"的流程使用。
   */
  async ensureAgentForChat(chatId: string, cwd?: string): Promise<{ sessionId: SessionId; cwd: string }> {
    const agent = await this.ensureAgent(chatId, cwd)
    const entry = this.entries.get(chatId)!
    return { sessionId: agent.session.id, cwd: entry.cwd }
  }

  // ------------------------------------------------------------------
  // 会话管理
  // ------------------------------------------------------------------

  private async ensureAgent(chatId: string, cwd?: string): Promise<Agent> {
    // 1) 本进程已建过且 agent 还活着 → 直接复用
    const existing = this.entries.get(chatId)
    if (existing) {
      const agent = this.opts.agents.get(existing.sessionId)
      if (agent) return agent
      // 活 agent 没了（agent-loop 重载/插件卸载等）→ 尝试 resume
      try {
        const handle = await this.opts.agents.resume({
          resumeSessionId: existing.sessionId,
          ...(this.opts.agentOptions === undefined ? {} : { agentOptions: this.opts.agentOptions }),
          // resume 同样装配 preset（工具集）与远程专用工具——之前缺 setup 导致恢复的会话工具不全
          ...(this.opts.agentPresets === undefined ? {} : { setup: this.makePresetSetup() }),
        })
        existing.handle = handle
        return handle.agent
      } catch (err) {
        this.opts.logger.warn(
          `[feishu-bridge] 会话 ${String(existing.sessionId)} 恢复失败，重建: ${String(err)}`,
        )
        this.sessionToChat.delete(String(existing.sessionId))
        this.entries.delete(chatId)
      }
    }

    // 2) 持久化映射里有 → 尝试 resume
    const rec = this.mapping[chatId]
    if (rec) {
      try {
        const handle = await this.opts.agents.resume({
          resumeSessionId: SessionId(rec.sessionId),
          ...(this.opts.agentOptions === undefined ? {} : { agentOptions: this.opts.agentOptions }),
          // resume 同样装配 preset（工具集）与远程专用工具——之前缺 setup 导致恢复的会话工具不全
          ...(this.opts.agentPresets === undefined ? {} : { setup: this.makePresetSetup() }),
        })
        const entry: ChatEntry = {
          chatId,
          sessionId: handle.agent.session.id,
          cwd: rec.cwd ?? this.opts.defaultCwd,
          handle,
        }
        this.entries.set(chatId, entry)
        this.sessionToChat.set(String(handle.agent.session.id), chatId)
        return handle.agent
      } catch (err) {
        this.opts.logger.warn(
          `[feishu-bridge] 恢复会话 ${rec.sessionId} 失败，新建会话: ${String(err)}`,
        )
        delete this.mapping[chatId]
      }
    }

    // 3) 新建会话
    // 工作目录优先级：命令参数（/new <路径>）> 运行时配置（/config sessionCwd）> 插件配置默认
    const runtimeCwd = this.opts.runtimeConfig?.load().sessionCwd?.trim()
    const sessionCwd = cwd?.trim() || runtimeCwd || this.opts.defaultCwd
    const sessionId = SessionId(randomUUID())
    const handle = await this.opts.agents.create({
      sessionId,
      meta: {
        cwd: sessionCwd,
        ...(this.opts.agentPreset === undefined ? {} : { agentPreset: this.opts.agentPreset }),
      },
      ...(this.opts.agentOptions === undefined ? {} : { agentOptions: this.opts.agentOptions }),
      ...(this.opts.agentPresets === undefined ? {} : { setup: this.makePresetSetup() }),
    })
    this.mapping[chatId] = { sessionId: String(sessionId), cwd: sessionCwd }
    this.saveMapping()
    const entry: ChatEntry = { chatId, sessionId, cwd: sessionCwd, handle }
    this.entries.set(chatId, entry)
    this.sessionToChat.set(String(sessionId), chatId)
    void this.attachToWorkspace(sessionId)
    this.applyRemotePermissionPreset(handle.agent.session)
    return handle.agent
  }

  /**
   * 远程会话权限预设：强制 workspace-write（sandbox=workspace-write + approval=ask）。
   * 效果：工作区内操作免审批，工作区外（如桌面、系统路径）触发 DSH 审批 → 飞书审批卡。
   * 覆盖全局默认（如 auto=danger-full-access+ask，审批形同虚设）。
   * 预设来源优先级：运行时配置（/config）> 插件配置 > 内置 workspace-write。
   */
  private applyRemotePermissionPreset(session: { events: unknown }): void {
    const presets = this.opts.permissionPresets
    if (presets === undefined) return
    const runtime = this.opts.runtimeConfig?.load().remotePermissionPreset?.trim()
    const presetName = runtime || this.opts.remotePermissionPreset?.trim() || 'workspace-write'
    try {
      presets.set(session, presetName)
      console.log(`[FB-DEBUG] 远程会话权限预设已设为 ${presetName}`)
    } catch (err) {
      this.opts.logger.warn(`[feishu-bridge] 设置权限预设失败（沿用全局默认）: ${String(err)}`)
    }
  }

  /**
   * /config 命令：查看或修改远程配置。
   * - 无参数：返回当前运行时配置描述。
   * - 带参数（<键> <值>）：写运行时配置；remotePermissionPreset 立即对当前所有活跃会话生效。
   * 返回 { ok, message } 供命令层回复。
   */
  applyRuntimeConfig(key?: string, value?: string): RuntimeConfigStatus {
    const store = this.opts.runtimeConfig
    if (store === undefined) {
      return { ok: false, message: '运行时配置不可用。' }
    }
    const presetPool = this.opts.permissionPresets?.names
    if (key === undefined) {
      return { ok: true, message: store.describe(presetPool) }
    }
    const err = store.set(key, value ?? '', presetPool)
    if (err !== null) {
      return { ok: false, message: `❌ ${err}` }
    }
    // 权限预设即时生效：对所有活跃会话重新应用
    if (key.trim().toLowerCase() === 'remotepermissionpreset') {
      const presetName = store.load().remotePermissionPreset ?? 'workspace-write'
      for (const entry of this.entries.values()) {
        const agent = this.opts.agents.get(entry.sessionId)
        if (agent) {
          try {
            this.opts.permissionPresets?.set(agent.session, presetName)
          } catch (err2) {
            this.opts.logger.warn(`[feishu-bridge] 即时应用权限预设失败: ${String(err2)}`)
          }
        }
      }
      return { ok: true, message: `✅ 权限预设已改为 \`${presetName}\`（已对当前会话生效，新会话同样生效）` }
    }
    return { ok: true, message: `✅ 已保存：\`${key.trim().toLowerCase()}\` = \`${value?.trim() ?? ''}\`（新会话生效）` }
  }

  /**
   * 把新建会话登记到 cwd 对应的工作区账本（GUI 侧边栏按工作区分组）。
   * 失败只告警不阻断——会话本身已可用，只是暂时显示在「未分组」。
   */
  private async attachToWorkspace(sessionId: SessionId): Promise<void> {
    const registry = this.opts.workspaceRegistry
    if (registry === undefined) return
    try {
      const workspace = await registry.resolveByPath(this.opts.defaultCwd)
        ?? await registry.create(this.opts.defaultCwd)
      await workspace.attachSession(sessionId)
      console.log(`[FB-DEBUG] 会话 ${String(sessionId)} 已登记到工作区（cwd=${this.opts.defaultCwd}）`)
    } catch (err) {
      this.opts.logger.warn(`[feishu-bridge] 会话登记工作区失败（不影响使用）: ${String(err)}`)
    }
  }

  /**
   * 生成 agent 创建/恢复时的 setup 回调：先把 agent preset 装配进 agent 作用域
   * （与 apiproxy 的 composeAgent 同模式：presets.mount 于 factory setup 中调用），
   * 再调用 registerRemoteTools 注册远程专用工具（如 ask_user_question 飞书版，
   * shadow preset 层的同名工具）。
   * setup 抛错会回滚 agent 创建（preset 不可用时会话不会半装配）。
   */
  private makePresetSetup(): (agentCtx: unknown) => Promise<void> {
    const presets = this.opts.agentPresets!
    const presetId = this.opts.agentPreset
    return async (agentCtx: unknown) => {
      await presets.mount(agentCtx, presetId)
      this.opts.registerRemoteTools?.(agentCtx)
      console.log(`[FB-DEBUG] agent preset 已装配: ${String(presetId)}`)
    }
  }

  // ------------------------------------------------------------------
  // 事件路由
  // ------------------------------------------------------------------

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const chatId = this.sessionToChat.get(String(session.id))
    if (chatId === undefined) return
    const card = this.entries.get(chatId)?.card
    if (!card) return

    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') {
          card.appendText(chunk.text)
        } else if (chunk.type === 'reasoning-delta') {
          card.appendReasoning(chunk.text)
        }
        break
      }
      case 'tool/call':
        card.startTool(event.data.callId, event.data.name)
        break
      case 'tool/result':
        card.completeTool(event.data.message.content[0]?.toolCallId, undefined)
        break
      case 'turn/end': {
        const entry = this.entries.get(chatId)
        if (!entry || entry.card !== card) return
        entry.card = undefined
        if (event.data.reason.kind === 'error') {
          const message = event.data.reason.error?.message ?? 'turn failed'
          void card.abort(new Error(message))
        } else {
          if (event.data.reason.kind === 'aborted') {
            // /stop 等用户取消：保留已生成内容，卡片尾部加停止标记
            card.appendText('\n\n---\n⏹ 已停止')
          }
          void card.finalize()
        }
        break
      }
      default:
        break
    }
  }

  private onAgentError(payload: { agent: Agent; turn: number; step: number; error: unknown }): void {
    const chatId = this.sessionToChat.get(String(payload.agent.id))
    if (chatId === undefined) return
    const entry = this.entries.get(chatId)
    if (!entry?.card) return
    const card = entry.card
    entry.card = undefined
    void card.abort(payload.error instanceof Error ? payload.error : new Error(String(payload.error)))
  }

  // ------------------------------------------------------------------
  // 持久化
  // ------------------------------------------------------------------

  private loadMapping(): SessionMapping {
    try {
      const raw = fs.readFileSync(this.mappingPath, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const out: SessionMapping = {}
      for (const [chatId, value] of Object.entries(parsed)) {
        if (value && typeof value === 'object' && typeof (value as { sessionId?: unknown }).sessionId === 'string') {
          out[chatId] = { sessionId: (value as { sessionId: string }).sessionId }
        }
      }
      return out
    } catch {
      return {}
    }
  }

  private saveMapping(): void {
    fs.mkdirSync(path.dirname(this.mappingPath), { recursive: true, mode: 0o700 })
    const tmp = `${this.mappingPath}.tmp.${randomUUID()}`
    fs.writeFileSync(tmp, JSON.stringify(this.mapping, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.mappingPath)
  }
}
