import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionVO, SaveConnectionDTO } from '@shared/types'
import ConnectionList from './components/ConnectionList'
import ConnectionForm from './components/ConnectionForm'
import TerminalTabs from './components/TerminalTabs'
import { toMessage } from './utils'
import type { TerminalTab } from './types'

/** 表单状态：新增、编辑或关闭 */
type EditorState = { mode: 'new' } | { mode: 'edit'; vo: ConnectionVO } | null

/** 会话区状态：标签与激活项合并维护，避免出现激活项已被关闭的中间态 */
interface SessionState {
  tabs: TerminalTab[]
  activeId: string | null
}

/** 初始会话状态 */
const EMPTY_SESSION: SessionState = { tabs: [], activeId: null }

/**
 * 应用根组件，负责连接列表、终端标签与表单三者的状态编排。
 * @returns 应用界面元素
 */
function App(): React.JSX.Element {
  const [connections, setConnections] = useState<ConnectionVO[]>([])
  const [session, setSession] = useState<SessionState>(EMPTY_SESSION)
  const [editor, setEditor] = useState<EditorState>(null)
  const [secureAvailable, setSecureAvailable] = useState(true)
  const [toast, setToast] = useState<string | null>(null)

  /** sessionId 到 xterm 写入函数，输出按会话精确分发，避免每个标签各自过滤全量数据 */
  const writers = useRef(new Map<string, (data: Uint8Array) => void>())

  /** 重新拉取连接列表 */
  const refresh = useCallback(async (): Promise<void> => {
    setConnections(await window.api.connections.list())
  }, [])

  // 初始化：读取连接列表与系统安全存储能力
  useEffect(() => {
    window.api.connections
      .list()
      .then(setConnections)
      .catch((err) => setToast(toMessage(err)))
    window.api.system
      .secureAvailable()
      .then(setSecureAvailable)
      .catch(() => undefined)
  }, [])

  // 全局订阅一次终端事件，按 sessionId 路由到对应终端实例
  useEffect(() => {
    const offData = window.api.terminal.onData((sessionId, data) => {
      writers.current.get(sessionId)?.(data)
    })
    const offExit = window.api.terminal.onExit((sessionId, reason) => {
      setSession((prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) =>
          tab.sessionId === sessionId ? { ...tab, exitReason: reason } : tab
        )
      }))
    })
    return () => {
      offData()
      offExit()
    }
  }, [])

  /**
   * 注册终端写入函数。
   * @param sessionId 会话 id
   * @param writer 写入函数
   */
  const registerWriter = useCallback(
    (sessionId: string, writer: (data: Uint8Array) => void): void => {
      writers.current.set(sessionId, writer)
    },
    []
  )

  /**
   * 注销终端写入函数。
   * @param sessionId 会话 id
   */
  const unregisterWriter = useCallback((sessionId: string): void => {
    writers.current.delete(sessionId)
  }, [])

  /**
   * 打开一个终端标签。
   * @param source 连接来源，已保存连接或临时连接
   * @param title 标签标题，缺省时用主进程返回的标题
   */
  const openTerminal = useCallback(
    async (source: TerminalTab['source'], title?: string): Promise<void> => {
      try {
        const vo = await window.api.terminal.open({
          connectionId: source.connectionId,
          inline: source.inline,
          // 先用默认尺寸建立会话，终端挂载后由 FitAddon 立即校准真实行列数
          cols: 80,
          rows: 24
        })
        setSession((prev) => ({
          tabs: [...prev.tabs, { sessionId: vo.sessionId, title: title || vo.title, source }],
          activeId: vo.sessionId
        }))
      } catch (err) {
        setToast(toMessage(err))
      }
    },
    []
  )

  /**
   * 关闭标签及其会话。
   * @param sessionId 会话 id
   */
  const closeTab = useCallback((sessionId: string): void => {
    window.api.terminal.close(sessionId)
    setSession((prev) => {
      const tabs = prev.tabs.filter((tab) => tab.sessionId !== sessionId)
      // 关闭的正是当前标签时，回退到最后一个剩余标签
      const activeId =
        prev.activeId === sessionId ? (tabs[tabs.length - 1]?.sessionId ?? null) : prev.activeId
      return { tabs, activeId }
    })
  }, [])

  /**
   * 用原配置重建会话。
   * @param tab 待重连的标签
   */
  const reconnect = useCallback(
    (tab: TerminalTab): void => {
      closeTab(tab.sessionId)
      openTerminal(tab.source, tab.title)
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
    },
    [refresh]
  )

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
        setToast(toMessage(err))
      }
    },
    [refresh]
  )

  return (
    <div className="app">
      <ConnectionList
        connections={connections}
        secureAvailable={secureAvailable}
        onConnect={(vo) => openTerminal({ connectionId: vo.id }, vo.name)}
        onCreate={() => setEditor({ mode: 'new' })}
        onEdit={(vo) => setEditor({ mode: 'edit', vo })}
        onRemove={removeConnection}
      />

      <main className="workspace">
        <TerminalTabs
          tabs={session.tabs}
          activeId={session.activeId}
          onActivate={(sessionId) => setSession((prev) => ({ ...prev, activeId: sessionId }))}
          onClose={closeTab}
          onReconnect={reconnect}
          registerWriter={registerWriter}
          unregisterWriter={unregisterWriter}
        />
      </main>

      {editor && (
        <ConnectionForm
          initial={editor.mode === 'edit' ? editor.vo : undefined}
          onSubmit={saveConnection}
          onCancel={() => setEditor(null)}
        />
      )}

      {toast && (
        <div className="toast" onClick={() => setToast(null)} title="点击关闭">
          {toast}
        </div>
      )}
    </div>
  )
}

export default App
