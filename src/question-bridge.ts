/**
 * 远程提问通道（P2.5）：把 DSH `ask_user_question` 转发到飞书交互卡。
 *
 * 背景：DSH 的 `ctx.userQuestions` 是单 provider 服务（apiproxy 注册了 GUI
 * 弹框 provider），远程会话（飞书桥接）的 agent 调用 ask_user_question 时
 * GUI 无人应答，飞书端一直卡"思考中"。本模块由 remote-ask-tool.ts 注册的
 * 同名工具调用（agent scope 层 shadow preset 层，GUI 会话不受影响）。
 *
 * 交互闭环（与 P2 审批卡同款模式）：
 * - ask() 把问题渲染成 Schema 2.0 交互卡（每题一组选项按钮 + 一个自定义按钮）
 * - 选项按钮 → card.action.trigger 回调 → handleCardAction 填充答案
 * - 自定义按钮 → 服务端提示"直接回复本消息即可" → 用户下一条普通文本消息
 *   被 inbound 分发先经 tryConsumeFreeText 消费，作为该题 custom 答案
 * - 所有问题都答齐 → resolve；超时（默认 10 分钟）→ reject；abort → reject
 * - teardown 时把所有挂起 settle 为错误（与 apiproxy 收尾一致）
 *
 * 多选（multiSelect）说明：卡片按钮一次点击回答一个选项，因此 multiSelect
 * 问题的按钮按单选处理；如需多选可用自定义输入按行/逗号分隔填写。
 */

import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// 类型（与 @deepseek-ai/dsh-user-questions 结构子类型一致，零运行时依赖）
// ---------------------------------------------------------------------------

export interface AskUserQuestionOption {
  label: string
  description?: string
}

export interface AskUserQuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: AskUserQuestionOption[]
  multiSelect?: boolean
}

export interface AskUserQuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

export interface AskUserQuestionAnswer {
  answers: AskUserQuestionAnswerItem[]
}

/** card.action.trigger 事件的最小形状（与 approval-cards.ts 同源）。 */
export interface CardActionEvent {
  operator?: { open_id?: string }
  action?: {
    value?: {
      action?: string
      token?: string
      qIndex?: number
      option?: string
    }
  }
  context?: { open_chat_id?: string }
}

export interface QuestionBridgeDeps {
  /** 发送交互卡到 chat，返回 message_id（失败返回 undefined）。 */
  sendCard: (chatId: string, card: Record<string, unknown>) => Promise<string | undefined>
  /** 普通文本消息（自定义回答提示、超时提示等）。 */
  sendText: (chatId: string, text: string) => Promise<void>
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void }
}

interface PendingQuestion {
  token: string
  chatId: string
  questions: AskUserQuestionItem[]
  /** 每题答案（未答为 undefined）。 */
  answers: (AskUserQuestionAnswerItem | undefined)[]
  resolve: (answer: AskUserQuestionAnswer) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** 正在等待自定义文本输入的问题下标（一次只等一题）。 */
  awaitingText: number | undefined
}

/** 默认提问挂起超时（毫秒）。 */
export const DEFAULT_QUESTION_TIMEOUT_MS = 10 * 60 * 1000 // 10 分钟

// ---------------------------------------------------------------------------
// 卡片构建（Schema 2.0）
// ---------------------------------------------------------------------------

/**
 * 构建提问交互卡：每题一个 markdown 段 + 选项按钮组 + 自定义回答按钮。
 * 按钮 value 携带 token（挂起键）+ qIndex + option，回调按此定位答案。
 */
