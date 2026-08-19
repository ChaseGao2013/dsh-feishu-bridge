/**
 * 远程命令体系（P4）：/help /status /new /clear /stop /projects（+ 中文别名）
 *
 * 命令在飞书消息进入 DSH agent 之前拦截（inbound.ts 分发），
 * 执行结果用文本回复；不消费 DSH 会话。
 *
 * 设计对齐 CChh adapters/feishu/index.ts 的命令集（MIT License,
 * Copyright (c) 2026 cc-haha；本文件为 DSH 侧重写）。
 */

import type { Bridge } from './bridge.js'
import type { PairingStore } from './pairing.js'
import type { AuditLog } from './audit.js'
import type { ApprovalMemoryStore } from './approval-memory.js'

// ---------------------------------------------------------------------------
// 命令解析
// ---------------------------------------------------------------------------

export type CommandKind = 'help' | 'status' | 'new' | 'clear' | 'stop' | 'projects' | 'config' | 'approval-memory'

export interface ParsedCommand {
  kind: CommandKind
  /** /new 的可选参数（工作目录路径）。 */
  arg?: string
  /** /config 的键值参数。 */
  configKey?: string
  configValue?: string
}

/** 无参数命令的别名表（key 大小写不敏感）。 */
const FLAG_COMMANDS: Record<string, CommandKind> = {
  '/help': 'help',
  '/status': 'status',
  '/clear': 'clear',
  '/stop': 'stop',
  '/projects': 'projects',
  '/config': 'config',
  '帮助': 'help',
  '状态': 'status',
  '清空': 'clear',
  '停止': 'stop',
  '项目列表': 'projects',
  '配置': 'config',
}

/** 带参数命令：/new [路径] 与 新会话 [路径]。 */
const NEW_COMMAND_RE = /^(\/new|\/新会话|新会话)(?:\s+(.+))?$/i

/** /config 命令：/config [键] [值]。 */
const CONFIG_COMMAND_RE = /^(\/config|配置)(?:\s+([^\s]+)(?:\s+(.+))?)?$/i

/** /approval-memory 命令：查看 / 清空审批记忆（永久允许）。 */
const MEMORY_COMMAND_RE = /^(\/approval-memory|审批记忆)(?:\s+([^\s]+))?$/i

/**
 * 解析一条用户文本是否为远程命令。非命令返回 null。
 * - 无参数命令：精确匹配（大小写不敏感）
 * - /new：支持可选路径参数（参数原样保留，不做大小写转换）
 * - /config：支持 [键] [值]（查看或修改远程配置）
 * - /approval-memory：支持 [clear]（查看或清空审批记忆）
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const flag = FLAG_COMMANDS[trimmed.toLowerCase()]
  if (flag) {
    if (flag === 'config') {
      // 精确匹配 /config 无参数
      return { kind: 'config' }
    }
    return { kind: flag }
  }

  const newMatch = NEW_COMMAND_RE.exec(trimmed)
  if (newMatch) {
    return { kind: 'new', ...(newMatch[2]?.trim() ? { arg: newMatch[2].trim() } : {}) }
  }

  const configMatch = CONFIG_COMMAND_RE.exec(trimmed)
  if (configMatch) {
    return {
      kind: 'config',
      ...(configMatch[2]?.trim() ? { configKey: configMatch[2].trim() } : {}),
      ...(configMatch[3]?.trim() ? { configValue: configMatch[3].trim() } : {}),
    }
  }

  const memoryMatch = MEMORY_COMMAND_RE.exec(trimmed)
  if (memoryMatch) {
    return {
      kind: 'approval-memory',
      ...(memoryMatch[2]?.trim() ? { arg: memoryMatch[2].trim() } : {}),
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// 命令执行
// ---------------------------------------------------------------------------

export interface CommandDeps {
  bridge: Bridge
  pairing: PairingStore
  allowedUsers?: readonly string[]
  sendText: (chatId: string, text: string, replyToMessageId?: string) => Promise<void>
  /** 可选：/config 无参数时发交互卡（按钮点选）。返回是否成功；失败降级为文本。 */
  sendConfigCard?: (chatId: string) => Promise<boolean>
  /** 审计日志（可选，P5）：配置变更落盘。 */
  audit?: AuditLog
  /** 审批记忆（方案 C）：/approval-memory 查看与清空。 */
  approvalMemory?: ApprovalMemoryStore
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void }
}

/** 完整命令帮助文本。 */
export function formatHelp(): string {
  return [
    '📖 **DSH 远程命令**',
    '',
    '`/help` 帮助 — 显示本列表',
    '`/status` 状态 — 查看会话与配对状态',
    '`/new <路径>` 新会话 — 重建会话（可指定工作目录）',
    '`/clear` 清空 — 清空当前会话上下文',
    '`/stop` 停止 — 中断正在进行的生成',
    '`/config` 配置 — 查看/修改远程配置（如权限预设、工作目录）',
    '`/projects` 项目列表 — 暂未支持',
    '`/approval-memory` 审批记忆 — 查看/清空「永久允许」记录（`/approval-memory clear`）',
    '',
    '中文别名：帮助 / 状态 / 新会话 / 清空 / 停止 / 配置 / 审批记忆',
  ].join('\n')
}

