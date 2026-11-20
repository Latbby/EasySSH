import type { SessionSnapshotVO } from '@shared/types'

interface Props {
  /** 上次退出时留下的会话快照 */
  snapshot: SessionSnapshotVO
  /** 连接 id → 连接名映射，用于展示快照里的标签来源；连接已被删除时取不到 */
  titles: Record<string, string>
  /** 正在执行恢复，期间禁用按钮避免重复触发 */
  busy: boolean
  /** 恢复快照里的全部标签 */
  onRestore(): void
  /** 忽略本次恢复，由上层清除快照 */
  onDismiss(): void
}

/**
 * 取标签对应的连接展示名。
 * 连接可能已被删除而取不到标题，此时用 connectionId 前 8 位兜底，避免界面出现空白项。
 * @param titles 连接 id → 连接名映射
 * @param connectionId 标签记录的连接 id
 * @returns 可展示的连接名
 */
function tabLabel(titles: Record<string, string>, connectionId: string): string {
  const name = titles[connectionId]
  return name && name.trim() ? name : connectionId.slice(0, 8)
}

/**
 * 会话恢复提示条：应用启动读到上次快照时，询问用户是否恢复那些标签。
 *
 * 快照里只有已保存连接的 id，连接若已被删除就恢复不了，
 * 因此全部连接都找不到时不再提供「恢复」，只提示并允许忽略。
 * @param props 见 Props
 * @returns 提示条元素
 */
function SessionRestoreBar({
  snapshot,
  titles,
  busy,
  onRestore,
  onDismiss
}: Props): React.JSX.Element {
  const total = snapshot.tabs.length
  const terminalCount = snapshot.tabs.filter((tab) => tab.kind === 'terminal').length
  const sftpCount = total - terminalCount

  // 连接被删除后 titles 里就没有对应表项，据此判断快照还剩多少可恢复的标签
  const restorable = snapshot.tabs.filter((tab) => {
    const name = titles[tab.connectionId]
    return Boolean(name && name.trim())
  })
  const lostAll = restorable.length === 0

  return (
    <div className="status-bar" role="status" aria-live="polite">
      <span className="status-text">
        {lostAll
          ? '上次的会话对应连接已不存在'
          : `上次有 ${total} 个会话（终端 ${terminalCount} / 文件 ${sftpCount}），是否恢复？`}
      </span>
      {/* 逐个列出标签来源，连接名缺失的用 id 前 8 位兜底；全部失效时该行没有意义故不展示 */}
      {!lostAll && (
        <span className="status-text">
          {snapshot.tabs.map((tab) => tabLabel(titles, tab.connectionId)).join('、')}
        </span>
      )}

      <div className="status-actions">
        {!lostAll && (
          <button
            type="button"
            className="status-btn primary-btn"
            onClick={onRestore}
            disabled={busy}
          >
            {busy ? '恢复中…' : '恢复'}
          </button>
        )}
        <button type="button" className="status-btn" onClick={onDismiss} disabled={busy}>
          忽略
        </button>
      </div>
    </div>
  )
}

export default SessionRestoreBar