export function buildQuestionCard(
  questions: AskUserQuestionItem[],
  token: string,
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = []
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]!
    if (index > 0) {
      elements.push({ tag: 'hr', margin: '12px 0 0 0' })
    }
    const headerText = question.header
      ? `**${question.header}**：${question.question}`
      : `**Q${index + 1}. ${question.question}**`
    const detailText = [
      headerText,
      question.detail ? `\n> ${question.detail}` : '',
      question.multiSelect ? '\n\n（本题支持多选，可点自定义回答一次填写多个选项）' : '',
    ].join('')
    elements.push({
      tag: 'markdown',
      content: detailText,
    })

    // 选项按钮：每 3 个一组 column_set 排列
    const options = question.options ?? []
    for (let start = 0; start < options.length; start += 3) {
      const columns = options.slice(start, start + 3).map(option => ({
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: truncateLabel(option.label) },
            type: 'primary',
            size: 'medium',
            value: { action: 'qanswer', token, qIndex: index, option: option.label },
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

    // 自定义回答按钮
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
              text: { tag: 'plain_text', content: '✏️ 自定义回答' },
              type: 'default',
              size: 'medium',
              value: { action: 'qcustom', token, qIndex: index },
            },
          ],
        },
      ],
    })
  }

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: false,
      update_multi: true,
    },
    header: {
      title: { tag: 'plain_text', content: '❓ DSH 需要你回答' },
      subtitle: { tag: 'plain_text', content: `共 ${questions.length} 个问题` },
      template: 'blue',
      padding: '12px 12px 12px 12px',
      icon: { tag: 'standard_icon', token: 'help_chat_filled' },
    },
    body: { elements },
  }
}

/** 按钮文案过长会溢出列宽，截断并加省略号（保留完整标签在 value 里）。 */
function truncateLabel(label: string): string {
  return label.length > 12 ? `${label.slice(0, 12)}…` : label
}

// ---------------------------------------------------------------------------
// 提问挂起服务
// ---------------------------------------------------------------------------

/**
 * 远程提问挂起通道：ask() 发飞书卡并挂起，等待按钮回调/自定义文本/超时/abort。
 * 注册方式：由 index.ts 构造，handleCardAction 挂在 card.action.trigger 分发，
 * tryConsumeFreeText 挂在入站文本分发（inbound 消费）。
 */
export class QuestionBridge {
  private readonly pending = new Map<string, PendingQuestion>()
  private readonly timeoutMs: number

  constructor(
    private readonly deps: QuestionBridgeDeps,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS
  }

  /** 当前挂起的提问数（测试/状态用）。 */
  pendingCount(): number {
    return this.pending.size
  }

