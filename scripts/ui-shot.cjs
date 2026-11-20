/**
 * UI 视觉取证脚本：把真实 Electron 界面驱动到固定状态，逐个截成 PNG 并打印清单。
 *
 * 用途：UI 改版（布局 / 排版 / 间隔 / 配色）前后的可重复取证，供 lead 用 read_image 逐张看效果。
 *   1. 在 127.0.0.1:2222 起一个 ssh2 测试服务：接受任意认证、shell 回显真实感的会话内容、
 *      sftp 子系统挂一个内存文件系统（/home/tester 下有 docs/、logs/、readme.txt、deploy.sh 等）
 *   2. 启动 Electron：优先环境变量 E2E_ELECTRON_BIN（开发态，参数 ['.']，cwd 为仓库根，需先 npm run build），
 *      否则回退到 dist/win-unpacked/ssh-client.exe；固定调试端口 9444（与 e2e-smoke.cjs 的 9333 错开）
 *   3. 用 CDP 固定视口（默认 1360x860，--dpr 可放大像素密度），通过 DOM 事件与 window.api 驱动界面
 *   4. 依次截 11 张固定命名的 PNG，任一状态驱动失败都会打印原因并以非零码退出
 *
 * 用法：
 *   node scripts/ui-shot.cjs                             # 全部 11 张，输出到 scripts/ui-shots
 *   node scripts/ui-shot.cjs --out=scripts/ui-shots/after # 指定输出目录（清单里会打印实际目录）
 *   node scripts/ui-shot.cjs --only=03,05,07             # 只截指定编号（前置状态会自动准备）
 *   node scripts/ui-shot.cjs --dpr=2                     # 2 倍像素密度（1360x860 -> 2720x1720）
 *
 * 开发态前置：先 `npm run build` 产出 out/；E2E_ELECTRON_BIN 必须指向一份可用的 electron.exe。
 * 本机 node_modules/electron/dist/electron.exe 带 Low 完整性标签，开发态会以 0x80000003 退出，
 * 可复制一份到 %TEMP%（Medium 完整性）后指过去；脚本内不写死任何绕过路径：
 *   robocopy node_modules\electron\dist %TEMP%\ui-shot-electron /E
 *   $env:E2E_ELECTRON_BIN="$env:TEMP\ui-shot-electron\electron.exe"
 *
 * 输出状态（编号 - 文件名）：
 *   01-empty.png         空状态：没有任何连接、没有任何标签
 *   02-connections.png   6 个中文连接 + 空工作区
 *   03-terminal.png      终端标签，远端回显出一段真实感会话
 *   04-multi-tab.png     4 个标签（3 终端 + 1 文件），其中一个终端已退出
 *   05-search.png        终端 Ctrl+F 搜索栏展开并显示命中计数
 *   06-context-menu.png  终端右键菜单展开
 *   07-sftp.png          SFTP 面板列表（目录与文件）
 *   08-conn-form.png     新建连接表单，已切到私钥认证
 *   09-toast.png         连接未监听端口后的错误提示
 *   10-narrow.png        1024x680 窄视口下的终端状态（标签栏里同时有文件标签）
 *   11-min.png           780x520 最小窗口下的 4 标签 + SFTP 面板（断言标签栏不横向溢出）
 */
const { Server, utils } = require('ssh2')
const { spawn, spawnSync } = require('child_process')
const net = require('net')
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const { generateHostKey } = require('./host-key.cjs')

/** 仓库根目录 */
const PROJECT_ROOT = path.resolve(__dirname, '..')
/** 测试 SSH 服务端口 */
const SSH_PORT = 2222
/** 用来触发连接失败提示的未监听端口 */
const DEAD_PORT = 2299
/** Electron 远程调试端口，刻意与 e2e-smoke.cjs 的 9333 错开 */
const CDP_PORT = 9444
/** 默认输出目录；基线/改版对比建议用 --out 分流到子目录，避免互相覆盖 */
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, 'scripts', 'ui-shots')
/** 默认视口 */
const DEFAULT_VIEWPORT = { width: 1360, height: 860 }
/** 10-narrow 使用的窄视口 */
const NARROW_VIEWPORT = { width: 1024, height: 680 }
/** 11-min 使用的最小窗口视口（应用允许的最小尺寸 780x520） */
const MIN_VIEWPORT = { width: 780, height: 520 }
/** 步骤名到视口的映射，供截图尺寸断言与 setDeviceMetricsOverride 共用 */
const VIEWPORTS = { default: DEFAULT_VIEWPORT, narrow: NARROW_VIEWPORT, min: MIN_VIEWPORT }
/** 假想目标机的登录 home，与内存文件系统保持一致 */
const FAKE_HOME = '/home/tester'

/** 临时 userData 目录，在 main 里创建、收尾时删除，避免污染真实用户配置 */
let USER_DATA_DIR = null

/**
 * 预置的 6 个连接：前两个是仅展示的内网机器，可连的三个指向本地测试服务，
 * 这样侧边栏与标签标题都是中文，同时终端与 SFTP 截图有真实数据。
 */
const SAMPLE_CONNECTIONS = [
  { name: '生产 Web 服务器', host: '10.20.0.11', port: 22, username: 'web-deploy' },
  { name: '数据库主库', host: '10.20.0.31', port: 22, username: 'dbadmin' },
  { name: '测试环境', host: '127.0.0.1', port: SSH_PORT, username: 'tester' },
  { name: '跳板机', host: '127.0.0.1', port: SSH_PORT, username: 'ops' },
  { name: '备份节点', host: '10.20.0.51', port: 22, username: 'backup' },
  { name: '监控节点', host: '127.0.0.1', port: SSH_PORT, username: 'monitor' }
]

/**
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// 命令行参数
// ---------------------------------------------------------------------------

/**
 * 解析命令行参数。
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{only: Set<string>|null, outDir: string, dpr: number}} 运行选项
 * @throws 参数非法时抛错，由 main 统一打印并以非零码退出
 */
function parseOptions(argv) {
  const options = { only: null, outDir: DEFAULT_OUT_DIR, dpr: 1 }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    }
    if (arg.startsWith('--only=')) {
      const ids = arg
        .slice('--only='.length)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => item.padStart(2, '0'))
      const unknown = ids.filter((id) => !STEPS.some((step) => step.id === id))
      if (unknown.length > 0) {
        throw new Error(`--only 里有未知编号：${unknown.join(', ')}（可用编号 01-11）`)
      }
      if (ids.length === 0) throw new Error('--only 至少要给一个编号，例如 --only=03,05')
      options.only = new Set(ids)
      continue
    }
    if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length).trim()
      if (!value) throw new Error('--out 需要给出目录，例如 --out=scripts/ui-shots/after')
      options.outDir = path.resolve(PROJECT_ROOT, value)
      continue
    }
    if (arg.startsWith('--dpr=')) {
      const value = Number(arg.slice('--dpr='.length))
      if (!Number.isInteger(value) || value < 1 || value > 3) {
        throw new Error('--dpr 必须是 1-3 之间的整数')
      }
      options.dpr = value
      continue
    }
    throw new Error(`无法识别的参数：${arg}（用 --help 查看用法）`)
  }
  return options
}

/** 打印用法说明 */
function printUsage() {
  console.log(
    [
      '用法：node scripts/ui-shot.cjs [--out=<目录>] [--only=01,03] [--dpr=2]',
      '  --out=<目录>   输出目录，默认 scripts/ui-shots（清单里会打印实际使用的绝对路径）',
      '  --only=<编号>  只截指定编号，逗号分隔，例如 --only=03,05,07',      '  --dpr=<n>      像素密度，默认 1；2 表示 2 倍图（1360x860 -> 2720x1720）',
      '  --help         显示本说明'
    ].join('\n')
  )
}

// ---------------------------------------------------------------------------
// 测试服务端：内存文件系统 + shell + sftp
// ---------------------------------------------------------------------------

/** SFTP 协议状态码，取自协议定义 */
const SFTP_STATUS = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4 }
/** 文件类型掩码 */
const S_IFDIR = 0o040000
const S_IFREG = 0o100000

/**
 * 生成给定字节数的文本内容，用于让 SFTP 面板显示真实感的大小。
 * @param {number} size 字节数
 * @returns {Buffer} 内容缓冲区
 */
function filler(size) {
  const line = 'ssh-client ui-shot fixture line\n'
  const buffer = Buffer.alloc(size)
  for (let offset = 0; offset < size; offset += line.length) {
    buffer.write(line.slice(0, Math.min(line.length, size - offset)), offset, 'utf8')
  }
  return buffer
}

