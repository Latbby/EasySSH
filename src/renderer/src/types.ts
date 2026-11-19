import type { SaveConnectionDTO } from '@shared/types'

/** 标签的来源信息，用于断线重连或重新打开 */
export interface TabSource {
  connectionId?: string
  inline?: SaveConnectionDTO
}

/** 终端标签 */
export interface TerminalTab {
  kind: 'terminal'
  /** 主进程终端会话 id */
  id: string
  title: string
  source: TabSource
  /** 会话断开原因，连接正常时为 undefined */
  exitReason?: string
}

/** SFTP 标签 */
export interface SftpTab {
  kind: 'sftp'
  /** 主进程 SFTP 会话 id */
  id: string
  title: string
  source: TabSource
  /** 面板起始目录 */
  home: string
}

/** 工作区中打开的标签 */
export type AppTab = TerminalTab | SftpTab
