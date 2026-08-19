/**
 * 审批卡片：DSH approval/request → 飞书 Schema 2.0 三按钮卡（P2）
 *
 * 模式照搬 DSH 内置先例 packages/host/apiproxy/src/api-proxy.ts 的 approval
 * 挂起通道（MIT, DeepSeek Harness）：
 * - 监听 `approval/request` waterfall：从 req.agent.session.events 反向找
 *   未决定的 `approval/asked` 审计事件拿 approvalId（排除已 decided/claimed，
 *   按 callId 对称匹配），无则 next() 放行到 fail-closed 默认
 * - 把请求挂起（返回 Promise 直到外部应答），飞书卡片即「外部」通道：
 *   三按钮（✅ 允许 / ♾️ 永久允许 / ❌ 拒绝），value 携带 requestId
 * - card.action.trigger 回调解析 value → resolve 挂起 promise
 * - 超时（可配置，默认 5 分钟）自动拒绝并提示用户
 * - teardown 时把所有挂起 settle 为 'cancelled'（与 apiproxy 一致）
 *
 * 卡片结构照 CChh adapters/feishu/index.ts buildPermissionCard（MIT,
 * Copyright (c) 2026 cc-haha），因 DSH ApprovalRequest 只有 toolName/reason
 * 无工具入参，省略目标预览与跨目录警告。
 *
 * 注意：DSH ApprovalOutcome 词汇只有 allowed-once/rejected/cancelled/
 * unavailable，官方不支持跨次永久授权；「♾️ 永久允许」由本插件的
 * ApprovalMemoryStore 在桥接层落地（见 approval-memory.ts）：
 * - 可永久化 reason（看不清但非破坏类）→ 落记忆，后续同 toolName+reason 自动放行
 * - 破坏性/敏感 reason → 拒绝永久化，仅本次单次允许
 */

import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AuditLog } from './audit.js'
import { normalizeApprovalReason, type ApprovalMemoryStore } from './approval-memory.js'

// ---------------------------------------------------------------------------
// 卡片构建（Schema 2.0，三按钮）
// ---------------------------------------------------------------------------

/** 构建权限审批卡。照 CChh buildPermissionCard 的结构（无工具入参版本）。 */
export function buildApprovalCard(params: {
  toolName: string
  reason?: string
  requestId: string
}): Record<string, unknown> {
  const { toolName, reason, requestId } = params
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: false,
      update_multi: true,
    },
    header: {
      title: { tag: 'plain_text', content: '🔐 需要权限确认' },
      subtitle: { tag: 'plain_text', content: toolName },
      template: 'orange',
      padding: '12px 12px 12px 12px',
      icon: { tag: 'standard_icon', token: 'lock-chat_filled' },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `**${toolName}** 请求执行${reason ? `\n\n> ${reason}` : ''}`,
        },
        { tag: 'hr', margin: '12px 0 0 0' },
        {
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
                  text: { tag: 'plain_text', content: '✅ 允许' },
                  type: 'primary',
                  size: 'medium',
                  value: { action: 'permit', requestId, allowed: true },
                },
              ],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              vertical_align: 'center',
              elements: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '♾️ 永久允许' },
                  type: 'default',
                  size: 'medium',
                  value: { action: 'permit', requestId, allowed: true, rule: 'always' },
                },
              ],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              vertical_align: 'center',
              elements: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '❌ 拒绝' },
                  type: 'danger',
                  size: 'medium',
                  value: { action: 'permit', requestId, allowed: false },
                },
              ],
            },
          ],
        },
      ],
    },
  }
}

// ---------------------------------------------------------------------------
// 审批挂起服务
// ---------------------------------------------------------------------------

/** card.action.trigger 事件的最小形状。 */
export interface CardActionEvent {
  operator?: { open_id?: string }
  action?: {
    value?: {
      action?: string
      requestId?: string
      allowed?: boolean
      rule?: string
    }
  }
  context?: { open_chat_id?: string }
}