  /**
   * 发一张提问卡并挂起，直到全部问题答齐（按钮/自定义文本）、超时或 abort。
   * @param request 提问请求（questions 至少 1 个；signal 用于取消）
   * @param chatId 归属飞书 chat
   * @returns 用户答案；超时/取消时 reject。
   */
  async ask(
    request: { questions: AskUserQuestionItem[]; signal?: AbortSignal },
    chatId: string,
  ): Promise<AskUserQuestionAnswer> {
    if (request.signal?.aborted === true) {
      throw new Error('远程提问在开始前已取消')
    }
    if (request.questions.length === 0) {
      throw new Error('远程提问需要至少一个问题')
    }
    const token = randomUUID()
    const cardId = await this.deps.sendCard(chatId, buildQuestionCard(request.questions, token))
    if (cardId === undefined) {
      // 卡片发送失败 → 不挂起（避免调用方永远悬空）
      throw new Error('远程提问卡片发送失败（飞书 API 不可用？）')
    }

    return await new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const entry: PendingQuestion = {
        token,
        chatId,
        questions: request.questions,
        answers: request.questions.map(() => undefined),
        resolve,
        reject,
        timer: setTimeout(() => {}, 0), // 占位，下面立即替换
        awaitingText: undefined,
      }
      const settle = (fn: (entry: PendingQuestion) => void): void => {
        if (!this.pending.delete(token)) return
        request.signal?.removeEventListener('abort', onAbort)
        clearTimeout(entry.timer)
        fn(entry)
      }
      const onAbort = (): void => {
        settle((e) => {
          void this.deps.sendText(e.chatId, '⏹ 提问已取消。')
          e.reject(new Error('远程提问已取消'))
        })
      }
      entry.timer = setTimeout(() => {
        settle((e) => {
          void this.deps.sendText(
            e.chatId,
            `⏰ 提问（${e.questions[0]?.question.slice(0, 30) ?? ''}…）超时未回答，已取消。`,
          )
          e.reject(new Error('远程提问超时'))
        })
      }, this.timeoutMs)
      request.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(token, entry)
      this.deps.logger.info(`[feishu-bridge] 提问卡已发送: ${request.questions.length} 题 → chat ${chatId} (${token.slice(0, 8)}…)`)
    })
  }

  /**
   * card.action.trigger 回调入口：选项按钮 → 填答案；自定义按钮 → 进入等待文本态。
   * 返回飞书卡片回调的 toast 响应（无对应挂起时返回 warning toast）。
   */
  async handleCardAction(data: CardActionEvent): Promise<{ toast: { type: string; content: string } } | undefined> {
    const action = data.action?.value
    if (action?.action !== 'qanswer' && action?.action !== 'qcustom') return undefined
    const token = action.token
    if (!token) return undefined

    const entry = this.pending.get(token)
    if (!entry) {
      return { toast: { type: 'warning', content: '问题不存在或已处理' } }
    }

    if (action.action === 'qcustom') {
      const qIndex = action.qIndex ?? 0
      if (qIndex < 0 || qIndex >= entry.questions.length) {
        return { toast: { type: 'warning', content: '问题序号无效' } }
      }
      entry.awaitingText = qIndex
      const question = entry.questions[qIndex]!
      await this.deps.sendText(
        entry.chatId,
        `✏️ 请回答 Q${qIndex + 1}：${question.question}\n直接回复本条消息即可（输入的内容将作为你的回答）。`,
      )
      return { toast: { type: 'info', content: '请输入你的回答' } }
    }

    // 选项按钮：填充该题答案
    const qIndex = action.qIndex ?? 0
    if (qIndex < 0 || qIndex >= entry.questions.length) {
      return { toast: { type: 'warning', content: '问题序号无效' } }
    }
    const option = action.option ?? ''
    if (!option) return { toast: { type: 'warning', content: '选项为空' } }
    entry.awaitingText = undefined
    this.fillAnswer(entry, qIndex, {
      id: entry.questions[qIndex]!.id,
      selected: [option],
    })
    if (this.allAnswered(entry)) {
      this.resolveNow(entry)
      return { toast: { type: 'info', content: `✅ 已选择：${option}` } }
    }
    const remaining = this.remainingCount(entry)
    return { toast: { type: 'info', content: `已选择：${option}（还剩 ${remaining} 题）` } }
  }

  /**
   * 入站文本消费：命中"等待自定义回答"的 chat 时，把文本作为该题答案并返回 true
   * （调用方应不再把该消息送入 DSH 会话/命令处理）。
   */
  tryConsumeFreeText(chatId: string, text: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.chatId !== chatId) continue
      if (entry.awaitingText === undefined) continue
      const qIndex = entry.awaitingText
      entry.awaitingText = undefined
      this.fillAnswer(entry, qIndex, {
        id: entry.questions[qIndex]!.id,
        selected: [],
        custom: text,
      })
      if (this.allAnswered(entry)) {
        this.resolveNow(entry)
        void this.deps.sendText(chatId, '✅ 已收到你的回答。')
      } else {
        void this.deps.sendText(chatId, `✅ 已收到 Q${qIndex + 1} 的回答，还有 ${this.remainingCount(entry)} 题待回答。`)
      }
      return true
    }
    return false
  }

  /** teardown：把所有挂起 reject（与 apiproxy 收尾一致，避免调用方悬空）。 */
  dispose(): void {
    for (const entry of [...this.pending.values()]) {
      this.rejectNow(entry, new Error('远程提问已取消（服务关闭）'))
    }
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  private fillAnswer(entry: PendingQuestion, qIndex: number, answer: AskUserQuestionAnswerItem): void {
    entry.answers[qIndex] = answer
  }

  private allAnswered(entry: PendingQuestion): boolean {
    return entry.answers.every(answer => answer !== undefined)
  }

  private remainingCount(entry: PendingQuestion): number {
    return entry.answers.filter(answer => answer === undefined).length
  }

  private collect(entry: PendingQuestion): AskUserQuestionAnswer {
    return {
      answers: entry.answers.map(answer => ({
        id: answer!.id,
        selected: [...answer!.selected],
        ...answer!.custom !== undefined ? { custom: answer!.custom } : {},
      })),
    }
  }

  private resolveNow(entry: PendingQuestion): void {
    if (!this.pending.delete(entry.token)) return
    clearTimeout(entry.timer)
    entry.resolve(this.collect(entry))
  }

  private rejectNow(entry: PendingQuestion, error: Error): void {
    if (!this.pending.delete(entry.token)) return
    clearTimeout(entry.timer)
    entry.reject(error)
  }
}
