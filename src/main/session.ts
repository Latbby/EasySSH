import { app } from 'electron'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { SessionSnapshotVO, SessionTabDTO } from '@shared/types'

/**
 * 会话恢复快照的落盘与读取。
 *
 * 安全约束（必须长期保持）：快照里只允许出现「已保存连接」的 id 与标签类型，
 * 绝不写入密码、私钥口令等任何凭据，也不记录一次性临时连接（inline）——
 * 临时连接没有 id，本就不该在重启后被恢复。写入前统一按白名单挑字段，
 * 即使调用方多塞了 host、password 之类的字段也不会落盘。
 */

/** 单个快照最多保留的标签数，避免标签异常增多时把配置文件撑大 */
const MAX_TABS = 50

/**
 * 快照文件路径，位于 Electron 的 userData 目录，三平台通用。
 * @returns session.json 的绝对路径
 */
function sessionFile(): string {
  return join(app.getPath('userData'), 'session.json')
}

/**
 * 把任意来源的一条记录收敛为合法的标签项。
 * @param raw 待校验的原始值
 * @returns 只含 kind 与 connectionId 的标签项；kind 非法或 connectionId 为空时返回 null
 */
function toTab(raw: unknown): SessionTabDTO | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<SessionTabDTO>
  if (item.kind !== 'terminal' && item.kind !== 'sftp') return null
  if (typeof item.connectionId !== 'string' || !item.connectionId.trim()) return null
  // 只挑出白名单字段，杜绝把凭据、主机地址等额外内容一起写入磁盘
  return { kind: item.kind, connectionId: item.connectionId }
}

/**
 * 收敛一组原始标签：丢弃非法项、按上限截断。
 * @param raw 待处理的原始值，允许不是数组
 * @returns 合法标签数组
 */
function collectTabs(raw: unknown): SessionTabDTO[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(toTab)
    .filter((tab): tab is SessionTabDTO => tab !== null)
    .slice(0, MAX_TABS)
}

/**
 * 校验并收敛磁盘上的原始快照。
 * @param raw JSON.parse 的结果
 * @returns 合法快照；结构不可用或没有任何合法标签时返回 null（没有可恢复内容）
 */
function normalize(raw: unknown): SessionSnapshotVO | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as { tabs?: unknown; savedAt?: unknown }
  if (!Array.isArray(record.tabs)) return null
  const tabs = collectTabs(record.tabs)
  if (tabs.length === 0) return null
  // savedAt 只用于展示判断，缺失或非法时按 0 处理，不影响恢复本身
  const savedAt =
    typeof record.savedAt === 'number' && Number.isFinite(record.savedAt) ? record.savedAt : 0
  return { tabs, savedAt }
}

/**
 * 把损坏的快照文件改名备份为 .bak。
 * 直接删除会丢掉排查线索；改名后本次启动不再读到坏数据，用户仍能从 .bak 里找回内容。
 * @param file 快照文件路径
 */
function backupCorrupt(file: string): void {
  try {
    renameSync(file, `${file}.bak`)
  } catch {
    // 备份失败不阻断启动：本次仍然返回 null，下次读取会再次尝试备份
  }
}

/**
 * 读取上次的会话快照。
 * @returns 合法快照；文件不存在时返回 null，内容损坏时备份为 .bak 后返回 null
 */
export function loadSession(): SessionSnapshotVO | null {
  const file = sessionFile()
  if (!existsSync(file)) return null

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // JSON 不合法（含空文件）视为损坏，降级为 null 而不是让应用启动失败
    backupCorrupt(file)
    return null
  }

  const snapshot = normalize(raw)
  if (!snapshot) {
    // 结构不合法同样是损坏：备份留证，避免每次启动都重复解析坏数据
    backupCorrupt(file)
    return null
  }
  return snapshot
}

/**
 * 保存会话快照：先写同目录临时文件再改名，保证磁盘上要么是旧内容要么是完整新内容。
 *
 * 只持久化已保存连接的 id 与标签类型，绝不写入凭据或临时连接，详见文件头注释。
 * @param snapshot 待保存的快照；没有任何合法标签时等同于清除快照
 */
export function saveSession(snapshot: SessionSnapshotVO): void {
  const tabs = collectTabs(snapshot?.tabs)
  if (tabs.length === 0) {
    // 没有标签就没有可恢复内容，落一个空快照只会让下次启动多一次无意义的备份
    clearSession()
    return
  }

  const savedAt =
    typeof snapshot?.savedAt === 'number' && Number.isFinite(snapshot.savedAt)
      ? snapshot.savedAt
      : Date.now()
  const file = sessionFile()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify({ tabs, savedAt }, null, 2), 'utf8')
  renameSync(tmp, file)
}

/**
 * 清除会话快照，用户在恢复提示条上选择「忽略」时调用。
 * 残留的临时文件一并删除，避免下次写入前的半成品被误读。
 */
export function clearSession(): void {
  const file = sessionFile()
  rmSync(file, { force: true })
  rmSync(`${file}.tmp`, { force: true })
}
