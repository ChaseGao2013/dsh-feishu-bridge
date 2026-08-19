/**
 * 远程 ask_user_question 工具（P2.5）：agent scope 层注册同名工具，
 * shadow 掉 preset（standard）注册的官方版本 → 远程会话的提问走飞书卡片，
 * GUI 会话不受影响（本工具只注册在 dsh-feishu-bridge 创建的 agent scope）。
 *
 * 为什么可行：dsh-tools 的 ToolRuntime 用 ScopedLayers 按 scope 分层，
 * view() 解析时"scope 自己的注册最后、shadow 继承的同名工具"
 * （packages/core/tools/src/index.ts view()）。本插件在 agent 装配
 * （agents.create/resume 的 setup 回调）里通过 agentCtx.tools.register()
 * 注册——Cordis tracker 把 Service 方法内 this.ctx 重绑到调用者 ctx，
 * 因此注册落在该 agent 自己的 scope layer。
 *
 * execute 语义与官方 @deepseek-ai/dsh-tool-ask-user 对齐：返回
 * { answers: [{ id, selected, custom? }] }，参数/输出 schema 完全一致。
 * 差异：提问经 QuestionBridge 发飞书卡并等待应答；无飞书归属（如子代理
 * 会话）时抛错，agent 得到 error result 而非永久挂起。
 */

import type { AskUserQuestionItem, AskUserQuestionAnswer } from './question-bridge.js'
import type { QuestionBridge } from './question-bridge.js'

// ---------------------------------------------------------------------------
// 最小工具定义面（与 @deepseek-ai/dsh-tools 的 ToolDefinition 结构子类型一致）
// ---------------------------------------------------------------------------

/** ContentBlock 最小面（render 返回值）。 */
type ContentBlock = { type: string; text: string }

export interface ToolRunContext {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly agent?: { id: unknown }
  readonly signal?: AbortSignal
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => ContentBlock[]
  }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}

/** agentCtx.tools 的最小使用面（真实实现是 @deepseek-ai/dsh-tools ToolRuntime）。 */
export interface RemoteToolsService {
  register(definition: ToolDefinition): () => void
}

export interface RemoteAskToolDeps {
  /** agent/session id → 飞书 chatId（本插件创建的会话才有）。 */
  chatIdOfAgent: (agentId: string) => string | undefined
  /** 提问挂起通道（发飞书卡并等待应答）。 */
  questionBridge: QuestionBridge
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void }
}

/** 与官方 dsh-tool-ask-user 相同的参数 schema。 */
const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      description: 'Questions to ask the user before continuing.',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          id: { type: 'string', description: 'Stable id for this question; echoed in the answer.' },
          question: { type: 'string', description: 'The specific question to ask the user.' },
          header: { type: 'string', description: 'Optional short heading for the question.' },
          options: {
            type: 'array',
            description: 'Optional choices to show the user.',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                label: { type: 'string', description: 'Short user-facing option label.' },
                description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
              },
            },
          },
          multi_select: { type: 'boolean', description: 'Whether more than one option may be selected. Defaults to false.' },
        },
      },
    },
  },
  required: ['questions'],
} as const

/** 与官方 dsh-tool-ask-user 相同的输出 schema。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          selected: { type: 'array', items: { type: 'string' } },
          custom: { type: 'string' },
        },
      },
    },
  },
} as const

const DESCRIPTION = 'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. '
  + 'Send one or more questions, each with a stable id that will be echoed in the answer.'

/** 构造（但不注册）远程版 ask_user_question 工具定义。 */
export function buildRemoteAskTool(deps: RemoteAskToolDeps): ToolDefinition {
  return {
    name: 'ask_user_question',
    description: DESCRIPTION,
    parameters: PARAMETERS_SCHEMA as unknown as Record<string, unknown>,
    output: {
      schema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agentId = exec.agent !== undefined ? String(exec.agent.id) : undefined
      const chatId = agentId !== undefined ? deps.chatIdOfAgent(agentId) : undefined
      if (chatId === undefined) {
        throw new Error(
          '该会话没有可用的飞书提问通道（子代理/无归属会话无法远程提问）；'
          + '请把未解决的问题或决策直接写进你的最终回复',
        )
      }
      const raw = args as { questions?: unknown } | undefined
      const rawQuestions = Array.isArray(raw?.questions) ? raw.questions : []
      const questions: AskUserQuestionItem[] = rawQuestions.map((item) => {
        const q = item as {
          id?: unknown
          question?: unknown
          header?: unknown
          detail?: unknown
          options?: unknown
          multi_select?: unknown
        }
        return {
          id: String(q.id ?? `q${Math.random().toString(36).slice(2, 8)}`),
          question: String(q.question ?? ''),
          ...q.header !== undefined ? { header: String(q.header) } : {},
          ...q.detail !== undefined ? { detail: String(q.detail) } : {},
          ...Array.isArray(q.options)
            ? {
              options: (q.options as Array<{ label?: unknown; description?: unknown }>).map(option => ({
                label: String(option.label ?? ''),
                ...option.description !== undefined ? { description: String(option.description) } : {},
              })),
            }
            : {},
          ...q.multi_select !== undefined ? { multiSelect: Boolean(q.multi_select) } : {},
        }
      })
      if (questions.length === 0 || questions.some(q => q.question === '')) {
        throw new Error('ask_user_question 需要至少一个带 question 文本的问题')
      }

      const answer: AskUserQuestionAnswer = await deps.questionBridge.ask(
        { questions, signal: exec.signal },
        chatId,
      )
      return {
        answers: answer.answers.map(a => ({
          id: a.id,
          selected: [...a.selected],
          ...a.custom !== undefined ? { custom: a.custom } : {},
        })),
      }
    },
  }
}

/**
 * 在 agent scope 注册远程版 ask_user_question 工具（shadow preset 层同名工具）。
 * 返回注册 disposer；agentCtx 无 tools 服务时静默跳过（不阻断装配）。
 */
export function registerRemoteAskTool(agentCtx: unknown, deps: RemoteAskToolDeps): () => void {
  const tools = (agentCtx as { tools?: RemoteToolsService }).tools
  if (tools === undefined) {
    deps.logger.warn('[feishu-bridge] agentCtx 无 tools 服务，跳过远程提问工具注册')
    return () => {}
  }
  try {
    return tools.register(buildRemoteAskTool(deps))
  } catch (err) {
    deps.logger.warn(`[feishu-bridge] 远程提问工具注册失败: ${String(err)}`)
    return () => {}
  }
}