/** 内存文件系统：绝对路径 -> 节点。用于让 SFTP 面板在真实协议上跑通 */
const memfs = new Map()

/**
 * 相对当前时间往前推的毫秒时间戳，用于让列表里的修改时间错开。
 * @param {number} minutes 分钟数
 * @returns {number} 毫秒时间戳
 */
function minutesAgo(minutes) {
  return Date.now() - minutes * 60 * 1000
}

memfs.set('/', { type: 'dir', mtime: minutesAgo(60 * 24 * 200) })
memfs.set('/home', { type: 'dir', mtime: minutesAgo(60 * 24 * 200) })
memfs.set(FAKE_HOME, { type: 'dir', mtime: minutesAgo(60 * 24 * 30) })
memfs.set(`${FAKE_HOME}/docs`, { type: 'dir', mtime: minutesAgo(75) })
memfs.set(`${FAKE_HOME}/logs`, { type: 'dir', mtime: minutesAgo(8) })
memfs.set(`${FAKE_HOME}/docs/部署手册.md`, {
  type: 'file',
  content: filler(8192),
  mtime: minutesAgo(1400)
})
memfs.set(`${FAKE_HOME}/docs/接口说明.md`, {
  type: 'file',
  content: filler(4096),
  mtime: minutesAgo(2600)
})
memfs.set(`${FAKE_HOME}/logs/app.log`, {
  type: 'file',
  content: filler(1048576),
  mtime: minutesAgo(6)
})
memfs.set(`${FAKE_HOME}/logs/nginx-error.log`, {
  type: 'file',
  content: filler(32768),
  mtime: minutesAgo(34)
})
memfs.set(`${FAKE_HOME}/config.yaml`, {
  type: 'file',
  content: filler(2048),
  mtime: minutesAgo(4300)
})
memfs.set(`${FAKE_HOME}/deploy.sh`, {
  type: 'file',
  content: filler(1284),
  mtime: minutesAgo(96)
})
memfs.set(`${FAKE_HOME}/readme.txt`, {
  type: 'file',
  content: filler(412),
  mtime: minutesAgo(2600)
})
memfs.set(`${FAKE_HOME}/backup-2026-11-18.tar.gz`, {
  type: 'file',
  content: filler(5242880),
  mtime: minutesAgo(1600)
})

/**
 * 规范化远程路径。
 * @param {string} input 原始路径
 * @returns {string} 绝对路径
 */
function normalizePath(input) {
  const parts = []
  for (const segment of String(input).split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return `/${parts.join('/')}`
}

/**
 * 列出某个目录的直接子项。
 * @param {string} dir 目录路径
 * @returns {Array<[string, object, string]>} 路径、节点、名称三元组
 */
function childrenOf(dir) {
  const prefix = dir === '/' ? '/' : `${dir}/`
  const result = []
  for (const [fullPath, node] of memfs) {
    if (fullPath === dir || !fullPath.startsWith(prefix)) continue
    // 只取直接子项，更深层级由下一级目录负责
    const rest = fullPath.slice(prefix.length)
    if (rest.includes('/')) continue
    result.push([fullPath, node, rest])
  }
  return result
}

/**
 * 构造节点属性。
 * @param {object} node 文件系统节点
 * @returns {object} SFTP attrs
 */
function attrsOf(node) {
  const mtime = node.mtime ?? Date.now()
  return {
    mode: (node.type === 'dir' ? S_IFDIR : S_IFREG) | 0o644,
    size: node.type === 'file' ? node.content.length : 0,
    uid: 1000,
    gid: 1000,
    atime: Math.floor(mtime / 1000),
    mtime: Math.floor(mtime / 1000)
  }
}

/**
 * 把 sftp 通道接到内存文件系统上，实现面板浏览与文件操作所需的子集。
 * @param {import('ssh2').SFTPWrapper} sftp 服务端 SFTP 通道
 */
function serveSftp(sftp) {
  /** 句柄表：数字 id -> 打开的上下文 */
  const handles = new Map()
  let nextHandleId = 1

  /**
   * 登记一个句柄。
   * @param {object} context 句柄上下文
   * @returns {Buffer} 4 字节句柄
   */
  const makeHandle = (context) => {
    const id = nextHandleId
    nextHandleId += 1
    handles.set(id, context)
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32BE(id, 0)
    return buffer
  }

  /**
   * 取出句柄上下文。
   * @param {Buffer} buffer 句柄
   * @returns {object|undefined} 上下文
   */
  const getHandle = (buffer) => handles.get(buffer.readUInt32BE(0))

  /**
   * 回复 stat 类请求。
   * @param {number} reqid 请求 id
   * @param {string} target 目标路径
   */
  const replyStat = (reqid, target) => {
    const node = memfs.get(normalizePath(target))
    if (!node) return sftp.status(reqid, SFTP_STATUS.NO_SUCH_FILE)
    sftp.attrs(reqid, attrsOf(node))
  }

  sftp.on('REALPATH', (reqid, givenPath) => {
    // 与真实服务端一致：'.' 解析为登录用户的 home 目录
    const resolved = !givenPath || givenPath === '.' ? FAKE_HOME : normalizePath(givenPath)
    sftp.name(reqid, [
      {
        filename: resolved,
        longname: resolved,
        attrs: { mode: S_IFDIR | 0o755, size: 0, uid: 1000, gid: 1000, atime: 0, mtime: 0 }
      }
    ])
  })

  sftp.on('OPENDIR', (reqid, target) => {
    const node = memfs.get(normalizePath(target))
    if (!node) return sftp.status(reqid, SFTP_STATUS.NO_SUCH_FILE)
    if (node.type !== 'dir') return sftp.status(reqid, SFTP_STATUS.FAILURE)
    sftp.handle(reqid, makeHandle({ kind: 'dir', path: normalizePath(target), sent: false }))
  })

  sftp.on('READDIR', (reqid, handle) => {
    const context = getHandle(handle)
    if (!context || context.kind !== 'dir') return sftp.status(reqid, SFTP_STATUS.FAILURE)
    // 目录内容一次性给出，之后按协议回复 EOF
    if (context.sent) return sftp.status(reqid, SFTP_STATUS.EOF)
    context.sent = true
    sftp.name(
      reqid,
      childrenOf(context.path).map(([, node, name]) => ({
        filename: name,
        longname: `${node.type === 'dir' ? 'd' : '-'}rw-r--r-- 1 tester tester ${
          node.type === 'file' ? node.content.length : 0
        } Jan 1 00:00 ${name}`,
        attrs: attrsOf(node)
      }))
    )
  })

  sftp.on('OPEN', (reqid, filename, flags) => {
    const target = normalizePath(filename)
    const canWrite = (flags & 0x02) !== 0
    let node = memfs.get(target)
    if (!node && canWrite) {
      node = { type: 'file', content: Buffer.alloc(0), mtime: Date.now() }
      memfs.set(target, node)
    }
    if (!node) return sftp.status(reqid, SFTP_STATUS.NO_SUCH_FILE)
    if (node.type !== 'file') return sftp.status(reqid, SFTP_STATUS.FAILURE)
    if (canWrite && (flags & 0x10) !== 0) node.content = Buffer.alloc(0)
    sftp.handle(reqid, makeHandle({ kind: 'file', path: target }))
  })

  sftp.on('READ', (reqid, handle, offset, length) => {
    const context = getHandle(handle)
    const node = context ? memfs.get(context.path) : undefined
    if (!node || node.type !== 'file') return sftp.status(reqid, SFTP_STATUS.FAILURE)
    const chunk = node.content.subarray(offset, offset + length)
    if (chunk.length === 0) return sftp.status(reqid, SFTP_STATUS.EOF)
    sftp.data(reqid, chunk)
  })

  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const context = getHandle(handle)
    const node = context ? memfs.get(context.path) : undefined
    if (!node || node.type !== 'file') return sftp.status(reqid, SFTP_STATUS.FAILURE)
    const needed = offset + data.length
    if (node.content.length < needed) {
      const grown = Buffer.alloc(needed)
      node.content.copy(grown)
      node.content = grown
    }
    data.copy(node.content, offset)
    sftp.status(reqid, SFTP_STATUS.OK)
  })

  sftp.on('CLOSE', (reqid, handle) => {
    handles.delete(handle.readUInt32BE(0))
    sftp.status(reqid, SFTP_STATUS.OK)
  })

  sftp.on('STAT', (reqid, target) => replyStat(reqid, target))
  sftp.on('LSTAT', (reqid, target) => replyStat(reqid, target))

  sftp.on('FSTAT', (reqid, handle) => {
    const context = getHandle(handle)
    const node = context ? memfs.get(context.path) : undefined
    if (!node) return sftp.status(reqid, SFTP_STATUS.NO_SUCH_FILE)
    sftp.attrs(reqid, attrsOf(node))
  })

  sftp.on('MKDIR', (reqid, target) => {
    const full = normalizePath(target)
    if (memfs.has(full)) return sftp.status(reqid, SFTP_STATUS.FAILURE)
    memfs.set(full, { type: 'dir', mtime: Date.now() })
    sftp.status(reqid, SFTP_STATUS.OK)
  })

  sftp.on('RMDIR', (reqid, target) => {
    const full = normalizePath(target)
    const node = memfs.get(full)
    if (!node || node.type !== 'dir') return sftp.status(reqid, SFTP_STATUS.NO_SUCH_FILE)
    memfs.delete(full)
    sftp.status(reqid, SFTP_STATUS.OK)
  })

  sftp.on('REMOVE', (reqid, target) => {
    const full = normalizePath(target)
    const node = memfs.get(full)
    if (!node || node.type !== 'file') return sftp.status(reqid, SFTP_STATUS.NO_SUCH_FILE)
    memfs.delete(full)
    sftp.status(reqid, SFTP_STATUS.OK)
  })

  sftp.on('RENAME', (reqid, oldPath, newPath) => {
    const from = normalizePath(oldPath)
    const to = normalizePath(newPath)
    if (!memfs.has(from)) return sftp.status(reqid, SFTP_STATUS.NO_SUCH_FILE)
    // 目录重命名必须连同子项一起搬迁，否则子项会变成孤儿节点
    for (const [fullPath, node] of [...memfs]) {
      if (fullPath === from || fullPath.startsWith(`${from}/`)) {
        memfs.delete(fullPath)
        memfs.set(to + fullPath.slice(from.length), node)
      }
    }
    sftp.status(reqid, SFTP_STATUS.OK)
  })

  sftp.on('SETSTAT', (reqid) => sftp.status(reqid, SFTP_STATUS.OK))
  sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, SFTP_STATUS.OK))
  sftp.on('EXTENDED', (reqid) => sftp.status(reqid, SFTP_STATUS.FAILURE))
}

