/**
 * 滑动窗口限流器（P5 加固）。
 *
 * 用于入站消息频率限制：同一用户（open_id）在窗口期内最多消费 max 次，
 * 超限后 tryConsume 返回 false（调用方应静默丢弃消息，防刷屏滥用）。
 * 记录按 key 惰性清理：窗口过期后首次访问时清除，避免无限增长。
 */

export interface RateLimiterOptions {
  /** 窗口时长（毫秒）。默认 30 秒。 */
  windowMs?: number
  /** 窗口内最大消费次数。默认 10。 */
  max?: number
  /** 时钟注入（测试用）。 */
  now?: () => number
}

interface WindowRecord {
  /** 窗口起点时间戳。 */
  start: number
  /** 窗口内已消费次数。 */
  count: number
}

export class RateLimiter {
  private readonly windowMs: number
  private readonly max: number
  private readonly now: () => number
  private readonly records = new Map<string, WindowRecord>()

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 30_000
    this.max = options.max ?? 10
    this.now = options.now ?? (() => Date.now())
    if (this.windowMs <= 0 || this.max <= 0) {
      throw new Error('RateLimiter: windowMs/max 必须为正数')
    }
  }

  /**
   * 尝试消费一次配额。命中窗口且未超限 → true；超限 → false。
   * 已过期窗口自动重置（惰性清理）。
   */
  tryConsume(key: string): boolean {
    const now = this.now()
    const record = this.records.get(key)
    if (record === undefined) {
      this.records.set(key, { start: now, count: 1 })
      return true
    }
    if (now - record.start > this.windowMs) {
      this.records.set(key, { start: now, count: 1 })
      return true
    }
    if (record.count >= this.max) {
      return false
    }
    record.count++
    return true
  }

  /** 当前被跟踪的 key 数（测试/状态用）。 */
  trackedCount(): number {
    return this.records.size
  }

  /** 清空全部记录（测试用/配置变更重载）。 */
  reset(): void {
    this.records.clear()
  }
}
