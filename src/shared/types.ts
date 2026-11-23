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
  /** 分组名，空串或 undefined 表示未分组 */
  group?: string
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
  /** 分组名，空串或 undefined 表示未分组 */
  group?: string
}

/** 批量调整分组入参 */
export interface AssignGroupDTO {
  /** 目标连接 id 列表 */
  ids: string[]
  /** 目标分组名，空串表示移出分组 */
  group: string
}

/**
 * 连接凭据出参。
 * 仅供「编辑连接」表单按需回显已保存的密码与私钥口令，不参与列表查询；
 * 渲染进程只在用户显式打开某个连接的编辑表单时才会拿到它。
 */
export interface ConnectionCredentialVO {
  password?: string
  passphrase?: string
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

/** SFTP 目录项类型 */
export type SftpEntryType = 'file' | 'directory' | 'symlink'

/** SFTP 目录项出参 */
export interface SftpEntryVO {
  name: string
  /** 绝对路径 */
  path: string
  type: SftpEntryType
  /** 字节数，目录恒为 0 */
  size: number
  /** 修改时间戳（毫秒） */
  mtime: number
}

/** 打开 SFTP 会话入参 */
export interface OpenSftpDTO {
  /** 已保存连接 id，与 inline 二选一 */
  connectionId?: string
  /** 临时连接配置，不落盘 */
  inline?: SaveConnectionDTO
}

/** 同名远程文件的处理方式 */
export type SftpConflictAction = 'overwrite' | 'backup'

/** 上传指定本地文件入参，供拖拽上传使用（不弹系统选择框） */
export interface SftpUploadPathsDTO {
  sftpId: string
  /** 目标远程目录 */
  remoteDir: string
  /** 本地文件绝对路径列表 */
  localPaths: string[]
  /**
   * 同名远程文件的处理方式，缺省不改动：同名文件不上传，在结果里列为 conflicts 交给界面询问。
   * - overwrite：直接覆盖同名文件
   * - backup：先把同名文件改名为「原名.日期」（同日重复备份自动加 -2、-3）再上传
   */
  conflictAction?: SftpConflictAction
}

/** 因同名而未上传、等待用户确认的文件 */
export interface SftpUploadConflictVO {
  /** 本地文件绝对路径，用户确认后据此重试上传 */
  localPath: string
  /** 远程目标绝对路径 */
  remotePath: string
  /** 文件名，供界面展示 */
  name: string
}

/** 备份后上传时产生的备份记录 */
export interface SftpBackupVO {
  /** 原远程路径（已改名为备份） */
  from: string
  /** 备份后的远程路径 */
  to: string
  /** 文件名，供界面展示 */
  name: string
}

/** 上传结果出参：已上传文件、等待确认的同名文件、以及产生的备份 */
export interface SftpUploadResultVO {
  /** 上传成功的远程文件绝对路径 */
  uploaded: string[]
  /** 因同名未上传的文件；conflictAction 有值时恒为空 */
  conflicts: SftpUploadConflictVO[]
  /** backup 模式下被改名的旧文件 */
  backups: SftpBackupVO[]
}

/** 文件传输进度出参，主进程按块上报，供面板显示进度条 */
export interface SftpTransferVO {
  sftpId: string
  /** 文件名，用于提示当前传输对象 */
  name: string
  /** 传输方向 */
  direction: 'upload' | 'download'
  /** 已传输字节数 */
  transferred: number
  /** 总字节数，服务端未提供大小时为 0 */
  total: number
  /** 该文件是否已完成 */
  done: boolean
  /** 本次传输是否从断点续传开始 */
  resumed?: boolean
}

/** 远程文件编辑会话出参 */
export interface EditSessionVO {
  sftpId: string
  /** 远程文件绝对路径 */
  remotePath: string
  /** 下载到的本地临时文件路径 */
  localPath: string
  /** 会话状态：已打开、已回传保存内容、出错 */
  state: 'opened' | 'saved' | 'error'
  /** 出错时的中文说明 */
  message?: string
}

/** 会话恢复：单个标签的来源（只记录已保存连接的 id，绝不落盘凭据） */
export interface SessionTabDTO {
  kind: 'terminal' | 'sftp'
  connectionId: string
}

/** 会话恢复快照 */
export interface SessionSnapshotVO {
  tabs: SessionTabDTO[]
  /** 快照写入时间（毫秒时间戳） */
  savedAt: number
}

/** 打开 SFTP 会话出参 */
export interface OpenSftpVO {
  /** SFTP 会话 id，后续文件操作都以此为路由键 */
  sftpId: string
  /** 标签标题 */
  title: string
  /** 登录后的初始目录，作为面板起始路径 */
  home: string
}

/** IPC 通道名常量，主进程与 preload 共用，避免字符串拼写漂移 */
export const IPC = {
  connList: 'conn:list',
  connSave: 'conn:save',
  connRemove: 'conn:remove',
  connAssignGroup: 'conn:assign-group',
  connGroups: 'conn:groups',
  connGroupCreate: 'conn:group-create',
  connGroupRename: 'conn:group-rename',
  connGroupRemove: 'conn:group-remove',
  connCredential: 'conn:credential',
  secureAvailable: 'system:secure-available',
  pickPrivateKey: 'system:pick-private-key',
  clipboardRead: 'system:clipboard-read',
  clipboardWrite: 'system:clipboard-write',
  trustHostKey: 'system:trust-host-key',
  termOpen: 'term:open',
  termWrite: 'term:write',
  termResize: 'term:resize',
  termClose: 'term:close',
  termData: 'term:data',
  termExit: 'term:exit',
  sftpOpen: 'sftp:open',
  sftpClose: 'sftp:close',
  sftpList: 'sftp:list',
  sftpUpload: 'sftp:upload',
  sftpUploadPaths: 'sftp:upload-paths',
  sftpDownload: 'sftp:download',
  sftpMkdir: 'sftp:mkdir',
  sftpRemove: 'sftp:remove',
  sftpRename: 'sftp:rename',
  sftpTransfer: 'sftp:transfer',
  sftpEdit: 'sftp:edit',
  sftpEditEvent: 'sftp:edit-event',
  sessionSave: 'session:save',
  sessionLoad: 'session:load',
  sessionClear: 'session:clear'
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
    /** 批量调整连接所属分组 */
    assignGroup(dto: AssignGroupDTO): Promise<ConnectionVO[]>
    /**
     * 查询全部分组名。已登记的分组在前并保持创建顺序，
     * 仅由连接携带（老数据）的分组按名称排序追加在后面。
     */
    groups(): Promise<string[]>
    /** 新建分组，返回最新分组列表；名称为空或重复时抛错 */
    createGroup(name: string): Promise<string[]>
    /** 重命名分组并同步组内连接，返回最新分组列表 */
    renameGroup(from: string, to: string): Promise<string[]>
    /** 删除分组（组内连接变为未分组），返回最新分组列表 */
    removeGroup(name: string): Promise<string[]>
    /**
     * 读取某个连接已保存的凭据，仅供编辑表单按需回显。
     * 只接受连接 id，不提供批量接口，避免凭据被无关流程带回渲染进程。
     */
    getCredential(id: string): Promise<ConnectionCredentialVO>
  }
  /** 系统能力 */
  system: {
    /** 当前系统是否可安全存储凭据 */
    secureAvailable(): Promise<boolean>
    /** 弹出文件选择框挑选私钥，取消时返回 null */
    pickPrivateKey(): Promise<string | null>
    /** 读取系统剪贴板文本，终端粘贴用 */
    readClipboard(): Promise<string>
    /** 写入系统剪贴板，终端复制用 */
    writeClipboard(text: string): Promise<void>
    /** 用户核对后确认信任变更后的主机密钥，写入本机 known_hosts */
    trustHostKey(host: string, port: number): Promise<void>
    /**
     * 取拖拽进来的本地文件的绝对路径。
     * 入参是浏览器的 File 对象，这里用 unknown 声明以免 node 侧 tsconfig 依赖 DOM 类型。
     */
    pathForFile(file: unknown): string
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
  /** SFTP 文件操作，与终端复用同一条底层 SSH 连接 */
  sftp: {
    /** 打开 SFTP 会话 */
    open(dto: OpenSftpDTO): Promise<OpenSftpVO>
    /** 关闭 SFTP 会话 */
    close(sftpId: string): void
    /** 列出远程目录内容 */
    list(sftpId: string, path: string): Promise<SftpEntryVO[]>
    /**
     * 弹出文件选择框上传到指定远程目录。
     * 不传 conflictAction 时绝不覆盖：同名文件不上传，在结果的 conflicts 里返回交给界面询问。
     */
    upload(
      sftpId: string,
      remoteDir: string,
      conflictAction?: SftpConflictAction
    ): Promise<SftpUploadResultVO>
    /** 上传指定的本地文件（拖拽上传）；conflictAction 缺省时同名文件进入 conflicts */
    uploadPaths(dto: SftpUploadPathsDTO): Promise<SftpUploadResultVO>
    /** 弹出保存框下载远程文件，返回是否完成 */
    download(sftpId: string, remotePath: string): Promise<boolean>
    /** 新建远程目录 */
    mkdir(sftpId: string, path: string): Promise<void>
    /** 删除远程文件或目录，类型由主进程判断 */
    remove(sftpId: string, path: string): Promise<void>
    /** 重命名或移动远程路径 */
    rename(sftpId: string, oldPath: string, newPath: string): Promise<void>
    /** 订阅文件传输进度，返回取消订阅函数 */
    onTransfer(listener: (vo: SftpTransferVO) => void): () => void
    /** 用系统默认程序打开远程文件，保存后自动回传，返回编辑会话 */
    edit(sftpId: string, remotePath: string): Promise<EditSessionVO>
    /** 订阅编辑会话状态变化，返回取消订阅函数 */
    onEditEvent(listener: (vo: EditSessionVO) => void): () => void
  }
  /** 会话恢复：只记录已保存连接的 id 与标签类型，不落盘任何凭据 */
  session: {
    /** 保存当前会话快照 */
    save(snapshot: SessionSnapshotVO): Promise<void>
    /** 读取上次快照，无快照时返回 null */
    load(): Promise<SessionSnapshotVO | null>
    /** 清除快照（用户选择忽略时调用） */
    clear(): Promise<void>
  }
}
