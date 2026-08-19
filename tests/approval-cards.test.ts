/**
 * 审批卡片测试（P2）
 *
 * 覆盖：卡片结构（三按钮 value）、approval/request → 挂起 → 应答映射、
 * 超时自动拒绝、signal abort、无审计事件/无 chat/发卡失败放行、teardown。
 */

import { describe, it, expect, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import {
  ApprovalCardService,
  buildApprovalCard,
  findUndecidedApprovalId,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type ApprovalCardDeps,
} from '../src/approval-cards.js'
import { ApprovalMemoryStore } from '../src/approval-memory.js'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakeAgent(sessionId: SessionId, events: SessionEvent[]): Agent {
  return {
    id: sessionId,
    session: { id: sessionId, header: {}, events },
    options: {},
    inbox: {},
    status: 'idle',
    ctx: {},
  } as unknown as Agent
}

function askedEvent(id: string, callId?: string): SessionEvent {
  return { type: 'approval/asked', seq: 1, time: 1, data: { id, toolName: 'bash', ...(callId ? { callId } : {}) } } as unknown as SessionEvent
}

function decidedEvent(id: string, outcome: ApprovalOutcome): SessionEvent {
  return { type: 'approval/decided', seq: 2, time: 2, data: { id, outcome } } as unknown as SessionEvent
}

function makeRequest(agent: Agent, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { agent, toolName: 'bash', ...overrides }
}

interface Harness {
  service: ApprovalCardService
  cards: Array<{ chatId: string; card: Record<string, unknown> }>
  sent: Array<{ chatId: string; text: string }>
  handler?: (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>
  teardownEffect?: () => void
  resolveChat: (sessionId: string) => string | undefined
}

function makeHarness(options: {
  timeoutMs?: number
  sendCardResult?: string | undefined
  resolveChat?: (sid: string) => string | undefined
  memory?: ApprovalMemoryStore
} = {}): Harness {
  const cards: Array<{ chatId: string; card: Record<string, unknown> }> = []
  const sent: Array<{ chatId: string; text: string }> = []
  const h: Harness = {
    service: new ApprovalCardService(
      {
        sendCard: async (chatId, card) => {
          cards.push({ chatId, card })
          // '__fail__' 哨兵模拟发卡失败（返回 undefined）
          return options.sendCardResult === '__fail__' ? undefined : (options.sendCardResult ?? 'om_card_1')
        },
        sendText: async (chatId, text) => { sent.push({ chatId, text }) },
        resolveChat: (sid) => h.resolveChat(sid),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        ...(options.memory ? { memory: options.memory } : {}),
      } satisfies ApprovalCardDeps,
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    ),
    cards,
    sent,
    resolveChat: options.resolveChat ?? (() => 'chat-1'),
  }
  const ctx = {
    on: (_name: string, handler: typeof h.handler) => {
      h.handler = handler as typeof h.handler
      return () => { h.handler = undefined }
    },
    effect: (execute: () => unknown) => {
      h.teardownEffect = execute() as () => void
      return () => { h.teardownEffect?.() }
    },
  }
  h.service.attach(ctx as never)
  return h
}

/** 模拟 approval service 的 waterfall 调用（listener 链的最后一个 next 即 fail-closed 默认）。 */
function callHandler(h: Harness, req: ApprovalRequest): Promise<ApprovalOutcome> {
  if (!h.handler) throw new Error('handler not registered')
  return h.handler(req, () => Promise.resolve<ApprovalOutcome>('unavailable'))
}

/** 让 handleRequest 的 sendCard await 链跑完（pending 注册是异步的）。 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

// ---------------------------------------------------------------------------
// 卡片结构
// ---------------------------------------------------------------------------

describe('buildApprovalCard', () => {
  it('Schema 2.0 三按钮卡：header + 工具行 + 允许/永久允许/拒绝', () => {
    const card = buildApprovalCard({ toolName: 'Write', reason: '写入文件', requestId: 'ap-1' })
    expect(card.schema).toBe('2.0')
    const header = card.header as Record<string, unknown>
    expect((header.title as { content: string }).content).toBe('🔐 需要权限确认')
    expect((header.subtitle as { content: string }).content).toBe('Write')
    expect(header.template).toBe('orange')

    const elements = (card.body as { elements: Record<string, unknown>[] }).elements
    expect(elements[0]).toMatchObject({ tag: 'markdown' })
    expect((elements[0] as { content: string }).content).toContain('写入文件')

    const columnSet = elements[2] as { columns: Array<{ elements: Array<{ value: Record<string, unknown> }> }> }
    expect(columnSet.tag).toBe('column_set')
    const buttons = columnSet.columns.map((c) => c.elements[0]!.value)
    expect(buttons).toEqual([
      { action: 'permit', requestId: 'ap-1', allowed: true },
      { action: 'permit', requestId: 'ap-1', allowed: true, rule: 'always' },
      { action: 'permit', requestId: 'ap-1', allowed: false },
    ])
  })
})

// ---------------------------------------------------------------------------
// findUndecidedApprovalId
// ---------------------------------------------------------------------------

describe('findUndecidedApprovalId', () => {
  it('从事件日志找未决定的 asked id', () => {
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-1', 'c1')])
    expect(findUndecidedApprovalId(makeRequest(agent, { callId: 'c1' as never }))).toBe('ap-1')
  })

  it('已 decided 的 id 跳过', () => {
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-1'), decidedEvent('ap-1', 'rejected'), askedEvent('ap-2')])
    expect(findUndecidedApprovalId(makeRequest(agent))).toBe('ap-2')
  })

  it('已被 claim 的 id 跳过', () => {
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-1'), askedEvent('ap-2')])
    expect(findUndecidedApprovalId(makeRequest(agent), new Set(['ap-1']))).toBe('ap-2')
  })

  it('callId 对称匹配：有 callId 的请求只匹配同 callId 的 asked', () => {
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-1'), askedEvent('ap-2', 'c2')])
    expect(findUndecidedApprovalId(makeRequest(agent, { callId: 'c2' as never }))).toBe('ap-2')
    expect(findUndecidedApprovalId(makeRequest(agent))).toBe('ap-1')
  })

  it('无 asked 事件返回 undefined', () => {
    const agent = makeFakeAgent('s1' as SessionId, [])
    expect(findUndecidedApprovalId(makeRequest(agent))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// approval/request 挂起
// ---------------------------------------------------------------------------

describe('ApprovalCardService approval/request', () => {
  it('挂起请求：发三按钮卡到归属 chat，等待应答', async () => {
    const h = makeHarness()
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-1', 'c1')])
    const promise = callHandler(h, makeRequest(agent, { callId: 'c1' as never, reason: '写入文件' }))
    await flush()

    expect(h.cards).toHaveLength(1)
    expect(h.cards[0]!.chatId).toBe('chat-1')
    expect(h.service.pendingCount()).toBe(1)

    const toast = await h.service.handleCardAction({
      operator: { open_id: 'ou_1' },
      action: { value: { action: 'permit', requestId: 'ap-1', allowed: true } },
      context: { open_chat_id: 'chat-1' },
    })
    expect(toast).toEqual({ toast: { type: 'info', content: '✅ 已允许' } })
    await expect(promise).resolves.toBe('allowed-once')
    expect(h.sent.some((s) => s.text.includes('✅ 已允许'))).toBe(true)
    expect(h.service.pendingCount()).toBe(0)
  })

  it('拒绝按钮 → rejected + ❌ 回复', async () => {
    const h = makeHarness()
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-1')])
    const promise = callHandler(h, makeRequest(agent))
    await flush()

    await h.service.handleCardAction({
      action: { value: { action: 'permit', requestId: 'ap-1', allowed: false } },
    })
    await expect(promise).resolves.toBe('rejected')
    expect(h.sent.some((s) => s.text.includes('❌ 已拒绝'))).toBe(true)
  })

  it('无审批记忆时永久允许按钮 → 按单次允许处理', async () => {
    const h = makeHarness()
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-1')])
    const promise = callHandler(h, makeRequest(agent))
    await flush()

    await h.service.handleCardAction({
      action: { value: { action: 'permit', requestId: 'ap-1', allowed: true, rule: 'always' } },
    })
    await expect(promise).resolves.toBe('allowed-once')
    const status = h.sent.find((s) => s.text.includes('已允许'))!.text
    expect(status).toBe('✅ 已允许')
  })

  it('超时（timeoutMs）自动拒绝并提示用户', async () => {
    const h = makeHarness({ timeoutMs: 20 })
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-1')])
    const promise = callHandler(h, makeRequest(agent))

    await expect(promise).resolves.toBe('rejected')
    expect(h.sent.some((s) => s.text.includes('超时未应答') && s.text.includes('已自动拒绝'))).toBe(true)
    expect(h.service.pendingCount()).toBe(0)
  })

  it('signal abort → cancelled（挂起不残留）', async () => {
    const h = makeHarness()
    const controller = new AbortController()
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-1')])
    const promise = callHandler(h, makeRequest(agent, { signal: controller.signal }))
    await flush()
    expect(h.service.pendingCount()).toBe(1)

    controller.abort()
    await expect(promise).resolves.toBe('cancelled')
    expect(h.service.pendingCount()).toBe(0)
  })

  it('已 aborted 的信号同步结算为 cancelled（不发卡）', async () => {
    const h = makeHarness()
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-1')])
    const outcome = await callHandler(h, makeRequest(agent, { signal: AbortSignal.abort() }))
    expect(outcome).toBe('cancelled')
    expect(h.cards).toHaveLength(0)
  })

  it('无 asked 审计事件 → next() 放行（不接管）', async () => {
    const h = makeHarness()
    const agent = makeFakeAgent('s1' as SessionId, [])
    let nextCalled = false
    const outcome = await h.handler!(makeRequest(agent), async () => {
      nextCalled = true
      return 'unavailable' as const
    })
    expect(nextCalled).toBe(true)
    expect(outcome).toBe('unavailable')
    expect(h.cards).toHaveLength(0)
  })

  it('会话无飞书 chat 归属 → next() 放行', async () => {
    const h = makeHarness({ resolveChat: () => undefined })
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-1')])
    const outcome = await callHandler(h, makeRequest(agent))
    expect(outcome).toBe('unavailable')
    expect(h.cards).toHaveLength(0)
  })

  it('发卡失败 → 不挂起，next() 放行', async () => {
    const h = makeHarness({ sendCardResult: '__fail__' })
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-1')])
    const outcome = await callHandler(h, makeRequest(agent))
    expect(outcome).toBe('unavailable')
    expect(h.service.pendingCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 审批记忆（方案 C）：永久允许落地
// ---------------------------------------------------------------------------

describe('审批记忆（方案 C）', () => {
  function makeMemoryHarness() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-approval-memory-'))
    const memory = new ApprovalMemoryStore(dir)
    const h = makeHarness({ memory })
    return { h, memory, dir }
  }

  it('记忆命中：同 toolName+reason 直接放行，不发卡不挂起', async () => {
    const { h, memory, dir } = makeMemoryHarness()
    memory.add('bash', '[auto-mode approval required] the command name is produced by a dynamic expansion')
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-1')])
    const outcome = await callHandler(h, makeRequest(agent, {
      reason: '[auto-mode approval required] the command name is produced by a dynamic expansion',
    }))
    expect(outcome).toBe('allowed-once')
    expect(h.cards).toHaveLength(0)
    expect(h.service.pendingCount()).toBe(0)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('记忆未命中：照常发卡挂起', async () => {
    const { h, dir } = makeMemoryHarness()
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-1')])
    const promise = callHandler(h, makeRequest(agent, { reason: 'opaque nested execution requires manual review' }))
    await flush()
    expect(h.cards).toHaveLength(1)
    await h.service.handleCardAction({ action: { value: { action: 'permit', requestId: 'ap-1', allowed: false } } })
    await expect(promise).resolves.toBe('rejected')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('永久允许 + 可永久化 reason → 落记忆并提示', async () => {
    const { h, memory, dir } = makeMemoryHarness()
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-1')])
    const promise = callHandler(h, makeRequest(agent, {
      reason: '[auto-mode approval required] the command name is produced by a dynamic expansion',
    }))
    await flush()
    await h.service.handleCardAction({
      action: { value: { action: 'permit', requestId: 'ap-1', allowed: true, rule: 'always' } },
    })
    await expect(promise).resolves.toBe('allowed-once')
    expect(memory.isPermitted('bash', '[auto-mode approval required] the command name is produced by a dynamic expansion')).toBe(true)
    expect(h.sent.some((s) => s.text.includes('已永久允许'))).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('永久允许 + 破坏性 reason → 不落记忆，提示不支持永久', async () => {
    const { h, memory, dir } = makeMemoryHarness()
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-1')])
    const promise = callHandler(h, makeRequest(agent, {
      reason: '[auto-mode approval required] deleting pre-session or unobserved data requires specific user authorization: /x',
    }))
    await flush()
    await h.service.handleCardAction({
      action: { value: { action: 'permit', requestId: 'ap-1', allowed: true, rule: 'always' } },
    })
    await expect(promise).resolves.toBe('allowed-once')
    expect(memory.isPermitted('bash', 'deleting pre-session or unobserved data requires specific user authorization')).toBe(false)
    expect(h.sent.some((s) => s.text.includes('不支持永久允许'))).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('记忆命中后仍需人工的破坏性请求不受影响（不同 reason 不豁免）', async () => {
    const { h, memory, dir } = makeMemoryHarness()
    memory.add('bash', '[auto-mode approval required] the command name is produced by a dynamic expansion')
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-1')])
    const promise = callHandler(h, makeRequest(agent, {
      reason: '[auto-mode approval required] opaque nested execution requires manual review',
    }))
    await flush()
    expect(h.cards).toHaveLength(1)
    await h.service.handleCardAction({ action: { value: { action: 'permit', requestId: 'ap-1', allowed: false } } })
    await expect(promise).resolves.toBe('rejected')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// handleCardAction 边界
// ---------------------------------------------------------------------------

describe('handleCardAction 边界', () => {
  it('未知 requestId → warning toast，不抛错', async () => {
    const h = makeHarness()
    const toast = await h.service.handleCardAction({
      action: { value: { action: 'permit', requestId: 'no-such', allowed: true } },
    })
    expect(toast).toEqual({ toast: { type: 'warning', content: '审批请求不存在或已处理' } })
  })

  it('非 permit action → undefined', async () => {
    const h = makeHarness()
    expect(await h.service.handleCardAction({ action: { value: { action: 'other' } } })).toBeUndefined()
    expect(await h.service.handleCardAction({})).toBeUndefined()
  })

  it('同一 requestId 二次应答被忽略（幂等）', async () => {
    const h = makeHarness()
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-1')])
    const promise = callHandler(h, makeRequest(agent))
    await flush()
    await h.service.handleCardAction({ action: { value: { action: 'permit', requestId: 'ap-1', allowed: true } } })
    await expect(promise).resolves.toBe('allowed-once')
    const toast = await h.service.handleCardAction({ action: { value: { action: 'permit', requestId: 'ap-1', allowed: false } } })
    expect(toast).toEqual({ toast: { type: 'warning', content: '审批请求不存在或已处理' } })
  })
})

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------

describe('审批审计（P5）', () => {
  function makeAuditHarness() {
    const auditLogs: Array<{ event: string; detail: string; chat?: string }> = []
    const audit = { log: vi.fn((r: { event: string; detail: string; chat?: string }) => { auditLogs.push(r) }) }
    const h = makeHarness()
    ;(h.service as unknown as { deps: ApprovalCardDeps }).deps = {
      ...(h.service as unknown as { deps: ApprovalCardDeps }).deps,
      audit,
    }
    return { h, auditLogs, audit }
  }

  it('按钮决策写入审计（工具名 + 结果）', async () => {
    const { h, auditLogs } = makeAuditHarness()
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-audit')])
    const promise = callHandler(h, makeRequest(agent))
    await flush()
    await h.service.handleCardAction({ action: { value: { action: 'permit', requestId: 'ap-audit', allowed: true } } })
    await promise
    expect(auditLogs.some(r => r.event === 'approval/decided' && r.detail.includes('bash') && r.detail.includes('allowed'))).toBe(true)
  })

  it('超时拒绝写入审计', async () => {
    const h = makeHarness({ timeoutMs: 20 })
    const auditLogs: Array<{ event: string; detail: string }> = []
    ;(h.service as unknown as { deps: ApprovalCardDeps }).deps = {
      ...(h.service as unknown as { deps: ApprovalCardDeps }).deps,
      audit: { log: (r: { event: string; detail: string }) => { auditLogs.push(r) } },
    }
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-to')])
    const promise = callHandler(h, makeRequest(agent))
    await expect(promise).resolves.toBe('rejected')
    expect(auditLogs.some(r => r.event === 'approval/decided' && r.detail.includes('timeout'))).toBe(true)
  })
})

describe('teardown', () => {
  it('effect 卸载时挂起全部 settle 为 cancelled', async () => {
    const h = makeHarness()
    const agent = makeFakeAgent('s1' as SessionId, [askedEvent('ap-1')])
    const promise = callHandler(h, makeRequest(agent))
    await flush()
    expect(h.service.pendingCount()).toBe(1)

    h.teardownEffect!()
    await expect(promise).resolves.toBe('cancelled')
    expect(h.service.pendingCount()).toBe(0)
  })

  it('DEFAULT_APPROVAL_TIMEOUT_MS 为 5 分钟', () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBe(5 * 60 * 1000)
  })
})
