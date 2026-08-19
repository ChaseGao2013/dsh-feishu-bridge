/**
 * 附件桥接单元测试（P3）
 *
 * 覆盖：buildAttachmentPrompt（图片 vision 引导/文件路径/附带文本）、
 * downloadAll（成功/超限删除/失败提示/多附件混合/GC 触发）。
 */

import { describe, it, expect, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AttachmentBridge, buildAttachmentPrompt, IMAGE_LIMIT_BYTES, FILE_LIMIT_BYTES } from '../src/attachment-bridge.js'

function makeDeps(overrides: Record<string, unknown> = {}) {
  const sent: string[] = []
  const api = {
    media: {
      downloadResource: vi.fn(),
    },
    sendText: vi.fn(async (chatId: string, text: string) => { sent.push(text) }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  }
  return { sent, api }
}

describe('buildAttachmentPrompt', () => {
  it('图片：绝对路径 + vision_understand 引导 + 附带文本', () => {
    const prompt = buildAttachmentPrompt(
      [{ kind: 'image', name: 'a.png', path: '/x/.feishu-attachments/feishu/s1/a.png', size: 2048, mimeType: 'image/png' }],
      '看看这个',
    )
    expect(prompt).toContain('/x/.feishu-attachments/feishu/s1/a.png')
    expect(prompt).toContain('vision_understand')
    expect(prompt).toContain('用户附带的消息：看看这个')
  })

  it('文件：名称/路径/大小 + 读取引导', () => {
    const prompt = buildAttachmentPrompt(
      [{ kind: 'file', name: 'data.json', path: '/x/.feishu-attachments/feishu/s1/data.json', size: 2 * 1024 * 1024, mimeType: 'application/json' }],
      '',
    )
    expect(prompt).toContain('data.json')
    expect(prompt).toContain('2.0 MB')
    expect(prompt).toContain('按需读取该文件')
    expect(prompt).not.toContain('用户附带的消息')
  })

  it('多附件逐个列出', () => {
    const prompt = buildAttachmentPrompt([
      { kind: 'image', name: 'a.png', path: 'p1', size: 1, mimeType: 'image/png' },
      { kind: 'file', name: 'b.txt', path: 'p2', size: 2, mimeType: 'text/plain' },
    ], '')
    expect(prompt).toContain('p1')
    expect(prompt).toContain('p2')
  })
})

describe('AttachmentBridge.downloadAll', () => {
  it('下载成功：落盘到 {cwd}/.feishu-attachments 并返回注入信息', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-attach-'))
    const { api } = makeDeps()
    api.media.downloadResource.mockResolvedValue({
      kind: 'image', name: 'shot.png', path: path.join(tmp, '.feishu-attachments', 'feishu', 's1', 'shot.png'),
      size: 1024, mimeType: 'image/png', buffer: Buffer.from('x'),
    })
    const bridge = new AttachmentBridge(api)
    const outcome = await bridge.downloadAll({
      chatId: 'chat-1', messageId: 'msg-1', sessionId: 's1', cwd: tmp,
      downloads: [{ kind: 'image', fileKey: 'img_x' }],
    })
    expect(outcome.ok).toHaveLength(1)
    expect(outcome.ok[0]).toMatchObject({ kind: 'image', path: path.join(tmp, '.feishu-attachments', 'feishu', 's1', 'shot.png') })
    expect(outcome.rejected).toBe(0)
    expect(api.media.downloadResource).toHaveBeenCalledWith({
      messageId: 'msg-1', fileKey: 'img_x', kind: 'image', fileName: undefined, sessionId: 's1',
    })
    // 暂存目录由 FeishuMediaService 内部 resolvePath 创建（mock 未走真实路径，不在此断言）
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('图片超限（>10MB）：删文件、拒绝、提示用户', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-attach-'))
    const bigPath = path.join(tmp, 'big.png')
    fs.writeFileSync(bigPath, Buffer.alloc(64))
    const { api, sent } = makeDeps()
    api.media.downloadResource.mockResolvedValue({
      kind: 'image', name: 'big.png', path: bigPath,
      size: IMAGE_LIMIT_BYTES + 1, mimeType: 'image/png', buffer: Buffer.alloc(0),
    })
    const bridge = new AttachmentBridge(api)
    const outcome = await bridge.downloadAll({
      chatId: 'chat-1', messageId: 'msg-1', sessionId: 's1', cwd: tmp,
      downloads: [{ kind: 'image', fileKey: 'img_big' }],
    })
    expect(outcome.ok).toHaveLength(0)
    expect(outcome.rejected).toBe(1)
    expect(sent[0]).toContain('超过大小限制')
    expect(sent[0]).toContain('10.0 MB')
    // 超限文件已删除
    expect(fs.existsSync(bigPath)).toBe(false)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('文件超限（>30MB）：拒绝', async () => {
    const { api, sent } = makeDeps()
    api.media.downloadResource.mockResolvedValue({
      kind: 'file', name: 'big.zip', path: '/x/big.zip',
      size: FILE_LIMIT_BYTES + 1, mimeType: 'application/zip', buffer: Buffer.alloc(0),
    })
    const bridge = new AttachmentBridge(api)
    const outcome = await bridge.downloadAll({
      chatId: 'chat-1', messageId: 'msg-1', sessionId: 's1', cwd: '/x',
      downloads: [{ kind: 'file', fileKey: 'f_big', fileName: 'big.zip' }],
    })
    expect(outcome.rejected).toBe(1)
    expect(sent[0]).toContain('30.0 MB')
  })

  it('下载失败（API 抛错）：拒绝并提示，不中断其他附件', async () => {
    const { api, sent } = makeDeps()
    api.media.downloadResource
      .mockRejectedValueOnce(new Error('resource gone'))
      .mockResolvedValueOnce({
        kind: 'file', name: 'ok.txt', path: '/x/ok.txt', size: 10, mimeType: 'text/plain', buffer: Buffer.from('ok'),
      })
    const bridge = new AttachmentBridge(api)
    const outcome = await bridge.downloadAll({
      chatId: 'chat-1', messageId: 'msg-1', sessionId: 's1', cwd: '/x',
      downloads: [
        { kind: 'file', fileKey: 'f_bad', fileName: 'bad.txt' },
        { kind: 'file', fileKey: 'f_ok', fileName: 'ok.txt' },
      ],
    })
    expect(outcome.ok).toHaveLength(1)
    expect(outcome.rejected).toBe(1)
    expect(sent[0]).toContain('bad.txt')
    expect(sent[0]).toContain('下载失败')
  })
})
