/**
 * 本文件照搬自 CChh (claude-code-im-adapters) 项目（MIT License, Copyright (c) 2026 cc-haha），
 * 原路径 adapters/feishu/ 或 adapters/common/ 对应文件。仅作路径与依赖适配，逻辑未改。
 */
/**
 * Shared attachment types for IM adapters.
 */

/** Attachment reference — mirrors CChh adapters/common/ws-bridge.ts AttachmentRef. */
export type AttachmentRef = {
  type: 'file' | 'image'
  name?: string
  path?: string
  data?: string      // base64 payload (images)
  mimeType?: string
}

/** Platform tag — used for local staging subdir and telemetry. */
export type ImPlatform = 'feishu' | 'telegram' | 'wechat' | 'dingtalk' | 'whatsapp'

/** Result of downloading an IM resource into the local stage dir. */
export interface LocalAttachment {
  kind: 'image' | 'file'
  name: string        // original filename, or synthesized if none
  path: string        // absolute path on disk (under ~/.claude/im-downloads)
  size: number        // bytes
  mimeType: string    // detected or provided
  buffer: Buffer      // raw bytes (kept so caller can choose base64 vs path)
}

/** Pending outbound media found in Agent stream output. */
export interface PendingUpload {
  id: string          // fingerprint, used for dedup
  source:
    | { kind: 'base64'; data: string; mime: string }
    | { kind: 'path'; path: string; mime?: string }
    | { kind: 'url'; url: string; mime?: string }
  alt?: string
}
