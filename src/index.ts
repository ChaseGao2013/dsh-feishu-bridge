/**
 * dsh-feishu-bridge — 飞书 IM 桥接插件（P1 MVP：文本往返 + 流式卡；P2：审批卡片）
 *
 * 启动流程：
 * 1. 读取 Cordis config（appId/appSecret/配对码/允许用户等）；留空则跳过连接
 * 2. 初始化配对存储并确保配对码（打印到日志，飞书私聊发码即配对）
 * 3. 创建 Lark Client + Bridge（DSH 会话桥接）+ EventDispatcher + WSClient 长连接
 * 4. 订阅 im.message.receive_v1（文本往返）与 card.action.trigger（审批卡应答）
 * 5. ApprovalCardService 监听 approval/request，把 DSH 权限请求转成飞书三按钮卡
 *
 * teardown：Cordis 卸载时关闭 WS 连接、摘除订阅、收尾卡片、dispose 本插件创建的 agent。
 */

import * as os from 'node:os'
import * as path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import * as Lark from '@larksuiteoapi/node-sdk'
import { Bridge } from './bridge.js'
import { MessageDedup } from './dedup.js'
import { handleInboundMessage, type InboundMessageEvent } from './inbound.js'
import { PairingStore } from './pairing.js'
import { ApprovalCardService, type CardActionEvent } from './approval-cards.js'
import { AttachmentBridge } from './attachment-bridge.js'
import { ConfigCardService, type ConfigCardActionEvent } from './config-cards.js'
import { QuestionBridge } from './question-bridge.js'
import { AttachmentStore } from './feishu/attachment/attachment-store.js'
import { FeishuMediaService } from './feishu/media.js'
import { registerRemoteAskTool } from './remote-ask-tool.js'
import { registerRemoteGuidance } from './remote-guidance.js'
import { registerSendFileTool } from './remote-send-file.js'
import { AuditLog } from './audit.js'
import { RateLimiter } from './rate-limit.js'
import { RuntimeConfigStore } from './runtime-config.js'
import { ApprovalMemoryStore } from './approval-memory.js'

export const name = 'dsh-feishu-bridge'

/** 最小 workspaceRegistry 服务面（与 @deepseek-ai/dsh-workspace 的 WorkspaceRegistry 结构兼容）。 */
interface MinimalWorkspace {
  attachSession(sessionId: unknown): Promise<void>
}
interface MinimalWorkspaceRegistry {
  resolveByPath(path: string): Promise<MinimalWorkspace | undefined>
  create(path: string): Promise<MinimalWorkspace>
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceRegistry: MinimalWorkspaceRegistry
    /** agent-presets 服务（dsh-agent-presets 提供）：resolve/mount 把预设装配进 agent 作用域。 */
    agentPresets: MinimalAgentPresets
    /** permission-presets 服务（dsh-permission-presets 提供）：切换会话权限预设。 */
    permissionPresets: MinimalPermissionPresets
  }
}

/** 最小 agentPresets 服务面（与 @deepseek-ai/dsh-agent-presets 的 AgentPresetService 结构兼容）。 */
interface MinimalAgentPresets {
  resolve(id?: string): Promise<{ id: string }>
  mount(agentCtx: unknown, id?: string): Promise<{ id: string }>
}

/** 最小 permissionPresets 服务面（与 @deepseek-ai/dsh-permission-presets 的 PermissionPresetService 结构兼容）。 */
interface MinimalPermissionPresets {
  set(session: { events: unknown }, name: string): void
  /** DSH 运行时已注册的预设名（含用户自定义，如 auto）。 */
  readonly names?: readonly string[]
}

/** 依赖的 Cordis service：agents 由 dsh-agent 提供，agentDefaultModel 由 dsh-base 提供，workspaceRegistry 由 dsh-workspace 提供，agentPresets 由 dsh-agent-presets 提供，permissionPresets 由 dsh-permission-presets 提供；均需声明注入方可读取。 */
export const inject = ['agents', 'agentDefaultModel', 'workspaceRegistry', 'agentPresets', 'permissionPresets']

