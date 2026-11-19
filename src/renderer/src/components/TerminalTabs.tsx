import TerminalView from './TerminalView'
import type { TerminalTab } from '../types'

interface Props {
  tabs: TerminalTab[]
  activeId: string | null
  /** 切换激活标签 */
  onActivate(sessionId: string): void
  /** 关闭标签，同时关闭其会话 */
  onClose(sessionId: string): void
  /** 用原配置重新建立一个会话 */
  onReconnect(tab: TerminalTab): void
  /** 见 TerminalView */
  registerWriter(sessionId: string, writer: (data: Uint8Array) => void): void
  /** 见 TerminalView */
  unregisterWriter(sessionId: string): void
}

/**
 * 终端区：顶部标签栏加下方全部终端实例。
 * 所有标签的终端实例始终挂载，靠显隐切换，保证后台会话持续接收输出。
 * @param props 见 Props
 * @returns 终端区元素
 */
function TerminalTabs({
  tabs,
  activeId,
  onActivate,
  onClose,
  onReconnect,
  registerWriter,
  unregisterWriter
}: Props): React.JSX.Element {
  return (
    <div className="tabs-area">
      <div className="tabbar">
        {tabs.map((tab) => (
          <div
            key={tab.sessionId}
            className={tab.sessionId === activeId ? 'tab active' : 'tab'}
            onClick={() => onActivate(tab.sessionId)}
          >
            <span className={tab.exitReason ? 'tab-dot exited' : 'tab-dot'} />
            <span className="tab-title" title={tab.title}>
              {tab.title}
            </span>
            {tab.exitReason && (
              <button
                className="tab-icon"
                title="重新连接"
                onClick={(event) => {
                  event.stopPropagation()
                  onReconnect(tab)
                }}
              >
                ↻
              </button>
            )}
            <button
              className="tab-icon"
              title="关闭"
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.sessionId)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="terminals">
        {tabs.map((tab) => (
          <TerminalView
            key={tab.sessionId}
            sessionId={tab.sessionId}
            active={tab.sessionId === activeId}
            exitReason={tab.exitReason}
            registerWriter={registerWriter}
            unregisterWriter={unregisterWriter}
          />
        ))}

        {tabs.length === 0 && (
          <div className="empty-state">
            <p className="empty-title">还没有打开的会话</p>
            <p className="empty-hint">在左侧点击一个连接即可打开终端</p>
          </div>
        )}
      </div>
    </div>
  )
}

export default TerminalTabs