// ---------------------------------------------------------------------------
// 测试服务端：shell 会话
// ---------------------------------------------------------------------------

/** 各终端会话轮流使用的提示符主机名，让多标签截图看起来像不同机器 */
const SHELL_HOSTS = ['prod-web-01', 'bastion-01', 'monitor-01', 'db-primary-01']
/** 已建立的 shell 会话计数 */
let shellSeq = 0

/** ls -lh 的输出，与内存文件系统里的预置文件保持一致 */
const LS_OUTPUT = [
  'total 5.4M',
  'drwxr-xr-x 2 tester tester 4.0K Nov 20 09:10 docs',
  'drwxr-xr-x 2 tester tester 4.0K Nov 20 09:08 logs',
  '-rw-r--r-- 1 tester tester 5.0M Nov 18 02:15 backup-2026-11-18.tar.gz',
  '-rw-r--r-- 1 tester tester 2.0K Nov 17 16:02 config.yaml',
  '-rwxr-xr-x 1 tester tester 1.3K Nov 20 09:12 deploy.sh',
  '-rw-r--r-- 1 tester tester  412 Nov 18 21:33 readme.txt'
].join('\r\n')

/** df -h 的输出 */
const DF_OUTPUT = [
  'Filesystem      Size  Used Avail Use% Mounted on',
  '/dev/vda1        40G   17G   21G  45% /',
  'tmpfs           3.9G     0  3.9G   0% /dev/shm'
].join('\r\n')

/** 支持的命令及其输出，键为命令全文 */
const SHELL_COMMANDS = {
  ls: LS_OUTPUT,
  'ls -l': LS_OUTPUT,
  'ls -lh': LS_OUTPUT,
  'ls -al': LS_OUTPUT,
  ll: LS_OUTPUT,
  pwd: '/home/tester',
  whoami: 'tester',
  'df -h': DF_OUTPUT,
  uptime: ' 10:24:31 up 12 days,  4:07,  1 user,  load average: 0.08, 0.12, 0.09',
  'free -m': [
    '               total        used        free',
    'Mem:            3941        1226        1408',
    'Swap:           2047           0        2047'
  ].join('\r\n'),
  'cat readme.txt': '这是 ssh-client 的 UI 截图夹具目录，仅供本地测试使用。'
}

/**
 * 生成一段像真实登录会话的欢迎语。
 * @returns {string} 欢迎语文本（以 \r\n 换行）
 */
function welcomeText() {
  return [
    'Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)',
    '',
    ' * Documentation:  https://help.ubuntu.com',
    ' * Management:     https://landscape.canonical.com',
    '',
    'Last login: Thu Nov 20 09:41:07 2026 from 10.20.0.5',
    ''
  ].join('\r\n')
}

/**
 * 生成提示符。
 * @param {string} host 主机名
 * @returns {string} 形如 tester@host:~$ 的提示符
 */
function shellPrompt(host) {
  return `tester@${host}:~$ `
}

/**
 * 执行一条命令并给出输出。
 * @param {string} command 命令全文
 * @returns {string|null} 输出文本，空命令返回 null
 */
function runCommand(command) {
  if (!command) return null
  const key = command.trim()
  if (Object.prototype.hasOwnProperty.call(SHELL_COMMANDS, key)) return SHELL_COMMANDS[key]
  if (key.startsWith('cat ')) return `cat: ${key.slice(4)}: 文件内容已省略`
  return `bash: ${key}: command not found`
}

/**
 * 处理一个 shell 通道：先回显输入，再按命令给出输出并补提示符。
 * @param {import('ssh2').ServerChannel} stream shell 通道
 */
function serveShell(stream) {
  const host = SHELL_HOSTS[shellSeq % SHELL_HOSTS.length]
  shellSeq += 1
  let buffer = ''
  stream.write(welcomeText())
  stream.write(shellPrompt(host))
  stream.on('data', (chunk) => {
    const text = chunk.toString('utf8')
    // 回显：把客户端发来的裸 \r 或 \n 统一成 PTY 的 \r\n，与真实终端一致
    stream.write(text.replace(/\r\n|\r|\n/g, '\r\n'))
    buffer += text
    let index = buffer.search(/[\r\n]/)
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      const output = runCommand(line)
      if (output !== null) stream.write(`${output}\r\n`)
      stream.write(shellPrompt(host))
      index = buffer.search(/[\r\n]/)
    }
  })
}

/** 服务端当前仍打开着的客户端连接，收尾时要主动断开 */
const activeClients = new Set()

/**
 * 启动本地 SSH 测试服务，充当被测客户端的目标机。
 * @param {string} hostKey 主机私钥
 * @returns {Promise<import('ssh2').Server>} 已监听的服务端
 */
function startTestServer(hostKey) {
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    // 客户端拒绝主机密钥后主动断开时服务端会抛 KEY_EXCHANGE_FAILED，必须吞掉否则进程退出
    client.on('error', () => undefined)
    activeClients.add(client)
    client.on('close', () => activeClients.delete(client))
    client.on('authentication', (ctx) => ctx.accept())
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (acceptPty) => acceptPty())
        session.on('window-change', (acceptChange) => acceptChange && acceptChange())
        session.on('shell', (acceptShell) => serveShell(acceptShell()))
        // SFTP 面板截图需要真实 sftp 子系统
        session.on('sftp', (acceptSftp) => serveSftp(acceptSftp()))
      })
    })
  })
  return listenOnTestPort(server)
}

/**
 * 在测试端口上监听，端口刚释放时的瞬时占用会重试几次。
 * @param {import('ssh2').Server} server 服务端
 * @returns {Promise<import('ssh2').Server>} 已监听的服务端
 */
function listenOnTestPort(server) {
  return new Promise((resolve, reject) => {
    let attempts = 0
    const tryListen = () => {
      attempts += 1
      const onError = (err) => {
        if (attempts < 10 && err.code === 'EADDRINUSE') {
          setTimeout(tryListen, 200)
          return
        }
        reject(err)
      }
      server.once('error', onError)
      server.listen(SSH_PORT, '127.0.0.1', () => {
        server.off('error', onError)
        server.on('error', () => undefined)
        resolve(server)
      })
    }
    tryListen()
  })
}

/**
 * 关闭服务端并等待端口释放。
 * 注意：net.Server.close 的回调要等所有客户端连接结束才触发，而被测应用可能还挂着终端与 SFTP 会话，
 * 因此这里主动断开现存连接，并给回调加超时兜底，避免脚本卡死。
 * @param {import('ssh2').Server|null} server 服务端
 * @returns {Promise<void>}
 */
