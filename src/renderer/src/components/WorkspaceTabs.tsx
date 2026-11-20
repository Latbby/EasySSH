import TabBar from './TabBar'
import TerminalView from './TerminalView'
import SftpPanel from './SftpPanel'
import type { AppTab, TerminalTab } from '../types'

interface Props {
  tabs: AppTab[]
  activeId: string | null
  onActivate(id: string): void
  onClose(id: string): void
  onReconnect(tab: TerminalTab): void
  /** 见 TerminalView */
  registerWriter(sessionId: string, writer: (data: Uint8Array) => void): void
  /** 见 TerminalView */
  unregisterWriter(sessionId: string): void
}

/**
 * 工作区：顶部标签栏加下方的终端与 SFTP 面板。
 * 所有标签的内容都保持挂载，靠显隐切换，保证后台终端持续接收输出、SFTP 面板保留浏览位置。
 * @param props 见 Props
 * @returns 工作区元素
 */
function WorkspaceTabs({
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
      {/* 没有标签时不渲染标签栏，避免工作区顶部留下一条空条 */}
      {tabs.length > 0 && (
        <TabBar
          tabs={tabs}
          activeId={activeId}
          onActivate={onActivate}
          onClose={onClose}
          onReconnect={onReconnect}
        />
      )}

      <div className="panes">
        {tabs.map((tab) =>
          tab.kind === 'terminal' ? (
            <TerminalView
              key={tab.id}
              sessionId={tab.id}
              active={tab.id === activeId}
              exitReason={tab.exitReason}
              registerWriter={registerWriter}
              unregisterWriter={unregisterWriter}
            />
          ) : (
            <SftpPanel key={tab.id} sftpId={tab.id} home={tab.home} active={tab.id === activeId} />
          )
        )}

        {tabs.length === 0 && (
          <div className="empty-state">
            <p className="empty-title">还没有打开的会话</p>
            <p className="empty-hint">
              在左侧点击连接打开终端，或点 ⇅ 打开 SFTP 文件管理； 也可以直接在侧边栏顶部输入
              user@host:22 回车直连。
            </p>
            <div className="empty-keys">
              <span className="empty-key">
                <span className="kbd">Ctrl</span>
                <span className="kbd">N</span> 新建连接
              </span>
              <span className="empty-key">
                <span className="kbd">Ctrl</span>
                <span className="kbd">Tab</span> 切换标签
              </span>
              <span className="empty-key">
                <span className="kbd">Ctrl</span>
                <span className="kbd">F</span> 终端搜索
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default WorkspaceTabs
