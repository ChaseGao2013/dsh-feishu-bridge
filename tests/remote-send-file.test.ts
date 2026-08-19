/**
 * send_file_to_feishu 工具单元测试（P3 第二阶段）
 *
 * 覆盖：图片路径 → uploadImage + sendImageMessage；文件 → uploadFile +
 * sendFileMessage；路径不存在/超限/无 chat 归属/缺参数抛错；注册行为。
 */

import { describe, it, expect, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildSendFileTool, registerSendFileTool, type SendFileToolDeps } from '../src/remote-send-file.js'
import { IMAGE_LIMIT_BYTES, FILE_LIMIT_BYTES } from '../src/attachment-bridge.js'
import type { ToolDefinition } from '../src/remote-ask-tool.js'

function makeDeps(overrides: Partial<SendFileToolDeps['media']> = {}) {
  const media = {
    uploadImage: vi.fn(async () => 'img_key_1'),
    uploadFile: vi.fn(async () => 'file_key_1'),
    sendImageMessage: vi.fn(async () => {}),
    sendFileMessage: vi.fn(async () => {}),
    ...overrides,
  }
  const chatIdOfAgent = vi.fn(() => 'chat-1')
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const deps: SendFileToolDeps = { media, chatIdOfAgent, logger }
  return { media, chatIdOfAgent, logger, deps }
}

function makeExec(overrides: Record<string, unknown> = {}) {
  return {
    callId: 'c1',
    name: 'send_file_to_feishu',
    arguments: {},
    agent: { id: 'session-1' },
    signal: new AbortController().signal,
    ...overrides,
  } as never
}

describe('buildSendFileTool', () => {
  it('工具名/描述/参数 schema 正确', () => {
    const { deps } = makeDeps()
    const tool = buildSendFileTool(deps)
    expect(tool.name).toBe('send_file_to_feishu')
    expect(tool.description).toContain('Send a local file to the user\'s Feishu chat')
    expect(tool.parameters).toMatchObject({ type: 'object', required: ['path'] })
    expect(tool.output.schema).toMatchObject({ type: 'object', properties: { sent: { type: 'boolean' } } })
  })

  it('图片文件：uploadImage + sendImageMessage，返回 sent 结构', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-send-'))
    const imgPath = path.join(tmp, 'shot.png')
    fs.writeFileSync(imgPath, Buffer.from('fake-png'))
    const { media, deps } = makeDeps()
    const tool = buildSendFileTool(deps)
    const result = await tool.execute({ path: imgPath }, makeExec())
    expect(media.uploadImage).toHaveBeenCalledWith(expect.any(Buffer), 'image/png')
    expect(media.sendImageMessage).toHaveBeenCalledWith('chat-1', 'img_key_1')
    expect(media.uploadFile).not.toHaveBeenCalled()
    expect(result).toEqual({ sent: true, kind: 'image', name: 'shot.png' })
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('普通文件：uploadFile + sendFileMessage', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-send-'))
    const filePath = path.join(tmp, 'report.pdf')
    fs.writeFileSync(filePath, Buffer.from('%PDF-fake'))
    const { media, deps } = makeDeps()
    const tool = buildSendFileTool(deps)
    const result = await tool.execute({ path: filePath }, makeExec())
    expect(media.uploadFile).toHaveBeenCalledWith(expect.any(Buffer), 'report.pdf')
    expect(media.sendFileMessage).toHaveBeenCalledWith('chat-1', 'file_key_1')
    expect(result).toEqual({ sent: true, kind: 'file', name: 'report.pdf' })
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('路径不存在 → 抛错', async () => {
    const { media, deps } = makeDeps()
    const tool = buildSendFileTool(deps)
    await expect(tool.execute({ path: '/no/such/file.png' }, makeExec())).rejects.toThrow('无法读取文件')
    expect(media.uploadImage).not.toHaveBeenCalled()
  })

  it('缺 path 参数 → 抛错', async () => {
    const { deps } = makeDeps()
    const tool = buildSendFileTool(deps)
    await expect(tool.execute({}, makeExec())).rejects.toThrow('path 参数')
  })

  it('无 chat 归属（子代理）→ 抛错', async () => {
    const { deps } = makeDeps()
    const chatIdOfAgent = vi.fn(() => undefined)
    const tool = buildSendFileTool({ ...deps, chatIdOfAgent })
    await expect(tool.execute({ path: '/x.png' }, makeExec())).rejects.toThrow('飞书发送通道')
  })

  it('图片超限（>10MB）→ 抛错', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-send-'))
    const imgPath = path.join(tmp, 'big.png')
    fs.writeFileSync(imgPath, Buffer.alloc(IMAGE_LIMIT_BYTES + 1))
    const { media, deps } = makeDeps()
    const tool = buildSendFileTool(deps)
    await expect(tool.execute({ path: imgPath }, makeExec())).rejects.toThrow('超过大小限制')
    expect(media.uploadImage).not.toHaveBeenCalled()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('文件超限（>30MB）→ 抛错', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-send-'))
    const filePath = path.join(tmp, 'big.zip')
    fs.writeFileSync(filePath, Buffer.alloc(FILE_LIMIT_BYTES + 1))
    const { media, deps } = makeDeps()
    const tool = buildSendFileTool(deps)
    await expect(tool.execute({ path: filePath }, makeExec())).rejects.toThrow('超过大小限制')
    expect(media.uploadFile).not.toHaveBeenCalled()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('上传抛错 → 向上抛（agent 得 error result）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-send-'))
    const imgPath = path.join(tmp, 'a.png')
    fs.writeFileSync(imgPath, Buffer.from('x'))
    const { deps } = makeDeps({ uploadImage: vi.fn(async () => { throw new Error('upload denied') }) })
    const tool = buildSendFileTool(deps)
    await expect(tool.execute({ path: imgPath }, makeExec())).rejects.toThrow('upload denied')
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

describe('registerSendFileTool', () => {
  it('有 tools 服务时注册并返回 disposer', () => {
    const { deps } = makeDeps()
    const register = vi.fn(() => () => {})
    const disposer = registerSendFileTool({ tools: { register } }, deps)
    expect(register).toHaveBeenCalledTimes(1)
    expect((register.mock.calls[0]![0] as ToolDefinition).name).toBe('send_file_to_feishu')
    expect(typeof disposer).toBe('function')
  })

  it('无 tools 服务时静默跳过', () => {
    const { deps } = makeDeps()
    expect(typeof registerSendFileTool({}, deps)).toBe('function')
  })

  it('注册抛错被捕获并告警', () => {
    const { deps } = makeDeps()
    const register = vi.fn(() => { throw new Error('dup') })
    expect(typeof registerSendFileTool({ tools: { register } }, deps)).toBe('function')
    expect(deps.logger.warn).toHaveBeenCalled()
  })
})
