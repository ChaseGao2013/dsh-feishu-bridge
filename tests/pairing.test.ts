/**
 * 配对核心单元测试
 *
 * 覆盖：配对码生成、持久化读写、有效/失效/过期、一次性使用、
 * 速率限制、白名单并集、损坏文件容错。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CODE_LENGTH, CODE_TTL_MS, generatePairingCode, PairingStore } from '../src/pairing.js'

let dir: string
let now = 0

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-pairing-test-'))
  now = 1_000_000_000_000
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function makeStore(): PairingStore {
  return new PairingStore(dir, () => now)
}

describe('generatePairingCode', () => {
  it('生成 6 位安全字母表内的码', () => {
    const code = generatePairingCode()
    expect(code).toHaveLength(CODE_LENGTH)
    for (const ch of code) {
      expect('ABCDEFGHJKMNPQRSTUVWXYZ23456789').toContain(ch)
    }
  })

  it('多次生成不重复（概率性，但 6 位空间足够）', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generatePairingCode()))
    expect(codes.size).toBeGreaterThan(40)
  })
})

describe('PairingStore 持久化', () => {
  it('首次读取返回空状态（无文件）', () => {
    const store = makeStore()
    const file = store.read()
    expect(file.pairing.code).toBeNull()
    expect(file.pairedUsers).toEqual([])
  })

  it('ensureCode 生成并持久化；再次读取得到同一码', () => {
    const store = makeStore()
    const code = store.ensureCode()
    expect(code).toHaveLength(CODE_LENGTH)
    const store2 = makeStore()
    expect(store2.currentCode()).toBe(code)
  })

  it('ensureCode 幂等：已有未过期码时复用', () => {
    const store = makeStore()
    const code1 = store.ensureCode()
    const code2 = store.ensureCode()
    expect(code2).toBe(code1)
  })

  it('码过期后 ensureCode 重新生成', () => {
    const store = makeStore()
    const code1 = store.ensureCode()
    now += CODE_TTL_MS + 1
    const code2 = store.ensureCode()
    expect(code2).not.toBe(code1)
  })

  it('预置码优先且大写归一化', () => {
    const store = makeStore()
    const code = store.ensureCode('abc123')
    expect(code).toBe('ABC123')
  })

  it('损坏文件容错：改名留档并返回空状态', () => {
    fs.writeFileSync(path.join(dir, 'pairing.json'), '{not-json', 'utf-8')
    const store = makeStore()
    const file = store.read()
    expect(file.pairing.code).toBeNull()
    expect(fs.readdirSync(dir).some((f) => f.startsWith('pairing.json.corrupt-'))).toBe(true)
  })
})

describe('PairingStore 配对流程', () => {
  it('正确配对码 → 成功并一次性清除', () => {
    const store = makeStore()
    const code = store.ensureCode()
    expect(store.tryPair(code, { userId: 'u1', displayName: 'A' })).toBe(true)
    expect(store.isPaired('u1')).toBe(true)
    // 一次性：码已清，他人再发同一码失败
    expect(store.tryPair(code, { userId: 'u2', displayName: 'B' })).toBe(false)
  })

  it('配对码忽略大小写与首尾空格', () => {
    const store = makeStore()
    const code = store.ensureCode()
    expect(store.tryPair(`  ${code.toLowerCase()}  `, { userId: 'u1', displayName: 'A' })).toBe(true)
  })

  it('错误码配对失败且不写入', () => {
    const store = makeStore()
    store.ensureCode()
    expect(store.tryPair('WRONG1', { userId: 'u1', displayName: 'A' })).toBe(false)
    expect(store.isPaired('u1')).toBe(false)
  })

  it('码过期后配对失败', () => {
    const store = makeStore()
    const code = store.ensureCode()
    now += CODE_TTL_MS + 1
    expect(store.tryPair(code, { userId: 'u1', displayName: 'A' })).toBe(false)
  })

  it('无有效码时任何文本都配对失败', () => {
    const store = makeStore()
    expect(store.tryPair('SOMETHING', { userId: 'u1', displayName: 'A' })).toBe(false)
  })

  it('速率限制：5 分钟内 5 次失败后锁定', () => {
    const store = makeStore()
    store.ensureCode()
    for (let i = 0; i < 5; i++) {
      expect(store.tryPair(`BAD${i}`, { userId: 'u1', displayName: 'A' })).toBe(false)
    }
    // 第 6 次即使码正确也被限速拒绝
    const code = store.currentCode()!
    expect(store.tryPair(code, { userId: 'u1', displayName: 'A' })).toBe(false)
    // 窗口过后恢复
    now += 5 * 60 * 1000 + 1
    expect(store.tryPair(store.currentCode()!, { userId: 'u1', displayName: 'A' })).toBe(true)
  })

  it('白名单用户直接放行且无需配对', () => {
    const store = makeStore()
    store.ensureCode()
    expect(store.isPaired('admin', ['admin'])).toBe(true)
    expect(store.tryPair('ANYTHING', { userId: 'admin', displayName: 'A' }, ['admin'])).toBe(true)
  })

  it('已配对用户重复配对不报错（幂等）', () => {
    const store = makeStore()
    const code = store.ensureCode()
    expect(store.tryPair(code, { userId: 'u1', displayName: 'A' })).toBe(true)
    // 码已清，但用户已配对 → 直接放行
    expect(store.tryPair('NOTACODE', { userId: 'u1', displayName: 'A' })).toBe(true)
  })

  it('配对记录跨实例持久化', () => {
    const store = makeStore()
    const code = store.ensureCode()
    store.tryPair(code, { userId: 'u1', displayName: 'A' })
    const store2 = makeStore()
    expect(store2.isPaired('u1')).toBe(true)
    expect(store2.listPairedUsers()).toHaveLength(1)
    expect(store2.listPairedUsers()[0]!.userId).toBe('u1')
  })
})
