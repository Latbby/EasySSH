import { useRef, useState } from 'react'
import type { ConnectionVO } from '@shared/types'
import { toMessage } from '../utils'
import type { ToastKind } from '../types'
import Icon from './Icon'
import ThemeToggle from './ThemeToggle'

/** 未分组的展示标题，分组名为空时使用 */
const UNGROUPED_LABEL = '未分组'

/** 未分组在列表里的键，分组名为空串时用它占位 */
const UNGROUPED_KEY = '__ungrouped__'

interface Props {
  connections: ConnectionVO[]
  /** 当前系统是否可安全存储凭据，不可用时提示用户改用私钥 */
  secureAvailable: boolean
  /** 已有打开会话的连接 id，用于在列表里标出"已连接" */
  activeIds: string[]
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
  /** 复制连接：调用方以原配置生成草稿并打开新建表单 */
  onDuplicate(vo: ConnectionVO): void
  /** 移动分组的结果提示，由调用方显示提示条；未传时静默处理 */
  onNotify?(kind: ToastKind, text: string): void
}

/** 一个分组及其连接 */
interface ConnectionGroup {
  /** 分组名，空串表示未分组 */
  name: string
  items: ConnectionVO[]
}

/**
 * 按分组归并连接。
 * 未分组固定排在最前，其余分组按名称排序，组内保持连接原有顺序。
 * @param list 待归并的连接
 * @returns 有序分组数组
 */
function groupConnections(list: ConnectionVO[]): ConnectionGroup[] {
  const buckets = new Map<string, ConnectionVO[]>()
  list.forEach((vo) => {
    // 空串与 undefined 都表示未分组，统一归到空串这个键上
    const name = vo.group?.trim() ?? ''
    const bucket = buckets.get(name)
    if (bucket) bucket.push(vo)
    else buckets.set(name, [vo])
  })
  return [...buckets.entries()]
    .sort(([left], [right]) => {
      if (left === right) return 0
      if (left === '') return -1
      if (right === '') return 1
      return left.localeCompare(right)
    })
    .map(([name, items]) => ({ name, items }))
}

/**
 * 左侧连接列表，含搜索过滤、分组展示与连接操作。
 * @param props 见 Props
 * @returns 侧边栏元素
 */
