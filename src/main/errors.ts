/**
 * 主进程错误信息中文化。
 *
 * ssh2 与 Node 抛出的原始错误（ECONNREFUSED、client-authentication 等）直接抛给用户毫无意义，
 * 这里统一翻译成可读中文，并把原始错误码与原始信息附在末尾，既方便用户复述，也方便排查时对照日志。
 * 本模块只放纯函数、不依赖 electron，保证能被 verify 脚本单文件转译后直接加载。
 */

/** Node 与 ssh2 错误对象上可能出现的扩展字段 */
interface RawError extends Error {
  /** Node 网络层与文件系统错误码，或 SFTP 数字状态码 */
  code?: string | number
  /** ssh2 的错误分类，如 client-authentication、client-timeout */
  level?: string
}

/** SFTP 协议状态码到中文提示的映射，状态码取值见 ssh2 的 statuses 定义 */
const SFTP_STATUS: Record<number, string> = {
  2: '路径不存在',
  3: '权限不足，无法完成该操作',
  4: '服务端拒绝执行该操作',
  5: 'SFTP 报文异常',
  6: 'SFTP 连接不可用',
  7: 'SFTP 连接已断开，请重新打开面板',
  8: '服务端不支持该操作'
}

/** Node 网络层与文件系统错误码到中文提示的映射 */
const NODE_CODES: Record<string, string> = {
  ECONNREFUSED: '目标端口未开放或 SSH 服务未启动',
  ETIMEDOUT: '连接超时，目标主机未在超时时间内响应',
  ENOTFOUND: '主机名无法解析，请检查主机地址',
  EAI_AGAIN: '主机名解析暂时失败，请检查 DNS 与网络',
  EHOSTUNREACH: '网络不可达，目标主机不可达',
  ENETUNREACH: '网络不可达，请检查本机网络',
  ECONNRESET: '连接被对端重置，可能被防火墙或安全设备中断',
  EPIPE: '连接已被对端关闭',
  EHOSTDOWN: '目标主机不在线',
  ENETDOWN: '本机网络未启用',
  EACCES: '权限不足，没有访问权限',
  EPERM: '权限不足，操作被拒绝',
  ENOENT: '路径不存在',
  EISDIR: '目标是一个目录',
  ENOTDIR: '路径中包含非目录项',
  EEXIST: '目标已存在',
  ENOSPC: '磁盘空间不足',
  EROFS: '文件系统只读',
  EBUSY: '目标被占用',
  EMFILE: '同时打开的文件过多',
  ENAMETOOLONG: '路径过长'
}

/** ssh2 错误分类到中文提示的映射 */
const SSH_LEVELS: Record<string, string> = {
  'client-authentication': '用户名、密码或私钥不正确',
  'client-timeout': '连接超时，等待 SSH 握手超时，请检查网络与防火墙',
  'client-dns': '主机名无法解析，请检查主机地址或本机 DNS',
  'client-socket': '网络连接失败，请检查网络与防火墙',
  'client-protocol': 'SSH 协议协商失败，可能与服务端版本不兼容',
  'client-keepalive-timeout': '连接心跳超时，链路可能已被中断'
}

/**
 * 把任意抛出值规整成带扩展字段的 Error。
 * @param err 原始抛出值，可能是 Error、字符串或其他类型
 * @returns 规整后的错误对象
 */
function toRawError(err: unknown): RawError {
  if (err instanceof Error) return err as RawError
  return new Error(typeof err === 'string' ? err : String(err))
}

/**
 * 从错误对象提取可读的中文原因。
 * 判断顺序有讲究：超时与私钥相关的信息会同时命中多个特征，先说清具体原因再退回通用分类。
 * @param raw 规整后的原始错误
 * @returns 中文原因描述
 */
function describe(raw: RawError): string {
  const message = raw.message ?? ''

  // 超时优先判断：ssh2 的「等待握手或私钥口令超时」同时命中超时与口令两个特征
  if (/timed? ?out/i.test(message)) {
    if (/handshake/i.test(message)) return '连接超时：等待 SSH 握手超时，请检查网络与防火墙'
    if (/passphrase/i.test(message)) return '连接超时：等待私钥口令校验超时'
    return '连接超时'
  }
  // 私钥口令与私钥解析失败同属 client-authentication，先按信息细分，避免把口令错误说成账号密码错误
  if (/passphrase/i.test(message)) return '私钥口令不正确或未提供，请检查口令'
  if (/cannot parse privatekey|invalid key|unsupported key|no key/i.test(message))
    return '私钥文件无法解析或格式不受支持'
  if (typeof raw.code === 'number')
    return SFTP_STATUS[raw.code] ?? `服务端返回未知状态（${message || '无描述'}）`
  if (typeof raw.code === 'string' && NODE_CODES[raw.code]) return NODE_CODES[raw.code]
  if (raw.level && SSH_LEVELS[raw.level]) return SSH_LEVELS[raw.level]
  if (
    /all configured authentication methods failed|authentication fail|invalid password/i.test(
      message
    )
  )
    return '用户名、密码或私钥不正确'
  if (/host denied|host key verification failed|verification failed/i.test(message))
    return '主机密钥校验未通过，已拒绝连接'
  return message || '未知错误'
}

/**
 * 把 ssh2 / Node 的原始错误翻译成可读中文提示。
 * 结果形如「端口未开放或 SSH 服务未启动（连接 127.0.0.1:2222；原始错误码 ECONNREFUSED：…）」，
 * 前半句是给用户看的原因，括号里是场景与原始信息，便于排查时对照日志。
 * @param err 原始错误，允许是任意抛出值
 * @param scene 操作场景，用于说明在做什么，如「连接 10.0.0.1:22」「新建目录 /home/x」
 * @returns 新的 Error，message 为中文提示并保留原始错误码与原始信息
 */
export function toReadableError(err: unknown, scene: string): Error {
  const raw = toRawError(err)
  const detail =
    raw.code === undefined
      ? raw.message
        ? `原始信息：${raw.message}`
        : ''
      : `原始错误码 ${raw.code}${raw.message ? `：${raw.message}` : ''}`
  return new Error(`${describe(raw)}（${scene}${detail ? `；${detail}` : ''}）`, { cause: raw })
}
