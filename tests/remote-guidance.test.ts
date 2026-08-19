/**
 * 远程控制引导注入单元测试（配置体验优化）
 *
 * 覆盖：引导文本内容要点、注册行为（有/无 systemPrompt 服务、抛错兜底）。
 */

import { describe, it, expect, vi } from 'vitest'
import { buildRemoteGuidanceText, registerRemoteGuidance } from '../src/remote-guidance.js'

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe('buildRemoteGuidanceText', () => {
  it('包含 /config 用法与"不要自创配置项、不要长链提问"指令', () => {
    const text = buildRemoteGuidanceText()
    expect(text).toContain('/config')
    expect(text).toContain('remotePermissionPreset')
    expect(text).toContain('sessionCwd')
    expect(text).toContain('/status')
    expect(text).toContain('/new')
    expect(text).toContain('do NOT invent configuration items')
    expect(text).toContain('ONE short clarifying question')
  })

  it('强调提问必须调用 ask_user_question 工具（禁止纯文本提问）', () => {
    const text = buildRemoteGuidanceText()
    expect(text).toContain('MUST call the `ask_user_question` tool')
    expect(text).toContain('Never ask such questions as plain text')
  })

  it('引导发文件用 send_file_to_feishu 工具', () => {
    const text = buildRemoteGuidanceText()
    expect(text).toContain('`send_file_to_feishu` tool')
    expect(text).toContain('absolute path')
  })
})

describe('registerRemoteGuidance', () => {
  it('有 systemPrompt 服务时注册 section（名称/顺序/文本）并返回 disposer', () => {
    const logger = makeLogger()
    const section = vi.fn(() => () => {})
    const agentCtx = { systemPrompt: { section } }
    const disposer = registerRemoteGuidance(agentCtx, { logger })
    expect(section).toHaveBeenCalledTimes(1)
    const entry = section.mock.calls[0]![0] as { name: string; order: number; text: string }
    expect(entry.name).toBe('feishu-bridge:remote-controls')
    expect(entry.order).toBe(200)
    expect(entry.text).toContain('/config')
    expect(typeof disposer).toBe('function')
  })

  it('无 systemPrompt 服务时静默跳过', () => {
    const logger = makeLogger()
    const disposer = registerRemoteGuidance({}, { logger })
    expect(typeof disposer).toBe('function')
    expect(logger.warn).toHaveBeenCalled()
  })

  it('注册抛错被捕获并告警（不阻断装配）', () => {
    const logger = makeLogger()
    const section = vi.fn(() => { throw new Error('duplicate section') })
    const disposer = registerRemoteGuidance({ systemPrompt: { section } }, { logger })
    expect(typeof disposer).toBe('function')
    expect(logger.warn).toHaveBeenCalled()
  })
})
