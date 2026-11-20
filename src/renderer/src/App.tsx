import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ConnectionVO,
  SaveConnectionDTO,
  SessionSnapshotVO,
  SessionTabDTO
} from '@shared/types'
import type { HostKeyChangeVO } from '@shared/errors'
import ConnectionList from './components/ConnectionList'
import ConnectionForm from './components/ConnectionForm'
import WorkspaceTabs from './components/WorkspaceTabs'
import Toast from './components/Toast'
import HostKeyDialog from './components/HostKeyDialog'
import SessionRestoreBar from './components/SessionRestoreBar'
import { asHostKeyChanged, toMessage } from './utils'
import type { AppTab, AppToast, TabSource, TerminalTab, ToastKind } from './types'

/** 表单状态：新增（可带草稿，用于复制连接）、编辑或关闭 */
type EditorState =
  | { mode: 'new'; draft?: ConnectionVO; inheritFrom?: string }
  | { mode: 'edit'; vo: ConnectionVO }
  | null

/** 侧栏默认宽度（px）：比上一版的 272 更宽一些，长主机名不用挤 */
const SIDEBAR_DEFAULT_WIDTH = 300
/** 侧栏最小宽度 */
const SIDEBAR_MIN_WIDTH = 240
/** 侧栏最大宽度：为工作区保留 480px，再扣掉 6px 的分隔条列，窄窗口下也不会把终端压没 */
const SIDEBAR_MAX_WIDTH = 560
/** 工作区保底可用宽度（含分隔条） */
const WORKSPACE_MIN_WIDTH = 486
/** 侧栏宽度持久化键 */
const SIDEBAR_WIDTH_KEY = 'ssh-client:sidebar-width'

/**
 * 当前窗口下侧栏允许的最大宽度。
 * @returns 最大宽度（px）
 */
function sidebarMaxWidth(): number {
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth - WORKSPACE_MIN_WIDTH)
  )
}

/**
 * 把任意宽度收拢到合法区间。
 * @param width 目标宽度
 * @returns 收拢后的宽度
 */
function clampSidebarWidth(width: number): number {
  return Math.min(Math.max(Math.round(width), SIDEBAR_MIN_WIDTH), sidebarMaxWidth())
}

/**
 * 读取上次保存的侧栏宽度。
 * @returns 合法宽度，缺失或非法时返回默认值
 */
function readSidebarWidth(): number {
  const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
  return Number.isFinite(raw) && raw > 0 ? clampSidebarWidth(raw) : SIDEBAR_DEFAULT_WIDTH
}

/** 会话区状态：标签与激活项合并维护，避免出现激活项已被关闭的中间态 */
interface SessionState {
  tabs: AppTab[]
  activeId: string | null
}

/** 主机密钥变更弹窗的上下文，确认后按同样的入参重试连接 */
interface HostKeyPrompt {
  change: HostKeyChangeVO
  source: TabSource
  title?: string
  /** 原连接类型，决定重试时走终端还是 SFTP */
  target: 'terminal' | 'sftp'
}

/** 初始会话状态 */
const EMPTY_SESSION: SessionState = { tabs: [], activeId: null }

/** 单会话首屏输出缓冲上限（字节），超出后丢弃最旧分片，避免异常场景下内存无限增长 */
const PENDING_OUTPUT_LIMIT = 1024 * 1024

/**
 * 把连接建立瞬间到达、但终端标签还没挂载的输出压入缓冲区。
 * 主进程 open 返回时 shell 可能已经吐出了欢迎语，而 xterm 实例要等 React 挂载后才注册写入函数，
 * 这段时间的输出如果直接丢弃，用户就会看到一个空白的首屏。
 * @param buffer 会话 id 到待回放分片的映射
 * @param sessionId 会话 id
 * @param data 远端输出的原始字节
 */
