import {
  app,
  dialog,
  type BrowserWindow,
  type OpenDialogOptions,
  type SaveDialogOptions
} from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { homedir, userInfo } from 'os'
import { extname, join } from 'path'
import type { ConnectionVO, ExportResultVO, ImportResultVO, SaveConnectionDTO } from '@shared/types'
import { listConnections, saveConnection } from './store'

/** 未写端口时使用的默认端口 */
const DEFAULT_PORT = 22

/** 解析中的一个 Host 块，字段沿用 OpenSSH 关键字的语义 */
interface HostBlock {
  /** Host 所在行号（从 1 开始），用于错误提示定位 */
  line: number
  /** Host 别名列表 */
  aliases: string[]
  hostName?: string
  user?: string
  port?: number
  identityFile?: string
}

/** 一次解析的结果：可用草稿与逐条跳过原因 */
interface ParseResult {
  drafts: SaveConnectionDTO[]
  errors: string[]
}

/**
 * 把 `~` 展开为当前用户主目录。
 * @param value 配置里出现的路径
 * @returns 展开后的路径；不含 `~` 时原样返回
 */
function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * 把 JSON 里的任意值转成去空白的字符串。
 * @param value 原始值
 * @returns 非字符串或全空白时返回空串
 */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 把导入的端口规范成合法端口。
 * @param value 原始端口值
 * @returns 1-65535 的整数端口，非法时回退 22
 */
function normalizePort(value: unknown): number {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT
}

/**
 * 生成重复判定键，与用户视角的「同一个连接」一致。
 * @param item 连接草稿或出参
 * @returns 名称、主机、端口、用户名拼成的键
 */
function dedupeKey(item: SaveConnectionDTO | ConnectionVO): string {
  return [item.name, item.host, item.port, item.username].join('\u0000')
}

/**
 * 解析 OpenSSH 客户端配置。
 * 只识别 Host / HostName / User / Port / IdentityFile 五个关键字，其余关键字（含 Include）按未知项忽略，
 * 注释与空行跳过；同一个关键字重复出现时保持 OpenSSH 的「首次取值生效」语义。
 * 含 `*` / `?` 通配的 Host 块整块跳过并记入 errors，因为通配块本身不是一个可保存的具体连接。
 * @param content 配置文件文本
 * @returns 连接草稿与逐条跳过原因
 */
function parseOpenSshConfig(content: string): ParseResult {
  const result: ParseResult = { drafts: [], errors: [] }
  // 配置里没写 User 时 OpenSSH 用当前系统登录用户，这里保持一致
  const fallbackUser = userInfo().username
  let block: HostBlock | null = null

  /** 收尾当前 Host 块：按别名逐条生成草稿，没有 HostName 时别名即主机名 */
  const flush = (): void => {
    if (!block) return
    const current = block
    block = null
    if (current.aliases.some((alias) => alias.includes('*') || alias.includes('?'))) {
      result.errors.push(
        `第 ${current.line} 行：通配 Host「${current.aliases.join(' ')}」不支持导入，已跳过`
      )
      return
    }
    current.aliases.forEach((alias) => {
      result.drafts.push({
        name: alias,
        host: current.hostName ?? alias,
        port: current.port ?? DEFAULT_PORT,
        username: current.user ?? fallbackUser,
        // 有 IdentityFile 即按私钥认证导入，口令与密码一律不导入，连接时再让用户补
        authType: current.identityFile ? 'privateKey' : 'password',
        privateKeyPath: current.identityFile ? expandHome(current.identityFile) : undefined
      })
    })
  }

  content.split(/\r?\n/).forEach((rawLine, index) => {
    // `#` 之后是注释，行首行内一律截掉
    const line = rawLine.split('#')[0].trim()
    if (!line) return
    // 兼容 `Key value` 与 `Key=value` 两种写法
    const matched = /^([A-Za-z]+)\s*[=\s]\s*(.*)$/.exec(line)
    if (!matched) return
    const key = matched[1].toLowerCase()
    const value = matched[2].trim()
    if (key === 'host') {
      flush()
      const aliases = value.split(/\s+/).filter(Boolean)
      // Host 行没写别名时不是有效块，交给后续行继续匹配 Host
      block = aliases.length > 0 ? { line: index + 1, aliases } : null
      return
    }
    if (!block || !value) return
    if (key === 'hostname' && !block.hostName) block.hostName = value
    else if (key === 'user' && !block.user) block.user = value
    else if (key === 'port' && block.port === undefined) {
      const port = Number(value)
      if (Number.isInteger(port) && port >= 1 && port <= 65535) block.port = port
      else result.errors.push(`第 ${index + 1} 行：端口「${value}」不是合法端口，已按 22 处理`)
    } else if (key === 'identityfile' && !block.identityFile) {
      // 路径含空格时 OpenSSH 允许用引号包住，导出端也会加引号，这里必须对称地去掉
      block.identityFile = unquoteValue(value)
    }
  })
  flush()

  if (result.drafts.length === 0 && result.errors.length === 0) {
    result.errors.push('文件中没有找到可导入的 Host 配置')
  }
  return result
}