/** 插件配置。字段留空则使用默认值或跳过连接（App ID/Secret 在飞书开放平台创建应用获得）。 */
export interface BridgeConfig {
  /** 飞书开放平台应用 App ID（必填，否则跳过连接）。 */
  appId?: string
  /** 飞书开放平台应用 App Secret（必填，否则跳过连接）。 */
  appSecret?: string
  /** 事件加密 key（EventDispatcher 用；WS 模式下可选）。 */
  encryptKey?: string
  /** 事件校验 token（EventDispatcher 用；WS 模式下可选）。 */
  verificationToken?: string
  /** 预置配对码（留空则启动时自动生成并打印到日志）。 */
  pairingCode?: string
  /** 允许用户 open_id 白名单（命中直接放行，与配对并集）。 */
  allowedUsers?: string[]
  /** DSH 会话工作目录（SessionHeader.cwd，创建时固化）。默认用户主目录。 */
  sessionCwd?: string
  /** 状态目录（配对码/会话映射持久化）。默认 $DSH_HOME/feishu-bridge。 */
  stateDir?: string
  /** 新建 DSH 会话的 provider（缺省读 ctx.agentDefaultModel，再兜底 deepseek-official）。 */
  defaultProvider?: string
  /** 新建 DSH 会话的 model（缺省读 ctx.agentDefaultModel，再兜底 deepseek-v4-flash）。 */
  defaultModel?: string
  /** 新建 DSH 会话的 reasoningEffort（可选）。 */
  defaultReasoningEffort?: string
  /** 新建 DSH 会话的 agent preset（工具装配；缺省 standard，与 GUI 会话一致）。 */
  agentPreset?: string
  /** 远程会话权限预设（缺省 workspace-write：工作区内自由、工作区外审批卡；可换 read-only / danger-full-access）。 */
  remotePermissionPreset?: string
  /** 审批卡挂起超时（秒）。默认 300（5 分钟），超时自动拒绝。 */
  approvalTimeoutSeconds?: number
  /** 远程提问卡挂起超时（秒）。默认 600（10 分钟），超时自动取消。 */
  questionTimeoutSeconds?: number
  /** 入站消息限流窗口（秒）。默认 30；0 或负数关闭限流。 */
  rateLimitWindowSeconds?: number
  /** 入站消息限流窗口内最大消息数。默认 10。 */
  rateLimitMaxMessages?: number
  /** 审计日志开关。默认 true（落盘 stateDir/audit.log）。 */
  auditEnabled?: boolean
}

function resolveHome(): string {
  const env = process.env.DSH_HOME?.trim()
  return env && env.length > 0 ? env : path.join(os.homedir(), '.dsh')
}

