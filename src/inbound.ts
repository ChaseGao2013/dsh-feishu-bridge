/**
 * 飞书入站消息分发（im.message.receive_v1 → 配对 / DSH 桥接）。
 *
 * 逻辑（借鉴 CChh adapters/feishu/index.ts 的 handleMessage，MIT，本文件重写）：
 * - 去重（同一 message_id 只处理一次）
 * - 只处理私聊（p2p）；群聊忽略
 * - 未授权用户：消息文本即配对码 → tryPair；成功回执提示，失败回未授权提示
 * - 已授权用户：先解析远程命令（/help /status /new /clear /stop 等，见 commands.ts），
 *   命中命令直接执行回复；否则提取文本 → Bridge.handleUserMessage（附件 MVP 暂不支持）
 */

import type { Bridge } from './bridge.js'
import type { PairingStore } from './pairing.js'
import { extractInboundPayload, type PendingDownload } from './feishu/extract-payload.js'
import { buildAttachmentPrompt } from './attachment-bridge.js'
import type { AuditLog } from './audit.js'
import type { MessageDedup } from './dedup.js'
import { executeCommand, parseCommand, type CommandDeps } from './commands.js'

/** 一条 im.message.receive_v1 事件的最小形状。 */
export interface InboundMessageEvent {
  sender?: { sender_id?: { open_id?: string } }
  message?: {
    message_id?: string
    chat_id?: string
    chat_type?: string
    content?: string
    message_type?: string
    mentions?: Array<{ id?: { open_id?: string }; name?: string }>
  }
}

export interface InboundDeps {
  dedup: MessageDedup
  pairing: PairingStore
  bridge: Bridge
  allowedUsers?: readonly string[]
  sendText: (chatId: string, text: string, replyToMessageId?: string) => Promise<void>
  /** 远程提问的自由输入消费（可选）：命中"等待自定义回答"的 chat 时消费该消息。 */
  questionBridge?: { tryConsumeFreeText(chatId: string, text: string): boolean }
  /** /config 交互卡（可选）：工作目录输入消费 + 无参 /config 发卡。 */
  configCard?: {
    tryConsumeCwdInput(chatId: string, text: string): boolean
    sendConfigCard(chatId: string): Promise<boolean>
  }
  /** 附件桥接（可选）：下载飞书图片/文件到工作区暂存并生成注入文本。 */
  attachmentBridge?: {
    downloadAll(task: {
      chatId: string
      messageId: string
      sessionId: string
      cwd: string
      downloads: PendingDownload[]
    }): Promise<{ ok: Array<{ kind: 'image' | 'file'; name: string; path: string; size: number; mimeType: string }>; rejected: number }>
  }
  /** 入站消息限流（可选，P5）：按发送者 open_id 限流，超限静默丢弃。 */
  rateLimiter?: { tryConsume(key: string): boolean }
  /** 审计日志（可选，P5）：关键事件落盘。 */
  audit?: AuditLog
  /** 审批记忆（方案 C）：供 /approval-memory 命令查看与清空。 */
  approvalMemory?: import('./approval-memory.js').ApprovalMemoryStore
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void }
}

/** 处理一条入站消息。任何异常都吞掉并记录（WS 事件处理不允许抛到连接层）。 */
export async function handleInboundMessage(event: InboundMessageEvent, deps: InboundDeps): Promise<void> {
  try {
    await handleInboundMessageInner(event, deps)
  } catch (err) {
    deps.logger.error(`[feishu-bridge] 处理入站消息失败: ${String(err)}`)
  }
}