function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    server.close(finish)
    for (const client of activeClients) {
      try {
        client.end()
      } catch {
        // 连接可能已经关闭，忽略
      }
    }
    setTimeout(finish, 1000)
  })
}

/**
 * 判断本机端口当前是否被监听。
 * @param {number} port 端口号
 * @returns {Promise<boolean>} 是否已监听
 */
function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const finish = (open) => {
      socket.destroy()
      resolve(open)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(1500, () => finish(false))
  })
}

// ---------------------------------------------------------------------------
// CDP 客户端
// ---------------------------------------------------------------------------

/**
 * 通过 CDP 与渲染进程交互的极简客户端。
 * @param {string} wsUrl 调试端点地址
 * @returns {Promise<object>} CDP 客户端
 */
async function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => reject(new Error('CDP 连接失败'))
  })

  let nextId = 0
  const pending = new Map()
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  }

  /**
   * 发送一条 CDP 命令。
   * @param {string} method 方法名
   * @param {Record<string, unknown>} params 参数
   * @returns {Promise<any>} 命令返回值
   */
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })

  return {
    send,
    /**
     * 在页面中执行表达式并取回结果。
     * @param {string} expression 表达式
     * @returns {Promise<any>} 执行结果
     */
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      })
      if (result.exceptionDetails) {
        const detail =
          result.exceptionDetails.exception?.description || result.exceptionDetails.text
        throw new Error(`页面执行出错：${detail}`)
      }
      return result.result.value
    },
    /**
     * 让 CDP 注入的按键也能被页面当成前台输入处理。
     * 后台运行时窗口可能没有系统焦点，不做这步按键会被丢弃。
     * @returns {Promise<void>}
     */
    async prepareFocus() {
      try {
        await send('Page.bringToFront')
        await send('Emulation.setFocusEmulationEnabled', { enabled: true })
      } catch {
        // 老版本 Chromium 不支持焦点模拟时忽略，后续还有页面内合成事件的兜底路径
      }
    },
    /**
     * 注入一次真实按键（走浏览器输入管线，等价用户按键盘）。
     * @param {{key: string, code: string, windowsVirtualKeyCode: number, modifiers?: number}} options 按键参数
     * @returns {Promise<void>}
     */
    async dispatchKey({ key, code, windowsVirtualKeyCode, modifiers = 0 }) {
      const base = {
        modifiers,
        key,
        code,
        windowsVirtualKeyCode,
        nativeVirtualKeyCode: windowsVirtualKeyCode
      }
      await send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' })
      await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
    },
    close: () => socket.close()
  }
}

/**
 * 等待 Electron 的调试端点就绪。
 * @param {number} timeout 超时毫秒数
 * @param {() => number|null} exitCodeOf 读取子进程退出码，用于提前给出可诊断的失败原因
 * @returns {Promise<string>} 页面 WebSocket 地址
 */
async function waitForPage(timeout, exitCodeOf) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    // 进程已经退出就不可能再有调试端点，直接报出退出码，避免白等
    const exitCode = exitCodeOf()
    if (exitCode !== null && exitCode !== undefined) {
      throw new Error(
        `Electron 进程启动后立即退出（exitCode=${exitCode}，0x80000003 表示 STATUS_BREAKPOINT）。` +
          '常见原因：1) 环境注入了 ELECTRON_RUN_AS_NODE=1；' +
          '2) 可执行文件带 Low Mandatory Level 标签（被 Windows 沙箱打标过的工作区），' +
          '可用 E2E_ELECTRON_BIN 指向一份复制到 %TEMP% 的 electron 目录。'
      )
    }
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const targets = await response.json()
      const page = targets.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      // 调试端口尚未监听，继续等待
    }
    await sleep(300)
  }
  throw new Error('等待 Electron 渲染进程调试端点超时')
}

// ---------------------------------------------------------------------------
// 页面内交互辅助
// ---------------------------------------------------------------------------

/** 注入页面的辅助函数：注册会话数据监听，并提供驱动界面所需的 DOM 操作 */
const PAGE_HELPERS = `
(() => {
  if (window.__uiShot && window.__uiShot.offData) {
    try { window.__uiShot.offData() } catch (error) { /* 旧上下文已失效，忽略 */ }
  }
  const shot = { sessions: [], data: '' };
  // 记录会话 id 与远端数据：脚本据此定位刚打开的终端并等待输出
  shot.offData = window.api.terminal.onData((sessionId, chunk) => {
    if (!shot.sessions.includes(sessionId)) shot.sessions.push(sessionId);
    shot.data += new TextDecoder().decode(chunk, { stream: true });
  });
  // xterm 的 DOM 渲染器把空格渲染成不间断空格，比较文本前先还原
  shot.normalize = (value) => String(value == null ? '' : value).split(String.fromCharCode(160)).join(' ');
  shot.has = (selector) => !!document.querySelector(selector);
  shot.count = (selector) => document.querySelectorAll(selector).length;
  shot.text = (selector) => shot.normalize((document.querySelector(selector) || {}).textContent || '');
  shot.click = (selector) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error('元素不存在：' + selector);
    el.click();
    return true;
  };
  shot.clickByText = (selector, text) => {
    const el = Array.from(document.querySelectorAll(selector)).find((item) => (item.textContent || '').includes(text));
    if (!el) throw new Error('未找到包含文本「' + text + '」的元素：' + selector);
    el.click();
    return true;
  };
  // React 受控输入必须走原生 setter + input 事件，直接改 value 不会触发 onChange
  shot.setValue = (selector, value) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error('元素不存在：' + selector);
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  };
  shot.setSelect = (selector, value) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error('元素不存在：' + selector);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  };
  // 按字段名（label 里的首个 span 文案）设置弹窗表单输入框
  shot.setField = (labelText, value) => {
    const fields = Array.from(document.querySelectorAll('.modal .field'));
    const field = fields.find((item) => {
      const span = item.querySelector('span');
      return span && shot.normalize(span.textContent).trim() === labelText;
    });
    if (!field) throw new Error('未找到表单字段：' + labelText);
    const input = field.querySelector('input');
    if (!input) throw new Error('表单字段没有输入框：' + labelText);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  };
  shot.pressEnter = (selector) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error('元素不存在：' + selector);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    return true;
  };
  // 标签种类以状态圆点的类名判定（.tab-dot.sftp），比徽标文案更稳定
  shot.tabs = () => Array.from(document.querySelectorAll('.tab')).map((el) => ({
    kind: el.querySelector('.tab-dot.sftp') ? 'sftp' : 'terminal',
    title: shot.normalize((el.querySelector('.tab-title') || {}).textContent || '').trim(),
    active: el.classList.contains('active'),
    exited: !!el.querySelector('.tab-dot.exited')
  }));
  shot.clickTab = (title, kind) => {
    const wanted = kind || 'terminal';
    const tab = Array.from(document.querySelectorAll('.tab')).find((el) => {
      const kindOf = el.querySelector('.tab-dot.sftp') ? 'sftp' : 'terminal';
      const label = shot.normalize((el.querySelector('.tab-title') || {}).textContent || '').trim();
      return kindOf === wanted && label === title;
    });
    if (!tab) throw new Error('未找到标签：' + title + '（' + wanted + '）');
    tab.click();
    return true;
  };
  shot.findConnection = (name) => {
    const item = Array.from(document.querySelectorAll('.conn-item')).find((el) => {
      const label = el.querySelector('.conn-name');
      return label && shot.normalize(label.textContent).trim() === name;
    });
    if (!item) throw new Error('未找到连接项：' + name);
    return item;
  };
  shot.clickConnection = (name) => {
    const item = shot.findConnection(name);
    (item.querySelector('.conn-main') || item).click();
    return true;
  };
  shot.clickConnAction = (name, actionTitle) => {
    const item = shot.findConnection(name);
    const button = Array.from(item.querySelectorAll('.icon-btn')).find(
      (el) => (el.getAttribute('title') || '') === actionTitle
    );
    if (!button) throw new Error('连接项「' + name + '」上没有按钮：' + actionTitle);
    button.click();
    return true;
  };
  shot.screenText = () => {
    const host = document.querySelector('.terminal-host:not(.hidden) .xterm-rows');
    return shot.normalize(host ? host.textContent : '');
  };
  shot.dispatchContextMenu = (selector, x, y) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error('元素不存在：' + selector);
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    return true;
  };
  // 关掉可能残留的浮层（右键菜单 / 搜索栏 / 提示条 / 弹窗），保证画面里只有目标状态
  shot.closeOverlays = () => {
    if (document.querySelector('.ctx-menu')) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    }
    const searchClose = document.querySelector('.term-search > .term-search-btn:last-child');
    if (searchClose) searchClose.click();
    const toast = document.querySelector('.toast');
    if (toast) toast.click();
    const cancel = Array.from(document.querySelectorAll('.modal-foot button, .modal-actions button')).find(
      (el) => (el.textContent || '').includes('取消')
    );
    if (cancel) cancel.click();
    return true;
  };
  window.__uiShot = shot;
  return true;
})()
`

