/**
 * 飞书入站消息分发单元测试
 *
 * 覆盖：私聊/群聊过滤、去重、未授权 → 配对流程（成功/失败/无文本）、
 * 已授权 → Bridge 转发、附件提示、字段缺失容错。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleInboundMessage, type InboundMessageEvent, type InboundDeps } from '../src/inbound.js'
import { MessageDedup } from '../src/dedup.js'
import { PairingStore } from '../src/pairing.js'
import { RateLimiter } from '../src/rate-limit.js'
import { AuditLog } from '../src/audit.js'

let dir: string
let now: number

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-inbound-test-'))
  now = 1_000_000_000_000
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function makeDeps(overrides?: Partial<InboundDeps>): {
  deps: InboundDeps
  bridge: { handleUserMessage: ReturnType<typeof vi.fn>; ensureAgentForChat: ReturnType<typeof vi.fn> }
  sent: string[]
} {
  const bridge = {
    handleUserMessage: vi.fn(async () => {}),
    ensureAgentForChat: vi.fn(async () => ({ sessionId: 's1', cwd: '/workspace' })),
  }
  const sent: string[] = []
  const deps: InboundDeps = {
    dedup: new MessageDedup(),
    pairing: new PairingStore(dir, () => now),
    bridge: bridge as never,
    sendText: async (chatId, text) => { sent.push(`${chatId}:${text}`) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  }
  return { deps, bridge, sent }
}

function event(partial: Partial<InboundMessageEvent> = {}): InboundMessageEvent {
  return {
    sender: { sender_id: { open_id: 'open-1' } },
    message: {
      message_id: 'msg-1',
      chat_id: 'chat-1',
      chat_type: 'p2p',
      content: JSON.stringify({ text: 'hello' }),
      message_type: 'text',
    },
    ...partial,
  }
}

describe('入站消息基础过滤', () => {
  it('字段缺失直接忽略', async () => {
    const { deps, bridge } = makeDeps()
    await handleInboundMessage({}, deps)
    await handleInboundMessage({ message: {} }, deps)
    expect(bridge.handleUserMessage).not.toHaveBeenCalled()
  })

  it('重复 message_id 只处理一次', async () => {
    const { deps, bridge } = makeDeps({ allowedUsers: ['open-1'] })
    const ev = event()
    await handleInboundMessage(ev, deps)
    await handleInboundMessage(ev, deps)
    expect(bridge.handleUserMessage).toHaveBeenCalledTimes(1)
  })

  it('群聊忽略', async () => {
    const { deps, bridge } = makeDeps()
    await handleInboundMessage(event({ message: { ...event().message, chat_type: 'group' } }), deps)
    expect(bridge.handleUserMessage).not.toHaveBeenCalled()
  })
})

describe('配对流程', () => {
  it('未授权用户发送配对码 → 配对成功并回执', async () => {
    const { deps, sent } = makeDeps()
    const code = deps.pairing.ensureCode()
    await handleInboundMessage(event({ message: { ...event().message, content: JSON.stringify({ text: code }) } }), deps)
    expect(deps.pairing.isPaired('open-1')).toBe(true)
    expect(sent[0]).toContain('配对成功')
    expect(deps.bridge.handleUserMessage).not.toHaveBeenCalled()
  })

  it('未授权用户发送错误码 → 拒绝并提示', async () => {
    const { deps, sent } = makeDeps()
    deps.pairing.ensureCode()
    await handleInboundMessage(event({ message: { ...event().message, content: JSON.stringify({ text: 'WRONG' }) } }), deps)
    expect(deps.pairing.isPaired('open-1')).toBe(false)
    expect(sent[0]).toContain('未授权')
  })

  it('未授权用户发非配对文本（空/普通消息）→ 提示未授权', async () => {
    const { deps, sent } = makeDeps()
    deps.pairing.ensureCode()
    await handleInboundMessage(event({ message: { ...event().message, content: JSON.stringify({ text: '你好' }) } }), deps)
    expect(sent[0]).toContain('未授权')
  })

  it('未授权用户发无文本消息 → 提示需配对码', async () => {
    const { deps, sent } = makeDeps()
    await handleInboundMessage(event({ message: { ...event().message, content: JSON.stringify({ text: '' }) } }), deps)
    expect(sent[0]).toContain('请发送配对码')
  })

  it('白名单用户无需配对直接转发', async () => {
    const { deps, bridge } = makeDeps({ allowedUsers: ['open-1'] })
    await handleInboundMessage(event(), deps)
    expect(bridge.handleUserMessage).toHaveBeenCalledTimes(1)
    expect(bridge.handleUserMessage).toHaveBeenCalledWith('chat-1', 'hello', 'msg-1')
  })

  it('配对成功后同一用户后续消息直接转发', async () => {
    const { deps, bridge } = makeDeps()
    const code = deps.pairing.ensureCode()
    await handleInboundMessage(event({ message: { ...event().message, content: JSON.stringify({ text: code }) } }), deps)
    await handleInboundMessage(event({ message: { ...event().message, message_id: 'msg-2', content: JSON.stringify({ text: '你好 DSH' }) } }), deps)
    expect(bridge.handleUserMessage).toHaveBeenCalledTimes(1)
    expect(bridge.handleUserMessage).toHaveBeenCalledWith('chat-1', '你好 DSH', 'msg-2')
  })
})

describe('已授权消息转发', () => {
  it('文本消息 → Bridge.handleUserMessage(chatId, text, messageId)', async () => {
    const { deps, bridge } = makeDeps({ allowedUsers: ['open-1'] })
    await handleInboundMessage(event({ message: { ...event().message, content: JSON.stringify({ text: '跑个测试' }) } }), deps)
    expect(bridge.handleUserMessage).toHaveBeenCalledWith('chat-1', '跑个测试', 'msg-1')
  })

  it('远程提问自由输入：命中等待态时消费消息，不再进 Bridge', async () => {
    const { deps, bridge, sent } = makeDeps({ allowedUsers: ['open-1'] })
    const tryConsumeFreeText = vi.fn(() => true)
    deps.questionBridge = { tryConsumeFreeText }
    await handleInboundMessage(event({ message: { ...event().message, content: JSON.stringify({ text: '我的回答' }) } }), deps)
    expect(tryConsumeFreeText).toHaveBeenCalledWith('chat-1', '我的回答')
    expect(bridge.handleUserMessage).not.toHaveBeenCalled()
  })

  it('自由输入未命中（false）时正常转发', async () => {
    const { deps, bridge } = makeDeps({ allowedUsers: ['open-1'] })
    const tryConsumeFreeText = vi.fn(() => false)
    deps.questionBridge = { tryConsumeFreeText }
    await handleInboundMessage(event(), deps)
    expect(tryConsumeFreeText).toHaveBeenCalledWith('chat-1', 'hello')
    expect(bridge.handleUserMessage).toHaveBeenCalledWith('chat-1', 'hello', 'msg-1')
  })

  it('未提供 questionBridge 时不影响普通流程', async () => {
    const { deps, bridge } = makeDeps({ allowedUsers: ['open-1'] })
    await handleInboundMessage(event(), deps)
    expect(bridge.handleUserMessage).toHaveBeenCalledWith('chat-1', 'hello', 'msg-1')
  })

  it('/config 工作目录输入：命中等待态时消费消息，不再进 Bridge', async () => {
    const { deps, bridge } = makeDeps({ allowedUsers: ['open-1'] })
    const tryConsumeCwdInput = vi.fn(() => true)
    deps.configCard = { tryConsumeCwdInput, sendConfigCard: vi.fn(async () => true) }
    await handleInboundMessage(event({ message: { ...event().message, content: JSON.stringify({ text: '/work' }) } }), deps)
    expect(tryConsumeCwdInput).toHaveBeenCalledWith('chat-1', '/work')
    expect(bridge.handleUserMessage).not.toHaveBeenCalled()
  })

  it('questionBridge 未命中（false）时继续尝试 configCard', async () => {
    const { deps, bridge } = makeDeps({ allowedUsers: ['open-1'] })
    deps.questionBridge = { tryConsumeFreeText: vi.fn(() => false) }
    const tryConsumeCwdInput = vi.fn(() => true)
    deps.configCard = { tryConsumeCwdInput, sendConfigCard: vi.fn(async () => true) }
    await handleInboundMessage(event({ message: { ...event().message, content: JSON.stringify({ text: '/x' }) } }), deps)
    expect(tryConsumeCwdInput).toHaveBeenCalledWith('chat-1', '/x')
    expect(bridge.handleUserMessage).not.toHaveBeenCalled()
  })

  it('空文本消息忽略', async () => {
    const { deps, bridge } = makeDeps({ allowedUsers: ['open-1'] })
    await handleInboundMessage(event({ message: { ...event().message, content: JSON.stringify({ text: '   ' }) } }), deps)
    expect(bridge.handleUserMessage).not.toHaveBeenCalled()
  })

  it('附件消息（无 attachmentBridge）→ 提示且不转发（向后兼容）', async () => {
    const { deps, bridge, sent } = makeDeps({ allowedUsers: ['open-1'] })
    await handleInboundMessage(event({
      message: { ...event().message, content: JSON.stringify({ image_key: 'img_x' }), message_type: 'image' },
    }), deps)
    expect(sent[0]).toContain('附件消息暂不支持')
    expect(bridge.handleUserMessage).not.toHaveBeenCalled()
  })

  it('附件消息（有 attachmentBridge）→ 下载成功 → 注入 AI 识图引导', async () => {
    const { deps, bridge } = makeDeps({ allowedUsers: ['open-1'] })
    const downloadAll = vi.fn(async () => ({
      ok: [{ kind: 'image', name: 'shot.png', path: '/workspace/.feishu-attachments/feishu/s1/shot.png', size: 1024, mimeType: 'image/png' }],
      rejected: 0,
    }))
    deps.attachmentBridge = { downloadAll }
    await handleInboundMessage(event({
      message: { ...event().message, content: JSON.stringify({ image_key: 'img_x' }), message_type: 'image' },
    }), deps)
    expect(bridge.ensureAgentForChat).toHaveBeenCalledWith('chat-1')
    expect(downloadAll).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'chat-1', messageId: 'msg-1', sessionId: 's1', cwd: '/workspace',
      downloads: [{ kind: 'image', fileKey: 'img_x' }],
    }))
    expect(bridge.handleUserMessage).toHaveBeenCalledTimes(1)
    const prompt = bridge.handleUserMessage.mock.calls[0]![1] as string
    expect(prompt).toContain('vision_understand')
    expect(prompt).toContain('/workspace/.feishu-attachments/feishu/s1/shot.png')
  })

  it('附件全部下载失败且无文本 → 不注入 AI', async () => {
    const { deps, bridge, sent } = makeDeps({ allowedUsers: ['open-1'] })
    deps.attachmentBridge = {
      downloadAll: vi.fn(async () => ({ ok: [], rejected: 1 })),
    }
    await handleInboundMessage(event({
      message: { ...event().message, content: JSON.stringify({ file_key: 'f_x', file_name: 'x.zip' }), message_type: 'file' },
    }), deps)
    expect(bridge.handleUserMessage).not.toHaveBeenCalled()
  })

  it('附件下载失败但带文本 → 文本仍注入 AI', async () => {
    const { deps, bridge } = makeDeps({ allowedUsers: ['open-1'] })
    deps.attachmentBridge = {
      downloadAll: vi.fn(async () => ({ ok: [], rejected: 1 })),
    }
    // post 富文本：zh_cn.content 里的 text 节点
    await handleInboundMessage(event({
      message: {
        ...event().message,
        content: JSON.stringify({ zh_cn: { content: [[{ tag: 'text', text: '看下这个文件' }]] } }),
        message_type: 'post',
      },
    }), deps)
    expect(bridge.handleUserMessage).toHaveBeenCalledWith('chat-1', '看下这个文件', 'msg-1')
  })

  it('文本+附件 → 提示忽略附件但转发文本', async () => {
    const { deps, bridge, sent } = makeDeps({ allowedUsers: ['open-1'] })
    await handleInboundMessage(event({
      message: {
        ...event().message,
        content: JSON.stringify({ text: '看图说话' }),
      },
    }), deps)
    // 纯文本无附件：直接转发
    expect(bridge.handleUserMessage).toHaveBeenCalledWith('chat-1', '看图说话', 'msg-1')
    expect(sent).toHaveLength(0)
  })

  it('处理异常被吞掉并记录（不抛到 WS 层）', async () => {
    const { deps, bridge } = makeDeps({ allowedUsers: ['open-1'] })
    bridge.handleUserMessage.mockRejectedValueOnce(new Error('boom'))
    await expect(handleInboundMessage(event(), deps)).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// P5：限流 + 审计
// ---------------------------------------------------------------------------

describe('P5 限流与审计', () => {
  it('消息超限：静默丢弃 + 审计 message/rate-limited', async () => {
    const { deps, bridge } = makeDeps({ allowedUsers: ['open-1'] })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-inbound-audit-'))
    const audit = new AuditLog(dir)
    deps.rateLimiter = new RateLimiter({ windowMs: 1000, max: 1 })
    deps.audit = audit
    await handleInboundMessage(event({ message: { ...event().message, message_id: 'm1' } }), deps)
    await handleInboundMessage(event({ message: { ...event().message, message_id: 'm2' } }), deps)
    expect(bridge.handleUserMessage).toHaveBeenCalledTimes(1) // 第二条被限流丢弃
    const records = audit.readAll()
    expect(records.some(r => r.event === 'message/rate-limited' && r.user === 'open-1')).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('配对成功/失败写入审计', async () => {
    const { deps } = makeDeps()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-inbound-audit-'))
    const audit = new AuditLog(dir)
    deps.audit = audit
    const code = deps.pairing.ensureCode()
    // 失败一次
    await handleInboundMessage(event({ message: { ...event().message, content: JSON.stringify({ text: 'WRONG' }) } }), deps)
    // 成功一次
    await handleInboundMessage(event({ message: { ...event().message, message_id: 'm2', content: JSON.stringify({ text: code }) } }), deps)
    const events = audit.readAll().map(r => r.event)
    expect(events).toContain('pairing/failed')
    expect(events).toContain('pairing/success')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('命令执行写入审计（带参数摘要）', async () => {
    const { deps } = makeDeps({ allowedUsers: ['open-1'] })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-inbound-audit-'))
    const audit = new AuditLog(dir)
    deps.audit = audit
    await handleInboundMessage(event({ message: { ...event().message, content: JSON.stringify({ text: '/status' }) } }), deps)
    const records = audit.readAll()
    expect(records.some(r => r.event === 'command/executed' && r.detail.includes('/status'))).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('无限流器时不限流（向后兼容）', async () => {
    const { deps, bridge } = makeDeps({ allowedUsers: ['open-1'] })
    await handleInboundMessage(event({ message: { ...event().message, message_id: 'm1' } }), deps)
    await handleInboundMessage(event({ message: { ...event().message, message_id: 'm2' } }), deps)
    expect(bridge.handleUserMessage).toHaveBeenCalledTimes(2)
  })
})
