/**
 * 审批记忆（方案 C 落地）：把飞书审批卡「♾️ 永久允许」变成真的。
 *
 * DSH ApprovalOutcome 词汇只有 allowed-once/rejected/cancelled/unavailable，
 * 官方不支持跨次永久授权；本模块在桥接层做持久化记忆：
 * - 用户点「永久允许」→ 记录 (toolName + 归一化 reasonKey)
 * - 后续同 toolName + 同 reasonKey 的 approval/request → 桥接层直接回 allowed-once，不发卡
 *
 * 安全边界（关键）：
 * - 只有「可永久化 reason 白名单」内的请求允许落记忆；破坏性/外部/受保护路径
 *   类 reason（删除、覆盖、外部写、凭据、提权等）一律拒绝永久化，仅单次允许。
 * - 归一化剥离 [auto-mode ...] 前缀与尾部 ": <目标>" 细节，避免同一原因因
 *   目标不同而漏匹配或错匹配。
 *
 * 存储位置：$DSH_HOME/feishu-bridge/approval-memory.json（原子写，损坏回退空）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** auto-mode 及其余来源的 reason 前缀，归一化时剥除。 */
const REASON_PREFIXES: RegExp[] = [
  /^\[auto-mode (?:approval required|classifier asks|classifier unavailable|classifier deny|hard deny)\]\s*/i,
  /^\[auto-mode\]\s*/i,
]
/** 可永久化的 reason 白名单（归一化后精确匹配；均为「看不清但非破坏」类）。 */
const PERMANENT_ALLOWABLE_REASONS = new Set([
  'the command name is produced by a dynamic expansion',
  'the command name is produced by a glob',
  'the command name is quoted or escaped rather than written literally',
  'opaque nested execution requires manual review',
  'visible nested or inline-code execution requires independent classification',
  'unrecognized pwsh command requires independent classification',
  'unrecognized bash command requires independent classification',
  'command requires independent classification because it cannot be read statically',
])
/** 兜底黑名单：命中即拒绝永久化（破坏性/外部/敏感），即使未来出现新 reason 文案。 */
const NON_PERMANENT_PATTERN = /delete|delet|remove|unlink|overwrite|protected|external|credential|privilege|destructive|state-changing|infrastructure|database|exfiltration|password|token|secret|authorization required/i

/** 一条审批记忆条目。 */
export interface ApprovalMemoryEntry {
  toolName: string
  reasonKey: string
  createdAt?: string
}

/** 归一化审批 reason：剥前缀、截掉冒号后的具体目标，转小写。 */
export function normalizeApprovalReason(reason: unknown): string {
  if (typeof reason !== 'string') return ''
  let text = reason.trim()
  for (const prefix of REASON_PREFIXES) text = text.replace(prefix, '')
  text = text.split(':')[0]!.trim().toLowerCase()
  return text
}

/** reason 是否允许永久化（白名单命中且不触碰黑名单）。 */
export function isPermanentAllowable(reason: unknown): boolean {
  const key = normalizeApprovalReason(reason)
  if (key === '' || !PERMANENT_ALLOWABLE_REASONS.has(key)) return false
  return !NON_PERMANENT_PATTERN.test(key)
}

/** 审批记忆存储：JSON 原子写，损坏时回退空列表。 */
export class ApprovalMemoryStore {
  private readonly file: string

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'approval-memory.json')
  }

  /** 读取全部记忆条目（不抛错）。 */
  load(): ApprovalMemoryEntry[] {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as { entries?: unknown }
      if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
        return parsed.entries.filter((entry): entry is ApprovalMemoryEntry =>
          entry !== null && typeof entry === 'object'
          && typeof (entry as ApprovalMemoryEntry).toolName === 'string'
          && typeof (entry as ApprovalMemoryEntry).reasonKey === 'string',
        )
      }
    } catch {
      /* 文件缺失/损坏：回退空列表 */
    }
    return []
  }

  /** 是否命中记忆：同 toolName + 同归一化 reasonKey。 */
  isPermitted(toolName: string, reason: unknown): boolean {
    const reasonKey = normalizeApprovalReason(reason)
    if (reasonKey === '') return false
    return this.load().some((entry) => entry.toolName === toolName && entry.reasonKey === reasonKey)
  }

  /**
   * 写入永久允许记忆。仅可永久化 reason 生效；返回是否真正落记忆。
   */
  add(toolName: string, reason: unknown): { recorded: boolean; reasonKey: string; error?: string } {
    const reasonKey = normalizeApprovalReason(reason)
    if (reasonKey === '' || !isPermanentAllowable(reason)) {
      return { recorded: false, reasonKey }
    }
    const entries = this.load()
    if (!entries.some((entry) => entry.toolName === toolName && entry.reasonKey === reasonKey)) {
      entries.push({ toolName, reasonKey, createdAt: new Date().toISOString() })
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        const tmp = `${this.file}.tmp`
        fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2), 'utf8')
        fs.renameSync(tmp, this.file)
      } catch (error) {
        return { recorded: false, reasonKey, error: String(error) }
      }
    }
    return { recorded: true, reasonKey }
  }

  /** 清空全部记忆。 */
  clear(): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ entries: [] }, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch {
      return false
    }
    return true
  }
}