async function handleInboundMessageInner(event: InboundMessageEvent, deps: InboundDeps): Promise<void> {
  const messageId = event.message?.message_id
  const chatId = event.message?.chat_id
  const senderOpenId = event.sender?.sender_id?.open_id
  const chatType = event.message?.chat_type
  const content = event.message?.content
  const msgType = event.message?.message_type

  console.log('[FB-DEBUG] inbound:', JSON.stringify({ messageId, chatId, senderOpenId, chatType, msgType, content }).slice(0, 600))

  if (!messageId || !chatId || !senderOpenId || !content || !msgType) return
  if (!deps.dedup.tryRecord(messageId)) return

  // 只处理私聊（MVP；群聊 @bot 后置）
  if (chatType !== 'p2p') return

  // P5 消息限流：按发送者 open_id 滑动窗口限流，超限静默丢弃（防刷屏滥用）
  if (deps.rateLimiter && !deps.rateLimiter.tryConsume(senderOpenId)) {
    deps.audit?.log({
      event: 'message/rate-limited',
      detail: '消息频率超限，已静默丢弃',
      user: senderOpenId,
      chat: chatId,
    })
    return
  }

  const payload = extractInboundPayload(content, msgType)
  const text = payload.text.trim()

  // 远程提问的自定义回答、/config 工作目录输入优先消费（用户点了按钮后直接回复文本）。
  // 只在等待态 chat 命中，不影响普通消息/命令/配对流程。
  if (text && deps.questionBridge?.tryConsumeFreeText(chatId, text)) {
    return
  }
  if (text && deps.configCard?.tryConsumeCwdInput(chatId, text)) {
    return
  }

  // 未授权 → 尝试配对
  if (!deps.pairing.isPaired(senderOpenId, deps.allowedUsers)) {
    if (text) {
      const ok = deps.pairing.tryPair(text, { userId: senderOpenId, displayName: 'Feishu User' }, deps.allowedUsers)
      if (ok) {
        deps.audit?.log({ event: 'pairing/success', detail: '配对成功', user: senderOpenId, chat: chatId })
        await deps.sendText(chatId, '✅ 配对成功！现在可以开始聊天了。\n\n直接发消息即可与 DSH 对话。', messageId)
      } else {
        deps.audit?.log({ event: 'pairing/failed', detail: '配对码无效或已过期', user: senderOpenId, chat: chatId })
        await deps.sendText(chatId, '🔒 未授权。配对码无效或已过期，请向 DSH 管理员获取有效配对码。', messageId)
      }
    } else {
      await deps.sendText(chatId, '🔒 未授权。请发送配对码完成配对。', messageId)
    }
    return
  }

  // 已授权：附件消息（图片/文件）→ 下载到工作区暂存 → 注入 AI
  if (payload.pendingDownloads.length > 0) {
    if (!deps.attachmentBridge) {
      // 无附件桥接（向后兼容）：维持"暂不支持"提示
      if (!text) {
        await deps.sendText(chatId, '📎 附件消息暂不支持，请发送文本消息。', messageId)
        return
      }
      await deps.sendText(chatId, '📎 附件消息暂不支持，已忽略附件，仅处理文本内容。', messageId)
    } else {
      const { sessionId, cwd } = await deps.bridge.ensureAgentForChat(chatId)
      const outcome = await deps.attachmentBridge.downloadAll({
        chatId,
        messageId,
        sessionId: String(sessionId),
        cwd,
        downloads: payload.pendingDownloads,
      })
      if (outcome.ok.length > 0) {
        const prompt = buildAttachmentPrompt(outcome.ok, text)
        await deps.bridge.handleUserMessage(chatId, prompt, messageId)
        return
      }
      // 全部下载失败：有文本则仍把文本交给 AI，否则不注入
      if (!text) return
    }
  }

  if (!text) return

  // 远程命令优先：命中命令则执行并回复，不进入 DSH 会话
  const command = parseCommand(text)
  if (command) {
    const commandDeps: CommandDeps = {
      bridge: deps.bridge,
      pairing: deps.pairing,
      allowedUsers: deps.allowedUsers,
      sendText: deps.sendText,
      sendConfigCard: deps.configCard
        ? (chatId) => deps.configCard!.sendConfigCard(chatId)
        : undefined,
      audit: deps.audit,
      logger: deps.logger,
      approvalMemory: deps.approvalMemory,
    }
    deps.audit?.log({
      event: 'command/executed',
      detail: `/${command.kind}${command.arg ? ` ${command.arg}` : ''}${command.configKey ? ` ${command.configKey}${command.configValue ? ` ${command.configValue}` : ''}` : ''}`,
      user: senderOpenId,
      chat: chatId,
    })
    await executeCommand(command, chatId, commandDeps, messageId)
    return
  }

  await deps.bridge.handleUserMessage(chatId, text, messageId)
}