/**
 * 解析本应用导出的 JSON 连接数组。
 * 只读取导出契约里的字段，未知字段一律忽略；私钥路径同样只做 `~` 展开、不校验是否存在。
 * @param content JSON 文本
 * @returns 连接草稿与逐条跳过原因
 * @throws 文本不是合法 JSON 时抛出中文错误
 */
function parseJsonConnections(content: string): ParseResult {
  const result: ParseResult = { drafts: [], errors: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('JSON 文件格式不正确，无法解析')
  }
  if (!Array.isArray(parsed)) {
    result.errors.push('JSON 文件内容不是连接数组，无法导入')
    return result
  }

  const fallbackUser = userInfo().username
  parsed.forEach((row, index) => {
    const item = (row ?? {}) as Record<string, unknown>
    const host = text(item.host)
    if (!host) {
      result.errors.push(`第 ${index + 1} 条记录缺少主机地址，已跳过`)
      return
    }
    const username = text(item.username) || fallbackUser
    const keyPath = expandHome(text(item.privateKeyPath))
    // 认证方式与私钥路径必须自洽：只有私钥认证且确实带路径时才写 privateKeyPath
    const privateKeyPath = item.authType === 'privateKey' && keyPath ? keyPath : undefined
    result.drafts.push({
      name: text(item.name) || `${username}@${host}`,
      host,
      port: normalizePort(item.port),
      username,
      authType: privateKeyPath ? 'privateKey' : 'password',
      privateKeyPath,
      group: text(item.group) || undefined
    })
  })

  if (result.drafts.length === 0 && result.errors.length === 0) {
    result.errors.push('JSON 文件中没有连接记录')
  }
  return result
}

/**
 * 判断导入文件按哪种格式解析。
 * 优先看扩展名，其次看内容是否以数组开头，兼容导出文件被改名的场景。
 * @param filePath 文件路径
 * @param content 文件文本
 * @returns 是否按 JSON 解析
 */
function isJsonFile(filePath: string, content: string): boolean {
  return extname(filePath).toLowerCase() === '.json' || content.trimStart().startsWith('[')
}

/**
 * 生成 JSON 导出文本，只包含非敏感字段。
 * @param list 连接出参
 * @returns 格式化后的 JSON 文本
 */
function buildJsonText(list: ConnectionVO[]): string {
  const rows = list.map((vo) => ({
    name: vo.name,
    host: vo.host,
    port: vo.port,
    username: vo.username,
    authType: vo.authType,
    privateKeyPath: vo.privateKeyPath,
    group: vo.group
  }))
  return `${JSON.stringify(rows, null, 2)}\n`
}

/**
 * 生成 OpenSSH 的 Host 别名。
 * @param vo 连接出参
 * @returns 单段别名，名称里的空白替换为短横线以免破坏配置语法
 */
function buildAlias(vo: ConnectionVO): string {
  return (vo.name || `${vo.username}@${vo.host}`).replace(/\s+/g, '-')
}

/**
 * 按需给配置值加引号。
 * @param value 配置值
 * @returns 含空白时用双引号包住的片段，否则原样返回
 */
function quoteValue(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value
}

/**
 * 去掉配置值两端成对的引号。
 * 与 {@link quoteValue} 对称：导出时含空格的路径会加引号，导入时必须还原，
 * 否则 Windows 用户名带空格的用户会拿到一个带引号的私钥路径。
 * @param value 配置值
 * @returns 去掉外层引号后的值
 */