// ---------------------------------------------------------------------------
// 等待与截图
// ---------------------------------------------------------------------------

/**
 * 轮询页面状态直到条件成立。
 * @param {object} cdp CDP 客户端
 * @param {string} expression 返回布尔值的表达式
 * @param {number} timeout 超时毫秒数
 * @returns {Promise<boolean>} 是否在超时前成立
 */
async function tryWait(cdp, expression, timeout) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      if (await cdp.evaluate(expression)) return true
    } catch {
      // 页面正在导航或上下文切换时会短暂报错，继续轮询
    }
    await sleep(200)
  }
  return false
}

/**
 * 等待条件成立，超时抛出带描述的异常。
 * @param {object} cdp CDP 客户端
 * @param {string} expression 返回布尔值的表达式
 * @param {string} label 失败时展示的描述
 * @param {number} timeout 超时毫秒数
 * @returns {Promise<void>}
 */
async function waitFor(cdp, expression, label, timeout = 15000) {
  if (await tryWait(cdp, expression, timeout)) return
  throw new Error(`等待超时：${label}`)
}

/**
 * 读取 PNG 的像素尺寸。
 * @param {Buffer} buffer PNG 文件内容
 * @returns {{width: number, height: number}} 像素宽高
 */
function readPngSize(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('截图文件不是合法 PNG')
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG 缺少 IHDR 头')
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/**
 * 采样 PNG 解压后的字节种类数，作为"画面不是纯色"的自检指标。
 * @param {Buffer} png PNG 文件内容
 * @returns {number} 采样到的不同字节值个数
 */
function countDistinctSamples(png) {
  const chunks = []
  let offset = 8
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length))
    if (type === 'IEND') break
    offset += 12 + length
  }
  if (chunks.length === 0) return 0
  const raw = zlib.inflateSync(Buffer.concat(chunks))
  const seen = new Set()
  for (let index = 0; index < raw.length; index += 997) seen.add(raw[index])
  return seen.size
}

/**
 * 通过 CDP 截取当前视口并落盘，同时做尺寸与空白自检。
 * @param {object} cdp CDP 客户端
 * @param {string} filePath 目标文件绝对路径
 * @param {{width: number, height: number}} viewport 期望的视口尺寸（CSS 像素）
 * @returns {Promise<{filePath: string, width: number, height: number, bytes: number, diversity: number}>} 截图信息
 */
async function captureScreenshot(cdp, filePath, viewport) {
  // 用 clip 显式框定视口：captureBeyondViewport 会按内容 scrollHeight 出图，
  // 窄视口下内容一旦溢出（例如 1024x680 时页面高 853）就会截出非视口尺寸的图
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: 1 }
  })
  const buffer = Buffer.from(result.data, 'base64')
  const size = readPngSize(buffer)
  const diversity = countDistinctSamples(buffer)
  // 先自检再落盘，避免把纯色/空白图留在输出目录里冒充成果
  if (buffer.length < 8000 || diversity < 6) {
    throw new Error(
      `截图疑似空白：${path.basename(filePath)}（${buffer.length} 字节，采样到 ${diversity} 种字节）`
    )
  }
  fs.writeFileSync(filePath, buffer)
  return { filePath, width: size.width, height: size.height, bytes: buffer.length, diversity }
}

// ---------------------------------------------------------------------------
// 状态驱动
// ---------------------------------------------------------------------------

/**
 * 打开指定连接的终端标签，并返回新会话 id。
 * @param {object} ctx 截图上下文
 * @param {string} name 连接名称
 * @returns {Promise<string>} 新会话 id
 */
async function openTerminalByName(ctx, name) {
  const before = await ctx.cdp.evaluate('window.__uiShot.sessions.length')
  await ctx.cdp.evaluate(`window.__uiShot.clickConnection(${JSON.stringify(name)})`)
  await waitFor(
    ctx.cdp,
    `window.__uiShot.sessions.length > ${before}`,
    `点击连接「${name}」后建立会话`,
    25000
  )
  const sessionId = await ctx.cdp.evaluate(`window.__uiShot.sessions[${before}]`)
  if (!sessionId) throw new Error(`未能定位「${name}」的会话 id`)
  return sessionId
}

/**
 * 打开指定连接的 SFTP 标签（不返回 id，面板状态由 DOM 断言）。
 * @param {object} ctx 截图上下文
 * @param {string} name 连接名称
 * @returns {Promise<void>}
 */
async function openSftpByName(ctx, name) {
  const before = await ctx.cdp.evaluate(`document.querySelectorAll('.tab').length`)
  await ctx.cdp.evaluate(
    `window.__uiShot.clickConnAction(${JSON.stringify(name)}, 'SFTP 文件管理')`
  )
  await waitFor(
    ctx.cdp,
    `document.querySelectorAll('.tab').length > ${before}`,
    `打开「${name}」的 SFTP 标签`,
    25000
  )
}

/**
 * 固定 CDP 视口。
 * @param {object} cdp CDP 客户端
 * @param {{width: number, height: number}} viewport 视口尺寸
 * @param {number} dpr 像素密度
 * @returns {Promise<void>}
 */
async function applyViewport(cdp, viewport, dpr) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: dpr,
    mobile: false
  })
}

/**
 * 读取当前标签列表。
 * @param {object} ctx 截图上下文
 * @returns {Promise<Array<{kind: string, title: string, active: boolean, exited: boolean}>>} 标签列表
 */
async function readTabs(ctx) {
  return JSON.parse(await ctx.cdp.evaluate('JSON.stringify(window.__uiShot.tabs())'))
}