function ConnectionList({
  connections,
  secureAvailable,
  activeIds,
  onConnect,
  onOpenSftp,
  onCreate,
  onEdit,
  onRemove,
  onDuplicate,
  onNotify
}: Props): React.JSX.Element {
  const [keyword, setKeyword] = useState('')
  /** 已折叠的分组名，搜索时统一忽略折叠状态 */
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([])
  /**
   * 「移动到分组」弹窗的目标连接与输入中的分组名。
   * Electron 不支持 window.prompt（调用即抛错），这里用应用内弹窗收集分组名。
   */
  const [groupPrompt, setGroupPrompt] = useState<{ vo: ConnectionVO; value: string } | null>(null)
  /**
   * 移动分组后主进程返回的最新列表。
   * 记录它对应的父组件列表引用：父组件一旦刷新出新的数组，这份副本就自动失效，避免两份状态长期打架。
   */
  const [override, setOverride] = useState<{ from: ConnectionVO[]; list: ConnectionVO[] } | null>(
    null
  )
  /** 弹窗遮罩的按下、松开标记：只有两者都落在遮罩上才关闭，避免在输入框里拖选文字时误关弹窗 */
  const pressOnMaskRef = useRef(false)
  const releaseOnMaskRef = useRef(false)

  const list = override && override.from === connections ? override.list : connections

  /**
   * 记录一次操作后的最新列表，让侧栏立刻反映分组改动。
   * @param fresh 主进程返回的最新连接列表
   */
  const applyFreshList = (fresh: ConnectionVO[]): void => {
    setOverride({ from: connections, list: fresh })
  }

  /** 展开或折叠一个分组 */
  const toggleGroup = (name: string): void => {
    setCollapsedGroups((prev) =>
      prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name]
    )
  }

  /** 把连接移动到用户输入的分组，留空表示移出分组 */
  const moveToGroup = async (): Promise<void> => {
    if (!groupPrompt) return
    const { vo, value } = groupPrompt
    const group = value.trim()
    setGroupPrompt(null)
    if (group === (vo.group ?? '').trim()) return
    const label = vo.name || `${vo.username}@${vo.host}`
    try {
      applyFreshList(await window.api.connections.assignGroup({ ids: [vo.id], group }))
      onNotify?.(
        'success',
        group ? `已把「${label}」移动到分组「${group}」` : `已把「${label}」移出分组`
      )
    } catch (err) {
      onNotify?.('error', toMessage(err))
    }
  }

  // 关键字命中名称、主机或用户名；名称留空时用 用户名@主机 兜底，与列表展示保持一致
  const key = keyword.trim().toLowerCase()
  const visible = key
    ? list.filter((vo) =>
        `${vo.name} ${vo.username} ${vo.host} ${vo.username}@${vo.host}`.toLowerCase().includes(key)
      )
    : list

  const groups = groupConnections(visible)
  // 搜索时强制展开：否则命中的连接藏在折叠分组里，用户会以为搜不到
  const searching = key !== ''
  // 全部连接都未分组时不必显示分组标题，保持原有的一层列表观感
  const showGroupHead = groups.some((group) => group.name !== '')
  const groupPromptLabel = groupPrompt
    ? groupPrompt.vo.name || `${groupPrompt.vo.username}@${groupPrompt.vo.host}`
    : ''

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <span className="sidebar-title">连接</span>
        <button className="primary-btn" onClick={onCreate}>
          <Icon name="plus" size={14} />
          新建
        </button>
      </header>

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

      {/* 空态提示紧跟在搜索框下方：列表区域会被 flex 撑开，放在列表之后会被推到侧栏底部 */}
      {list.length === 0 && !key && <p className="hint-text">还没有连接，点「新建」添加一个</p>}
      {key !== '' && visible.length === 0 && <p className="hint-text">没有匹配的连接</p>}

      <ul className="conn-list">
        {groups.map((group) => {
          const groupLabel = group.name || UNGROUPED_LABEL
          const collapsed = !searching && collapsedGroups.includes(group.name)
          return (
            <li key={group.name || UNGROUPED_KEY} className="conn-group">
              {showGroupHead && (
                <button
                  type="button"
                  className="conn-group-head"
                  aria-expanded={!collapsed}
                  title={collapsed ? `展开分组「${groupLabel}」` : `折叠分组「${groupLabel}」`}
                  onClick={() => toggleGroup(group.name)}
                >
                  <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={14} />
                  <Icon name="folder" size={14} />
                  <span className="conn-group-name">{groupLabel}</span>
                  <span className="conn-group-count">{group.items.length}</span>
                </button>
              )}
              {!collapsed && (
                <ul className="conn-group-list">
                  {group.items.map((vo) => {
                    const label = vo.name || `${vo.username}@${vo.host}`
                    const connected = activeIds.includes(vo.id)
                    return (
                      <li
                        key={vo.id}
                        className={connected ? 'conn-item session-active' : 'conn-item'}
                      >
                        <button
                          className="conn-main"
                          onClick={() => onConnect(vo)}
                          title={`打开终端：${label}`}
                        >
                          <span className="conn-name">
                            {/* 绿点表示这个连接已经有打开的会话 */}
                            {connected && <span className="conn-dot" aria-hidden="true" />}
                            {label}
                          </span>
                          <span className="conn-sub">
                            {vo.username}@{vo.host}:{vo.port}
                          </span>
                        </button>
                        <div className="conn-actions">
                          <button
                            className="icon-btn"
                            title="SFTP 文件管理"
                            aria-label={`打开 ${label} 的 SFTP 文件管理`}
                            onClick={() => onOpenSftp(vo)}
                          >
                            <Icon name="sftp" size={14} />
                          </button>
                          <button
                            className="icon-btn"
                            title="编辑"
                            aria-label={`编辑 ${label}`}
                            onClick={() => onEdit(vo)}
                          >
                            <Icon name="edit" size={14} />
                          </button>
                          <button
                            className="icon-btn"
                            title="移动到分组…"
                            aria-label={`把 ${label} 移动到分组`}
                            onClick={() => setGroupPrompt({ vo, value: vo.group ?? '' })}
                          >
                            <Icon name="folder" size={14} />
                          </button>
                          <button
                            className="icon-btn"
                            title="复制连接"
                            aria-label={`复制 ${label}`}
                            onClick={() => onDuplicate(vo)}
                          >
                            <Icon name="copy" size={14} />
                          </button>
                          <button
                            className="icon-btn danger"
                            title="删除"
                            aria-label={`删除 ${label}`}
                            onClick={() => onRemove(vo)}
                          >
                            <Icon name="trash" size={14} />
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          )
        })}
      </ul>

      <footer className="sidebar-foot">
        <span>共 {list.length} 个连接</span>
        <span>{activeIds.length > 0 ? `${activeIds.length} 个会话进行中` : ''}</span>
        <ThemeToggle />
      </footer>

      {groupPrompt && (
        <div
          className="modal-mask"
          onMouseDown={(event) => {
            // 只记「落点是否就是遮罩本身」，弹窗内部的按下不算
            pressOnMaskRef.current = event.target === event.currentTarget
          }}
          onMouseUp={(event) => {
            releaseOnMaskRef.current = event.target === event.currentTarget
          }}
          onClick={(event) => {
            // click 的目标是按下点与松开点的最近公共祖先，在输入框里拖选文字松手落到遮罩上时
            // 也会命中这里，所以必须按下与松开都在遮罩上才关闭
            const onMask = pressOnMaskRef.current && releaseOnMaskRef.current
            pressOnMaskRef.current = false
            releaseOnMaskRef.current = false
            if (onMask && event.target === event.currentTarget) setGroupPrompt(null)
          }}
        >
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="conn-group-title"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault()
              void moveToGroup()
            }}
          >
            <div className="modal-head">
              <h2 className="modal-title" id="conn-group-title">
                移动到分组
              </h2>
            </div>
            <div className="modal-body">
              <label className="field">
                <span>分组名</span>
                <input
                  value={groupPrompt.value}
                  onChange={(event) =>
                    setGroupPrompt({ vo: groupPrompt.vo, value: event.target.value })
                  }
                  onKeyDown={(event) => {
                    // Esc 关闭，与连接表单弹窗保持一致
                    if (event.key === 'Escape') setGroupPrompt(null)
                  }}
                  placeholder="留空表示移出分组"
                  autoFocus
                />
              </label>
              <p className="modal-note">连接「{groupPromptLabel}」，留空保存即移出分组。</p>
            </div>
            <div className="modal-foot">
              <button type="button" onClick={() => setGroupPrompt(null)}>
                取消
              </button>
              <button type="submit" className="primary-btn">
                保存
              </button>
            </div>
          </form>
        </div>
      )}
    </aside>
  )
}

export default ConnectionList