export function apply(ctx: Context, config: BridgeConfig = {}): void {
  const appId = config.appId?.trim() ?? ''
  const appSecret = config.appSecret?.trim() ?? ''

  if (!appId || !appSecret) {
    ctx.logger.warn(
      '[dsh-feishu-bridge] appId/appSecret 未配置，跳过飞书连接。'
      + '请在 web profile 的 cordis.patch.yml 的 dsh-feishu-bridge 条目配置后重启 dsh web。',
    )
    return
  }

  const stateDir = config.stateDir?.trim() || path.join(resolveHome(), 'feishu-bridge')
  const sessionCwd = config.sessionCwd?.trim() || os.homedir()

  // ---- P5 加固：审计日志 + 入站消息限流 ----
  const audit = new AuditLog(stateDir, { enabled: config.auditEnabled ?? true })
  const rateLimitWindowMs = Number.isFinite(config.rateLimitWindowSeconds) && (config.rateLimitWindowSeconds ?? 0) > 0
    ? Math.round(config.rateLimitWindowSeconds! * 1000)
    : undefined
  const rateLimiter = rateLimitWindowMs === undefined
    ? undefined
    : new RateLimiter({ windowMs: rateLimitWindowMs, max: config.rateLimitMaxMessages ?? 10 })

  // ---- 配对 ----
  const pairing = new PairingStore(stateDir)
  const pairingCode = pairing.ensureCode(config.pairingCode)
  ctx.logger.info(
    `[dsh-feishu-bridge] 配对码：${pairingCode}（有效期 60 分钟，一次性；`
    + `在飞书私聊中发送该码完成配对。已配对用户：${pairing.listPairedUsers().length} 人）`,
  )
  ctx.logger.info(`[dsh-feishu-bridge] 状态目录：${stateDir}；DSH 会话工作目录：${sessionCwd}`)

  // ---- Lark 客户端 ----
  const larkClient = new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
  })

  const sendText = async (chatId: string, text: string, replyToMessageId?: string): Promise<void> => {
    const content = JSON.stringify({
      zh_cn: { content: [[{ tag: 'md', text }]] },
    })
    try {
      if (replyToMessageId) {
        await larkClient.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content, msg_type: 'post' },
        })
        return
      }
      await larkClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'post', content },
      })
    } catch (err) {
      ctx.logger.error(`[feishu-bridge] 发送文本失败: ${String(err)}`)
    }
  }

  // ---- DSH 会话桥接 ----
  // 默认模型解析优先级：插件配置 defaultProvider/defaultModel → ctx.agentDefaultModel 服务 → 兜底 deepseek-official/deepseek-v4-flash
  const explicitProvider = config.defaultProvider?.trim() ?? ''
  const explicitModel = config.defaultModel?.trim() ?? ''
  let defaultSelection: { provider: string; model: string; reasoningEffort?: string }
  if (explicitProvider && explicitModel) {
    defaultSelection = {
      provider: explicitProvider,
      model: explicitModel,
      ...(config.defaultReasoningEffort?.trim() ? { reasoningEffort: config.defaultReasoningEffort.trim() } : {}),
    }
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = (ctx as any).agentDefaultModel as { currentSelection?: () => { provider: string; model: string; reasoningEffort?: string } } | undefined
    const selection = svc?.currentSelection?.()
    defaultSelection = selection && selection.provider && selection.model
      ? selection
      : { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  }

  // 运行时配置（/config 命令可远程改；优先级高于 cordis.patch.yml 的静态配置）
  const runtimeConfig = new RuntimeConfigStore(stateDir)
  const runtimeCfg = runtimeConfig.load()
  const effectiveCwd = runtimeCfg.sessionCwd?.trim() || sessionCwd
  const effectivePreset = runtimeCfg.remotePermissionPreset?.trim() || config.remotePermissionPreset?.trim() || 'workspace-write'

  // ---- 远程提问通道（P2.5）：ask_user_question → 飞书交互卡 → 应答回传 ----
  const questionTimeoutMs =
    Number.isFinite(config.questionTimeoutSeconds) && (config.questionTimeoutSeconds ?? 0) > 0
      ? Math.round(config.questionTimeoutSeconds! * 1000)
      : undefined
  const questionBridge = new QuestionBridge(
    {
      sendCard: async (chatId, card) => {
        try {
          const resp = await larkClient.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'interactive',
              content: JSON.stringify(card),
            },
          })
          return resp.data?.message_id
        } catch (err) {
          ctx.logger.error(`[feishu-bridge] 提问卡发送失败: ${String(err)}`)
          return undefined
        }
      },
      sendText: (chatId, text) => sendText(chatId, text),
      logger: ctx.logger,
    },
    questionTimeoutMs === undefined ? {} : { timeoutMs: questionTimeoutMs },
  )

  // ---- 照搬层媒体服务（附件接收下载 + 发送文件共用）----
  const feishuMedia = new FeishuMediaService(larkClient, new AttachmentStore())

  const bridge = new Bridge({
    defaultCwd: effectiveCwd,
    stateDir,
    agents: ctx.agents,
    logger: ctx.logger,
    larkClient,
    sendText: (chatId, text) => sendText(chatId, text),
    agentOptions: defaultSelection,
    agentPreset: config.agentPreset?.trim() || 'standard',
    remotePermissionPreset: effectivePreset,
    workspaceRegistry: ctx.workspaceRegistry,
    agentPresets: ctx.agentPresets,
    permissionPresets: ctx.permissionPresets,
    runtimeConfig,
    // 远程会话装配：注册同名 ask_user_question（agent scope shadow preset 层）
    // + send_file_to_feishu（AI 把文件发回飞书）+ 注入远程控制/配置命令认知
    registerRemoteTools: (agentCtx: unknown) => {
      registerRemoteAskTool(agentCtx, {
        chatIdOfAgent: (agentId) => bridge.chatIdOf(agentId),
        questionBridge,
        logger: ctx.logger,
      })
      registerSendFileTool(agentCtx, {
        media: feishuMedia,
        chatIdOfAgent: (agentId) => bridge.chatIdOf(agentId),
        audit,
        logger: ctx.logger,
      })
      registerRemoteGuidance(agentCtx, { logger: ctx.logger })
    },
  })
  bridge.attach(ctx)

  // ---- 审批卡片（P2）：approval/request → 飞书三按钮卡 → card.action.trigger 应答 ----
  const approvalTimeoutMs =
    Number.isFinite(config.approvalTimeoutSeconds) && (config.approvalTimeoutSeconds ?? 0) > 0
      ? Math.round(config.approvalTimeoutSeconds! * 1000)
      : undefined
  const approvalService = new ApprovalCardService(
    {
      sendCard: async (chatId, card) => {
        try {
          const resp = await larkClient.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'interactive',
              content: JSON.stringify(card),
            },
          })
          return resp.data?.message_id
        } catch (err) {
          ctx.logger.error(`[feishu-bridge] 审批卡发送失败: ${String(err)}`)
          return undefined
        }
      },
      sendText: (chatId, text) => sendText(chatId, text),
      resolveChat: (sessionId) => bridge.chatIdOf(sessionId),
      audit,
      logger: ctx.logger,
      memory: new ApprovalMemoryStore(stateDir),
    },
    approvalTimeoutMs === undefined ? {} : { timeoutMs: approvalTimeoutMs },
  )
  approvalService.attach(ctx)

  // ---- /config 交互卡（配置体验优化二）：按钮点选权限预设/工作目录 ----
  const configCard = new ConfigCardService({
    sendCard: async (chatId, card) => {
      try {
        const resp = await larkClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: JSON.stringify(card),
          },
        })
        return resp.data?.message_id
      } catch (err) {
        ctx.logger.error(`[feishu-bridge] 配置卡发送失败: ${String(err)}`)
        return undefined
      }
    },
    sendText: (chatId, text) => sendText(chatId, text),
    currentStatus: () => {
      const runtimeCfg = runtimeConfig.load()
      const names = ctx.permissionPresets?.names
      return {
        preset: runtimeCfg.remotePermissionPreset?.trim() || undefined,
        cwd: runtimeCfg.sessionCwd?.trim() || effectiveCwd,
        availablePresets: names && names.length > 0 ? names : [],
      }
    },
    applyPreset: async (chatId, preset) => {
      const result = bridge.applyRuntimeConfig('remotePermissionPreset', preset)
      if (result.ok) {
        audit.log({ event: 'config/changed', detail: `remotePermissionPreset=${preset}（配置卡按钮）`, chat: chatId })
      }
      return result.message
    },
    applyCwd: async (chatId, cwd) => {
      const result = bridge.applyRuntimeConfig('sessionCwd', cwd)
      if (result.ok) {
        audit.log({ event: 'config/changed', detail: `sessionCwd=${cwd}（配置卡输入）`, chat: chatId })
      }
      return result.message
    },
    logger: ctx.logger,
  })

  // ---- 附件桥接（P3，飞书 → DSH）：图片/文件下载到工作区暂存 ----
  const attachmentBridge = new AttachmentBridge({
    media: feishuMedia,
    sendText: (chatId, text) => sendText(chatId, text),
    audit,
    logger: ctx.logger,
  })

  // ---- 入站分发 ----
  const dedup = new MessageDedup()
  const inboundDeps = {
    dedup,
    pairing,
    bridge,
    allowedUsers: config.allowedUsers,
    sendText,
    questionBridge,
    configCard,
    attachmentBridge,
    rateLimiter,
    audit,
    logger: ctx.logger,
    approvalMemory: new ApprovalMemoryStore(stateDir),
  }

  // ---- 飞书长连接 ----
  const dispatcher = new Lark.EventDispatcher({
    encryptKey: config.encryptKey,
    verificationToken: config.verificationToken,
  })
  dispatcher.register({
    'im.message.receive_v1': async (data: unknown) => {
      console.log('[FB-DEBUG] receive_v1 事件到达:', JSON.stringify(data).slice(0, 500))
      await handleInboundMessage(data as InboundMessageEvent, inboundDeps)
    },
    // 卡片按钮回调：先尝试提问卡应答（P2.5），再尝试配置卡应答，最后审批卡应答（P2）。
    'card.action.trigger': async (data: unknown) => {
      try {
        const questionToast = await questionBridge.handleCardAction(data as CardActionEvent)
        if (questionToast !== undefined) return questionToast
        const configToast = await configCard.handleCardAction(data as ConfigCardActionEvent)
        if (configToast !== undefined) return configToast
        return await approvalService.handleCardAction(data as CardActionEvent)
      } catch (err) {
        ctx.logger.error(`[feishu-bridge] card.action.trigger 处理失败: ${String(err)}`)
        return undefined
      }
    },
  } as never)

  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.info,
  })
  void wsClient.start({ eventDispatcher: dispatcher })
    .then(() => {
      ctx.logger.info('[dsh-feishu-bridge] 飞书 WS 长连接已建立，机器人上线。')
    })
    .catch((err: unknown) => {
      ctx.logger.error(`[dsh-feishu-bridge] 飞书 WS 连接失败（检查 App ID/Secret 与网络）：${String(err)}`)
    })

  // ---- teardown ----
  ctx.effect(() => () => {
    try { wsClient.close() } catch { /* 忽略 */ }
    questionBridge.dispose()
    configCard.dispose()
    void bridge.dispose().catch((err: unknown) => {
      ctx.logger.warn(`[dsh-feishu-bridge] teardown 收尾失败: ${String(err)}`)
    })
  }, 'dsh-feishu-bridge')
}
