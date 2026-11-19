import type { SaveConnectionDTO } from '@shared/types'

/** 已打开的终端标签 */
export interface TerminalTab {
  /** 主进程会话 id，读写与关闭都以它为路由键 */
  sessionId: string
  /** 标签标题 */
  title: string
  /** 会话断开原因，连接正常时为 undefined */
  exitReason?: string
  /** 重连所需的来源信息 */
  source: { connectionId?: string; inline?: SaveConnectionDTO }
}
