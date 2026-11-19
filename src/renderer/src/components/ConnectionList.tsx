import type { ConnectionVO } from '@shared/types'

interface Props {
  connections: ConnectionVO[]
  /** 当前系统是否可安全存储凭据，不可用时提示用户改用私钥 */
  secureAvailable: boolean
  /** 点击连接项，打开终端 */
  onConnect(vo: ConnectionVO): void
  /** 打开新建表单 */
  onCreate(): void
  /** 打开编辑表单 */
  onEdit(vo: ConnectionVO): void
  /** 删除连接，调用方负责二次确认 */
  onRemove(vo: ConnectionVO): void
}

/**
 * 左侧连接列表。
 * @param props 见 Props
 * @returns 侧边栏元素
 */
function ConnectionList({
  connections,
  secureAvailable,
  onConnect,
  onCreate,
  onEdit,
  onRemove
}: Props): React.JSX.Element {
  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <span className="sidebar-title">连接</span>
        <button className="primary-btn" onClick={onCreate}>
          + 新建
        </button>
      </header>

      {!secureAvailable && (
        <p className="warn-text">系统安全存储不可用，无法保存密码，请改用私钥认证</p>
      )}

      <ul className="conn-list">
        {connections.map((vo) => (
          <li key={vo.id} className="conn-item">
            <button className="conn-main" onClick={() => onConnect(vo)}>
              <span className="conn-name">{vo.name || `${vo.username}@${vo.host}`}</span>
              <span className="conn-sub">
                {vo.username}@{vo.host}:{vo.port}
              </span>
            </button>
            <div className="conn-actions">
              <button className="icon-btn" title="编辑" onClick={() => onEdit(vo)}>
                ✎
              </button>
              <button className="icon-btn danger" title="删除" onClick={() => onRemove(vo)}>
                ×
              </button>
            </div>
          </li>
        ))}
      </ul>

      {connections.length === 0 && <p className="hint-text">还没有连接，点「新建」添加一个</p>}
    </aside>
  )
}

export default ConnectionList
