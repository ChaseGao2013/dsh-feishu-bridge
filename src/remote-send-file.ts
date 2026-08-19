/**
 * 远程发文件工具（P3 第二阶段，DSH → 飞书）：`send_file_to_feishu`
 *
 * 远程会话（飞书桥接）的 agent 生成/找到文件后，调用本工具把文件
 * 直接发回用户的飞书聊天。注册在 agent scope（与 ask_user_question
 * 同款 shadow 模式），仅远程会话可见。
 *
 * 流程：校验路径 → 读文件（限额：图片 10MB / 文件 30MB，与接收对齐）
 * → 按扩展名区分图片/文件 → FeishuMediaService.uploadImage/uploadFile
 * → sendImageMessage/sendFileMessage 发到归属 chat。
 * 失败（路径不存在/超限/上传或发送失败）直接抛错，agent 得到 error result。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ToolDefinition, ToolRunContext } from './remote-ask-tool.js'
import { IMAGE_LIMIT_BYTES, FILE_LIMIT_BYTES } from './attachment-bridge.js'

/** 图片扩展名集合（走飞书 image 消息）。 */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic'])

export interface SendFileToolDeps {
  /** 照搬层媒体服务（上传/发送）。 */
  media: {
    uploadImage(buffer: Buffer, mime: string): Promise<string>
    uploadFile(buffer: Buffer, fileName: string): Promise<string>
    sendImageMessage(chatId: string, imageKey: string): Promise<void>
    sendFileMessage(chatId: string, fileKey: string): Promise<void>
  }
  /** agent/session id → 飞书 chatId（本插件创建的会话才有）。 */
  chatIdOfAgent: (agentId: string) => string | undefined
  /** 审计日志（可选，P5）：文件发送落盘。 */
  audit?: { log(record: { event: string; detail: string; user?: string; chat?: string }): void }
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void }
}

const DESCRIPTION = 'Send a local file to the user\'s Feishu chat. '
  + 'Use this when the user is operating you remotely through Feishu and you produced, downloaded, or found a file '
  + 'they should receive (an image, a document, an archive, etc.). Images (png/jpg/jpeg/gif/webp/bmp/heic) are sent '
  + 'as image messages; everything else as a file message. Size limits: images 10MB, other files 30MB.'

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Absolute path of the local file to send.',
    },
    note: {
      type: 'string',
      description: 'Optional short note to the user about this file (sent as a text message alongside).',
    },
  },
  required: ['path'],
} as const

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sent: { type: 'boolean' },
    kind: { type: 'string' },
    name: { type: 'string' },
  },
} as const

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 构造（但不注册）send_file_to_feishu 工具定义。 */
export function buildSendFileTool(deps: SendFileToolDeps): ToolDefinition {
  return {
    name: 'send_file_to_feishu',
    description: DESCRIPTION,
    parameters: PARAMETERS_SCHEMA as unknown as Record<string, unknown>,
    output: {
      schema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec: ToolRunContext) {
      const raw = args as { path?: unknown; note?: unknown } | undefined
      const filePath = typeof raw?.path === 'string' && raw.path.trim() ? raw.path.trim() : ''
      if (!filePath) {
        throw new Error('send_file_to_feishu 需要 path 参数（本地文件绝对路径）')
      }
      const agentId = exec.agent !== undefined ? String(exec.agent.id) : undefined
      const chatId = agentId !== undefined ? deps.chatIdOfAgent(agentId) : undefined
      if (chatId === undefined) {
        throw new Error('该会话没有可用的飞书发送通道（子代理/无归属会话无法发送文件）')
      }

      let bytes: Buffer
      try {
        bytes = await fs.readFile(filePath)
      } catch (err) {
        throw new Error(`无法读取文件 ${filePath}：${String((err as Error).message ?? err)}`)
      }

      const ext = path.extname(filePath).toLowerCase()
      const isImage = IMAGE_EXTS.has(ext)
      const limit = isImage ? IMAGE_LIMIT_BYTES : FILE_LIMIT_BYTES
      if (bytes.byteLength > limit) {
        throw new Error(`文件超过大小限制（${isImage ? '图片' : '文件'}上限 ${formatSize(limit)}，实际 ${formatSize(bytes.byteLength)}）`)
      }

      const name = path.basename(filePath)
      if (isImage) {
        const key = await deps.media.uploadImage(bytes, 'image/' + ext.slice(1))
        await deps.media.sendImageMessage(chatId, key)
        deps.logger.info(`[feishu-bridge] 图片已发送到飞书: ${name} (${formatSize(bytes.byteLength)}) → chat ${chatId}`)
      } else {
        const key = await deps.media.uploadFile(bytes, name)
        await deps.media.sendFileMessage(chatId, key)
        deps.logger.info(`[feishu-bridge] 文件已发送到飞书: ${name} (${formatSize(bytes.byteLength)}) → chat ${chatId}`)
      }
      deps.audit?.log({
        event: 'attachment/sent',
        detail: `${isImage ? 'image' : 'file'} ${name} (${formatSize(bytes.byteLength)})`,
        chat: chatId,
      })
      return { sent: true, kind: isImage ? 'image' : 'file', name }
    },
  }
}

/**
 * 在 agent scope 注册 send_file_to_feishu 工具。返回注册 disposer；
 * agentCtx 无 tools 服务时静默跳过（不阻断装配）。
 */
export function registerSendFileTool(agentCtx: unknown, deps: SendFileToolDeps): () => void {
  const tools = (agentCtx as { tools?: { register(definition: ToolDefinition): () => void } }).tools
  if (tools === undefined) {
    deps.logger.warn('[feishu-bridge] agentCtx 无 tools 服务，跳过发送文件工具注册')
    return () => {}
  }
  try {
    return tools.register(buildSendFileTool(deps))
  } catch (err) {
    deps.logger.warn(`[feishu-bridge] 发送文件工具注册失败: ${String(err)}`)
    return () => {}
  }
}
