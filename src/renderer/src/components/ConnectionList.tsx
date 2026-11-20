import { useState } from 'react'
import type { ConnectionVO, SaveConnectionDTO } from '@shared/types'
import { parseQuickConnect } from '../quickConnect'

interface Props {
  connections: ConnectionVO[]
  /** 当前系统是否可安全存储凭据，不可用时提示用户改用私钥 */
  secureAvailable: boolean
  /** 快速连接未写用户名时使用的默认用户名 */
  defaultUsername: string
  /** 点击连接项，打开终端 */
  onConnect(vo: ConnectionVO): void
  /** 打开 SFTP 文件管理 */
  onOpenSftp(vo: ConnectionVO): void
  /** 打开新建表单 */
  onCreate(): void
  /** 打开编辑表单 */
  onEdit(vo: ConnectionVO): void
  /** 删除连接，调用方负责二次确认 */
  onRemove(vo: ConnectionVO): void
  /** 快速连接：把临时连接交给调用方直接打开，不落盘 */
  onQuickConnect(dto: SaveConnectionDTO): void
  /** 复制连接：调用方以原配置生成草稿并打开新建表单 */
  onDuplicate(vo: ConnectionVO): void
}

/**
 * 左侧连接列表，含快速连接、搜索过滤与连接操作。
 * @param props 见 Props
 * @returns 侧边栏元素
 */
function ConnectionList({
  connections,
  secureAvailable,
  defaultUsername,
  onConnect,
  onOpenSftp,
  onCreate,
  onEdit,
  onRemove,
  onQuickConnect,
  onDuplicate
}: Props): React.JSX.Element {
  const [quickInput, setQuickInput] = useState('')
  const [quickError, setQuickError] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')

  /** 回车提交快速连接：解析通过后清空输入并交给调用方打开临时会话 */
  const submitQuickConnect = (): void => {
    const parsed = parseQuickConnect(quickInput, defaultUsername)
    if (!parsed.ok) {
      setQuickError(parsed.error)
      return
    }
    setQuickError(null)
    setQuickInput('')
    onQuickConnect(parsed.dto)
  }

  // 关键字命中名称、主机或用户名；名称留空时用 用户名@主机 兜底，与列表展示保持一致
  const key = keyword.trim().toLowerCase()
  const visible = key
    ? connections.filter((vo) =>
        `${vo.name} ${vo.username} ${vo.host} ${vo.username}@${vo.host}`.toLowerCase().includes(key)
      )
    : connections

  // 默认用户名先 trim：系统取不到用户名时提示不能再说「未写用户名时用 X」，否则文案末尾悬空
  const fallbackUser = defaultUsername.trim()
  const quickHint = fallbackUser
    ? `回车直接连接且不保存，未写用户名时用 ${fallbackUser}`
    : '回车直接连接且不保存；请按 用户名@主机 填写'

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <span className="sidebar-title">连接</span>
        <button className="primary-btn" onClick={onCreate}>
          + 新建
        </button>
      </header>

      <div className="quick-connect">
        <input
          value={quickInput}
          onChange={(event) => {
            setQuickInput(event.target.value)
            // 输入变化即清掉上一次的解析错误，避免旧提示误导
            if (quickError) setQuickError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submitQuickConnect()
            }
          }}
          placeholder="user@host:22"
          aria-label="快速连接"
        />
        <span className="quick-connect-hint">{quickHint}</span>
        {quickError && <span className="quick-connect-error">{quickError}</span>}
      </div>

      {!secureAvailable && (
        <p className="warn-text">系统安全存储不可用，无法保存密码，请改用私钥认证</p>
      )}

      <div className="conn-search">
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索名称 / 主机 / 用户名"
          aria-label="搜索连接"
        />
      </div>

      <ul className="conn-list">
        {visible.map((vo) => (
          <li key={vo.id} className="conn-item">
            <button className="conn-main" onClick={() => onConnect(vo)}>
              <span className="conn-name">{vo.name || `${vo.username}@${vo.host}`}</span>
              <span className="conn-sub">
                {vo.username}@{vo.host}:{vo.port}
              </span>
            </button>
            <div className="conn-actions">
              <button className="icon-btn" title="SFTP 文件管理" onClick={() => onOpenSftp(vo)}>
                ⇅
              </button>
              <button className="icon-btn" title="编辑" onClick={() => onEdit(vo)}>
                ✎
              </button>
              <button className="icon-btn" title="复制连接" onClick={() => onDuplicate(vo)}>
                ⧉
              </button>
              <button className="icon-btn danger" title="删除" onClick={() => onRemove(vo)}>
                ×
              </button>
            </div>
          </li>
        ))}
      </ul>

      {connections.length === 0 && !key && (
        <p className="hint-text">还没有连接，点「新建」添加一个</p>
      )}
      {key !== '' && visible.length === 0 && <p className="hint-text">没有匹配的连接</p>}
    </aside>
  )
}

export default ConnectionList
