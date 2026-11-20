import { useEffect, useRef, useState } from 'react'
import type { ConnectionVO } from '@shared/types'
import { toMessage } from '../utils'
import type { ToastKind } from '../types'
import Icon from './Icon'
import ThemeToggle from './ThemeToggle'

/** 未分组的展示标题，分组名为空时使用 */
const UNGROUPED_LABEL = '未分组'

/** 未分组在列表里的键，分组名为空串时用它占位 */
const UNGROUPED_KEY = '__ungrouped__'

/**
 * 分组下拉框里「新建分组…」的哨兵值。
 * 以 NUL 字符开头，正常分组名不可能与它相同，因此不会和真实分组名撞车。
 */
const NEW_GROUP_OPTION = '\u0000new-group'

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
  /** 分组操作的结果提示，由调用方显示提示条；未传时静默处理 */
  onNotify?(kind: ToastKind, text: string): void
}

/** 一个分组及其连接 */
interface ConnectionGroup {
  /** 分组名，空串表示未分组 */
  name: string
  items: ConnectionVO[]
}

/**
 * 侧栏内的弹窗状态：新建 / 重命名 / 删除分组，以及把某个连接移动到分组。
 * 四种弹窗共用同一套遮罩、标题与底部按钮，用联合类型区分内容，避免写四份弹窗骨架。
 */
type SideDialog =
  | { kind: 'create'; name: string }
  | { kind: 'rename'; from: string; name: string }
  | { kind: 'remove'; name: string; count: number }
  | { kind: 'move'; vo: ConnectionVO; selection: string; newName: string }

/** 各弹窗的标题 */
const DIALOG_TITLES: Record<SideDialog['kind'], string> = {
  create: '新建分组',
  rename: '重命名分组',
  remove: '删除分组',
  move: '移动到分组'
}

/** 各弹窗确认按钮的文案 */
const DIALOG_CONFIRMS: Record<SideDialog['kind'], string> = {
  create: '创建',
  rename: '保存',
  remove: '删除',
  move: '保存'
}

/**
 * 把连接按分组归并成侧栏要展示的结构。
 * 分组名列表来自主进程（可能包含还没有连接的空分组），因此不能只从连接推导；
 * 未分组固定排在第一项，其余按分组列表顺序排列。
 * @param list 待展示的连接（已经过搜索过滤）
 * @param names 分组名列表，顺序即展示顺序
 * @returns 分组数组，每项含分组名与该组连接
 */
function groupConnections(list: ConnectionVO[], names: string[]): ConnectionGroup[] {
  const buckets = new Map<string, ConnectionVO[]>()
  // 先按「未分组 → 已登记分组」的顺序建桶，保证展示顺序稳定且空分组不丢
  buckets.set('', [])
  names.forEach((name) => buckets.set(name, []))
  list.forEach((vo) => {
    const name = vo.group?.trim() ?? ''
    // 分组列表里没有的名字（老数据或分组拉取失败）就地补桶，避免连接从列表里消失
    if (!buckets.has(name)) buckets.set(name, [])
    buckets.get(name)?.push(vo)
  })
  return [...buckets.entries()].map(([name, items]) => ({ name, items }))
}