export interface ApprovalCardDeps {
  /** 发送交互卡到 chat，返回 message_id（失败返回 undefined）。 */
  sendCard: (chatId: string, card: Record<string, unknown>) => Promise<string | undefined>
  /** 普通文本消息（超时提示等）。 */
  sendText: (chatId: string, text: string) => Promise<void>
  /** sessionId → chatId 反查（请求只发给归属 chat 的配对用户）。 */
  resolveChat: (sessionId: string) => string | undefined
  /** 审计日志（可选，P5）：审批决策落盘。 */
  audit?: AuditLog
  /** 审批记忆（方案 C）：命中后自动放行；「永久允许」按钮落记忆。 */
  memory?: ApprovalMemoryStore
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void }
}

interface PendingEntry {
  requestId: string
  chatId: string
  toolName: string
  reason: string
  resolve: (outcome: ApprovalOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

/** 默认审批挂起超时（毫秒）。 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟

/**
 * 审批挂起通道：把 approval/request 转成飞书三按钮卡，等待 card.action.trigger
 * 应答或超时。注册方式：attach(ctx)（ctx.on + teardown effect）。
 */
export class ApprovalCardService {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly timeoutMs: number

  constructor(
    private readonly deps: ApprovalCardDeps,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
  }

  /**
   * 注册 approval/request 监听与 teardown。返回 disposer。
   * listener 签名与 cordis waterfall 一致：(req, next) => Promise<ApprovalOutcome>。
   */
  attach(ctx: {
    on(
      name: 'approval/request',
      handler: (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>,
    ): () => void
    effect(execute: () => unknown, label?: string): () => void
  }): () => void {
    const off = ctx.on('approval/request', (req, next) => this.handleRequest(req, next))
    const teardown = ctx.effect(() => () => {
      for (const entry of [...this.pending.values()]) {
        entry.resolve('cancelled')
        clearTimeout(entry.timer)
      }
      this.pending.clear()
    }, 'dsh-feishu-bridge: approval cards')
    return () => { off(); teardown() }
  }

  /** 当前挂起的审批数（测试/状态用）。 */
  pendingCount(): number {
    return this.pending.size
  }

  /**
   * approval/request waterfall 处理：找审计 id → 发飞书卡 → 挂起等待。
   * 无对应 asked 事件或该会话没有飞书 chat → next() 放行。
   */
  private async handleRequest(
    req: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    // 与 apiproxy 相同：abort 竞态同步结算
    if (req.signal?.aborted === true) return 'cancelled'

    // 审批记忆命中（方案 C）：同 toolName + 同归一化 reason 直接放行，不发卡
    const memory = this.deps.memory
    if (memory !== undefined && req.reason !== undefined && memory.isPermitted(req.toolName, req.reason)) {
      this.deps.audit?.log({
        event: 'approval/decided',
        detail: `${req.toolName} → allowed (approval memory hit: ${normalizeApprovalReason(req.reason)})`,
        chat: this.deps.resolveChat(String(req.agent.session.id)),
      })
      return 'allowed-once'
    }

    const approvalId = findUndecidedApprovalId(req)
    if (approvalId === undefined) return next()

    const chatId = this.deps.resolveChat(String(req.agent.session.id))
    if (chatId === undefined) {
      // 没有飞书 chat 归属（GUI 会话等）→ 不接管，走 fail-closed 默认
      return next()
    }

    const requestId = String(approvalId)
    const cardId = await this.deps.sendCard(chatId, buildApprovalCard({
      toolName: req.toolName,
      reason: req.reason,
      requestId,
    }))
    if (cardId === undefined) {
      // 卡片发送失败 → 不挂起（避免请求永远悬空），放行到默认
      this.deps.logger.warn(`[feishu-bridge] 审批卡发送失败，请求 ${requestId} 走默认处理`)
      return next()
    }

    return await new Promise<ApprovalOutcome>((resolve) => {
      const settle = (outcome: ApprovalOutcome): void => {
        if (!this.pending.delete(requestId)) return
        req.signal?.removeEventListener('abort', onAbort)
        clearTimeout(timer)
        resolve(outcome)
      }
      const onAbort = (): void => {
        settle('cancelled')
        this.deps.audit?.log({
          event: 'approval/decided',
          detail: `${req.toolName} → cancelled (aborted)`,
          chat: chatId,
        })
      }
      const timer = setTimeout(() => {
        if (this.pending.has(requestId)) {
          settle('rejected')
          this.deps.audit?.log({
            event: 'approval/decided',
            detail: `${req.toolName} → rejected (timeout)`,
            chat: chatId,
          })
          void this.deps.sendText(chatId, `⏰ 审批请求 \`${requestId.slice(0, 8)}…\`（${req.toolName}）超时未应答，已自动拒绝。`)
        }
      }, this.timeoutMs)
      req.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(requestId, { requestId, chatId, toolName: req.toolName, reason: req.reason ?? '', resolve: settle, timer })
      this.deps.logger.info(`[feishu-bridge] 审批卡已发送: ${req.toolName} → chat ${chatId} (${requestId.slice(0, 8)}…)`)
    })
  }

  /**
   * card.action.trigger 回调入口。解析 value → 应答挂起审批。
   * 返回飞书卡片回调的 toast 响应（无对应挂起时返回 warning toast）。
   */
  async handleCardAction(data: CardActionEvent): Promise<{ toast: { type: string; content: string } } | undefined> {
    const action = data.action?.value
    if (action?.action !== 'permit') return undefined
    const requestId = action.requestId
    if (!requestId) return undefined

    const entry = this.pending.get(requestId)
    if (!entry) {
      return { toast: { type: 'warning', content: '审批请求不存在或已处理' } }
    }

    const allowed = action.allowed ?? false
    const rule = action.rule
    if (!allowed) {
      entry.resolve('rejected')
      this.deps.audit?.log({
        event: 'approval/decided',
        detail: `${entry.toolName} → rejected`,
        chat: entry.chatId,
      })
      await this.deps.sendText(entry.chatId, '❌ 已拒绝')
      return { toast: { type: 'info', content: '❌ 已拒绝' } }
    }

    // 允许（单次或永久）
    entry.resolve('allowed-once')
    let statusText: string
    if (rule === 'always' && this.deps.memory !== undefined) {
      const result = this.deps.memory.add(entry.toolName, entry.reason)
      if (result.recorded) {
        statusText = `♾️ 已永久允许：\`${result.reasonKey}\`。此后同工具+同原因请求自动放行；撤销请发 \`/approval-memory clear\`。`
        this.deps.audit?.log({
          event: 'approval/decided',
          detail: `${entry.toolName} → allowed-once + permanent memory (${result.reasonKey})`,
          chat: entry.chatId,
        })
      } else {
        statusText = `⚠️ 该请求属于破坏性/敏感操作（\`${normalizeApprovalReason(entry.reason)}\`），不支持永久允许，本次按单次允许处理。`
        this.deps.audit?.log({
          event: 'approval/decided',
          detail: `${entry.toolName} → allowed-once (permanent rejected for reason: ${normalizeApprovalReason(entry.reason)})`,
          chat: entry.chatId,
        })
      }
    } else {
      statusText = '✅ 已允许'
      this.deps.audit?.log({
        event: 'approval/decided',
        detail: `${entry.toolName} → allowed-once${rule === 'always' ? ' (permanent unavailable)' : ''}`,
        chat: entry.chatId,
      })
    }
    await this.deps.sendText(entry.chatId, statusText)
    return { toast: { type: 'info', content: '✅ 已允许' } }
  }
}

// ---------------------------------------------------------------------------
// approval/asked 审计 id 查找（照 apiproxy 的对称配对逻辑）
// ---------------------------------------------------------------------------

/**
 * 从会话事件日志反向找本请求对应的未决定 approval/asked id。
 * 排除已 decided 与已被其他挂起 claim 的 id；callId 对称匹配。
 */
export function findUndecidedApprovalId(
  req: ApprovalRequest,
  claimed = new Set<string>(),
): string | undefined {
  const events = req.agent.session.events
  const decided = new Set<string>()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as SessionEvent
    if (event.type === 'approval/decided') {
      decided.add(String(event.data.id))
    } else if (event.type === 'approval/asked') {
      const id = String(event.data.id)
      if (decided.has(id) || claimed.has(id)) continue
      if ((req.callId ?? null) !== (event.data.callId ?? null)) continue
      return id
    }
  }
  return undefined
}