/** 步骤表：phase 为 true 的步骤只准备状态不截图，供 --only 复用前置状态 */
const STEPS = [
  {
    id: '01',
    file: '01-empty.png',
    state: '空状态：没有任何连接、没有任何标签',
    viewport: 'default',
    requires: [],
    /**
     * 全新 userData 启动即空状态，这里只做断言，避免截到别的画面还说成功。
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async prepare(ctx) {
      await waitFor(
        ctx.cdp,
        `window.__uiShot.text('.sidebar').includes('还没有连接')`,
        '侧边栏显示「还没有连接」提示'
      )
      if ((await ctx.cdp.evaluate(`window.__uiShot.count('.conn-item')`)) !== 0) {
        throw new Error('空状态截图前侧边栏已经存在连接项')
      }
      await waitFor(ctx.cdp, `window.__uiShot.has('.empty-state')`, '工作区显示空状态提示')
      if ((await ctx.cdp.evaluate(`window.__uiShot.count('.tab')`)) !== 0) {
        throw new Error('空状态截图前已经存在标签')
      }
    }
  },
  {
    id: 'connections',
    phase: true,
    requires: [],
    /**
     * 写入 6 个连接并重载页面，让列表按真实启动路径重新拉取。
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async prepare(ctx) {
      const dtoList = SAMPLE_CONNECTIONS.map((item) => ({ ...item, authType: 'password' }))
      // 逐个保存：底层是「读文件 → 改 → 原子替换」，并发写有互相覆盖的风险
      const savedCount = await ctx.cdp.evaluate(`(async () => {
        const list = ${JSON.stringify(dtoList)};
        for (const item of list) await window.api.connections.save(item);
        return (await window.api.connections.list()).length;
      })()`)
      if (savedCount !== SAMPLE_CONNECTIONS.length) {
        throw new Error(`预置连接数量不符：期望 ${SAMPLE_CONNECTIONS.length}，实际 ${savedCount}`)
      }
      // 保存动作不会自动刷新已挂载的列表，重载页面等价于重启后的真实加载路径。
      // 先埋一个标记，重载后标记消失才算新文档就绪，否则会误判成旧文档已完成
      await ctx.cdp.evaluate(
        `(window.__uiShotStale = true, setTimeout(() => location.reload(), 30), true)`
      )
      await waitFor(
        ctx.cdp,
        `typeof window.__uiShotStale === 'undefined' && document.readyState === 'complete'`,
        '页面重载完成'
      )
      await waitFor(ctx.cdp, `typeof window.api !== 'undefined'`, '重载后 window.api 可用')
      await ctx.cdp.evaluate(PAGE_HELPERS)
      await ctx.cdp.prepareFocus()
      await waitFor(
        ctx.cdp,
        `window.__uiShot.count('.conn-item') === ${SAMPLE_CONNECTIONS.length}`,
        '侧边栏加载出 6 个连接'
      )
    }
  },
  {
    id: '02',
    file: '02-connections.png',
    state: '6 个真实感中文连接 + 空工作区',
    viewport: 'default',
    requires: ['connections'],
    /**
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async prepare(ctx) {
      const names = await ctx.cdp.evaluate(
        `JSON.stringify(Array.from(document.querySelectorAll('.conn-name')).map((el) => el.textContent.trim()))`
      )
      const parsed = JSON.parse(names)
      for (const item of SAMPLE_CONNECTIONS) {
        if (!parsed.some((name) => name.includes(item.name))) {
          throw new Error(`侧边栏缺少连接「${item.name}」，实际：${parsed.join(' / ')}`)
        }
      }
      await waitFor(ctx.cdp, `window.__uiShot.count('.tab') === 0`, '工作区仍为空（没有标签）')
      // 侧边栏滚回顶部，保证连接列表完整入镜
      await ctx.cdp.evaluate(`(document.querySelector('.sidebar').scrollTop = 0, true)`)
    }
  },
  {
    id: '03',
    file: '03-terminal.png',
    state: '终端标签：远端回显出一段真实感会话（欢迎语 + ls -lh + uptime）',
    viewport: 'default',
    requires: ['connections'],
    /**
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async prepare(ctx) {
      const sessionId = await openTerminalByName(ctx, '测试环境')
      ctx.primaryTerminal = sessionId
      await waitFor(
        ctx.cdp,
        `window.__uiShot.screenText().includes('prod-web-01')`,
        '终端显示远端欢迎语与提示符',
        25000
      )
      await ctx.cdp.evaluate(
        `(window.api.terminal.write(${JSON.stringify(sessionId)}, 'ls -lh\\n'), true)`
      )
      await waitFor(
        ctx.cdp,
        `window.__uiShot.screenText().includes('deploy.sh')`,
        '终端显示 ls -lh 的输出'
      )
      await ctx.cdp.evaluate(
        `(window.api.terminal.write(${JSON.stringify(sessionId)}, 'uptime\\n'), true)`
      )
      await waitFor(
        ctx.cdp,
        `window.__uiShot.screenText().includes('load average')`,
        '终端显示 uptime 的输出'
      )
      // 等 xterm 把最后一批写入渲染完再截图
      await sleep(400)
    }
  },
  {
    id: '04',
    file: '04-multi-tab.png',
    state: '4 个标签：3 个终端（其中 1 个已退出）+ 1 个文件标签',
    viewport: 'default',
    requires: ['03'],
    /**
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async prepare(ctx) {
      const bastionSession = await openTerminalByName(ctx, '跳板机')
      await openTerminalByName(ctx, '监控节点')
      await openSftpByName(ctx, '测试环境')
      await waitFor(ctx.cdp, `window.__uiShot.count('.tab') === 4`, '工作区出现 4 个标签')
      // 关掉跳板机会话：标签保留，圆点转为 exited 并出现「重新连接」按钮
      await ctx.cdp.evaluate(`(window.api.terminal.close(${JSON.stringify(bastionSession)}), true)`)
      await waitFor(
        ctx.cdp,
        `window.__uiShot.count('.tab-dot.exited') === 1`,
        '其中一个终端标签显示为已退出'
      )
      const tabs = await readTabs(ctx)
      const terminals = tabs.filter((tab) => tab.kind === 'terminal').length
      const files = tabs.filter((tab) => tab.kind === 'sftp').length
      const exited = tabs.filter((tab) => tab.exited).length
      if (tabs.length !== 4 || terminals !== 3 || files !== 1 || exited !== 1) {
        throw new Error(
          `标签组合不符合预期：${JSON.stringify(tabs)}（期望 4 个标签 = 3 终端 + 1 文件，其中 1 个已退出）`
        )
      }
      // 激活带完整输出的终端，让工作区不是空画面
      await ctx.cdp.evaluate(`window.__uiShot.clickTab('测试环境', 'terminal')`)
      await waitFor(
        ctx.cdp,
        `window.__uiShot.has('.terminal-host:not(.hidden) .xterm-rows')`,
        '终端内容可见'
      )
      await sleep(300)
    }
  },
  {
    id: '05',
    file: '05-search.png',
    state: '终端 Ctrl+F 搜索栏展开，关键词命中并显示计数',
    viewport: 'default',
    requires: ['04'],
    /**
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async prepare(ctx) {
      await ctx.cdp.evaluate('window.__uiShot.closeOverlays()')
      await ctx.cdp.evaluate(`window.__uiShot.clickTab('测试环境', 'terminal')`)
      const focusTerminal = `(() => {
        const textarea = document.querySelector('.terminal-host:not(.hidden) .xterm-helper-textarea');
        if (textarea) textarea.focus();
        return !!textarea && document.activeElement === textarea;
      })()`
      if (!(await ctx.cdp.evaluate(focusTerminal))) {
        throw new Error('激活终端的输入区无法获得焦点，无法用 Ctrl+F 打开搜索栏')
      }
      // 优先用 CDP 注入真实按键（走浏览器输入管线，等价用户按 Ctrl+F）
      await ctx.cdp.dispatchKey({ key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 2 })
      let opened = await tryWait(ctx.cdp, `window.__uiShot.has('.term-search')`, 4000)
      if (!opened) {
        console.log('[信息] CDP 真实按键未打开搜索栏，退回页面内合成键盘事件重试')
        await ctx.cdp.evaluate(`(() => {
          const textarea = document.querySelector('.terminal-host:not(.hidden) .xterm-helper-textarea');
          if (!textarea) return false;
          textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true
          }));
          return true;
        })()`)
        opened = await tryWait(ctx.cdp, `window.__uiShot.has('.term-search')`, 4000)
      }
      if (!opened) throw new Error('Ctrl+F 未能展开终端搜索栏（CDP 真实按键与页面内合成事件均未生效）')
      await ctx.cdp.evaluate(`window.__uiShot.setValue('.term-search-input', 'prod-web-01')`)
      await waitFor(
        ctx.cdp,
        `(() => {
          const text = window.__uiShot.text('.term-search-count');
          return text.includes('项') && !text.includes('无结果');
        })()`,
        '搜索栏显示命中计数',
        8000
      )
      const hitCount = await ctx.cdp.evaluate(`window.__uiShot.text('.term-search-count')`)
      console.log(`[信息] 05-search 命中计数：${hitCount}`)
    }
  },
  {
    id: '06',
    file: '06-context-menu.png',
    state: '终端右键菜单展开（复制/粘贴/全选/查找/清屏）',
    viewport: 'default',
    requires: ['05'],
    /**
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async prepare(ctx) {
      // 先收起 05 留下的搜索栏，保证画面里只有右键菜单
      await ctx.cdp.evaluate('window.__uiShot.closeOverlays()')
      await tryWait(ctx.cdp, `!window.__uiShot.has('.term-search')`, 3000)
      await ctx.cdp.evaluate(`window.__uiShot.clickTab('测试环境', 'terminal')`)
      await waitFor(
        ctx.cdp,
        `window.__uiShot.has('.terminal-host:not(.hidden) .xterm-rows')`,
        '终端内容可见'
      )
      await ctx.cdp.evaluate(
        `window.__uiShot.dispatchContextMenu('.terminal-host:not(.hidden)', 460, 320)`
      )
      await waitFor(ctx.cdp, `window.__uiShot.has('.ctx-menu')`, '右键菜单已展开')
      const items = await ctx.cdp.evaluate(
        `Array.from(document.querySelectorAll('.ctx-menu-item')).map((el) => el.textContent.trim()).join(' / ')`
      )
      console.log(`[信息] 06-context-menu 菜单项：${items}`)
      // 菜单首帧会按窗口边界收拢位置，等定位完成再截图
      await sleep(250)
    }
  },
  {
    id: '07',
    file: '07-sftp.png',
    state: 'SFTP 面板：/home/tester 下的目录与文件列表',
    viewport: 'default',
    requires: ['04'],
    /**
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async prepare(ctx) {
      await ctx.cdp.evaluate('window.__uiShot.closeOverlays()')
      await tryWait(ctx.cdp, `!window.__uiShot.has('.ctx-menu')`, 3000)
      await ctx.cdp.evaluate(`window.__uiShot.clickTab('测试环境', 'sftp')`)
      await waitFor(ctx.cdp, `window.__uiShot.has('.sftp-panel:not(.hidden)')`, 'SFTP 面板显示')
      await waitFor(
        ctx.cdp,
        `window.__uiShot.count('.sftp-panel:not(.hidden) .sftp-row.clickable') >= 4`,
        'SFTP 列表出现目录与文件'
      )
      await waitFor(
        ctx.cdp,
        `(() => {
          const text = window.__uiShot.text('.sftp-panel:not(.hidden) .sftp-list');
          return ['docs', 'logs', 'readme.txt', 'deploy.sh'].every((name) => text.includes(name));
        })()`,
        'SFTP 列表包含预置目录与文件'
      )
      const pathValue = await ctx.cdp.evaluate(
        `document.querySelector('.sftp-panel:not(.hidden) .sftp-path-input').value`
      )
      if (pathValue !== FAKE_HOME) {
        throw new Error(`SFTP 起始目录应为 ${FAKE_HOME}，实际 ${pathValue}`)
      }
      await sleep(300)
    }
  },
  {
    id: '08',
    file: '08-conn-form.png',
    state: '新建连接表单：已切到私钥认证，展示私钥路径与口令字段',
    viewport: 'default',
    requires: ['connections'],
    /**
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async prepare(ctx) {
      await ctx.cdp.evaluate('window.__uiShot.closeOverlays()')
      await ctx.cdp.evaluate(`window.__uiShot.click('.sidebar-head .primary-btn')`)
      await waitFor(
        ctx.cdp,
        `window.__uiShot.text('.modal-title') === '新建连接'`,
        '打开新建连接表单'
      )
      await ctx.cdp.evaluate(`window.__uiShot.setField('名称', '预发布环境')`)
      await ctx.cdp.evaluate(`window.__uiShot.setField('主机', 'staging-01.internal')`)
      await ctx.cdp.evaluate(`window.__uiShot.setField('端口', '22')`)
      await ctx.cdp.evaluate(`window.__uiShot.setField('用户名', 'deploy')`)
      await ctx.cdp.evaluate(`window.__uiShot.setSelect('.modal select', 'privateKey')`)
      await waitFor(
        ctx.cdp,
        `window.__uiShot.text('.modal').includes('私钥文件') && window.__uiShot.text('.modal').includes('私钥口令')`,
        '切换到私钥认证后出现私钥路径与口令字段'
      )
      await ctx.cdp.evaluate(
        `window.__uiShot.setField('私钥文件', 'C:\\\\Users\\\\deploy\\\\.ssh\\\\id_ed25519')`
      )
      await ctx.cdp.evaluate(`window.__uiShot.setField('私钥口令', 'ed25519-passphrase')`)
      const authType = await ctx.cdp.evaluate(`document.querySelector('.modal select').value`)
      if (authType !== 'privateKey') throw new Error(`认证方式未切到私钥，实际 ${authType}`)
      await sleep(250)
    }
  },
  {
    id: '09',
    file: '09-toast.png',
    state: `连接 127.0.0.1:${DEAD_PORT}（未监听）后的错误提示条`,
    viewport: 'default',
    requires: ['08'],
    /**
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async prepare(ctx) {
      // 收起 08 的表单，否则弹窗会盖住提示条
      await ctx.cdp.evaluate('window.__uiShot.closeOverlays()')
      if (!(await tryWait(ctx.cdp, `!window.__uiShot.has('.modal-title')`, 3000))) {
        throw new Error('新建连接表单未能关闭，错误提示会被弹窗遮挡')
      }
      await tryWait(ctx.cdp, `!window.__uiShot.has('.toast')`, 3000)
      if (await isPortOpen(DEAD_PORT)) {
        throw new Error(`127.0.0.1:${DEAD_PORT} 已被监听，无法用它触发连接失败提示`)
      }
      await ctx.cdp.evaluate(
        `window.__uiShot.setValue('.quick-connect input', ${JSON.stringify(`127.0.0.1:${DEAD_PORT}`)})`
      )
      await ctx.cdp.evaluate(`window.__uiShot.pressEnter('.quick-connect input')`)
      await waitFor(ctx.cdp, `window.__uiShot.has('.toast.error')`, '出现错误提示条', 25000)
      const toastText = await ctx.cdp.evaluate(`window.__uiShot.text('.toast-text')`)
      if (!toastText.trim()) throw new Error('错误提示条没有文案')
      console.log(`[信息] 09-toast 提示文案：${toastText.trim()}`)
      await sleep(250)
    }
  },
  {
    id: '10',
    file: '10-narrow.png',
    state: '1024x680 窄视口：终端状态，标签栏里同时保留文件标签',
    viewport: 'narrow',
    requires: ['07'],
    /**
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async prepare(ctx) {
      // 窄视口截图前清掉 09 的提示条，避免画面里混入无关状态
      await ctx.cdp.evaluate('window.__uiShot.closeOverlays()')
      await tryWait(ctx.cdp, `!window.__uiShot.has('.toast')`, 4000)
      await applyViewport(ctx.cdp, NARROW_VIEWPORT, ctx.dpr)
      // 等一次重排，让 FitAddon 按新尺寸校准终端
      await sleep(400)
      await ctx.cdp.evaluate(`window.__uiShot.clickTab('测试环境', 'terminal')`)
      await waitFor(
        ctx.cdp,
        `window.__uiShot.has('.terminal-host:not(.hidden) .xterm-rows')`,
        '窄视口下终端内容可见'
      )
      await waitFor(
        ctx.cdp,
        `window.__uiShot.screenText().includes('deploy.sh')`,
        '窄视口下终端仍保留会话输出'
      )
      const tabs = await readTabs(ctx)
      if (tabs.filter((tab) => tab.kind === 'sftp').length !== 1) {
        throw new Error(`窄视口截图缺少文件标签：${JSON.stringify(tabs)}`)
      }
      await sleep(500)
    }
  },
  {
    id: '11',
    file: '11-min.png',
    state: '780x520 最小窗口：4 个标签 + 可见的 SFTP 面板，标签栏不横向溢出',
    viewport: 'min',
    requires: ['04'],
    /**
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async prepare(ctx) {
      await ctx.cdp.evaluate('window.__uiShot.closeOverlays()')
      await tryWait(ctx.cdp, `!window.__uiShot.has('.toast')`, 4000)
      await applyViewport(ctx.cdp, MIN_VIEWPORT, ctx.dpr)
      // 等一次重排，让标签按可压缩 flex 重新分配宽度
      await sleep(400)
      // 激活文件标签：4 个标签全在，且 SFTP 面板可见
      await ctx.cdp.evaluate(`window.__uiShot.clickTab('测试环境', 'sftp')`)
      await waitFor(
        ctx.cdp,
        `window.__uiShot.has('.sftp-panel:not(.hidden)')`,
        '最小窗口下 SFTP 面板显示'
      )
      const tabs = await readTabs(ctx)
      if (tabs.length !== 4) {
        throw new Error(`最小窗口截图应保留 4 个标签，实际 ${tabs.length}：${JSON.stringify(tabs)}`)
      }
      await waitFor(ctx.cdp, `!!document.querySelector('.tabbar')`, '标签栏已渲染')
      // 标签栏横向溢出断言：scrollWidth 超过 clientWidth 说明标签放不下
      const metrics = JSON.parse(
        await ctx.cdp.evaluate(`(() => {
          const bar = document.querySelector('.tabbar');
          return JSON.stringify({
            scrollWidth: bar.scrollWidth,
            clientWidth: bar.clientWidth,
            overflow: bar.scrollWidth - bar.clientWidth,
            tabWidths: Array.from(document.querySelectorAll('.tab')).map((el) =>
              Math.round(el.getBoundingClientRect().width)
            )
          });
        })()`)
      )
      console.log(
        `[信息] 11-min 标签栏 scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth} ` +
          `标签宽度=[${metrics.tabWidths.join(', ')}]`
      )
      if (metrics.scrollWidth > metrics.clientWidth + 1) {
        throw new Error(
          `最小窗口下标签栏溢出：scrollWidth=${metrics.scrollWidth} > clientWidth=${metrics.clientWidth}` +
            `（超出 ${metrics.overflow}px，标签宽度 [${metrics.tabWidths.join(', ')}]）`
        )
      }
      await sleep(400)
    }
  }
]

// ---------------------------------------------------------------------------
// Electron 启动与主流程
// ---------------------------------------------------------------------------

/**
 * 选择要启动的 Electron：优先 E2E_ELECTRON_BIN 指定的开发态，否则用打包产物。
 * @returns {{command: string, args: string[], mode: string}} 启动命令
 */
function resolveElectron() {
  const devBinary = process.env.E2E_ELECTRON_BIN
  if (devBinary) {
    if (!fs.existsSync(devBinary)) {
      throw new Error(`E2E_ELECTRON_BIN 指向的文件不存在：${devBinary}`)
    }
    const devMain = path.join(PROJECT_ROOT, 'out', 'main', 'index.js')
    if (!fs.existsSync(devMain)) {
      throw new Error('开发态需要先构建：请先执行 npm run build 产出 out/')
    }
    return {
      command: devBinary,
      args: ['.', `--remote-debugging-port=${CDP_PORT}`],
      mode: '开发态（E2E_ELECTRON_BIN）'
    }
  }
  const packaged = path.join(PROJECT_ROOT, 'dist', 'win-unpacked', 'ssh-client.exe')
  if (fs.existsSync(packaged)) {
    return {
      command: packaged,
      args: [`--remote-debugging-port=${CDP_PORT}`],
      mode: '打包产物 dist/win-unpacked'
    }
  }
  throw new Error(
    '既没有设置 E2E_ELECTRON_BIN，也没有 dist/win-unpacked/ssh-client.exe，无法启动 Electron'
  )
}

/**
 * 打印运行环境信息，便于事后复现。
 * @param {{command: string, mode: string}} electron 启动信息
 * @param {{outDir: string, dpr: number}} options 运行选项
 */
function printHeader(electron, options) {
  console.log(`[信息] 输出目录：${options.outDir}`)
  console.log(
    `[信息] 视口：${DEFAULT_VIEWPORT.width}x${DEFAULT_VIEWPORT.height} @${options.dpr}x` +
      `（10-narrow 用 ${NARROW_VIEWPORT.width}x${NARROW_VIEWPORT.height}，` +
      `11-min 用 ${MIN_VIEWPORT.width}x${MIN_VIEWPORT.height}）`
  )
  console.log(`[信息] Electron：${electron.command}（${electron.mode}）`)
  console.log(`[信息] 调试端口：${CDP_PORT}，临时 userData：${USER_DATA_DIR}`)
}

/**
 * 主流程：起服务、开 Electron、逐个状态截图、打印清单、可靠收尾。
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseOptions(process.argv.slice(2))
  const shotIds = STEPS.filter((step) => !step.phase).map((step) => step.id)
  const requested = options.only ?? new Set(shotIds)
  const planned = shotIds.filter((id) => requested.has(id))

  const electron = resolveElectron()
  fs.mkdirSync(options.outDir, { recursive: true })
  USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-client-ui-shot-'))
  printHeader(electron, options)
  console.log(`[信息] 本次计划截图：${planned.join(', ')}`)

  // 残留的旧图会让清单失真，先清掉本次要产出的同名文件
  for (const id of planned) {
    const step = STEPS.find((item) => item.id === id)
    fs.rmSync(path.join(options.outDir, step.file), { force: true })
  }

  if (await isPortOpen(SSH_PORT)) {
    throw new Error(
      `127.0.0.1:${SSH_PORT} 已被监听，可能有残留的测试服务（e2e-smoke.cjs 等）在跑，请先结束它`
    )
  }

  const logFile = path.join(options.outDir, 'ui-shot-electron.log')
  /** 测试服务端，收尾时必须关闭 */
  let server = null
  /** Electron 子进程，收尾时必须按进程树结束 */
  let child = null
  /** CDP 客户端 */
  let cdp = null
  /** Electron 日志文件句柄 */
  let logFd = null

  /** 已产出的截图信息 */
  const results = []
  /** 失败记录：步骤 id -> 错误，失败步骤的后继直接跳过，避免连锁误报 */
  const failures = new Map()
  /** 已完成的步骤 id */
  const done = new Set()

  /**
   * 把某个步骤准备到位（前置步骤自动递归准备）。
   * @param {object} ctx 截图上下文
   * @param {string} id 步骤 id
   * @returns {Promise<void>}
   */
  const ensureStep = async (ctx, id) => {
    if (done.has(id)) return
    if (failures.has(id)) throw new Error(`前置步骤 ${id} 失败：${failures.get(id).message}`)
    const step = STEPS.find((item) => item.id === id)
    if (!step) throw new Error(`未知步骤：${id}`)
    for (const dep of step.requires ?? []) await ensureStep(ctx, dep)
    try {
      await step.prepare(ctx)
      done.add(id)
    } catch (err) {
      failures.set(id, err)
      throw err
    }
  }

  try {
    server = await startTestServer(generateHostKey())
    console.log(`[信息] 测试 SSH 服务已启动 127.0.0.1:${SSH_PORT}`)

    logFd = fs.openSync(logFile, 'w')
    const env = { ...process.env, SSH_CLIENT_USER_DATA: USER_DATA_DIR }
    // 本环境默认注入 ELECTRON_RUN_AS_NODE=1，会让 Electron 退化成纯 Node 运行，必须剔除
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron.command, electron.args, {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', logFd, logFd],
      env
    })

    const wsUrl = await waitForPage(40000, () => child.exitCode)
    cdp = await connectCdp(wsUrl)
    await waitFor(cdp, `typeof window.api !== 'undefined'`, '预加载脚本已注入 window.api')
    await cdp.prepareFocus()
    // 固定视口：不覆盖的话截出来的是真实窗口尺寸，图与图之间还会随内容高度抖动
    await applyViewport(cdp, DEFAULT_VIEWPORT, options.dpr)
    await cdp.evaluate(PAGE_HELPERS)
    await waitFor(cdp, `document.readyState === 'complete'`, '渲染进程文档就绪')
    await waitFor(
      cdp,
      `window.__uiShot.text('.sidebar-title') === '连接'`,
      'React 界面已挂载（侧边栏渲染成功）'
    )
    console.log('[信息] 调试通道已连通，开始驱动界面')

    const ctx = { cdp, dpr: options.dpr }

    for (const id of planned) {
      const step = STEPS.find((item) => item.id === id)
      const startedAt = Date.now()
      try {
        await ensureStep(ctx, id)
        const filePath = path.join(options.outDir, step.file)
        const expected = VIEWPORTS[step.viewport ?? 'default']
        const shot = await captureScreenshot(cdp, filePath, expected)
        if (
          shot.width !== expected.width * options.dpr ||
          shot.height !== expected.height * options.dpr
        ) {
          throw new Error(
            `截图尺寸不符合预期：实际 ${shot.width}x${shot.height}，` +
              `期望 ${expected.width * options.dpr}x${expected.height * options.dpr}`
          )
        }
        results.push({ ...shot, id, state: step.state })
        console.log(
          `[完成] ${id} ${step.file}（${shot.width}x${shot.height}，${shot.bytes} 字节，耗时 ${
            Date.now() - startedAt
          }ms）`
        )
      } catch (err) {
        failures.set(id, err)
        console.error(`[失败] ${id} ${step.file}：${err.message}`)
      }
    }
  } finally {
    // 收尾必须干净：先关 CDP，再按进程树强杀 Electron，最后关服务与临时目录
    if (cdp) cdp.close()
    if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    if (server) await closeServer(server)
    await sleep(500)
    if (logFd !== null) {
      try {
        fs.closeSync(logFd)
      } catch {
        // 日志句柄可能已随子进程一起释放，忽略
      }
    }
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true })
  }

  // 清单：无论成功与否都打印，方便 lead 直接取用
  console.log(`\n[清单] 输出目录：${options.outDir}`)
  for (const item of results) {
    console.log(`[清单] ${path.basename(item.filePath)}  ${item.width}x${item.height}  ${item.bytes} 字节  ${item.filePath}`)
  }
  for (const [id, err] of failures) {
    console.error(`[清单] ${id} 未产出：${err.message}`)
  }

  if (failures.size > 0) {
    console.error(
      `\n[结果] ${results.length}/${planned.length} 张成功，${failures.size} 张失败；Electron 日志：${logFile}`
    )
    // 失败时把 Electron 日志尾部打出来，省去再翻文件
    try {
      const lines = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/)
      console.error(`[日志] 末尾 ${Math.min(10, lines.length)} 行：`)
      console.error(lines.slice(-10).join('\n'))
    } catch {
      // 日志不可读时忽略
    }
    process.exitCode = 1
    return
  }
  console.log(`\n[结果] 全部完成，共 ${results.length} 张，输出目录：${options.outDir}`)
}

main().catch((err) => {
  console.error(`\n[失败] ${err.message}`)
  console.error(`[提示] 开发态请先 npm run build；E2E_ELECTRON_BIN 需指向可用的 electron.exe`)
  // 走到这里说明主流程在 try/finally 之前就失败了，补一次临时目录清理
  if (USER_DATA_DIR) fs.rmSync(USER_DATA_DIR, { recursive: true, force: true })
  process.exitCode = 1
})
