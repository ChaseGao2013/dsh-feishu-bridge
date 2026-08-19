/**
 * 远程命令体系测试（P4）
 *
 * 覆盖：
 * - parseCommand：全部命令 + 中文别名 + 大小写 + /new 参数 + 非命令文本
 * - executeCommand：/help /status /new /clear /stop /projects 的行为
 * - inbound 分发：命令消息不进入 DSH 会话（不调 followup）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { Bridge, type BridgeEventSource } from '../src/bridge.js'
import { PairingStore } from '../src/pairing.js'
import { parseCommand, executeCommand, formatHelp, type CommandDeps } from '../src/commands.js'
import { handleInboundMessage, type InboundDeps } from '../src/inbound.js'
import { MessageDedup } from '../src/dedup.js'
import { StreamingCard } from '../src/feishu/streaming-card.js'

// ---------------------------------------------------------------------------
// parseCommand
// ---------------------------------------------------------------------------

describe('parseCommand', () => {
  it('识别全部英文命令', () => {
    expect(parseCommand('/help')).toEqual({ kind: 'help' })
    expect(parseCommand('/status')).toEqual({ kind: 'status' })
    expect(parseCommand('/clear')).toEqual({ kind: 'clear' })
    expect(parseCommand('/stop')).toEqual({ kind: 'stop' })
    expect(parseCommand('/projects')).toEqual({ kind: 'projects' })
    expect(parseCommand('/new')).toEqual({ kind: 'new' })
  })

  it('识别中文别名', () => {
    expect(parseCommand('帮助')).toEqual({ kind: 'help' })
    expect(parseCommand('状态')).toEqual({ kind: 'status' })
    expect(parseCommand('清空')).toEqual({ kind: 'clear' })
    expect(parseCommand('停止')).toEqual({ kind: 'stop' })
    expect(parseCommand('项目列表')).toEqual({ kind: 'projects' })
    expect(parseCommand('新会话')).toEqual({ kind: 'new' })
  })

  it('大小写不敏感（英文）', () => {
    expect(parseCommand('/HELP')).toEqual({ kind: 'help' })
    expect(parseCommand('/Stop')).toEqual({ kind: 'stop' })
    expect(parseCommand('/New')).toEqual({ kind: 'new' })
  })

  it('/new 携带路径参数（原样保留大小写与空格内内容）', () => {
    expect(parseCommand('/new /Projects/MyApp')).toEqual({ kind: 'new', arg: '/Projects/MyApp' })
    expect(parseCommand('/new   /home/user/proj  ')).toEqual({ kind: 'new', arg: '/home/user/proj' })
    expect(parseCommand('新会话 /other')).toEqual({ kind: 'new', arg: '/other' })
  })

  it('/new 空参数不带 arg 字段', () => {
    expect(parseCommand('/new ')).toEqual({ kind: 'new' })
    expect(parseCommand('新会话  ')).toEqual({ kind: 'new' })
  })

  it('非命令文本返回 null', () => {
    expect(parseCommand('你好')).toBeNull()
    expect(parseCommand('/newpath')).toBeNull()
    expect(parseCommand('/helping')).toBeNull()
    expect(parseCommand('')).toBeNull()
    expect(parseCommand('   ')).toBeNull()
    expect(parseCommand('/help 额外参数')).toBeNull() // 无参数命令带尾巴不算命令
    expect(parseCommand('查一下 /status 是什么')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// executeCommand 集成（真实 Bridge + fake agents/cards）
// ---------------------------------------------------------------------------

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-commands-test-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

type FakeAgent = Agent & { followup: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }

function makeFakeAgent(sessionId: SessionId, status: 'idle' | 'running' = 'idle'): FakeAgent {
  return {
    id: sessionId,
    session: { id: sessionId, header: {} },
    options: {},
    inbox: {},
    status,
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
  const registry = new Map<string, { agent: FakeAgent; dispose: ReturnType<typeof vi.fn> }>()
  return {
    created,
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
        return handle
      },
      get(id: SessionId): Agent | undefined {
        return registry.get(String(id))?.agent
      },
    },
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

interface Harness {
  agents: ReturnType<typeof makeFakeAgents>
  pairing: PairingStore
  sent: Array<{ chatId: string; text: string; replyTo?: string }>
  bridge: Bridge
  deps: CommandDeps
}

function makeHarness(opts?: { status?: 'idle' | 'running' }): Harness {
  const agents = makeFakeAgents()
  const pairing = new PairingStore(dir)
  const sent: Array<{ chatId: string; text: string; replyTo?: string }> = []
  const state: Record<string, string> = {}
  const bridge = new Bridge({
    defaultCwd: '/workspace',
    stateDir: dir,
    agents: agents.api,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    larkClient: {} as never,
    sendText: async () => {},
    createStreamingCard: () => makeFakeCard() as unknown as StreamingCard,
    runtimeConfig: {
      load: () => ({ ...state }),
      set: (key, value) => {
        // 与真实 RuntimeConfigStore 对齐：存驼峰语义键
        if (key && value) state[key.trim().toLowerCase() === 'remotepermissionpreset' ? 'remotePermissionPreset' : 'sessionCwd'] = value.trim()
        return null
      },
      describe: () => '🎯 远程配置\n- 权限预设: (默认 workspace-write)\n- 工作目录: (默认插件配置)',
    },
  })
  const deps: CommandDeps = {
    bridge,
    pairing,
    allowedUsers: ['ou_whitelisted'],
    sendText: async (chatId, text, replyTo) => { sent.push({ chatId, text, replyTo }) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
  return { agents, pairing, sent, bridge, deps }
}

describe('executeCommand', () => {
  it('/help 返回命令清单', async () => {
    const h = makeHarness()
    await executeCommand({ kind: 'help' }, 'chat1', h.deps, 'msg-1')
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.replyTo).toBe('msg-1')
    expect(h.sent[0]!.text).toContain('/status')
    expect(h.sent[0]!.text).toContain('/new')
    expect(h.sent[0]!.text).toContain('/stop')
    expect(formatHelp()).toContain('/clear')
  })

  it('/status 真实反映会话状态（无会话时）', async () => {
    const h = makeHarness()
    await executeCommand({ kind: 'status' }, 'chat1', h.deps)
    const text = h.sent[0]!.text
    expect(text).toContain('无')
    expect(text).toContain('配对用户')
  })

  it('/status 有会话时显示 sessionId/cwd/agent 状态/卡片活跃', async () => {
    const h = makeHarness()
    await h.bridge.handleUserMessage('chat1', '你好')
    const sessionId = h.agents.created[0]!.sessionId
    const agent = h.agents.registry.get(String(sessionId))!.agent

    // running 状态
    Object.defineProperty(agent, 'status', { value: 'running', configurable: true })
    await executeCommand({ kind: 'status' }, 'chat1', h.deps)
    expect(h.sent[0]!.text).toContain(String(sessionId).slice(0, 8))
    expect(h.sent[0]!.text).toContain('/workspace')
    expect(h.sent[0]!.text).toContain('🟡 运行中')

    // idle + 无卡片
    Object.defineProperty(agent, 'status', { value: 'idle', configurable: true })
    await executeCommand({ kind: 'status' }, 'chat1', h.deps)
    expect(h.sent[1]!.text).toContain('🟢 空闲')
  })

  it('/status 显示配对用户数与配对码（码为一次性，配对成功后清空）', async () => {
    const h = makeHarness()
    h.pairing.ensureCode('ABC123')
    await executeCommand({ kind: 'status' }, 'chat1', h.deps)
    expect(h.sent[0]!.text).toContain('ABC123')
    expect(h.sent[0]!.text).toContain('**0 人**')

    // 配对成功后配对码一次性清空（正确行为）
    expect(h.pairing.tryPair('ABC123', { userId: 'ou_bob', displayName: 'Bob' })).toBe(true)
    await executeCommand({ kind: 'status' }, 'chat1', h.deps)
    expect(h.sent[1]!.text).toContain('**1 人**')
    expect(h.sent[1]!.text).toContain('配对码：（无')
  })

  it('/new 重建会话：dispose 旧 handle、映射更新、换 cwd', async () => {
    const h = makeHarness()
    await h.bridge.handleUserMessage('chat1', '你好')
    const oldSessionId = h.agents.created[0]!.sessionId
    const oldHandle = h.agents.registry.get(String(oldSessionId))!

    await executeCommand({ kind: 'new', arg: '/Projects/NewApp' }, 'chat1', h.deps)

    // 旧 handle 被 dispose，新会话用新 cwd
    expect(oldHandle.dispose).toHaveBeenCalledTimes(1)
    expect(h.agents.created).toHaveLength(2)
    expect(h.agents.created[1]!.meta?.cwd).toBe('/Projects/NewApp')
    expect(h.agents.created[1]!.sessionId).not.toBe(oldSessionId)
    expect(h.sent[0]!.text).toContain('已新建会话')
    expect(h.sent[0]!.text).toContain('/Projects/NewApp')

    // 持久化映射已换新 sessionId：新 Bridge 实例 resume 新会话
    await h.bridge.dispose()
    const h2 = makeHarness()
    await h2.bridge.handleUserMessage('chat1', '继续')
    expect(String(h2.agents.registry.keys().next().value)).toBe(String(h.agents.created[1]!.sessionId))
  })

  it('/new 无参数用默认 cwd', async () => {
    const h = makeHarness()
    await h.bridge.handleUserMessage('chat1', '你好')
    await executeCommand({ kind: 'new' }, 'chat1', h.deps)
    expect(h.agents.created).toHaveLength(2)
    expect(h.agents.created[1]!.meta?.cwd).toBe('/workspace')
  })

  it('/clear 重建会话且不换 cwd', async () => {
    const h = makeHarness()
    await h.bridge.handleUserMessage('chat1', '你好')
    const oldSessionId = h.agents.created[0]!.sessionId
    const oldHandle = h.agents.registry.get(String(oldSessionId))!

    await executeCommand({ kind: 'clear' }, 'chat1', h.deps)

    expect(oldHandle.dispose).toHaveBeenCalledTimes(1)
    expect(h.agents.created).toHaveLength(2)
    expect(h.agents.created[1]!.meta?.cwd).toBe('/workspace')
    expect(h.sent[0]!.text).toContain('已清空')
  })

  it('/stop 在 agent running 时调用 cancel 并确认', async () => {
    const h = makeHarness()
    await h.bridge.handleUserMessage('chat1', '你好')
    const sessionId = h.agents.created[0]!.sessionId
    const agent = h.agents.registry.get(String(sessionId))!.agent
    Object.defineProperty(agent, 'status', { value: 'running', configurable: true })

    await executeCommand({ kind: 'stop' }, 'chat1', h.deps)

    expect(agent.cancel).toHaveBeenCalledTimes(1)
    expect(agent.cancel.mock.calls[0]![0]).toEqual({ kind: 'user' })
    expect(h.sent[0]!.text).toContain('已发送停止信号')
  })

  it('/stop 在 agent idle 时不调 cancel', async () => {
    const h = makeHarness()
    await h.bridge.handleUserMessage('chat1', '你好')
    const sessionId = h.agents.created[0]!.sessionId
    const agent = h.agents.registry.get(String(sessionId))!.agent

    await executeCommand({ kind: 'stop' }, 'chat1', h.deps)

    expect(agent.cancel).not.toHaveBeenCalled()
    expect(h.sent[0]!.text).toContain('没有正在进行的生成')
  })

  it('/stop 无会话时不报错', async () => {
    const h = makeHarness()
    await executeCommand({ kind: 'stop' }, 'chat1', h.deps)
    expect(h.sent[0]!.text).toContain('没有正在进行的生成')
  })

  it('/projects 提示暂未支持', async () => {
    const h = makeHarness()
    await executeCommand({ kind: 'projects' }, 'chat1', h.deps)
    expect(h.sent[0]!.text).toContain('暂未支持')
  })
})

// ---------------------------------------------------------------------------
// turn/end aborted → 卡片加停止标记后收尾
// ---------------------------------------------------------------------------

describe('Bridge turn/end aborted', () => {
  it('用户取消后卡片 append 停止标记并 finalize', async () => {
    const agents = makeFakeAgents()
    const sent: string[] = []
    const cards: ReturnType<typeof makeFakeCard>[] = []
    const bridge = new Bridge({
      defaultCwd: '/workspace',
      stateDir: dir,
      agents: agents.api,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      larkClient: {} as never,
      sendText: async (chatId, text) => { sent.push(`${chatId}:${text}`) },
      createStreamingCard: () => {
        const card = makeFakeCard()
        cards.push(card)
        return card as unknown as StreamingCard
      },
    })
    const handlers = new Map<string, (...args: unknown[]) => void>()
    bridge.attach({
      on(name: string, handler: (...args: unknown[]) => void): () => void {
        handlers.set(name, handler)
        return () => { handlers.delete(name) }
      },
    } as unknown as BridgeEventSource)

    await bridge.handleUserMessage('chat1', 'a')
    const card = cards[0]!
    const sessionId = agents.created[0]!.sessionId
    const emit = handlers.get('session/event')!

    emit({ id: String(sessionId), header: {} }, {
      type: 'turn/end', seq: 1, time: 1,
      data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    } as unknown as SessionEvent)

    expect(card.appendText).toHaveBeenCalledWith('\n\n---\n⏹ 已停止')
    expect(card.finalize).toHaveBeenCalledTimes(1)
    expect(card.abort).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// inbound 命令分发
// ---------------------------------------------------------------------------

function makeInboundDeps(h: Harness): InboundDeps {
  return {
    dedup: new MessageDedup(),
    pairing: h.pairing,
    bridge: h.bridge,
    allowedUsers: ['ou_whitelisted'],
    sendText: async (chatId, text, replyToMessageId) => {
      h.sent.push({ chatId, text, replyTo: replyToMessageId })
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
}

function inboundEvent(chatId: string, messageId: string, text: string) {
  return {
    sender: { sender_id: { open_id: 'ou_whitelisted' } },
    message: {
      message_id: messageId,
      chat_id: chatId,
      chat_type: 'p2p',
      content: JSON.stringify({ text }),
      message_type: 'text',
    },
  }
}

// ---------------------------------------------------------------------------
// /config 交互卡（无参发卡，失败降级文本）
// ---------------------------------------------------------------------------

describe('executeCommand /config 交互卡', () => {
  it('无参数且有 sendConfigCard：发卡成功则不再发文本', async () => {
    const h = makeHarness()
    const sendConfigCard = vi.fn(async () => true)
    await executeCommand({ kind: 'config' }, 'chat1', { ...h.deps, sendConfigCard })
    expect(sendConfigCard).toHaveBeenCalledWith('chat1')
    expect(h.sent).toHaveLength(0)
  })

  it('无参数发卡失败：降级为文本 describe', async () => {
    const h = makeHarness()
    const sendConfigCard = vi.fn(async () => false)
    await executeCommand({ kind: 'config' }, 'chat1', { ...h.deps, sendConfigCard })
    expect(sendConfigCard).toHaveBeenCalledWith('chat1')
    expect(h.sent[0]!.text).toContain('远程配置')
  })

  it('带参数：直接走文本（不尝试发卡）', async () => {
    const h = makeHarness()
    const sendConfigCard = vi.fn(async () => true)
    await executeCommand({ kind: 'config', configKey: 'remotePermissionPreset', configValue: 'read-only' }, 'chat1', { ...h.deps, sendConfigCard })
    expect(sendConfigCard).not.toHaveBeenCalled()
    expect(h.sent[0]!.text).toContain('read-only')
  })

  it('无 sendConfigCard 时保持原文本行为', async () => {
    const h = makeHarness()
    await executeCommand({ kind: 'config' }, 'chat1', h.deps)
    expect(h.sent[0]!.text).toContain('远程配置')
  })
})

describe('inbound 命令分发', () => {
  it('命令消息不进入 DSH 会话（不创建 agent）', async () => {
    const h = makeHarness()
    await handleInboundMessage(inboundEvent('chat1', 'm1', '/status'), makeInboundDeps(h))
    expect(h.agents.created).toHaveLength(0)
    expect(h.sent[0]!.text).toContain('DSH 状态')
  })

  it('中文别名命令同样拦截', async () => {
    const h = makeHarness()
    await handleInboundMessage(inboundEvent('chat1', 'm1', '状态'), makeInboundDeps(h))
    expect(h.agents.created).toHaveLength(0)
    expect(h.sent[0]!.text).toContain('DSH 状态')
  })

  it('/clear 后消息走新会话', async () => {
    const h = makeHarness()
    const deps = makeInboundDeps(h)
    await handleInboundMessage(inboundEvent('chat1', 'm1', '你好'), deps)
    const oldSessionId = h.agents.created[0]!.sessionId
    await handleInboundMessage(inboundEvent('chat1', 'm2', '/clear'), deps)
    await handleInboundMessage(inboundEvent('chat1', 'm3', '继续'), deps)
    expect(h.agents.created).toHaveLength(2)
    expect(h.agents.created[1]!.sessionId).not.toBe(oldSessionId)
  })

  it('普通消息照常进入会话', async () => {
    const h = makeHarness()
    await handleInboundMessage(inboundEvent('chat1', 'm1', '你好'), makeInboundDeps(h))
    expect(h.agents.created).toHaveLength(1)
  })
})
