import { useRef } from 'react'
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
 * 键盘遵循 ARIA tabs 模式：左右方向键移动并激活，Home/End 跳到首尾，Enter/空格激活。
 * @param props 见 Props
 * @returns 标签栏元素
 */
function TabBar({ tabs, activeId, onActivate, onClose, onReconnect }: Props): React.JSX.Element {
  /** 标签元素引用，用于方向键移动后把焦点交给新激活的标签 */
  const tabRefs = useRef<(HTMLDivElement | null)[]>([])

  return (
    <div className="tabbar" role="tablist">
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          ref={(element) => {
            tabRefs.current[index] = element
          }}
          role="tab"
          aria-selected={tab.id === activeId}
          tabIndex={tab.id === activeId ? 0 : -1}
          className={tab.id === activeId ? 'tab active' : 'tab'}
          title={tab.kind === 'sftp' ? `${tab.title}（文件）` : tab.title}
          onClick={() => onActivate(tab.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onActivate(tab.id)
              return
            }
            // 方向键在标签之间移动：只有可聚焦的那个标签能收到按键，因此必须同时移动焦点
            let next = -1
            if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
            else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
            else if (event.key === 'Home') next = 0
            else if (event.key === 'End') next = tabs.length - 1
            if (next < 0) return
            event.preventDefault()
            onActivate(tabs[next].id)
            tabRefs.current[next]?.focus()
          }}
        >
          <span className={dotClass(tab)} />
          {/* 用终端与文件面板的符号代替文字徽标，窄标签下更省空间 */}
          <span className="tab-kind" aria-hidden="true">
            {tab.kind === 'sftp' ? '⇅' : '>_'}
          </span>
          <span className="tab-title">{tab.title}</span>

          {tab.kind === 'terminal' && tab.exitReason && (
            <button
              className="tab-icon persistent"
              title="重新连接"
              aria-label={`重新连接 ${tab.title}`}
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
            aria-label={`关闭 ${tab.title}`}
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
