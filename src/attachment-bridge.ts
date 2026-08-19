/**
 * 附件桥接（P3，飞书 → DSH 方向）：下载飞书图片/文件到工作区内暂存目录，
 * 生成注入文本让 AI 处理（图片配合 vision_understand 识图）。
 *
 * 链路：im.message.receive_v1 → extractInboundPayload 得到 pendingDownloads
 * （fileKey/kind/name）→ 本服务用 FeishuMediaService.downloadResource 下载
 * （照搬层，Lark messageResource.get）→ 落盘到 `{会话cwd}/.feishu-attachments/
 * feishu/{sessionId}/{safeName}`（工作区内，AI 读写不触发审批）→ 生成注入文本。
 *
 * 限额（对齐 CChh）：图片 ≤10MB、文件 ≤30MB，超限拒绝并提示。
 * 暂存目录 24h 自动 GC（AttachmentStore 自带，下载时顺带触发）。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { AttachmentStore } from './feishu/attachment/attachment-store.js'
import type { PendingDownload } from './feishu/extract-payload.js'
import type { FeishuMediaService } from './feishu/media.js'
import type { AuditLog } from './audit.js'

/** 附件限额（字节）。对齐 CChh：图片 10MB、文件 30MB。 */
export const IMAGE_LIMIT_BYTES = 10 * 1024 * 1024
export const FILE_LIMIT_BYTES = 30 * 1024 * 1024

/** 暂存根目录名（放在会话工作目录下，AI 读写不触发审批）。 */
export const ATTACHMENT_DIR_NAME = '.feishu-attachments'

export interface AttachmentBridgeDeps {
  /** 照搬层媒体服务（下载/上传/发送）。 */
  media: FeishuMediaService
  /** 普通文本消息（下载失败/超限提示）。 */
  sendText: (chatId: string, text: string) => Promise<void>
  /** 审计日志（可选，P5）：附件下载落盘。 */
  audit?: AuditLog
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void }
}

export interface DownloadOutcome {
  /** 成功下载的附件。 */
  ok: LocalAttachmentLike[]
  /** 被拒绝的附件（超限/失败），已向用户发提示。 */
  rejected: number
}

export interface LocalAttachmentLike {
  kind: 'image' | 'file'
  name: string
  path: string
  size: number
  mimeType: string
}

/** 一次消息内的下载任务。 */
export interface DownloadTask {
  chatId: string
  messageId: string
  sessionId: string
  /** 会话工作目录（附件落盘根）。 */
  cwd: string
  downloads: PendingDownload[]
}

/** 注入给 AI 的附件描述文本（图片用 vision_understand 引导）。 */
export function buildAttachmentPrompt(
  attachments: LocalAttachmentLike[],
  userText: string,
): string {
  const lines: string[] = []
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      lines.push(
        `用户通过飞书发送了一张图片，已保存到 \`${attachment.path}\`（${formatSize(attachment.size)}）。`,
        '请用 vision_understand 工具识别这张图片（传入上面的绝对路径），并把内容/结论回复给用户。',
      )
    } else {
      lines.push(
        `用户通过飞书发送了文件 \`${attachment.name}\`，已保存到 \`${attachment.path}\`（${formatSize(attachment.size)}）。`,
        '请按需读取该文件并回复用户。',
      )
    }
  }
  if (userText.trim()) {
    lines.push('', `用户附带的消息：${userText.trim()}`)
  }
  return lines.join('\n')
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 附件下载桥接：把 pendingDownloads 下载到会话工作区暂存目录。
 * 每个 chat 的暂存根 = `{cwd}/.feishu-attachments`（工作区内，AI 可自由读写）。
 */
export class AttachmentBridge {
  constructor(private readonly deps: AttachmentBridgeDeps) {}

  /**
   * 下载一条消息的所有附件。逐个处理：超限/失败拒绝并提示用户，
   * 成功者返回 LocalAttachmentLike 列表供生成注入文本。
   */
  async downloadAll(task: DownloadTask): Promise<DownloadOutcome> {
    const outcomes: DownloadOutcome = { ok: [], rejected: 0 }
    const store = new AttachmentStore({ root: path.join(task.cwd, ATTACHMENT_DIR_NAME) })
    for (const pending of task.downloads) {
      try {
        const attachment = await this.downloadOne(store, task, pending)
        outcomes.ok.push({
          kind: attachment.kind,
          name: attachment.name,
          path: attachment.path,
          size: attachment.size,
          mimeType: attachment.mimeType,
        })
        this.deps.audit?.log({
          event: 'attachment/downloaded',
          detail: `${attachment.kind} ${attachment.name} (${formatSize(attachment.size)}) → ${attachment.path}`,
          chat: task.chatId,
        })
      } catch (err) {
        outcomes.rejected += 1
        const reason = String((err as Error).message ?? err)
        this.deps.logger.warn(`[feishu-bridge] 附件下载失败: ${reason}`)
        this.deps.audit?.log({
          event: 'attachment/rejected',
          detail: `${pending.kind} ${pending.fileName ?? pending.fileKey}: ${reason.slice(0, 200)}`,
          chat: task.chatId,
        })
        await this.deps.sendText(task.chatId, `⚠️ 附件 \`${pending.fileName ?? pending.fileKey}\` 下载失败：${reason.slice(0, 200)}`)
      }
    }
    // 顺带 GC 过期附件（24h 保留，fire-and-forget）
    void store.gc().catch(() => {})
    return outcomes
  }

  private async downloadOne(
    store: AttachmentStore,
    task: DownloadTask,
    pending: PendingDownload,
  ): Promise<LocalAttachmentLike & { kind: 'image' | 'file' }> {
    const limit = pending.kind === 'image' ? IMAGE_LIMIT_BYTES : FILE_LIMIT_BYTES
    const attachment = await this.deps.media.downloadResource({
      messageId: task.messageId,
      fileKey: pending.fileKey,
      kind: pending.kind,
      fileName: pending.fileName,
      sessionId: task.sessionId,
    })
    if (attachment.size > limit) {
      // 超限：删掉刚落盘的文件，拒绝
      try { await fs.unlink(attachment.path) } catch { /* 忽略 */ }
      throw new Error(
        `超过大小限制（${pending.kind === 'image' ? '图片' : '文件'}上限 ${formatSize(limit)}，实际 ${formatSize(attachment.size)}）`,
      )
    }
    this.deps.logger.info(
      `[feishu-bridge] 附件已下载: ${pending.kind} ${attachment.name} (${formatSize(attachment.size)}) → ${attachment.path}`,
    )
    return attachment
  }
}
