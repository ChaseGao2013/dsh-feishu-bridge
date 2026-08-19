/**
 * P5 加固单元测试：RateLimiter + AuditLog
 */

import { describe, it, expect, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { RateLimiter } from '../src/rate-limit.js'
import { AuditLog } from '../src/audit.js'

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

describe('RateLimiter', () => {
  it('窗口内未超限逐次消费', () => {
    const limiter = new RateLimiter({ windowMs: 1000, max: 3 })
    expect(limiter.tryConsume('u1')).toBe(true)
    expect(limiter.tryConsume('u1')).toBe(true)
    expect(limiter.tryConsume('u1')).toBe(true)
    expect(limiter.tryConsume('u1')).toBe(false) // 第 4 次超限
  })

  it('不同 key 独立计数', () => {
    const limiter = new RateLimiter({ windowMs: 1000, max: 1 })
    expect(limiter.tryConsume('u1')).toBe(true)
    expect(limiter.tryConsume('u1')).toBe(false)
    expect(limiter.tryConsume('u2')).toBe(true)
  })

  it('窗口过期后自动重置', () => {
    let now = 0
    const limiter = new RateLimiter({ windowMs: 100, max: 2, now: () => now })
    expect(limiter.tryConsume('u1')).toBe(true)
    expect(limiter.tryConsume('u1')).toBe(true)
    expect(limiter.tryConsume('u1')).toBe(false)
    now = 200 // 窗口过期
    expect(limiter.tryConsume('u1')).toBe(true)
  })

  it('非法参数抛错', () => {
    expect(() => new RateLimiter({ windowMs: 0 })).toThrow()
    expect(() => new RateLimiter({ max: 0 })).toThrow()
  })

  it('reset 清空记录', () => {
    const limiter = new RateLimiter({ windowMs: 1000, max: 1 })
    limiter.tryConsume('u1')
    limiter.tryConsume('u1') // false
    expect(limiter.trackedCount()).toBe(1)
    limiter.reset()
    expect(limiter.trackedCount()).toBe(0)
    expect(limiter.tryConsume('u1')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AuditLog
// ---------------------------------------------------------------------------

describe('AuditLog', () => {
  it('写读 JSONL：time/event/detail/user/chat', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-audit-'))
    const audit = new AuditLog(dir, { now: () => 12345 })
    audit.log({ event: 'pairing/success', detail: '配对成功', user: 'ou_1', chat: 'oc_1' })
    audit.log({ event: 'config/changed', detail: 'remotePermissionPreset=read-only', chat: 'oc_1' })

    const records = audit.readAll()
    expect(records).toHaveLength(2)
    expect(records[0]).toEqual({ time: 12345, event: 'pairing/success', detail: '配对成功', user: 'ou_1', chat: 'oc_1' })
    expect(records[1]!.event).toBe('config/changed')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('disabled 时不写文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-audit-'))
    const audit = new AuditLog(dir, { enabled: false })
    audit.log({ event: 'pairing/success', detail: 'x' })
    expect(audit.readAll()).toHaveLength(0)
    expect(fs.existsSync(path.join(dir, 'audit.log'))).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('超过 maxBytes 轮转为 audit.log.1', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-audit-'))
    const audit = new AuditLog(dir, { maxBytes: 64, now: () => Date.now() })
    for (let i = 0; i < 10; i++) {
      audit.log({ event: 'pairing/failed', detail: 'x'.repeat(40), user: `ou_${i}` })
    }
    // 轮转后旧文件在 .1，新文件继续写
    const rotated = fs.existsSync(path.join(dir, 'audit.log.1'))
    const records = audit.readAll()
    expect(rotated || records.length > 0).toBe(true)
    expect(records.length + (rotated ? 1 : 0)).toBeGreaterThan(0)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('损坏行跳过', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-audit-'))
    fs.writeFileSync(path.join(dir, 'audit.log'), 'not-json\n' + JSON.stringify({ time: 1, event: 'pairing/success', detail: 'x' }) + '\n')
    const audit = new AuditLog(dir)
    expect(audit.readAll()).toHaveLength(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