/** 执行一条已解析的命令，回复文本到 chat。 */
export async function executeCommand(
  cmd: ParsedCommand,
  chatId: string,
  deps: CommandDeps,
  replyToMessageId?: string,
): Promise<void> {
  switch (cmd.kind) {
    case 'help':
      await deps.sendText(chatId, formatHelp(), replyToMessageId)
      return

    case 'status':
      await deps.sendText(chatId, formatStatus(cmd, chatId, deps), replyToMessageId)
      return

    case 'new': {
      const { sessionId, cwd } = await deps.bridge.recreateSession(chatId, cmd.arg)
      deps.logger.info(`[feishu-bridge] /new: chat=${chatId} session=${String(sessionId)} cwd=${cwd}`)
      const target = cmd.arg?.trim() ? `**${cwd}**` : `默认目录 **${cwd}**`
      await deps.sendText(chatId, `✅ 已新建会话，工作目录：${target}\n\n直接发送消息即可开始对话。`, replyToMessageId)
      return
    }

    case 'clear': {
      await deps.bridge.recreateSession(chatId)
      await deps.sendText(chatId, '🧹 已清空当前会话上下文，新的对话将从头开始。', replyToMessageId)
      return
    }

    case 'stop': {
      const cancelled = deps.bridge.stop(chatId)
      if (cancelled) {
        await deps.sendText(chatId, '⏹ 已发送停止信号，正在中断当前生成…', replyToMessageId)
      } else {
        await deps.sendText(chatId, '⏹ 当前没有正在进行的生成。', replyToMessageId)
      }
      return
    }

    case 'projects': {
      await deps.sendText(
        chatId,
        '📁 项目列表暂未支持（后续版本提供）。\n'
        + '当前可用 `/new <绝对路径>` 直接指定工作目录新建会话。',
        replyToMessageId,
      )
      return
    }

    case 'config': {
      // 无参数：优先发交互卡（按钮点选权限预设/工作目录），发卡失败降级为文本
      if (cmd.configKey === undefined && deps.sendConfigCard) {
        const sent = await deps.sendConfigCard(chatId)
        if (sent) return
      }
      const result = deps.bridge.applyRuntimeConfig(cmd.configKey, cmd.configValue)
      if (cmd.configKey !== undefined && result.ok) {
        deps.audit?.log({
          event: 'config/changed',
          detail: `${cmd.configKey}=${cmd.configValue}（${result.message}）`,
          chat: chatId,
        })
      }
      await deps.sendText(chatId, result.message, replyToMessageId)
      return
    }

    case 'approval-memory': {
      if (!deps.approvalMemory) {
        await deps.sendText(chatId, '审批记忆未启用。', replyToMessageId)
        return
      }
      const arg = cmd.arg?.trim().toLowerCase()
      if (arg === 'clear') {
        deps.approvalMemory.clear()
        await deps.sendText(chatId, '🧹 已清空全部审批记忆（「永久允许」条目已全部撤销）。', replyToMessageId)
        return
      }
      const entries = deps.approvalMemory.load()
      if (entries.length === 0) {
        await deps.sendText(chatId, '🗂 审批记忆为空（尚无「永久允许」记录）。\n\n在审批卡上点「♾️ 永久允许」即可记录。', replyToMessageId)
        return
      }
      const lines: string[] = ['🗂 **审批记忆（永久允许）**', '',
        ...entries.map((entry) => `• \`${entry.toolName}\` — \`${entry.reasonKey}\`（${String(entry.createdAt ?? '').slice(0, 10)}）`),
        '', '撤销：`/approval-memory clear` 清空全部']
      await deps.sendText(chatId, lines.join('\n'), replyToMessageId)
      return
    }
  }
}

// ---------------------------------------------------------------------------
// /status 文本
// ---------------------------------------------------------------------------

function formatStatus(_cmd: ParsedCommand, chatId: string, deps: CommandDeps): string {
  const status = deps.bridge.status(chatId)
  const paired = deps.pairing.listPairedUsers().length
  const whitelisted = deps.allowedUsers?.length ?? 0
  const code = deps.pairing.currentCode()

  const lines: string[] = ['📊 **DSH 状态**', '']
  if (status.hasSession) {
    lines.push(
      `• 会话：\`${status.sessionId?.slice(0, 8)}…\``,
      `• 工作目录：\`${status.cwd ?? '-'}\``,
      `• Agent：${status.agentStatus === 'running' ? '🟡 运行中' : status.agentStatus === 'idle' ? '🟢 空闲' : '⚪ 无'}`,
      `• 流式卡片：${status.cardActive ? '🟢 活跃' : '⚪ 无'}`,
    )
  } else {
    lines.push(
      `• 会话：${status.sessionId ? `\`${status.sessionId.slice(0, 8)}…\`（已持久化，发送消息即恢复）` : '⚪ 无（发送消息将自动创建）'}`,
      `• 工作目录：\`${status.cwd ?? '-'}\``,
    )
  }
  lines.push(
    '',
    `• 已配对用户：**${paired} 人**${whitelisted > 0 ? `（另有白名单 ${whitelisted} 人）` : ''}`,
    `• 配对码：${code ? `\`${code}\`` : '（无，需管理员重新生成）'}`,
  )
  return lines.join('\n')
}
