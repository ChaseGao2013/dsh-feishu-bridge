/**
 * 远程可配置项（/config 命令白名单）的持久化存储。
 *
 * 存储位置：$DSH_HOME/feishu-bridge/runtime-config.json
 * 读取优先级：runtime-config.json > cordis.patch.yml 插件配置 > 内置默认值。
 * 白名单外的键一律拒绝——App ID/Secret 等敏感配置不允许远程修改。
 * 权限预设的合法值**动态对齐** DSH 运行时已注册的预设列表（含用户自定义预设，如 auto），
 * 由调用方通过 allowedPermissionPresets 传入（来自 ctx.permissionPresets.names）。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** 远程可配置项。键的语义与插件 config 同名。 */
export interface RuntimeConfig {
  /** 远程会话权限预设（动态白名单：DSH 已注册预设，如 workspace-write/read-only/danger-full-access/auto）。 */
  remotePermissionPreset?: string
  /** 新建会话的工作目录（覆盖插件配置 sessionCwd）。 */
  sessionCwd?: string
}

/** 运行时配置存储：原子写 JSON，损坏时回退空对象并告警。 */
export class RuntimeConfigStore {
  private readonly file: string

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'runtime-config.json')
  }

  /** 读取当前运行时配置（不抛错：文件缺失/损坏都回退空对象）。 */
  load(): RuntimeConfig {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') {
        const cfg: RuntimeConfig = {}
        const obj = parsed as Record<string, unknown>
        if (typeof obj.remotePermissionPreset === 'string') {
          cfg.remotePermissionPreset = obj.remotePermissionPreset
        }
        if (typeof obj.sessionCwd === 'string' && obj.sessionCwd.trim().length > 0) {
          cfg.sessionCwd = obj.sessionCwd.trim()
        }
        return cfg
      }
    } catch {
      /* 文件缺失/损坏：回退空配置 */
    }
    return {}
  }

  /**
   * 持久化一个远程配置键。
   * @param allowedPermissionPresets - DSH 运行时已注册的预设名（ctx.permissionPresets.names）；
   *   传 undefined 时退化为官方三预设校验。
   * @returns 错误文本（校验失败）或 null（成功）。
   */
  set(key: string, value: string, allowedPermissionPresets?: readonly string[]): string | null {
    const normalizedKey = key.trim().toLowerCase()
    const normalizedValue = value.trim()
    if (normalizedValue.length === 0) return '值不能为空。'

    const current = this.load()
    switch (normalizedKey) {
      case 'remotepermissionpreset': {
        const pool = allowedPermissionPresets && allowedPermissionPresets.length > 0
          ? allowedPermissionPresets
          : (['workspace-write', 'read-only', 'danger-full-access'] as const)
        if (!(pool as readonly string[]).includes(normalizedValue)) {
          return `非法预设 "${normalizedValue}"。当前可用：${pool.join(' / ')}`
        }
        current.remotePermissionPreset = normalizedValue
        break
      }
      case 'sessioncwd':
        current.sessionCwd = normalizedValue
        break
      default:
        return `未知配置项 "${key}"。可配置：remotePermissionPreset / sessionCwd`
    }

    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
    return null
  }

  /** 当前配置的文本描述（/config 无参时展示）。 */
  describe(allowedPermissionPresets?: readonly string[]): string {
    const cfg = this.load()
    const pool = allowedPermissionPresets && allowedPermissionPresets.length > 0
      ? allowedPermissionPresets
      : (['workspace-write', 'read-only', 'danger-full-access'] as const)
    const lines = [
      '⚙️ **远程配置**',
      '',
      `• 权限预设：\`${cfg.remotePermissionPreset ?? '（默认 workspace-write）'}\``,
      `• 工作目录：\`${cfg.sessionCwd ?? '（默认插件配置）'}\``,
      '',
      '修改：`/config <键> <值>`',
      `可用键：\`remotePermissionPreset\`（当前可用：${pool.join(' / ')}）、\`sessionCwd\``,
    ]
    return lines.join('\n')
  }
}
