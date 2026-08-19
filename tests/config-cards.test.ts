/**
 * /config 交互卡单元测试
 *
 * 覆盖：卡片构建（预设按钮/当前值高亮/工作目录按钮）、cfg-preset 点击应用、
 * cfg-cwd 进入等待态 → 文本消费为路径、超时退出、dispose、发卡失败。
 */

import { describe, it, expect, vi } from 'vitest'
import { ConfigCardService, buildConfigCard } from '../src/config-cards.js'

function makeDeps(overrides: Record<string, unknown> = {}) {
  const sent: Array<{ chatId: string; card?: Record<string, unknown>; text?: string }> = []
  const api = {
    sendCard: vi.fn(async (chatId: string, card: Record<string, unknown>) => {
      sent.push({ chatId, card })
      return `card-${sent.length}`
    }),
    sendText: vi.fn(async (chatId: string, text: string) => {
      sent.push({ chatId, text })
    }),
    currentStatus: vi.fn(() => ({
      preset: 'workspace-write',
      cwd: '/workspace',
      availablePresets: ['read-only', 'workspace-write', 'auto', 'danger-full-access'],
    })),
    applyPreset: vi.fn(async (_chatId: string, preset: string) => `✅ 权限预设已改为 \`${preset}\``),
    applyCwd: vi.fn(async (_chatId: string, cwd: string) => `✅ 已保存：\`sessioncwd\` = \`${cwd}\`（新会话生效）`),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  }
  return { sent, api }
}

/** 从卡片 body 找按钮 value。 */
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

describe('buildConfigCard', () => {
  it('渲染当前配置 + 预设按钮（当前值高亮）+ 工作目录按钮', () => {
    const card = buildConfigCard({
      preset: 'workspace-write',
      cwd: '/workspace',
      availablePresets: ['read-only', 'workspace-write', 'auto', 'danger-full-access'],
    })
    const json = JSON.stringify(card)
    expect(json).toContain('workspace-write')
    expect(json).toContain('/workspace')
    const preset = findButton(card, 'cfg-preset')!
    expect(preset.preset).toBe('read-only')
    const cwd = findButton(card, 'cfg-cwd')!
    expect(cwd.action).toBe('cfg-cwd')
    // 当前值按钮为 primary 且带 ✅
    expect(json).toContain('✅ workspace-write')
    expect(json).toContain('"type":"primary"')
  })

  it('无可用预设时给出兜底三预设', () => {
    const card = buildConfigCard({ preset: undefined, cwd: '/workspace', availablePresets: [] })
    const json = JSON.stringify(card)
    expect(json).toContain('read-only')
    expect(json).toContain('workspace-write')
    expect(json).toContain('danger-full-access')
  })
})

describe('ConfigCardService', () => {
  it('sendConfigCard 发卡并返回 true；失败返回 false', async () => {
    const { api } = makeDeps()
    const service = new ConfigCardService(api)
    expect(await service.sendConfigCard('chat-1')).toBe(true)
    expect(api.sendCard).toHaveBeenCalledWith('chat-1', expect.objectContaining({ schema: '2.0' }))

    api.sendCard.mockResolvedValue(undefined)
    expect(await service.sendConfigCard('chat-1')).toBe(false)
  })

  it('cfg-preset 点击：应用预设并回 toast + 确认文本', async () => {
    const { api, sent } = makeDeps()
    const service = new ConfigCardService(api)
    const toast = await service.handleCardAction({
      action: { value: { action: 'cfg-preset', preset: 'read-only' } },
      context: { open_chat_id: 'chat-1' },
    })
    expect(toast).toMatchObject({ toast: { type: 'info' } })
    expect(api.applyPreset).toHaveBeenCalledWith('chat-1', 'read-only')
    expect(sent.some(s => s.text?.includes('read-only'))).toBe(true)
  })

  it('cfg-preset 无 chat 定位 → warning toast 不应用', async () => {
    const { api } = makeDeps()
    const service = new ConfigCardService(api)
    const toast = await service.handleCardAction({ action: { value: { action: 'cfg-preset', preset: 'read-only' } } })
    expect(toast).toMatchObject({ toast: { type: 'warning' } })
    expect(api.applyPreset).not.toHaveBeenCalled()
  })

  it('cfg-cwd：进入等待态 → 文本消费为新路径并应用', async () => {
    const { api, sent } = makeDeps()
    const service = new ConfigCardService(api)
    await service.handleCardAction({
      action: { value: { action: 'cfg-cwd' } },
      context: { open_chat_id: 'chat-1' },
    })
    expect(api.sendText).toHaveBeenCalledWith('chat-1', expect.stringContaining('工作目录'))
    expect(service.waitingCount()).toBe(1)

    expect(service.tryConsumeCwdInput('chat-1', '/work')).toBe(true)
    expect(api.applyCwd).toHaveBeenCalledWith('chat-1', '/work')
    expect(service.waitingCount()).toBe(0)
    // 消费后不再命中
    expect(service.tryConsumeCwdInput('chat-1', '/x')).toBe(false)
  })

  it('其他 chat 的文本不消费', async () => {
    const { api } = makeDeps()
    const service = new ConfigCardService(api)
    await service.handleCardAction({ action: { value: { action: 'cfg-cwd' } }, context: { open_chat_id: 'chat-1' } })
    expect(service.tryConsumeCwdInput('chat-2', '/x')).toBe(false)
    expect(service.tryConsumeCwdInput('chat-1', '/y')).toBe(true)
  })

  it('等待输入超时自动退出并提示', async () => {
    const { api, sent } = makeDeps()
    const service = new ConfigCardService(api, { timeoutMs: 30 })
    await service.handleCardAction({ action: { value: { action: 'cfg-cwd' } }, context: { open_chat_id: 'chat-1' } })
    await new Promise(r => setTimeout(r, 60))
    expect(service.waitingCount()).toBe(0)
    expect(sent.some(s => s.text?.includes('超时'))).toBe(true)
  })

  it('非配置卡回调返回 undefined（不干扰其他卡）', async () => {
    const { api } = makeDeps()
    const service = new ConfigCardService(api)
    const toast = await service.handleCardAction({ action: { value: { action: 'qanswer', token: 'x' } } })
    expect(toast).toBeUndefined()
  })

  it('dispose 清空等待态', async () => {
    const { api } = makeDeps()
    const service = new ConfigCardService(api)
    await service.handleCardAction({ action: { value: { action: 'cfg-cwd' } }, context: { open_chat_id: 'chat-1' } })
    service.dispose()
    expect(service.waitingCount()).toBe(0)
  })
})
