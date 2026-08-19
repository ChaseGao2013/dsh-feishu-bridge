/**
 * 配对核心（思路借鉴 CChh adapters/common/pairing.ts，MIT License，
 * Copyright (c) 2026 cc-haha；本文件为 DSH 侧重写：存储路径、校验逻辑
 * 独立实现，便于测试注入）。
 *
 * - 6 位安全配对码（字母表排除 0/O/1/I/L），有效期 60 分钟，一次性使用
 * - 状态持久化到 stateDir/pairing.json（原子写：tmp + rename，0600）
 * - 速率限制：每个用户 5 分钟内最多 5 次失败尝试
 * - 用户授权 = 配置白名单 allowedUsers 与已配对 pairedUsers 的并集
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export const SAFE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // 排除 0/O/1/I/L
export const CODE_LENGTH = 6
export const CODE_TTL_MS = 60 * 60 * 1000 // 60 分钟

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000 // 5 分钟
const RATE_LIMIT_MAX_ATTEMPTS = 5

/** 一个已配对用户记录。 */
export interface PairedUser {
  userId: string
  displayName: string
  pairedAt: number
}

/** 当前配对码状态。code 为 null 表示没有有效配对码（已使用/已过期）。 */
export interface PairingState {
  code: string | null
  expiresAt: number | null
  createdAt: number | null
}

/** pairing.json 的完整内容。 */
export interface PairingFile {
  pairing: PairingState
  pairedUsers: PairedUser[]
}

function emptyState(): PairingState {
  return { code: null, expiresAt: null, createdAt: null }
}

function emptyFile(): PairingFile {
  return { pairing: emptyState(), pairedUsers: [] }
}

/** 生成 6 位安全配对码（crypto.randomInt，均匀采样）。 */
export function generatePairingCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += SAFE_ALPHABET[crypto.randomInt(SAFE_ALPHABET.length)]!
  }
  return code
}

/**
 * 配对状态存取 + 校验逻辑。所有文件 IO 收敛在这里，测试可注入临时目录。
 */
export class PairingStore {
  private readonly filePath: string
  private readonly now: () => number
  /** 进程内速率限制记录：userId → { count, firstAttempt }。 */
  private readonly failedAttempts = new Map<string, { count: number; firstAttempt: number }>()

  constructor(stateDir: string, now: () => number = () => Date.now()) {
    this.filePath = path.join(stateDir, 'pairing.json')
    this.now = now
  }

  // ------------------------------------------------------------------
  // 持久化
  // ------------------------------------------------------------------

  /** 读取状态文件；缺失/损坏时返回空状态（损坏文件改名留档，不覆盖丢数据）。 */
  read(): PairingFile {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<PairingFile>
      return {
        pairing: {
          code: typeof parsed.pairing?.code === 'string' ? parsed.pairing.code : null,
          expiresAt: typeof parsed.pairing?.expiresAt === 'number' ? parsed.pairing.expiresAt : null,
          createdAt: typeof parsed.pairing?.createdAt === 'number' ? parsed.pairing.createdAt : null,
        },
        pairedUsers: Array.isArray(parsed.pairedUsers)
          ? parsed.pairedUsers.filter((u): u is PairedUser =>
            typeof u === 'object' && u !== null && typeof u.userId === 'string')
          : [],
      }
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyFile()
      }
      // 损坏文件：改名留档后返回空状态（不删除原数据）
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupt-${this.now()}`)
      } catch {
        // 改名失败不阻塞启动
      }
      return emptyFile()
    }
  }

  /** 原子写：tmp + rename，0600 权限。 */
  write(data: PairingFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
    const tmp = `${this.filePath}.tmp.${crypto.randomBytes(8).toString('hex')}`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(tmp, this.filePath)
  }

  // ------------------------------------------------------------------
  // 配对码生命周期
  // ------------------------------------------------------------------

  /**
   * 确保存在一个有效配对码并返回它。
   * - 预置码（配置传入）优先：若当前无有效码，用它并设 60 分钟有效期
   * - 否则生成新码
   * 幂等：已有未过期 code 时直接返回现有值。
   */
  ensureCode(preconfigured?: string): string {
    const file = this.read()
    const now = this.now()
    if (file.pairing.code && file.pairing.expiresAt !== null && file.pairing.expiresAt > now) {
      return file.pairing.code
    }
    const code = preconfigured && preconfigured.trim() ? preconfigured.trim().toUpperCase() : generatePairingCode()
    file.pairing = { code, expiresAt: now + CODE_TTL_MS, createdAt: now }
    this.write(file)
    return code
  }

  /** 当前有效配对码（无则 null）。 */
  currentCode(): string | null {
    const file = this.read()
    const now = this.now()
    if (!file.pairing.code || file.pairing.expiresAt === null || file.pairing.expiresAt <= now) {
      return null
    }
    return file.pairing.code
  }

  // ------------------------------------------------------------------
  // 用户授权
  // ------------------------------------------------------------------

  /** 是否已授权：配置白名单 or 已配对列表命中。 */
  isPaired(userId: string, allowedUsers?: readonly string[]): boolean {
    const file = this.read()
    if (allowedUsers && allowedUsers.length > 0 && allowedUsers.includes(userId)) return true
    return file.pairedUsers.some((u) => u.userId === userId)
  }

  /**
   * 尝试用消息文本完成配对。成功：写入 pairedUsers 并清空配对码（一次性），
   * 返回 true。失败（码无效/过期/被限速）返回 false。
   */
  tryPair(
    messageText: string,
    sender: { userId: string; displayName: string },
    allowedUsers?: readonly string[],
  ): boolean {
    const now = this.now()

    // 已授权用户无需再配对
    if (this.isPaired(sender.userId, allowedUsers)) return true

    // 速率限制
    if (this.isRateLimited(sender.userId, now)) return false

    const file = this.read()
    const pairing = file.pairing
    if (!pairing.code || pairing.expiresAt === null || pairing.expiresAt <= now) {
      return false
    }

    // 比对（忽略大小写和首尾空格）
    const input = messageText.trim().toUpperCase()
    if (input !== pairing.code.toUpperCase()) {
      this.recordFailedAttempt(sender.userId, now)
      return false
    }

    // 配对成功：写入 pairedUsers，清除配对码（一次性）
    if (!file.pairedUsers.some((u) => u.userId === sender.userId)) {
      file.pairedUsers.push({
        userId: sender.userId,
        displayName: sender.displayName,
        pairedAt: now,
      })
    }
    file.pairing = emptyState()
    this.write(file)
    return true
  }

  /** 已配对用户列表（只读副本）。 */
  listPairedUsers(): PairedUser[] {
    return [...this.read().pairedUsers]
  }

  // ------------------------------------------------------------------
  // 速率限制
  // ------------------------------------------------------------------

  private isRateLimited(userId: string, now: number): boolean {
    const record = this.failedAttempts.get(userId)
    if (!record) return false
    if (now - record.firstAttempt > RATE_LIMIT_WINDOW_MS) {
      this.failedAttempts.delete(userId)
      return false
    }
    return record.count >= RATE_LIMIT_MAX_ATTEMPTS
  }

  private recordFailedAttempt(userId: string, now: number): void {
    const record = this.failedAttempts.get(userId)
    if (!record || now - record.firstAttempt > RATE_LIMIT_WINDOW_MS) {
      this.failedAttempts.set(userId, { count: 1, firstAttempt: now })
    } else {
      record.count++
    }
  }
}
