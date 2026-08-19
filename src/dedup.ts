/**
 * 入站事件去重（借鉴 CChh feishu 侧的 dedup 思路，MIT）。
 *
 * 飞书 WebSocket 事件可能重投（断线重连、超时重试），同一 message_id
 * 只处理一次。进程内 Set + 上限，超限时清空最旧一半（消息 id 是随机的，
 * 顺序无关紧要，清一半即可保持窗口有效）。
 */

const MAX_ENTRIES = 1000

export class MessageDedup {
  private readonly seen = new Set<string>()

  /** 记录并返回是否首次见到。重复消息返回 false。 */
  tryRecord(id: string): boolean {
    if (this.seen.has(id)) return false
    if (this.seen.size >= MAX_ENTRIES) {
      // 简单滚动窗口：清掉一半，保留最近的记录
      const entries = [...this.seen]
      const drop = Math.floor(entries.length / 2)
      for (let i = 0; i < drop; i++) this.seen.delete(entries[i]!)
    }
    this.seen.add(id)
    return true
  }

  /** 测试辅助：当前记录数。 */
  size(): number {
    return this.seen.size
  }
}
