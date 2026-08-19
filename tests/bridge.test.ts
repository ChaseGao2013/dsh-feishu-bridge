/**
 * DSH 会话桥接单元测试
 *
 * 覆盖：会话创建/复用/resume、followup 注入（user 消息映射）、
 * session/event → StreamingCard 路由（文本/reasoning/工具/turn 收尾）、
 * agent/error → abort、dispose 收尾。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { Bridge, type BridgeEventSource } from '../src/bridge.js'
import { StreamingCard } from '../src/feishu/streaming-card.js'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-bridge-test-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type FakeAgent = Agent & { followup: ReturnType<typeof vi.fn> }

function makeFakeAgent(sessionId: SessionId): FakeAgent {
  return {
    id: sessionId,
    session: { id: sessionId, header: {} },
    options: {},
    inbox: {},
    status: 'idle',
    ctx: {},
    followup: vi.fn(),
    send: vi.fn(),
    steer: vi.fn(),
    inject: vi.fn(),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
    runMaintenance: vi.fn(),
  } as unknown as FakeAgent
}

function makeFakeAgents() {
  const created: Array<{ sessionId: SessionId; meta?: { cwd?: string } }> = []
  const resumed: Array<{ resumeSessionId: SessionId }> = []
  const registry = new Map<string, { agent: FakeAgent; dispose: ReturnType<typeof vi.fn> }>()
  return {
    created,
    resumed,
    registry,
    api: {
      async create(opts: { sessionId: SessionId; meta?: { cwd?: string } }) {
        const agent = makeFakeAgent(opts.sessionId)
        const handle = { agent, dispose: vi.fn(async () => { registry.delete(String(opts.sessionId)) }) }
        registry.set(String(opts.sessionId), { agent, dispose: handle.dispose })
        created.push(opts)
        return handle
      },
      async resume(opts: { resumeSessionId: SessionId }) {
        const agent = makeFakeAgent(opts.resumeSessionId)
        const handle = { agent, dispose: vi.fn(async () => {}) }
        registry.set(String(opts.resumeSessionId), { agent, dispose: handle.dispose })
        resumed.push(opts)
        return handle
      },
      get(id: SessionId): Agent | undefined {
        return registry.get(String(id))?.agent
      },
    },
  }
}

function makeFakeEventSource() {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  return {
    handlers,
    api: {
      on(name: string, handler: (...args: unknown[]) => void): () => void {
        handlers.set(name, handler)
        return () => { handlers.delete(name) }
      },
    } as unknown as BridgeEventSource,
  }
}

function makeFakeCard() {
  return {
    ensureCreated: vi.fn(async () => {}),
    appendText: vi.fn(),
    appendReasoning: vi.fn(),
    startTool: vi.fn(),
    completeTool: vi.fn(),
    finalize: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  }
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

interface Harness {
  agents: ReturnType<typeof makeFakeAgents>
  events: ReturnType<typeof makeFakeEventSource>
  cards: ReturnType<typeof makeFakeCard>[]
  logger: ReturnType<typeof makeLogger>
  sent: string[]
  bridge: Bridge
}

function makeBridge(opts?: { createStreamingCard?: () => ReturnType<typeof makeFakeCard> }): Harness {
  const agents = makeFakeAgents()
  const events = makeFakeEventSource()
  const logger = makeLogger()
  const sent: string[] = []
  const cards: ReturnType<typeof makeFakeCard>[] = []
  const bridge = new Bridge({
    defaultCwd: '/workspace',
    stateDir: dir,
    agents: agents.api,
    logger,
    larkClient: {} as never,
    sendText: async (chatId, text) => { sent.push(`${chatId}:${text}`) },
    createStreamingCard: () => {
      const card = makeFakeCard()
      cards.push(card)
      return card as unknown as StreamingCard
    },
  })
  bridge.attach(events.api)
  return { agents, events, cards, logger, sent, bridge }
}

// 构造 session/event 事件
function sessionEvent(type: string, data: Record<string, unknown>, sessionId = 's1'): SessionEvent {
  return { type, seq: 1, time: 1, data } as unknown as SessionEvent
}

const fakeSession = (id = 's1') => ({ id: id as SessionId, header: {} }) as never

// ---------------------------------------------------------------------------
// 会话创建与消息注入
// ---------------------------------------------------------------------------

describe('Bridge 会话与注入', () => {
  it('首条消息：create 新会话（默认 cwd）+ followup 注入 user 消息 + 建卡', async () => {
    const h = makeBridge()
    await h.bridge.handleUserMessage('chat1', '你好', 'msg-1')

    expect(h.agents.created).toHaveLength(1)
    expect(h.agents.created[0]!.meta?.cwd).toBe('/workspace')

    const agent = h.agents.registry.get(String(h.agents.created[0]!.sessionId))!.agent
    expect(agent.followup).toHaveBeenCalledTimes(1)
    const message = agent.followup.mock.calls[0]![0]
    expect(message.role).toBe('user')
    expect(message.source.kind).toBe('user')
    expect(message.content).toEqual([{ type: 'text', text: '你好' }])

    expect(h.cards).toHaveLength(1)
    expect(h.cards[0]!.ensureCreated).toHaveBeenCalledTimes(1)
  })

  it('第二条消息复用同一会话（不重复 create）', async () => {
    const h = makeBridge()
    await h.bridge.handleUserMessage('chat1', 'a')
    const createdId = h.agents.created[0]!.sessionId
    await h.bridge.handleUserMessage('chat1', 'b')

    expect(h.agents.created).toHaveLength(1)
    expect(h.agents.resumed).toHaveLength(0)
    expect(h.agents.registry.get(String(createdId))!.agent.followup).toHaveBeenCalledTimes(2)
  })

  it('不同 chat 各自独立会话', async () => {
    const h = makeBridge()
    await h.bridge.handleUserMessage('chat1', 'a')
    await h.bridge.handleUserMessage('chat2', 'b')
    expect(h.agents.created).toHaveLength(2)
    expect(h.agents.created[0]!.sessionId).not.toBe(h.agents.created[1]!.sessionId)
  })

  it('上一条卡未收尾时先 finalize 再开新卡', async () => {
    const h = makeBridge()
    await h.bridge.handleUserMessage('chat1', 'a')
    // 模拟 turn 未结束又来一条
    await h.bridge.handleUserMessage('chat1', 'b')
    expect(h.cards[0]!.finalize).toHaveBeenCalledTimes(1)
    expect(h.cards).toHaveLength(2)
  })

  it('create 后 agent 丢失（registry 空）→ resume 同一 sessionId', async () => {
    const h = makeBridge()
    await h.bridge.handleUserMessage('chat1', 'a')
    const sessionId = h.agents.created[0]!.sessionId
    // 模拟 agent-loop 重载导致 agent 消失
    h.agents.registry.clear()
    await h.bridge.handleUserMessage('chat1', 'b')
    expect(h.agents.resumed).toHaveLength(1)
    expect(String(h.agents.resumed[0]!.resumeSessionId)).toBe(String(sessionId))
  })

  it('新 Bridge 实例（重启）→ 从持久化映射 resume', async () => {
    const h = makeBridge()
    await h.bridge.handleUserMessage('chat1', 'a')
    await h.bridge.dispose()
    const sessionId = h.agents.created[0]!.sessionId

    const h2 = makeBridge()
    await h2.bridge.handleUserMessage('chat1', 'b')
    expect(h2.agents.created).toHaveLength(0)
    expect(h2.agents.resumed).toHaveLength(1)
    expect(String(h2.agents.resumed[0]!.resumeSessionId)).toBe(String(sessionId))
  })

  it('resume 失败 → 回退新建会话并更新映射', async () => {
    const h = makeBridge()
    await h.bridge.handleUserMessage('chat1', 'a')
    const sessionId = h.agents.created[0]!.sessionId

    // 下一个实例 resume 会失败（mock 抛错）
    const agents = makeFakeAgents()
    const resumeSpy = vi.spyOn(agents.api, 'resume').mockRejectedValue(new Error('no persistence'))
    const events = makeFakeEventSource()
    const logger = makeLogger()
    const cards: ReturnType<typeof makeFakeCard>[] = []
    const bridge = new Bridge({
      defaultCwd: '/workspace',
      stateDir: dir,
      agents: agents.api,
      logger,
      larkClient: {} as never,
      sendText: async () => {},
      createStreamingCard: () => {
        const card = makeFakeCard()
        cards.push(card)
        return card as unknown as StreamingCard
      },
    })
    bridge.attach(events.api)
    await bridge.handleUserMessage('chat1', 'b')

    expect(resumeSpy).toHaveBeenCalledTimes(1)
    expect(agents.created).toHaveLength(1)
    expect(String(agents.created[0]!.sessionId)).not.toBe(String(sessionId))
    // 新映射已持久化：再建实例应从新 sessionId resume
    await bridge.dispose()
    const h3 = makeBridge()
    await h3.bridge.handleUserMessage('chat1', 'c')
    expect(String(h3.agents.resumed[0]!.resumeSessionId)).toBe(String(agents.created[0]!.sessionId))
  })

  it('卡片创建失败 → 降级提示文本，消息仍注入', async () => {
    const agents = makeFakeAgents()
    const events = makeFakeEventSource()
    const logger = makeLogger()
    const sent: string[] = []
    let cardCall = 0
    const bridge = new Bridge({
      defaultCwd: '/workspace',
      stateDir: dir,
      agents: agents.api,
      logger,
      larkClient: {} as never,
      sendText: async (chatId, text) => { sent.push(`${chatId}:${text}`) },
      createStreamingCard: () => {
        const card = makeFakeCard()
        cardCall += 1
        // 第二条消息的卡创建失败
        if (cardCall === 2) card.ensureCreated.mockRejectedValueOnce(new Error('card api down'))
        return card as unknown as StreamingCard
      },
    })
    bridge.attach(events.api)
    await bridge.handleUserMessage('chat1', '第一条')
    await bridge.handleUserMessage('chat1', '你好')
    expect(sent.some((s) => s.includes('卡片创建失败'))).toBe(true)
    expect(agents.registry.values().next().value.agent.followup).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// session/event 路由
// ---------------------------------------------------------------------------

describe('Bridge session/event 路由', () => {
  it('assistant/chunk text-delta → appendText；reasoning-delta → appendReasoning', async () => {
    const h = makeBridge()
    await h.bridge.handleUserMessage('chat1', 'a')
    const card = h.cards[0]!
    const sessionId = h.agents.created[0]!.sessionId

    const emit = h.events.handlers.get('session/event')!
    emit(
      fakeSession(String(sessionId)),
      sessionEvent('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '你' } }, String(sessionId)),
    )
    emit(
      fakeSession(String(sessionId)),
      sessionEvent('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '想' } }, String(sessionId)),
    )
    expect(card.appendText).toHaveBeenCalledWith('你')
    expect(card.appendReasoning).toHaveBeenCalledWith('想')
  })

  it('tool/call → startTool；tool/result → completeTool', async () => {
    const h = makeBridge()
    await h.bridge.handleUserMessage('chat1', 'a')
    const card = h.cards[0]!
    const sessionId = h.agents.created[0]!.sessionId
    const emit = h.events.handlers.get('session/event')!

    emit(fakeSession(String(sessionId)), sessionEvent('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }, String(sessionId)))
    expect(card.startTool).toHaveBeenCalledWith('c1', 'bash')

    emit(fakeSession(String(sessionId)), sessionEvent('tool/result', {
      turn: 1,
      step: 1,
      message: { id: 'm', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [], isError: false }], source: {} },
    }, String(sessionId)))
    expect(card.completeTool).toHaveBeenCalledWith('c1', undefined)
  })

  it('turn/end completed → finalize 并清空活跃卡', async () => {
    const h = makeBridge()
    await h.bridge.handleUserMessage('chat1', 'a')
    const card = h.cards[0]!
    const sessionId = h.agents.created[0]!.sessionId
    const emit = h.events.handlers.get('session/event')!

    emit(fakeSession(String(sessionId)), sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, String(sessionId)))
    expect(card.finalize).toHaveBeenCalledTimes(1)

    // 下一轮 turn/end 不再影响已清空的卡
    emit(fakeSession(String(sessionId)), sessionEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }, String(sessionId)))
    expect(card.finalize).toHaveBeenCalledTimes(1)
  })

  it('turn/end error → abort 卡片', async () => {
    const h = makeBridge()
    await h.bridge.handleUserMessage('chat1', 'a')
    const card = h.cards[0]!
    const sessionId = h.agents.created[0]!.sessionId
    const emit = h.events.handlers.get('session/event')!

    emit(fakeSession(String(sessionId)), sessionEvent('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } },
    }, String(sessionId)))
    expect(card.abort).toHaveBeenCalledTimes(1)
    expect((card.abort.mock.calls[0]![0] as Error).message).toContain('boom')
  })

  it('无关会话的事件不路由', async () => {
    const h = makeBridge()
    await h.bridge.handleUserMessage('chat1', 'a')
    const card = h.cards[0]!
    const emit = h.events.handlers.get('session/event')!

    emit(fakeSession('other-session'), sessionEvent('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } }, 'other-session'))
    expect(card.appendText).not.toHaveBeenCalled()
  })

  it('agent/error → abort 并清空活跃卡', async () => {
    const h = makeBridge()
    await h.bridge.handleUserMessage('chat1', 'a')
    const card = h.cards[0]!
    const sessionId = h.agents.created[0]!.sessionId
    const agent = h.agents.registry.get(String(sessionId))!.agent
    const emit = h.events.handlers.get('agent/error')!

    emit({ agent, turn: 1, step: 1, error: new Error('agent died') })
    expect(card.abort).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe('Bridge dispose', () => {
  it('dispose：摘除订阅、finalize 未完成卡、dispose agent', async () => {
    const h = makeBridge()
    await h.bridge.handleUserMessage('chat1', 'a')
    const card = h.cards[0]!
    const sessionId = h.agents.created[0]!.sessionId
    const handle = h.agents.registry.get(String(sessionId))!

    await h.bridge.dispose()
    expect(card.finalize).toHaveBeenCalledTimes(1)
    expect(handle.dispose).toHaveBeenCalledTimes(1)
    expect(h.events.handlers.size).toBe(0)
  })

  it('dispose 后事件不再路由', async () => {
    const h = makeBridge()
    await h.bridge.handleUserMessage('chat1', 'a')
    const card = h.cards[0]!
    const sessionId = h.agents.created[0]!.sessionId
    await h.bridge.dispose()
    const emit = h.events.handlers.get('session/event')
    expect(emit).toBeUndefined()
    expect(card.appendText).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 远程工具装配（P2.5）
// ---------------------------------------------------------------------------

describe('Bridge 远程工具装配', () => {
  function makePresetAgents() {
    const agents = makeFakeAgents()
    // 模拟真实 dsh-agent：create/resume 的 setup 回调会在发布前执行
    const agentCtx = { id: 'agent-ctx' }
    const rawCreate = agents.api.create.bind(agents.api)
    agents.api.create = async (opts: Parameters<typeof rawCreate>[0]) => {
      const handle = await rawCreate(opts)
      await (opts as { setup?: (ctx: unknown) => Promise<void> }).setup?.(agentCtx)
      return handle
    }
    const rawResume = agents.api.resume.bind(agents.api)
    agents.api.resume = async (opts: Parameters<typeof rawResume>[0]) => {
      const handle = await rawResume(opts)
      await (opts as { setup?: (ctx: unknown) => Promise<void> }).setup?.(agentCtx)
      return handle
    }
    const mounted: unknown[] = []
    const remoteTools: unknown[] = []
    const agentPresets = {
      resolve: vi.fn(async () => ({ id: 'standard' })),
      mount: vi.fn(async (agentCtx: unknown) => { mounted.push(agentCtx) }),
    }
    const bridge = new Bridge({
      defaultCwd: '/workspace',
      stateDir: dir,
      agents: agents.api,
      logger: makeLogger(),
      larkClient: {} as never,
      sendText: async () => {},
      createStreamingCard: () => makeFakeCard() as unknown as StreamingCard,
      agentPreset: 'standard',
      agentPresets: agentPresets as never,
      registerRemoteTools: (agentCtx: unknown) => { remoteTools.push(agentCtx) },
    })
    return { agents, agentPresets, mounted, remoteTools, bridge }
  }

  it('create 装配：mount preset 后调用 registerRemoteTools（同一 agentCtx）', async () => {
    const h = makePresetAgents()
    await h.bridge.handleUserMessage('chat1', 'a')
    expect(h.agentPresets.mount).toHaveBeenCalledTimes(1)
    expect(h.mounted).toHaveLength(1)
    expect(h.remoteTools).toHaveLength(1)
    expect(h.remoteTools[0]).toBe(h.mounted[0])
  })

  it('resume 装配：恢复会话同样 mount preset + registerRemoteTools（修复恢复后工具不全）', async () => {
    const h1 = makePresetAgents()
    await h1.bridge.handleUserMessage('chat1', 'a')
    const sessionId = h1.agents.created[0]!.sessionId
    await h1.bridge.dispose()

    const h2 = makePresetAgents()
    await h2.bridge.handleUserMessage('chat1', 'b')
    expect(h2.agents.resumed).toHaveLength(1)
    expect(String(h2.agents.resumed[0]!.resumeSessionId)).toBe(String(sessionId))
    // resume 调用携带 setup（之前缺失导致恢复会话无工具）
    expect(typeof (h2.agents.resumed[0] as { setup?: unknown }).setup).toBe('function')
    expect(h2.agentPresets.mount).toHaveBeenCalledTimes(1)
    expect(h2.remoteTools).toHaveLength(1)
    expect(h2.mounted).toHaveLength(1)
  })

  it('agent 在运行中丢失后 resume：同样走 setup 装配', async () => {
    const h = makePresetAgents()
    await h.bridge.handleUserMessage('chat1', 'a')
    const sessionId = h.agents.created[0]!.sessionId
    h.agents.registry.clear()
    await h.bridge.handleUserMessage('chat1', 'b')
    expect(h.agents.resumed).toHaveLength(1)
    expect(String(h.agents.resumed[0]!.resumeSessionId)).toBe(String(sessionId))
    expect(typeof (h.agents.resumed[0] as { setup?: unknown }).setup).toBe('function')
    expect(h.remoteTools).toHaveLength(2)
  })
})
