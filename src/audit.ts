/**
 * 审计日志（P5 加固）。
 *
 * 关键安全事件落盘为 JSON Lines（stateDir/audit.log，0600）：
 * 配对成功/失败、消息限流、命令执行、配置变更、审批决策、
 * 附件下载/发送。单行 JSON：{ time, event, detail, user?, chat? }。
 *
 * 轮转：超过 maxBytes（默认 5MB）时把当前文件改名 audit.log.1 再续写
 * （只保留一份旧档，避免无限占盘）。写入失败只告警不抛错（审计不能
 * 阻断主流程）。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

export interface AuditOptions {
  /** 是否启用（默认 true）。 */
  enabled?: boolean
  /** 单文件大小上限（字节），超限轮转。默认 5MB。 */
  maxBytes?: number
  /** 时钟注入（测试用）。 */
  now?: () => number
}

export type AuditEvent =
  | 'pairing/success'
  | 'pairing/failed'
  | 'message/rate-limited'
  | 'command/executed'
  | 'config/changed'
  | 'approval/decided'
  | 'attachment/downloaded'
  | 'attachment/sent'
  | 'attachment/rejected'

export interface AuditRecord {
  time: number
  event: AuditEvent
  detail: string
  user?: string
  chat?: string
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

export class AuditLog {
  private readonly filePath: string
  private readonly enabled: boolean
  private readonly maxBytes: number
  private readonly now: () => number

  constructor(stateDir: string, options: AuditOptions = {}) {
    this.filePath = path.join(stateDir, 'audit.log')
    this.enabled = options.enabled ?? true
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.now = options.now ?? (() => Date.now())
  }

  /** 追加一条审计记录。失败只告警。 */
  log(record: Omit<AuditRecord, 'time'>): void {
    if (!this.enabled) return
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
      this.rotateIfNeeded()
      const line = JSON.stringify({ time: this.now(), ...record }) + '\n'
      fs.appendFileSync(this.filePath, line, { encoding: 'utf-8', mode: 0o600 })
    } catch (err) {
      // 审计失败不阻断主流程
      try { console.warn(`[feishu-bridge] 审计日志写入失败: ${String(err)}`) } catch { /* 忽略 */ }
    }
  }

  /** 读取全部审计记录（测试/运维用）。文件缺失返回空数组。 */
  readAll(): AuditRecord[] {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      const records: AuditRecord[] = []
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          records.push(JSON.parse(line) as AuditRecord)
        } catch {
          // 跳过损坏行
        }
      }
      return records
    } catch {
      return []
    }
  }

  private rotateIfNeeded(): void {
    try {
      const stat = fs.statSync(this.filePath)
      if (stat.size > this.maxBytes) {
        fs.renameSync(this.filePath, `${this.filePath}.1`)
      }
    } catch {
      // 文件不存在或不可读：无需轮转
    }
  }
}
