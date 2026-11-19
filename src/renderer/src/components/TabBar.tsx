import type { AppTab, TerminalTab } from '../types'

interface Props {
  tabs: AppTab[]
  activeId: string | null
  /** 切换激活标签 */
  onActivate(id: string): void
  /** 关闭标签及其会话 */
  onClose(id: string): void
  /** 用原配置重建终端会话 */
  onReconnect(tab: TerminalTab): void
}

/**
 * 计算标签状态圆点的样式类。
 * @param tab 标签
 * @returns 样式类名
 */
function dotClass(tab: AppTab): string {
  if (tab.kind === 'sftp') return 'tab-dot sftp'
  return tab.exitReason ? 'tab-dot exited' : 'tab-dot'
}

/**
 * 工作区标签栏，终端与 SFTP 标签共用。
 * @param props 见 Props
 * @returns 标签栏元素
 */
function TabBar({ tabs, activeId, onActivate, onClose, onReconnect }: Props): React.JSX.Element {
  return (
    <div className="tabbar">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={tab.id === activeId ? 'tab active' : 'tab'}
          onClick={() => onActivate(tab.id)}
        >
          <span className={dotClass(tab)} />
          <span className="tab-kind">{tab.kind === 'sftp' ? '文件' : '终端'}</span>
          <span className="tab-title" title={tab.title}>
            {tab.title}
          </span>

          {tab.kind === 'terminal' && tab.exitReason && (
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
              onClose(tab.id)
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

export default TabBar