function unquoteValue(value: string): string {
  const text = value.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1)
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1)
  return text
}

/**
 * 生成 OpenSSH 客户端配置文本，每个连接一个 Host 块。
 * @param list 连接出参
 * @returns 可直接写入 ~/.ssh/config 的文本
 */
function buildOpenSshText(list: ConnectionVO[]): string {
  const blocks = list.map((vo) => {
    const lines = [
      `Host ${buildAlias(vo)}`,
      `  HostName ${vo.host}`,
      `  User ${vo.username}`,
      `  Port ${vo.port}`
    ]
    if (vo.authType === 'privateKey' && vo.privateKeyPath) {
      lines.push(`  IdentityFile ${quoteValue(vo.privateKeyPath)}`)
    }
    return lines.join('\n')
  })
  const header = '# 由 SSH 客户端导出，不含任何密码或私钥口令，导入后需重新填写凭据'
  return `${[header, ...blocks].join('\n\n')}\n`
}

/**
 * 从 OpenSSH 配置或本应用导出的 JSON 导入连接。
 * 重复连接（名称、主机、端口、用户名完全一致）计入 skipped，逐条原因写入 errors；
 * 导入的私钥路径只做 `~` 展开，不校验文件是否存在，连接失败时再提示用户。
 * @param win 发起对话框的窗口，为空时退化为无父窗口的对话框
 * @returns 导入结果；用户取消时返回 null
 */
export async function importConnectionsFromFile(
  win: BrowserWindow | null
): Promise<ImportResultVO | null> {
  const options: OpenDialogOptions = {
    title: '导入连接',
    properties: ['openFile'],
    filters: [
      { name: 'OpenSSH 配置', extensions: ['config', 'conf', 'txt'] },
      { name: 'JSON 连接文件', extensions: ['json'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  }
  const picked = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  if (picked.canceled || picked.filePaths.length === 0) return null

  const filePath = picked.filePaths[0]
  // 读取失败直接抛出：IPC 层会把错误转成渲染进程可展示的提示
  const content = readFileSync(filePath, 'utf8')
  const parsed = isJsonFile(filePath, content)
    ? parseJsonConnections(content)
    : parseOpenSshConfig(content)

  const errors = parsed.errors
  const seen = new Set(listConnections().map(dedupeKey))
  let imported = 0
  let skipped = 0
  parsed.drafts.forEach((dto) => {
    const key = dedupeKey(dto)
    if (seen.has(key)) {
      skipped += 1
      errors.push(`连接「${dto.name}」已存在，已跳过`)
      return
    }
    seen.add(key)
    try {
      // 复用 saveConnection：写入路径与手工新建完全一致，且天然不含任何凭据
      saveConnection(dto)
      imported += 1
    } catch (err) {
      skipped += 1
      errors.push(
        `连接「${dto.name}」导入失败：${err instanceof Error ? err.message : String(err)}`
      )
    }
  })

  return { imported, skipped, errors }
}

/**
 * 导出全部连接。
 * 只导出名称、主机、端口、用户名、认证方式、私钥路径与分组，绝不包含任何密码或口令；
 * 格式由保存框里的文件后缀决定：`.json` 导出 JSON，其余（.config/.conf/无后缀）导出 OpenSSH 配置。
 * @param win 发起对话框的窗口，为空时退化为无父窗口的对话框
 * @returns 导出结果；用户取消时返回 null
 */
export async function exportConnectionsToFile(
  win: BrowserWindow | null
): Promise<ExportResultVO | null> {
  const options: SaveDialogOptions = {
    title: '导出连接',
    defaultPath: join(app.getPath('documents'), 'ssh-connections.json'),
    filters: [
      { name: 'JSON 连接文件', extensions: ['json'] },
      { name: 'OpenSSH 配置', extensions: ['config', 'conf', 'txt'] }
    ]
  }
  const picked = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options)
  if (picked.canceled || !picked.filePath) return null

  const list = listConnections()
  const format = extname(picked.filePath).toLowerCase() === '.json' ? 'json' : 'openssh'
  writeFileSync(
    picked.filePath,
    format === 'json' ? buildJsonText(list) : buildOpenSshText(list),
    'utf8'
  )
  return { exported: list.length, path: picked.filePath, format }
}
