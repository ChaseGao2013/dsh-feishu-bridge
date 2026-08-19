/**
 * 本文件照搬自 CChh (claude-code-im-adapters) 项目（MIT License, Copyright (c) 2026 cc-haha），
 * 原路径 adapters/feishu/ 或 adapters/common/ 对应文件。仅作路径与依赖适配，逻辑未改。
 */
import * as path from 'node:path'

/** True if `filePath` resolves to a location outside of `workDir`.
 *  Relative paths are resolved against workDir first. */
export function isOutsideWorkDir(filePath: string, workDir: string): boolean {
  const pathApi = usesWindowsPath(filePath) || usesWindowsPath(workDir) ? path.win32 : path.posix
  const abs = pathApi.isAbsolute(filePath)
    ? pathApi.normalize(filePath)
    : pathApi.resolve(workDir, filePath)
  const normWork = stripTrailingSeparators(pathApi.normalize(workDir), pathApi)
  const relative = pathApi.relative(normWork, abs)
  return relative !== '' && (relative.startsWith('..') || pathApi.isAbsolute(relative))
}

function usesWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function stripTrailingSeparators(value: string, pathApi: typeof path.posix | typeof path.win32): string {
  const root = pathApi.parse(value).root
  if (value === root) return value
  return value.replace(/[\\/]+$/, '')
}