/**
 * 左侧连接列表：按分组展示连接，支持新建/重命名/删除分组、搜索与连接操作。
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
  /** 主进程登记的分组名（含空分组），顺序即侧栏展示顺序 */
  const [groupNames, setGroupNames] = useState<string[]>([])
  /** 分组操作返回的最新连接列表：以父组件数组引用为失效键，App 一刷新自动让位 */
  const [override, setOverride] = useState<{ from: ConnectionVO[]; list: ConnectionVO[] } | null>(
    null
  )
  /** 折叠的分组名 */
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([])
  /** 当前悬停或聚焦的分组行，决定是否显示重命名 / 删除按钮 */
  const [activeGroup, setActiveGroup] = useState<string | null>(null)
  /** 当前打开的侧栏弹窗 */
  const [dialog, setDialog] = useState<SideDialog | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  /** 遮罩按下/松开标记：只有两次都落在遮罩本身才关闭，避免在弹窗里拖选文字时误关 */
  const pressOnMaskRef = useRef(false)
  const releaseOnMaskRef = useRef(false)

  const list = override && override.from === connections ? override.list : connections

  /**
   * 用主进程返回的最新连接列表覆盖展示，直到父组件刷新出新数组。
   * @param fresh 最新连接列表
   */
  const applyFreshList = (fresh: ConnectionVO[]): void => {
    setOverride({ from: connections, list: fresh })
  }

  // 连接列表一变就同步一次分组：表单里新建的分组、以及父组件的刷新都能立刻反映到侧栏
  useEffect(() => {
    void window.api.connections
      .groups()
      .then(setGroupNames)
      .catch(() => undefined)
  }, [connections])

  /**
   * 拉取最新连接列表并展示：重命名 / 删除分组改了组内连接的分组名，只刷新分组列表还不够。
   */
  const refreshConnections = async (): Promise<void> => {
    applyFreshList(await window.api.connections.list())
  }

  /**
   * 确保分组存在：已登记的直接返回，未登记的交给主进程创建。
   * 主进程对重名会报错（并发创建或本地列表过期都会命中），所以创建失败后再查一次列表，
   * 确实已有同名分组就按成功继续，否则把原始错误抛给调用方展示。
   * @param name 分组名，已去掉两端空白
   * @returns 最新的分组列表
   */
  const ensureGroup = async (name: string): Promise<string[]> => {
    if (groupNames.includes(name)) return groupNames
    try {
      return await window.api.connections.createGroup(name)
    } catch (err) {
      const latest = await window.api.connections.groups().catch(() => groupNames)
      if (!latest.includes(name)) throw err
      return latest
    }
  }

  /** 展开或折叠一个分组 */
  const toggleGroup = (name: string): void => {
    setCollapsedGroups((prev) =>
      prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name]
    )
  }

  /** 关闭弹窗并复位内部状态 */
  const closeDialog = (): void => {
    setDialog(null)
    setDialogError(null)
    setDialogBusy(false)
  }

  /** 打开「新建分组」弹窗 */
  const openCreateGroup = (): void => {
    setDialogError(null)
    setDialog({ kind: 'create', name: '' })
  }

  /**
   * 打开「重命名分组」弹窗，名称预填当前分组名。
   * @param name 待重命名的分组名
   */
  const openRenameGroup = (name: string): void => {
    setDialogError(null)
    setDialog({ kind: 'rename', from: name, name })
  }

  /**
   * 打开「删除分组」确认弹窗，文案里带上组内连接数。
   * @param name 待删除的分组名
   */
  const openRemoveGroup = (name: string): void => {
    // 连接数按全量列表统计：搜索过滤后的命中数不代表组内真实连接数
    const count = list.filter((vo) => (vo.group?.trim() ?? '') === name).length
    setDialogError(null)
    setDialog({ kind: 'remove', name, count })
  }

  /**
   * 打开「移动到分组」弹窗，下拉框预选连接当前所在的分组。
   * @param vo 目标连接
   */
  const openMoveDialog = (vo: ConnectionVO): void => {
    setDialogError(null)
    setDialog({ kind: 'move', vo, selection: vo.group?.trim() ?? '', newName: '' })
  }

  /** 提交当前弹窗：新建 / 重命名 / 删除分组，或把连接移动到分组 */
  const submitDialog = async (): Promise<void> => {
    if (!dialog || dialogBusy) return
    setDialogBusy(true)
    setDialogError(null)
    try {
      if (dialog.kind === 'create') {
        const name = dialog.name.trim()
        setGroupNames(await ensureGroup(name))
        closeDialog()
        onNotify?.('success', `已创建分组「${name}」`)
        return
      }

      if (dialog.kind === 'rename') {
        const to = dialog.name.trim()
        setGroupNames(await window.api.connections.renameGroup(dialog.from, to))
        // 折叠状态跟着改名走，否则折叠中的分组改名后会自己展开
        setCollapsedGroups((prev) => prev.map((item) => (item === dialog.from ? to : item)))
        await refreshConnections()
        closeDialog()
        onNotify?.('success', `分组「${dialog.from}」已重命名为「${to}」`)
        return
      }

      if (dialog.kind === 'remove') {
        setGroupNames(await window.api.connections.removeGroup(dialog.name))
        setCollapsedGroups((prev) => prev.filter((item) => item !== dialog.name))
        await refreshConnections()
        closeDialog()
        onNotify?.('success', `已删除分组「${dialog.name}」，组内连接已变为未分组`)
        return
      }

      // 移动到分组：选「新建分组…」时先建组再移动，目标为空则用主进程的错误提示拦下
      const creating = dialog.selection === NEW_GROUP_OPTION
      const target = creating ? dialog.newName.trim() : dialog.selection.trim()
      if (creating && !target) {
        setDialogError('请填写新分组名称')
        return
      }
      // 目标与当前分组一致时不必打扰主进程
      if (target === (dialog.vo.group?.trim() ?? '')) {
        closeDialog()
        return
      }
      if (creating) setGroupNames(await ensureGroup(target))
      const label = dialog.vo.name || `${dialog.vo.username}@${dialog.vo.host}`
      applyFreshList(
        await window.api.connections.assignGroup({ ids: [dialog.vo.id], group: target })
      )
      closeDialog()
      onNotify?.(
        'success',
        target ? `已把「${label}」移动到分组「${target}」` : `已把「${label}」移出分组`
      )
    } catch (err) {
      setDialogError(toMessage(err))
    } finally {
      setDialogBusy(false)
    }
  }

  // 关键字命中名称、主机或用户名；名称留空时用 用户名@主机 兜底，与列表展示保持一致
  const key = keyword.trim().toLowerCase()
  const visible = key
    ? list.filter((vo) =>
        `${vo.name} ${vo.username} ${vo.host} ${vo.username}@${vo.host}`.toLowerCase().includes(key)
      )
    : list

  const groups = groupConnections(visible, groupNames)
  // 搜索时只保留有命中的分组，免得一屏空分组干扰；不搜索时空分组也要显示（新建后立刻可见）
  const searching = key !== ''
  const shownGroups = searching ? groups.filter((group) => group.items.length > 0) : groups
  // 一个分组标题都没有时保持原来的一层列表观感
  const showGroupHead = shownGroups.some((group) => group.name !== '')
  // 移动弹窗的下拉选项：连接当前所在分组也补进去，分组列表拉取失败时下拉框仍能显示正确项
  const moveCurrentGroup = dialog?.kind === 'move' ? (dialog.vo.group?.trim() ?? '') : ''
  const moveOptions =
    moveCurrentGroup && !groupNames.includes(moveCurrentGroup)
      ? [...groupNames, moveCurrentGroup]
      : groupNames
  const dialogLabel =
    dialog?.kind === 'move' ? dialog.vo.name || `${dialog.vo.username}@${dialog.vo.host}` : ''

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <span className="sidebar-title">连接</span>
        <div className="sidebar-head-actions">
          <button
            className="icon-btn"
            title="新建分组"
            aria-label="新建分组"
            onClick={openCreateGroup}
          >
            <Icon name="folder-plus" size={14} />
          </button>
          <button className="primary-btn" onClick={onCreate}>
            <Icon name="plus" size={14} />
            新建
          </button>
        </div>
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
        {shownGroups.map((group) => {
          const groupLabel = group.name || UNGROUPED_LABEL
          const collapsed = !searching && collapsedGroups.includes(group.name)
          const rowKey = group.name || UNGROUPED_KEY
          return (
            <li key={rowKey} className="conn-group">
              {showGroupHead && (
                <div
                  className="conn-group-head"
                  // 整行可点：标题、计数与空白处都能收起/展开，展开状态同时挂在行上供外部探针读取
                  aria-expanded={!collapsed}
                  title={collapsed ? `展开分组「${groupLabel}」` : `折叠分组「${groupLabel}」`}
                  onClick={() => toggleGroup(group.name)}
                  onMouseEnter={() => setActiveGroup(rowKey)}
                  onMouseLeave={() => setActiveGroup((prev) => (prev === rowKey ? null : prev))}
                  onFocus={() => setActiveGroup(rowKey)}
                  onBlur={(event) => {
                    // 焦点还在这一行内部（例如从重命名按钮移到删除按钮）时不收起操作按钮
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setActiveGroup((prev) => (prev === rowKey ? null : prev))
                    }
                  }}
                >
                  <button
                    type="button"
                    className="conn-group-toggle"

                    aria-expanded={!collapsed}
                  >
                    <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={14} />
                    <Icon name="folder" size={14} />
                    <span className="conn-group-name">{groupLabel}</span>
                    <span className="conn-group-count">{group.items.length}</span>
                  </button>
                  {/* 重命名与删除只对已登记的分组开放：未分组固定存在，没有可改可删的东西 */}
                  {group.name !== '' && activeGroup === rowKey && (
                    <div className="conn-group-tools">
                      <button
                        className="icon-btn"
                        title={`重命名分组「${groupLabel}」`}
                        aria-label={`重命名分组 ${groupLabel}`}
                        // 操作按钮自己处理点击，别让事件冒到整行去折叠分组
                        onClick={(event) => {
                          event.stopPropagation()
                          openRenameGroup(group.name)
                        }}
                      >
                        <Icon name="edit" size={14} />
                      </button>
                      <button
                        className="icon-btn danger"
                        title={`删除分组「${groupLabel}」`}
                        aria-label={`删除分组 ${groupLabel}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          openRemoveGroup(group.name)
                        }}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  )}
                </div>
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
                            onClick={() => openMoveDialog(vo)}
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

      {dialog && (
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
            if (onMask && event.target === event.currentTarget) closeDialog()
          }}
        >
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="conn-group-title"
            onClick={(event) => event.stopPropagation()}
            // 焦点在弹窗内时 Esc 一定冒泡到这里，键盘用户不必先点输入框
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeDialog()
            }}
            onSubmit={(event) => {
              event.preventDefault()
              void submitDialog()
            }}
          >
            <div className="modal-head">
              <h2 className="modal-title" id="conn-group-title">
                {DIALOG_TITLES[dialog.kind]}
              </h2>
            </div>
            <div className="modal-body">
              {dialog.kind === 'create' && (
                <label className="field">
                  <span>分组名</span>
                  <input
                    value={dialog.name}
                    onChange={(event) => setDialog({ kind: 'create', name: event.target.value })}
                    placeholder="例如：生产环境"
                    disabled={dialogBusy}
                    autoFocus
                  />
                </label>
              )}

              {dialog.kind === 'rename' && (
                <label className="field">
                  <span>分组名</span>
                  <input
                    value={dialog.name}
                    onChange={(event) =>
                      setDialog({ kind: 'rename', from: dialog.from, name: event.target.value })
                    }
                    placeholder="例如：生产环境"
                    disabled={dialogBusy}
                    autoFocus
                  />
                </label>
              )}

              {dialog.kind === 'remove' && (
                <p className="modal-note">
                  {`分组「${dialog.name}」内有 ${dialog.count} 个连接，删除后这些连接会变为未分组（连接本身不会被删除）。`}
                </p>
              )}

              {dialog.kind === 'move' && (
                <>
                  <label className="field">
                    <span>分组</span>
                    <select
                      value={dialog.selection}
                      onChange={(event) =>
                        setDialog({
                          kind: 'move',
                          vo: dialog.vo,
                          selection: event.target.value,
                          newName: dialog.newName
                        })
                      }
                      disabled={dialogBusy}
                      // 打开弹窗即聚焦下拉框，键盘用户不必先点一下
                      autoFocus
                    >
                      <option value="">（未分组）</option>
                      {moveOptions.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                      <option value={NEW_GROUP_OPTION}>＋ 新建分组…</option>
                    </select>
                  </label>
                  {/* 选「新建分组…」才出现名称输入框，与表单里的分组下拉框保持一致 */}
                  {dialog.selection === NEW_GROUP_OPTION && (
                    <label className="field">
                      <span>新分组名称</span>
                      <input
                        value={dialog.newName}
                        onChange={(event) =>
                          setDialog({
                            kind: 'move',
                            vo: dialog.vo,
                            selection: dialog.selection,
                            newName: event.target.value
                          })
                        }
                        placeholder="例如：生产环境"
                        disabled={dialogBusy}
                        autoFocus
                      />
                    </label>
                  )}
                  <p className="modal-note">连接「{dialogLabel}」，保存后移动到所选分组。</p>
                </>
              )}

              {dialogError && <p className="form-error">{dialogError}</p>}
            </div>
            <div className="modal-foot">
              <button
                type="button"
                onClick={closeDialog}
                disabled={dialogBusy}
                autoFocus={dialog.kind === 'remove'}
              >
                取消
              </button>
              <button type="submit" className="primary-btn" disabled={dialogBusy}>
                {dialogBusy ? '处理中…' : DIALOG_CONFIRMS[dialog.kind]}
              </button>
            </div>
          </form>
        </div>
      )}
    </aside>
  )
}

export default ConnectionList
