/**
 * 远程 ask_user_question 工具单元测试（P2.5）
 *
 * 覆盖：工具定义结构（与官方 schema 一致）、execute 正常路径（答案回传）、
 * 无飞书归属（子代理）抛错、参数防御（缺 questions 抛错）、注册函数行为。
 */

import { describe, it, expect, vi } from 'vitest'
import { buildRemoteAskTool, registerRemoteAskTool, type ToolDefinition } from '../src/remote-ask-tool.js'
import { QuestionBridge, type AskUserQuestionAnswer } from '../src/question-bridge.js'

function makeDeps(overrides: Partial<{ chatId: string | undefined; answer: AskUserQuestionAnswer }> = {}) {
  const chatIdOfAgent = vi.fn(() =>
    Object.prototype.hasOwnProperty.call(overrides, 'chatId') ? overrides.chatId : 'chat-1',
  )
  const ask = vi.fn(async (request: { questions: unknown[]; signal?: AbortSignal }, chatId: string) => {
    expect(chatId).toBe('chat-1')
    return overrides.answer ?? {
      answers: request.questions.map((_, index) => ({ id: `id-${index}`, selected: [`opt-${index}`] })),
    }
  })
  const questionBridge = {
    ask,
    pendingCount: vi.fn(() => 0),
    handleCardAction: vi.fn(),
    tryConsumeFreeText: vi.fn(),
    dispose: vi.fn(),
  } as unknown as QuestionBridge
  return {
    chatIdOfAgent,
    questionBridge,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    deps: { chatIdOfAgent, questionBridge, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
  }
}

const ARGS = {
  questions: [
    { id: 'a', question: '选哪个？', options: [{ label: '甲', description: '选项甲' }], multi_select: false },
  ],
}

describe('buildRemoteAskTool', () => {
  it('工具名/描述/参数/输出 schema 与官方一致', () => {
    const { deps } = makeDeps()
    const tool = buildRemoteAskTool(deps) as ToolDefinition
    expect(tool.name).toBe('ask_user_question')
    expect(tool.description).toContain('Ask the user a concise question')
    expect(tool.parameters).toMatchObject({ type: 'object', required: ['questions'] })
    expect(tool.output.schema).toMatchObject({ type: 'object', properties: { answers: { type: 'array' } } })
    expect(typeof tool.output.render).toBe('function')
    expect(tool.output.render(ARGS, { answers: [] })).toEqual([{ type: 'text', text: '{"answers":[]}' }])
  })

  it('execute：把答案回传（selected/custom 结构）', async () => {
    const { deps, questionBridge, chatIdOfAgent } = makeDeps()
    const tool = buildRemoteAskTool(deps)
    const result = await tool.execute(ARGS, {
      callId: 'call-1',
      name: 'ask_user_question',
      arguments: ARGS,
      agent: { id: 'session-1' },
      signal: new AbortController().signal,
    })
    expect(chatIdOfAgent).toHaveBeenCalledWith('session-1')
    expect(questionBridge.ask).toHaveBeenCalledWith(
      expect.objectContaining({ questions: expect.arrayContaining([
        expect.objectContaining({ id: 'a', question: '选哪个？', multiSelect: false }),
      ]) }),
      'chat-1',
    )
    expect(result).toEqual({ answers: [{ id: 'id-0', selected: ['opt-0'] }] })
  })

  it('execute：custom 答案原样透传', async () => {
    const { deps } = makeDeps({
      answer: { answers: [{ id: 'a', selected: [], custom: '我选别的' }] },
    })
    const tool = buildRemoteAskTool(deps)
    const result = await tool.execute(ARGS, {
      callId: 'c',
      name: 'ask_user_question',
      arguments: ARGS,
      agent: { id: 'session-1' },
    })
    expect(result).toEqual({ answers: [{ id: 'a', selected: [], custom: '我选别的' }] })
  })

  it('execute：无飞书归属（子代理/无会话）抛错而非挂起', async () => {
    const { deps, questionBridge } = makeDeps({ chatId: undefined })
    const tool = buildRemoteAskTool(deps)
    await expect(tool.execute(ARGS, {
      callId: 'c',
      name: 'ask_user_question',
      arguments: ARGS,
      agent: { id: 'child-session' },
    })).rejects.toThrow('飞书提问通道')
    expect(questionBridge.ask).not.toHaveBeenCalled()
  })

  it('execute：questions 缺失或为空抛错', async () => {
    const { deps } = makeDeps()
    const tool = buildRemoteAskTool(deps)
    await expect(tool.execute({}, {
      callId: 'c',
      name: 'ask_user_question',
      arguments: {},
      agent: { id: 'session-1' },
    })).rejects.toThrow('至少一个')
    await expect(tool.execute({ questions: [] }, {
      callId: 'c',
      name: 'ask_user_question',
      arguments: { questions: [] },
      agent: { id: 'session-1' },
    })).rejects.toThrow('至少一个')
    await expect(tool.execute({ questions: [{ id: 'x', question: '' }] }, {
      callId: 'c',
      name: 'ask_user_question',
      arguments: {},
      agent: { id: 'session-1' },
    })).rejects.toThrow('至少一个')
  })

  it('execute：无 agent（顶层调用）抛错', async () => {
    const { deps } = makeDeps()
    const tool = buildRemoteAskTool(deps)
    await expect(tool.execute(ARGS, {
      callId: 'c',
      name: 'ask_user_question',
      arguments: ARGS,
    })).rejects.toThrow('飞书提问通道')
  })
})

describe('registerRemoteAskTool', () => {
  it('有 tools 服务时注册并返回 disposer', () => {
    const { deps } = makeDeps()
    const register = vi.fn(() => () => {})
    const agentCtx = { tools: { register } }
    const disposer = registerRemoteAskTool(agentCtx, deps)
    expect(register).toHaveBeenCalledTimes(1)
    const definition = register.mock.calls[0]![0] as ToolDefinition
    expect(definition.name).toBe('ask_user_question')
    expect(typeof disposer).toBe('function')
  })

  it('无 tools 服务时静默跳过（不阻断装配）', () => {
    const { deps } = makeDeps()
    const disposer = registerRemoteAskTool({}, deps)
    expect(typeof disposer).toBe('function')
  })

  it('注册抛错被捕获并告警', () => {
    const { deps } = makeDeps()
    const register = vi.fn(() => { throw new Error('duplicate') })
    const disposer = registerRemoteAskTool({ tools: { register } }, deps)
    expect(typeof disposer).toBe('function')
    expect(deps.logger.warn).toHaveBeenCalled()
  })
})