function appendPendingOutput(
  buffer: Map<string, Uint8Array[]>,
  sessionId: string,
  data: Uint8Array
): void {
  const chunks = buffer.get(sessionId) ?? []
  chunks.push(data)
  let total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  while (total > PENDING_OUTPUT_LIMIT && chunks.length > 1) {
    const removed = chunks.shift()
    total -= removed ? removed.length : 0
  }
  buffer.set(sessionId, chunks)
}

/**
 * 把连接来源整理成可读文案，用于连接中的状态提示。
 * @param source 连接来源
 * @returns 形如 user@host:22 的文案
 */
function describeSource(source: TabSource): string {
  const inline = source.inline
  return inline ? `${inline.username}@${inline.host}:${inline.port}` : '已保存的连接'
}

/**
 * 应用根组件，负责连接列表、工作区标签、表单与全局提示的状态编排。
 * @returns 应用界面元素
 */
function App(): React.JSX.Element {
  const [connections, setConnections] = useState<ConnectionVO[]>([])
  const [session, setSession] = useState<SessionState>(EMPTY_SESSION)
  const [editor, setEditor] = useState<EditorState>(null)
  const [secureAvailable, setSecureAvailable] = useState(true)
  const [toast, setToast] = useState<AppToast | null>(null)
  /** 正在建立的连接描述，非空时在工作区顶部显示进度条 */
  const [pendingLabel, setPendingLabel] = useState<string | null>(null)
  const [hostKey, setHostKey] = useState<HostKeyPrompt | null>(null)
  const [trusting, setTrusting] = useState(false)
  /** 上次退出时留下的会话快照，非空时显示恢复提示条 */
  const [restore, setRestore] = useState<SessionSnapshotVO | null>(null)
  const [restoring, setRestoring] = useState(false)
  /** 侧栏宽度（px）：可拖动、可键盘微调，并持久化到 localStorage */
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readSidebarWidth())
  /** 是否正在拖动分隔条，仅用于切换拖动态样式 */
  const [resizing, setResizing] = useState(false)
  /** 拖动中的最新宽度：pointermove 里读 ref，避免高频 setState 依赖 */
  const sidebarWidthRef = useRef(sidebarWidth)

  /** sessionId 到 xterm 写入函数，输出按会话精确分发，避免每个标签各自过滤全量数据 */
  const writers = useRef(new Map<string, (data: Uint8Array) => void>())

  /** sessionId 到「写入函数注册前到达的输出」，注册时按序回放，保证首屏不丢内容 */
  const pendingOutput = useRef(new Map<string, Uint8Array[]>())

  /** 提示条自增序号，用于重置自动关闭计时器 */
  const toastSeq = useRef(0)
  const toastTimer = useRef<number | undefined>(undefined)

  /**
   * 弹出一条提示。
   * 成功与普通信息 3 秒后自动消失，错误保留 8 秒，用户也可以随时点掉。
   * @param kind 提示类型
   * @param text 提示文案
   */
  const showToast = useCallback((kind: ToastKind, text: string): void => {
    window.clearTimeout(toastTimer.current)
    toastSeq.current += 1
    setToast({ id: toastSeq.current, kind, text })
    toastTimer.current = window.setTimeout(() => setToast(null), kind === 'error' ? 8000 : 3000)
  }, [])

  /** 重新拉取连接列表 */
  const refresh = useCallback(async (): Promise<void> => {
    setConnections(await window.api.connections.list())
  }, [])

  // 初始化：读取连接列表、系统安全存储能力与默认用户名（快速连接用）
  useEffect(() => {
    window.api.connections
      .list()
      .then(setConnections)
      .catch((err) => showToast('error', toMessage(err)))
    window.api.system
      .secureAvailable()
      .then(setSecureAvailable)
      .catch(() => undefined)
    // 上次退出时若还有会话，交给用户决定是否恢复（自动连服务器会让人意外）
    window.api.session
      .load()
      .then((snapshot) => setRestore(snapshot && snapshot.tabs.length > 0 ? snapshot : null))
      .catch(() => undefined)
  }, [showToast])

  // 标签变化后延迟写入会话快照：只记录已保存连接的 id 与类型，不落盘任何凭据
  useEffect(() => {
    const tabs = session.tabs
      .map((tab) => ({ kind: tab.kind, connectionId: tab.source.connectionId }))
      .filter((item): item is SessionTabDTO => Boolean(item.connectionId))
    // 空会话不覆盖上次的快照，否则启动时的空状态会把恢复机会抹掉
    if (tabs.length === 0) return
    const timer = window.setTimeout(
      () => void window.api.session.save({ tabs, savedAt: Date.now() }),
      800
    )
    return () => window.clearTimeout(timer)
  }, [session.tabs])

  // 组件卸载时清掉提示计时器，避免对已卸载组件写入状态
  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  // 全局订阅一次终端事件，按 sessionId 路由到对应终端实例
  useEffect(() => {
    const offData = window.api.terminal.onData((sessionId, data) => {
      const writer = writers.current.get(sessionId)
      if (writer) {
        writer(data)
        return
      }
      // 终端标签还没挂载完，先缓冲，等 registerWriter 时回放
      appendPendingOutput(pendingOutput.current, sessionId, data)
    })
    const offExit = window.api.terminal.onExit((sessionId, reason) => {
      setSession((prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) =>
          tab.kind === 'terminal' && tab.id === sessionId ? { ...tab, exitReason: reason } : tab
        )
      }))
    })
    return () => {
      offData()
      offExit()
    }
  }, [])

  // 窗口标题跟随当前标签，便于在任务栏与多窗口场景下区分会话
  useEffect(() => {
    const active = session.tabs.find((tab) => tab.id === session.activeId)
    document.title = active ? `${active.title} · SSH 客户端` : 'SSH 客户端'
  }, [session.tabs, session.activeId])

  /**
   * 注册终端写入函数，并回放注册前缓冲的输出。
   * @param sessionId 会话 id
   * @param writer 写入函数
   */
  const registerWriter = useCallback(
    (sessionId: string, writer: (data: Uint8Array) => void): void => {
      writers.current.set(sessionId, writer)
      const chunks = pendingOutput.current.get(sessionId)
      if (!chunks) return
      pendingOutput.current.delete(sessionId)
      // 按到达顺序回放，xterm 的 UTF-8 解码器会正确处理跨分片的多字节字符
      chunks.forEach((chunk) => writer(chunk))
    },
    []
  )

  /**
   * 注销终端写入函数。
   * @param sessionId 会话 id
   */
  const unregisterWriter = useCallback((sessionId: string): void => {
    writers.current.delete(sessionId)
    // 标签已卸载，残留的缓冲不会再有人消费
    pendingOutput.current.delete(sessionId)
  }, [])

  /**
   * 打开一个终端标签。
   * 连接期间在工作区顶部显示进度，失败时提示；主机密钥变更则转为让用户核对的弹窗。
   * @param source 连接来源，已保存连接或临时连接
   * @param title 标签标题，缺省时用主进程返回的标题
   */
  const openTerminal = useCallback(
    async (source: TabSource, title?: string): Promise<void> => {
      setPendingLabel(`正在连接 ${title || describeSource(source)} …`)
      try {
        const vo = await window.api.terminal.open({
          connectionId: source.connectionId,
          inline: source.inline,
          // 先用默认尺寸建立会话，终端挂载后由 FitAddon 立即校准真实行列数
          cols: 80,
          rows: 24
        })
        setSession((prev) => ({
          tabs: [
            ...prev.tabs,
            { kind: 'terminal', id: vo.sessionId, title: title || vo.title, source }
          ],
          activeId: vo.sessionId
        }))
      } catch (err) {
        const change = asHostKeyChanged(err)
        if (change) setHostKey({ change, source, title, target: 'terminal' })
        else showToast('error', toMessage(err))
      } finally {
        setPendingLabel(null)
      }
    },
    [showToast]
  )

  /**
   * 打开一个 SFTP 标签，与终端共享同一条底层 SSH 连接。
   * @param source 连接来源，已保存连接或临时连接
   * @param title 标签标题，缺省时用主进程返回的标题
   */
  const openSftp = useCallback(
    async (source: TabSource, title?: string): Promise<void> => {
      setPendingLabel(`正在打开文件管理 ${title || describeSource(source)} …`)
      try {
        const vo = await window.api.sftp.open({
          connectionId: source.connectionId,
          inline: source.inline
        })
        setSession((prev) => ({
          tabs: [
            ...prev.tabs,
            { kind: 'sftp', id: vo.sftpId, title: title || vo.title, source, home: vo.home }
          ],
          activeId: vo.sftpId
        }))
      } catch (err) {
        const change = asHostKeyChanged(err)
        if (change) setHostKey({ change, source, title, target: 'sftp' })
        else showToast('error', toMessage(err))
      } finally {
        setPendingLabel(null)
      }
    },
    [showToast]
  )

  /**
   * 用户核对指纹后信任变更后的主机密钥，并按原入参重试连接。
   */
  const trustAndRetry = useCallback(async (): Promise<void> => {
    if (!hostKey) return
    setTrusting(true)
    try {
      await window.api.system.trustHostKey(hostKey.change.host, hostKey.change.port)
      const { source, title, target } = hostKey
      setHostKey(null)
      if (target === 'terminal') await openTerminal(source, title)
      else await openSftp(source, title)
    } catch (err) {
      showToast('error', toMessage(err))
    } finally {
      setTrusting(false)
    }
  }, [hostKey, openSftp, openTerminal, showToast])

  /**
   * 关闭标签及其会话，按标签种类调用对应的关闭通道。
   * @param id 会话 id
   */
  const closeTab = useCallback(
    (id: string): void => {
      const target = session.tabs.find((tab) => tab.id === id)
      if (target?.kind === 'sftp') window.api.sftp.close(id)
      else if (target?.kind === 'terminal') window.api.terminal.close(id)
      // 会话已关闭，未消费的缓冲没有意义
      pendingOutput.current.delete(id)

      setSession((prev) => {
        const tabs = prev.tabs.filter((tab) => tab.id !== id)
        // 关闭的正是当前标签时，回退到最后一个剩余标签
        const activeId = prev.activeId === id ? (tabs[tabs.length - 1]?.id ?? null) : prev.activeId
        return { tabs, activeId }
      })
    },
    [session.tabs]
  )

  /** 关闭当前激活标签 */
  const closeActiveTab = useCallback((): void => {
    if (session.activeId) closeTab(session.activeId)
  }, [closeTab, session.activeId])

  /** 已有打开会话的连接 id，用于在侧边栏把这些连接标成"已连接" */
  const activeConnectionIds = session.tabs
    .map((tab) => tab.source.connectionId)
    .filter((id): id is string => Boolean(id))

  // 窗口变窄时把侧栏收拢回合法区间，避免工作区被压到不可用
  useEffect(() => {
    const onWindowResize = (): void => setSidebarWidth((prev) => clampSidebarWidth(prev))
    window.addEventListener('resize', onWindowResize)
    return () => window.removeEventListener('resize', onWindowResize)
  }, [])

  /**
   * 应用并持久化侧栏宽度。
   * @param width 目标宽度，会被收拢到合法区间
   */
  const applySidebarWidth = useCallback((width: number): void => {
    const next = clampSidebarWidth(width)
    sidebarWidthRef.current = next
    setSidebarWidth(next)
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next))
  }, [])

  /** 双击分隔条复位到默认宽度 */
  const resetSidebarWidth = useCallback((): void => {
    applySidebarWidth(SIDEBAR_DEFAULT_WIDTH)
  }, [applySidebarWidth])

  /**
   * 开始拖动分隔条。
   * @param event 指针事件
   */
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizing(true)
    document.body.classList.add('resizing')
  }

  /**
   * 拖动中实时更新宽度：侧栏贴着窗口左边，指针的 clientX 就是目标宽度。
   * @param event 指针事件
   */
  const moveResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!resizing) return
    const next = clampSidebarWidth(event.clientX)
    sidebarWidthRef.current = next
    setSidebarWidth(next)
  }

  /**
   * 结束拖动并落盘。
   * @param event 指针事件
   */
  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!resizing) return
    setResizing(false)
    document.body.classList.remove('resizing')
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidthRef.current))
  }

  /**
   * 方向键微调侧栏宽度，Home 复位；Shift 加大步长。
   * @param event 键盘事件
   */
  const resizeByKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 48 : 16
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      applySidebarWidth(sidebarWidth - step)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      applySidebarWidth(sidebarWidth + step)
    } else if (event.key === 'Home') {
      event.preventDefault()
      applySidebarWidth(SIDEBAR_DEFAULT_WIDTH)
    }
  }

  /**
   * 切换到相邻标签。
   * @param step 偏移量，+1 下一个、-1 上一个
   */
  const cycleTab = useCallback((step: number): void => {
    setSession((prev) => {
      if (prev.tabs.length < 2) return prev
      const index = prev.tabs.findIndex((tab) => tab.id === prev.activeId)
      const next = (index + step + prev.tabs.length) % prev.tabs.length
      return { ...prev, activeId: prev.tabs[next].id }
    })
  }, [])

  /**
   * 激活指定序号的标签。
   * @param index 从 0 开始的标签序号
   */
  const activateTabAt = useCallback((index: number): void => {
    setSession((prev) => (prev.tabs[index] ? { ...prev, activeId: prev.tabs[index].id } : prev))
  }, [])

  // 全局快捷键：标签切换与关闭、新建连接。输入框内不触发，Ctrl+Tab 例外
  useEffect(() => {
    /**
     * 判断事件目标是否为可编辑控件，避免在输入框里误触全局快捷键。
     * @param target 事件目标
     * @returns 是否可编辑
     */
    const isEditable = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null
      if (!element) return false
      const tag = element.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable
    }

    /**
     * 处理全局按键。
     * @param event 键盘事件
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault()
        cycleTab(event.shiftKey ? -1 : 1)
        return
      }
      if (isEditable(event.target)) return
      if (event.ctrlKey && event.shiftKey && (event.key === 'W' || event.key === 'w')) {
        event.preventDefault()
        closeActiveTab()
        return
      }
      if (
        event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        (event.key === 'n' || event.key === 'N')
      ) {
        event.preventDefault()
        setEditor({ mode: 'new' })
        return
      }
      if (event.altKey && /^[1-9]$/.test(event.key)) {
        event.preventDefault()
        activateTabAt(Number(event.key) - 1)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activateTabAt, closeActiveTab, cycleTab])

  /**
   * 用原配置重建终端会话。
   * @param tab 待重连的终端标签
   */
  const reconnect = useCallback(
    (tab: TerminalTab): void => {
      closeTab(tab.id)
      void openTerminal(tab.source, tab.title)
    },
    [closeTab, openTerminal]
  )

  /**
   * 保存连接并刷新列表。
   * @param dto 保存入参
   */
  const saveConnection = useCallback(
    async (dto: SaveConnectionDTO): Promise<void> => {
      await window.api.connections.save(dto)
      setEditor(null)
      await refresh()
      showToast('success', '连接已保存')
    },
    [refresh, showToast]
  )

  /**
   * 复制连接：用原配置打开一个新建表单草稿，并把已保存的凭据一并带过去。
   * @param vo 被复制的连接
   */
  const duplicateConnection = useCallback((vo: ConnectionVO): void => {
    const label = vo.name || `${vo.username}@${vo.host}`
    setEditor({
      mode: 'new',
      // id 置空表示新增；凭据由表单从源连接读取回显，保存后副本即可直接连接
      draft: { ...vo, id: '', name: `${label} 副本` },
      inheritFrom: vo.id
    })
  }, [])

  /**
   * 按快照逐个重开上次的标签。
   * 连接已被删除的标签会跳过，最后清掉快照避免下次再问。
   */
  const restoreSession = useCallback(async (): Promise<void> => {
    if (!restore) return
    setRestoring(true)
    let opened = 0
    try {
      for (const tab of restore.tabs) {
        const vo = connections.find((item) => item.id === tab.connectionId)
        if (!vo) continue
        if (tab.kind === 'terminal') await openTerminal({ connectionId: vo.id }, vo.name)
        else await openSftp({ connectionId: vo.id }, vo.name)
        opened += 1
      }
      await window.api.session.clear()
      setRestore(null)
      showToast(opened > 0 ? 'success' : 'info', `已恢复 ${opened} 个会话`)
    } catch (err) {
      showToast('error', toMessage(err))
    } finally {
      setRestoring(false)
    }
  }, [connections, openSftp, openTerminal, restore, showToast])

  /** 忽略上次的会话快照并清掉，避免每次启动都被追问 */
  const dismissRestore = useCallback((): void => {
    void window.api.session.clear()
    setRestore(null)
  }, [])

  /**
   * 删除连接，删除前二次确认。
   * @param vo 待删除的连接
   */
  const removeConnection = useCallback(
    async (vo: ConnectionVO): Promise<void> => {
      const label = vo.name || `${vo.username}@${vo.host}`
      if (!window.confirm(`确认删除连接「${label}」？`)) return
      try {
        await window.api.connections.remove(vo.id)
        await refresh()
      } catch (err) {
        showToast('error', toMessage(err))
      }
    },
    [refresh, showToast]
  )

  return (
    <div className="app" style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}>
      <ConnectionList
        connections={connections}
        secureAvailable={secureAvailable}
        activeIds={activeConnectionIds}
        onConnect={(vo) => void openTerminal({ connectionId: vo.id }, vo.name)}
        onOpenSftp={(vo) => void openSftp({ connectionId: vo.id }, vo.name)}
        onCreate={() => setEditor({ mode: 'new' })}
        onDuplicate={duplicateConnection}
        onEdit={(vo) => setEditor({ mode: 'edit', vo })}
        onRemove={removeConnection}
        onNotify={showToast}
      />

      {/* 侧栏与工作区之间的拖拽手柄：拖动改宽度，双击复位，方向键微调 */}
      <div
        className={resizing ? 'splitter dragging' : 'splitter'}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧栏宽度"
        aria-valuenow={Math.round(sidebarWidth)}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={sidebarMaxWidth()}
        tabIndex={0}
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onDoubleClick={resetSidebarWidth}
        onKeyDown={resizeByKeyboard}
      />

      <main className="workspace">
        {restore && (
          <SessionRestoreBar
            snapshot={restore}
            titles={Object.fromEntries(connections.map((vo) => [vo.id, vo.name || vo.host]))}
            busy={restoring}
            onRestore={() => void restoreSession()}
            onDismiss={dismissRestore}
          />
        )}

        {pendingLabel && (
          <div className="status-bar" role="status" aria-live="polite">
            <span className="status-spinner" />
            <span className="status-text">{pendingLabel}</span>
          </div>
        )}

        <WorkspaceTabs
          tabs={session.tabs}
          activeId={session.activeId}
          onActivate={(id) => setSession((prev) => ({ ...prev, activeId: id }))}
          onClose={closeTab}
          onReconnect={reconnect}
          registerWriter={registerWriter}
          unregisterWriter={unregisterWriter}
        />
      </main>

      {editor && (
        <ConnectionForm
          initial={editor.mode === 'edit' ? editor.vo : editor.draft}
          isNew={editor.mode !== 'edit'}
          inheritedCredentialFrom={editor.mode === 'new' ? editor.inheritFrom : undefined}
          inheritedCredentialName={
            editor.mode === 'new' && editor.draft
              ? editor.draft.name.replace(/ 副本$/, '')
              : undefined
          }
          onSubmit={saveConnection}
          onCancel={() => setEditor(null)}
        />
      )}

      {hostKey && (
        <HostKeyDialog
          change={hostKey.change}
          busy={trusting}
          onTrust={() => void trustAndRetry()}
          onCancel={() => setHostKey(null)}
        />
      )}

      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
    </div>
  )
}

export default App
