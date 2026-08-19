/**
 * 远程会话配置认知注入（配置体验优化，2026-08-18）
 *
 * 背景：用户反馈——本地 AI 不知道插件已有 `/config` 远程配置命令，用户说
 * "配置"时 AI 绕一大圈一步步问插件配置，且无法对应到真正的权限配置项。
 *
 * 方案：在远程 agent 装配时（与 ask_user_question 飞书版同一步骤）往
 * agent 的 systemPrompt 注册一个引导 section（agent scope 层，仅远程会话
 * 可见，GUI 会话不受影响）。内容让 AI 知道：
 * - 会话由飞书桥接，用户在飞书端直接输入斜杠命令
 * - /config 是配置的权威入口（查看/修改权限预设、工作目录），AI 不要自创
 *   配置项、不要长链提问，直接引导用户发 /config
 * - /status /new /clear /stop 等会话命令的存在
 *
 * SystemPrompt registry 与 tools 同为 ScopedLayers（scope-aware），
 * agentCtx.systemPrompt.section() 注册进 agent 自己的层。
 */

export interface RemoteGuidanceDeps {
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void }
}

/** agentCtx.systemPrompt 的最小使用面。 */
export interface RemoteSystemPromptService {
  section(section: {
    name: string
    order: number
    text: string
  }): () => void
}

const SECTION_NAME = 'feishu-bridge:remote-controls'

/** 注入给远程会话 AI 的引导文本。 */
export function buildRemoteGuidanceText(): string {
  return [
    'You are being operated through the Feishu (飞书) remote bridge: the user messages you from a mobile Feishu chat.',
    '',
    'Feishu chat commands exist for session and configuration control. The USER types them directly in the Feishu chat (they are NOT tools you can call):',
    '- `/config` — view remote configuration as an interactive card with buttons; `/config <key> <value>` changes it directly (e.g. `/config remotePermissionPreset workspace-write`, `/config sessionCwd /path/to/workspace`). Keys: `remotePermissionPreset` (read-only/workspace-write/danger-full-access or a custom preset), `sessionCwd`.',
    '- `/status` — session status; `/new` — new session (optionally `/new <cwd>`); `/clear` — reset session; `/stop` — interrupt the current generation.',
    '',
    'When the user asks to view or change configuration or settings, do NOT invent configuration items, do NOT guess values, and do NOT walk them through a long chain of questions. Instead: tell the user to run `/config` (or the specific `/config <key> <value>` command) in the Feishu chat and wait for its output. You may ask at most ONE short clarifying question about what they want to change before referring them to `/config`.',
    '',
    'When you need the user to make a choice, confirm something, or provide missing information, you MUST call the `ask_user_question` tool — it renders an interactive card with tappable buttons on the user\'s Feishu screen. Never ask such questions as plain text; plain-text questions leave the remote user with no way to answer properly.',
    '',
    'When you produced, downloaded, or found a file the user should receive, call the `send_file_to_feishu` tool with the file\'s absolute path — it uploads and delivers the file into the user\'s Feishu chat directly.',
  ].join('\n')
}

/**
 * 在 agent scope 注册远程控制引导 section。返回注册 disposer；
 * agentCtx 无 systemPrompt 服务时静默跳过（不阻断装配）。
 */
export function registerRemoteGuidance(agentCtx: unknown, deps: RemoteGuidanceDeps): () => void {
  const systemPrompt = (agentCtx as { systemPrompt?: RemoteSystemPromptService }).systemPrompt
  if (systemPrompt === undefined) {
    deps.logger.warn('[feishu-bridge] agentCtx 无 systemPrompt 服务，跳过远程控制引导注入')
    return () => {}
  }
  try {
    return systemPrompt.section({
      name: SECTION_NAME,
      // 工具引导（100-199）之后、其它尾部 section 之前；不影响 persona（0）与 harness 身份（-100）
      order: 200,
      text: buildRemoteGuidanceText(),
    })
  } catch (err) {
    deps.logger.warn(`[feishu-bridge] 远程控制引导注入失败: ${String(err)}`)
    return () => {}
  }
}
