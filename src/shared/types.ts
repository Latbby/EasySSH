/**
 * 主进程与渲染进程共享的类型定义。
 * 约定：接口入参一律使用 DTO、出参一律使用 VO，磁盘存储结构不外泄给渲染进程，
 * 且凭据只以明文形式存在于内存与 IPC 传输中，落盘前必须由 safeStorage 加密。
 */

/** 认证方式 */
export type AuthType = 'password' | 'privateKey'

/** 保存连接的入参，password / passphrase 为明文 */
export interface SaveConnectionDTO {
  /** 为空表示新增，有值表示更新 */
  id?: string
  /** 连接名称，仅用于列表展示 */
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  /** 登录密码；undefined 表示不修改，空串表示清除 */
  password?: string
  /** 私钥文件绝对路径 */
  privateKeyPath?: string
  /** 私钥口令；undefined 表示不修改，空串表示清除 */
  passphrase?: string
}

/** 连接列表出参，绝不包含任何形式的明文或密文凭据 */
export interface ConnectionVO {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  privateKeyPath?: string
  /** 是否已保存凭据 */
  hasCredential: boolean
  createdAt: number
}

/** 打开终端入参，支持已保存连接与一次性临时连接 */
export interface OpenTerminalDTO {
  /** 已保存连接 id，与 inline 二选一 */
  connectionId?: string
  /** 临时连接配置，不落盘 */
  inline?: SaveConnectionDTO
  cols: number
  rows: number
}

/** 打开终端出参 */
export interface OpenTerminalVO {
  /** 会话 id，后续读写与关闭都以此为路由键 */
  sessionId: string
  /** 标签标题 */
  title: string
}

/** IPC 通道名常量，主进程与 preload 共用，避免字符串拼写漂移 */
export const IPC = {
  connList: 'conn:list',
  connSave: 'conn:save',
  connRemove: 'conn:remove',
  secureAvailable: 'system:secure-available',
  pickPrivateKey: 'system:pick-private-key',
  termOpen: 'term:open',
  termWrite: 'term:write',
  termResize: 'term:resize',
  termClose: 'term:close',
  termData: 'term:data',
  termExit: 'term:exit'
} as const

/** 暴露给渲染进程的 API 契约，由 preload 实现 */
export interface SshClientApi {
  /** 连接配置管理 */
  connections: {
    /** 查询全部连接 */
    list(): Promise<ConnectionVO[]>
    /** 新增或更新连接 */
    save(dto: SaveConnectionDTO): Promise<ConnectionVO>
    /** 删除连接 */
    remove(id: string): Promise<void>
  }
  /** 系统能力 */
  system: {
    /** 当前系统是否可安全存储凭据 */
    secureAvailable(): Promise<boolean>
    /** 弹出文件选择框挑选私钥，取消时返回 null */
    pickPrivateKey(): Promise<string | null>
  }
  /** 终端会话 */
  terminal: {
    /** 打开一个终端标签 */
    open(dto: OpenTerminalDTO): Promise<OpenTerminalVO>
    /** 发送键盘输入 */
    write(sessionId: string, data: string): void
    /** 同步终端尺寸 */
    resize(sessionId: string, cols: number, rows: number): void
    /** 关闭会话 */
    close(sessionId: string): void
    /** 订阅远端输出，返回取消订阅函数；data 为原始字节，由 xterm 做 UTF-8 解码 */
    onData(listener: (sessionId: string, data: Uint8Array) => void): () => void
    /** 订阅会话结束事件，返回取消订阅函数 */
    onExit(listener: (sessionId: string, reason: string) => void): () => void
  }
}
