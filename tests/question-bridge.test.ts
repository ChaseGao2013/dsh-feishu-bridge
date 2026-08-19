/**
 * 远程提问通道单元测试（P2.5）
 *
 * 覆盖：卡片构建（选项按钮/自定义按钮/value 结构）、ask 挂起、
 * 选项按钮应答（单题/多题/未答齐）、自定义输入两段式（按钮→文本消费）、
 * 超时/abort/卡片发送失败/dispose 收尾、未知 token 回调。
 */

import { describe, it, expect, vi } from 'vitest'
import { QuestionBridge, buildQuestionCard } from '../src/question-bridge.js'
import type { AskUserQuestionItem } from '../src/question-bridge.js'

function makeDeps() {
  const sent: Array<{ chatId: string; card?: Record<string, unknown>; text?: string }> = []
  return {
    sent,
    api: {
      sendCard: vi.fn(async (chatId: string, card: Record<string, unknown>) => {
        sent.push({ chatId, card })
        return `card-${sent.length}`
      }),
      sendText: vi.fn(async (chatId: string, text: string) => {
        sent.push({ chatId, text })
      }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
  }
}

function makeQuestion(overrides: Partial<AskUserQuestionItem> = {}): AskUserQuestionItem {
  return {
    id: 'q1',
    question: '要继续执行吗？',
    options: [{ label: '继续' }, { label: '停止' }],
    ...overrides,
  }
}

/** 从卡片 body 里找某个按钮的 value。 */
function findButton(card: Record<string, unknown>, action: string): Record<string, unknown> | undefined {
  const body = card.body as { elements?: unknown[] }
  for (const element of body.elements ?? []) {
    const el = element as { tag?: string; columns?: Array<{ elements?: Array<{ tag?: string; value?: unknown }> }> }
    if (el.tag !== 'column_set') continue
    for (const column of el.columns ?? []) {
      for (const btn of column.elements ?? []) {
        if (btn.tag !== 'button') continue
        const value = btn.value as { action?: string }
        if (value?.action === action) return btn.value as Record<string, unknown>
      }
    }
  }
  return undefined
}

describe('buildQuestionCard', () => {
  it('渲染每题：选项按钮带 token/qIndex/option，自定义按钮带 qIndex', () => {
    const card = buildQuestionCard([
      makeQuestion({ id: 'a', question: '问题A', options: [{ label: '甲' }, { label: '乙' }] }),
      makeQuestion({ id: 'b', question: '问题B', options: [{ label: '丙' }] }),
    ], 'tok-1')

    const answerA = findButton(card, 'qanswer')!
    expect(answerA).toMatchObject({ action: 'qanswer', token: 'tok-1', qIndex: 0, option: '甲' })
    const answerB = findButton(card, 'qanswer')
    // 至少有两个选项按钮；找 qIndex=1 的
    expect(answerB).toBeDefined()
    const custom = findButton(card, 'qcustom')!
    expect(custom).toMatchObject({ action: 'qcustom', token: 'tok-1', qIndex: 0 })

    // 长标签截断显示，value 保留完整标签
    const long = buildQuestionCard([makeQuestion({ options: [{ label: '这是一个非常非常长的选项标签内容' }] })], 't')
    const longBtn = findButton(long, 'qanswer')!
    expect(longBtn.option).toBe('这是一个非常非常长的选项标签内容')
  })

  it('multiSelect 问题渲染多选提示', () => {
    const card = buildQuestionCard([makeQuestion({ multiSelect: true })], 't')
    const json = JSON.stringify(card)
    expect(json).toContain('支持多选')
  })
})

describe('QuestionBridge.ask', () => {
  it('选项按钮应答：单题点击后 resolve 完整答案', async () => {
    const deps = makeDeps()
    const bridge = new QuestionBridge(deps.api)
    const pending = bridge.ask({ questions: [makeQuestion()] }, 'chat-1')

    await vi.waitFor(() => expect(bridge.pendingCount()).toBe(1))
    const card = deps.sent.find(s => s.card)!.card!
    const button = findButton(card, 'qanswer')!
    const toast = await bridge.handleCardAction({
      action: { value: button as Record<string, unknown> },
    })
    expect(toast).toMatchObject({ toast: { type: 'info' } })
    const answer = await pending
    expect(answer.answers).toEqual([{ id: 'q1', selected: ['继续'] }])
    expect(bridge.pendingCount()).toBe(0)
  })

  it('多题：全部答齐才 resolve；未答齐继续挂起', async () => {
    const deps = makeDeps()
    const bridge = new QuestionBridge(deps.api)
    const pending = bridge.ask({
      questions: [
        makeQuestion({ id: 'a', question: '问题A', options: [{ label: '甲' }] }),
        makeQuestion({ id: 'b', question: '问题B', options: [{ label: '丙' }] }),
      ],
    }, 'chat-1')

    await vi.waitFor(() => expect(bridge.pendingCount()).toBe(1))
    const card = deps.sent.find(s => s.card)!.card!

    // 答第一题 → 未 resolve
    const buttonA = findButton(card, 'qanswer')!
    const toastA = await bridge.handleCardAction({ action: { value: { ...buttonA, qIndex: 0 } } })
    expect(toastA!.toast.content).toContain('还剩 1 题')
    await expect(Promise.race([pending, Promise.resolve('pending')])).resolves.toBe('pending')

    // 答第二题 → resolve
    await bridge.handleCardAction({ action: { value: { ...buttonA, qIndex: 1, option: '丙' } } })
    const answer = await pending
    expect(answer.answers).toEqual([
      { id: 'a', selected: ['甲'] },
      { id: 'b', selected: ['丙'] },
    ])
  })

  it('自定义回答：点按钮进入等待态 → 文本消息消费为 custom 答案', async () => {
    const deps = makeDeps()
    const bridge = new QuestionBridge(deps.api)
    const pending = bridge.ask({ questions: [makeQuestion()] }, 'chat-1')

    await vi.waitFor(() => expect(bridge.pendingCount()).toBe(1))
    const card = deps.sent.find(s => s.card)!.card!
    const custom = findButton(card, 'qcustom')!
    await bridge.handleCardAction({ action: { value: custom } })

    // 等待提示已发出
    expect(deps.sent.some(s => s.text?.includes('请回答 Q1'))).toBe(true)

    // 普通文本在等待态被消费
    expect(bridge.tryConsumeFreeText('chat-1', '我的自定义回答')).toBe(true)
    const answer = await pending
    expect(answer.answers).toEqual([{ id: 'q1', selected: [], custom: '我的自定义回答' }])

    // 消费后不再命中
    expect(bridge.tryConsumeFreeText('chat-1', '再来一条')).toBe(false)
  })

  it('多题混合：一题按钮 + 一题自定义，答齐后 resolve', async () => {
    const deps = makeDeps()
    const bridge = new QuestionBridge(deps.api)
    const pending = bridge.ask({
      questions: [
        makeQuestion({ id: 'a', options: [{ label: '甲' }] }),
        makeQuestion({ id: 'b', options: [{ label: '丙' }] }),
      ],
    }, 'chat-1')

    await vi.waitFor(() => expect(bridge.pendingCount()).toBe(1))
    const card = deps.sent.find(s => s.card)!.card!
    const buttonA = findButton(card, 'qanswer')!
    const customB = findButton(card, 'qcustom')!

    await bridge.handleCardAction({ action: { value: { ...buttonA, qIndex: 0 } } })
    await bridge.handleCardAction({ action: { value: { ...customB, qIndex: 1 } } })
    expect(bridge.tryConsumeFreeText('chat-1', '自由填写')).toBe(true)

    const answer = await pending
    expect(answer.answers).toEqual([
      { id: 'a', selected: ['甲'] },
      { id: 'b', selected: [], custom: '自由填写' },
    ])
  })

  it('其他 chat 的文本不消费', async () => {
    const deps = makeDeps()
    const bridge = new QuestionBridge(deps.api)
    const pending = bridge.ask({ questions: [makeQuestion()] }, 'chat-1')
    await vi.waitFor(() => expect(bridge.pendingCount()).toBe(1))
    const card = deps.sent.find(s => s.card)!.card!
    await bridge.handleCardAction({ action: { value: findButton(card, 'qcustom')! } })

    expect(bridge.tryConsumeFreeText('chat-2', '别的chat')).toBe(false)
    expect(bridge.tryConsumeFreeText('chat-1', '回答')).toBe(true)
    await expect(pending).resolves.toBeDefined()
  })

  it('未知 token 回调返回 warning toast', async () => {
    const deps = makeDeps()
    const bridge = new QuestionBridge(deps.api)
    const toast = await bridge.handleCardAction({
      action: { value: { action: 'qanswer', token: 'nope', qIndex: 0, option: '甲' } },
    })
    expect(toast).toMatchObject({ toast: { type: 'warning' } })
  })

  it('非提问卡回调直接返回 undefined（不干扰审批卡）', async () => {
    const deps = makeDeps()
    const bridge = new QuestionBridge(deps.api)
    const toast = await bridge.handleCardAction({
      action: { value: { action: 'permit', requestId: 'x', allowed: true } },
    })
    expect(toast).toBeUndefined()
  })

  it('卡片发送失败 → ask 直接抛错（不挂起）', async () => {
    const deps = makeDeps()
    deps.api.sendCard.mockResolvedValue(undefined)
    const bridge = new QuestionBridge(deps.api)
    await expect(bridge.ask({ questions: [makeQuestion()] }, 'chat-1')).rejects.toThrow('发送失败')
    expect(bridge.pendingCount()).toBe(0)
  })

  it('超时 → reject 并提示用户', async () => {
    const deps = makeDeps()
    const bridge = new QuestionBridge(deps.api, { timeoutMs: 30 })
    const pending = bridge.ask({ questions: [makeQuestion()] }, 'chat-1')
    await expect(pending).rejects.toThrow('超时')
    expect(deps.sent.some(s => s.text?.includes('超时未回答'))).toBe(true)
    expect(bridge.pendingCount()).toBe(0)
  })

  it('abort → reject（/stop 取消）', async () => {
    const deps = makeDeps()
    const bridge = new QuestionBridge(deps.api)
    const controller = new AbortController()
    const pending = bridge.ask({ questions: [makeQuestion()], signal: controller.signal }, 'chat-1')
    await vi.waitFor(() => expect(bridge.pendingCount()).toBe(1))
    controller.abort()
    await expect(pending).rejects.toThrow('已取消')
    expect(bridge.pendingCount()).toBe(0)
  })

  it('开始前已 abort → 直接抛错不发卡', async () => {
    const deps = makeDeps()
    const bridge = new QuestionBridge(deps.api)
    const controller = new AbortController()
    controller.abort()
    await expect(
      bridge.ask({ questions: [makeQuestion()], signal: controller.signal }, 'chat-1'),
    ).rejects.toThrow('已取消')
    expect(deps.sent).toHaveLength(0)
  })

  it('dispose 把所有挂起 reject', async () => {
    const deps = makeDeps()
    const bridge = new QuestionBridge(deps.api)
    const pending = bridge.ask({ questions: [makeQuestion()] }, 'chat-1')
    await vi.waitFor(() => expect(bridge.pendingCount()).toBe(1))
    bridge.dispose()
    await expect(pending).rejects.toThrow('服务关闭')
    expect(bridge.pendingCount()).toBe(0)
  })

  it('答齐 resolve 后重复点击同一 token：返回 warning（结果不再改变）', async () => {
    const deps = makeDeps()
    const bridge = new QuestionBridge(deps.api)
    const pending = bridge.ask({ questions: [makeQuestion()] }, 'chat-1')
    await vi.waitFor(() => expect(bridge.pendingCount()).toBe(1))
    const card = deps.sent.find(s => s.card)!.card!
    const button = findButton(card, 'qanswer')!
    await bridge.handleCardAction({ action: { value: { ...button, option: '继续' } } })
    const answer = await pending
    expect(answer.answers).toEqual([{ id: 'q1', selected: ['继续'] }])
    const again = await bridge.handleCardAction({ action: { value: { ...button, option: '停止' } } })
    expect(again).toMatchObject({ toast: { type: 'warning' } })
  })
})
