/**
 * UI 视觉取证脚本：把真实 Electron 界面驱动到固定状态，逐个截成 PNG 并打印清单。
 *
 * 用途：UI 改版（布局 / 排版 / 间隔 / 配色）前后的可重复取证，供 lead 用 read_image 逐张看效果。
 *   1. 在 127.0.0.1:2323 起一个 ssh2 测试服务：接受任意认证、shell 回显真实感的会话内容、
 *      sftp 子系统挂一个内存文件系统（/home/tester 下有 docs/、logs/、readme.txt、deploy.sh 等）
 *   2. 启动 Electron：优先环境变量 E2E_ELECTRON_BIN（开发态，参数 ['.']，cwd 为仓库根，需先 npm run build），
 *      否则回退到 dist/win-unpacked/EasySSH.exe；固定调试端口 9455
 *      （与 e2e-smoke.cjs 的 9333、另一名验证者的 2222/9333 全部错开）
 *   3. 用 CDP 固定视口（默认 1360x860，--dpr 可放大像素密度，支持 1 / 1.25 / 1.5 / 2 等小数），
 *      通过 DOM 事件、CDP 输入注入与 window.api 驱动界面
 *   4. 依次截 18 张固定命名的 PNG，任一状态驱动失败都会打印原因并以非零码退出
 *
 * 用法：
 *   node scripts/ui-shot.cjs                              # 全部 18 张，输出到 scripts/ui-shots/after
 *   node scripts/ui-shot.cjs --out=scripts/ui-shots/before # 指定输出目录（清单里会打印实际目录）
 *   node scripts/ui-shot.cjs --only=03,05,07              # 只截指定编号（前置状态会自动准备）
 *   node scripts/ui-shot.cjs --only=03 --dpr=2            # 2 倍像素密度（1360x860 -> 2720x1720）
 *   node scripts/ui-shot.cjs --suffix=-dpr125             # 文件名加后缀，供同一状态多 DPR 对比
 *   node scripts/ui-shot.cjs --checks=dpr                 # 只跑高 DPI 对照检查（写 dpr/ 子目录）
 *   node scripts/ui-shot.cjs --checks=drag                # 只跑真实拖拽上传检查
 *   node scripts/ui-shot.cjs --checks=contrast            # 只跑浅色主题对比度像素量测
 *   node scripts/ui-shot.cjs --checks=all                 # 三项检查都跑（可与 --only 叠加）
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
 *   12-light.png         浅色主题（走 .theme-toggle 真实切换路径）下的终端 + 侧栏
 *   13-light-sftp.png    浅色主题下的 SFTP 面板
 *   14-groups.png        侧栏分组：未分组 + 4 个分组，其中「生产环境」折叠
 *   16-restore.png       会话恢复提示条（预置 session 快照后重载页面触发）
 *   17-hidpi.png         --dpr=2 的终端态（含侧栏/工作区分隔带与 1px 竖线的设备像素断言）
 *   18-bigdir.png        2000 行目录：虚拟滚动、表头固定、行高一致、滚动可定位
 *   19-light-dialog.png  浅色主题下的新建连接表单
 *
 * 注：原 15-forward（端口转发面板）已随用户要求移除该功能而删除；编号不复用，
 *     16~19 保持原编号，便于与历史截图和 scripts/ui-review.md、verify-report.md 对照。
 *
 * 检查产物（--checks=...）：
 *   dpr/03-terminal-dpr{1,1.25,1.5,2}.png + report-dpr.json    高 DPI 对照
 *   drag-*.png + report-drag.json                              真实拖拽上传
 *   contrast-*.png + report-contrast.json                      浅色主题像素对比度
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
/** 测试 SSH 服务端口（刻意避开另一名验证者占用的 2222） */
const SSH_PORT = 2323
/** 用来触发连接失败提示的未监听端口（同样留在 23xx 段，避免与人抢占） */
const DEAD_PORT = 2399
/** Electron 远程调试端口，刻意避开 e2e-smoke.cjs 的 9333 与并行验证者的 9444 */
const CDP_PORT = 9455
/** 默认输出目录：本轮成果统一落在 after/，before/ 只读保留 */
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, 'scripts', 'ui-shots', 'after')
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
/** 18-bigdir 用的大目录：2000 个文件，专门检验虚拟滚动与表头固定 */
const BIG_DIR = `${FAKE_HOME}/bigdir`
/** 大目录的文件个数，与任务要求的 2000 行一致 */
const BIG_DIR_ENTRIES = 2000
/** 高 DPI 对照检查使用的像素密度序列 */
const DPR_SWEEP = [1, 1.25, 1.5, 2]
/**
 * 09-toast 借用的演示连接：快速连接移除后，错误提示只能靠「点一条连不通的已保存连接」触发，
 * 这里把这条内网机器临时改到未监听端口，截图后由该步的 verify 改回原配置。
 */
const TOAST_DEMO_CONNECTION = '备份节点'

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
 * @returns {{only: Set<string>|null, outDir: string, dpr: number, suffix: string, checks: Set<string>}} 运行选项
 * @throws 参数非法时抛错，由 main 统一打印并以非零码退出
 */
function parseOptions(argv) {
  const options = {
    only: null,
    outDir: DEFAULT_OUT_DIR,
    dpr: 1,
    suffix: '',
    checks: new Set(),
    allShots: false
  }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    }
    if (arg.startsWith('--only=')) {
      const raw = arg.slice('--only='.length).trim()
      // --only=all 与 --checks 同时使用时表示"既有截图也跑检查"
      if (raw === 'all') {
        options.only = null
        options.allShots = true
        continue
      }
      const ids = raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => item.padStart(2, '0'))
      const unknown = ids.filter((id) => !STEPS.some((step) => step.id === id))
      if (unknown.length > 0) {
        throw new Error(`--only 里有未知编号：${unknown.join(', ')}（可用编号 01-19）`)
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
      // 支持 1 / 1.25 / 1.5 / 2 这类小数密度：Windows 的 125% / 150% 缩放必须能复现
      const value = Number(arg.slice('--dpr='.length))
      if (!Number.isFinite(value) || value < 1 || value > 3) {
        throw new Error('--dpr 必须是 1-3 之间的数字，例如 --dpr=1.25')
      }
      options.dpr = value
      continue
    }
    if (arg.startsWith('--suffix=')) {
      const value = arg.slice('--suffix='.length).trim()
      if (!value) throw new Error('--suffix 需要给出后缀，例如 --suffix=-dpr125')
      options.suffix = value
      continue
    }
    if (arg.startsWith('--checks=')) {
      const names = arg
        .slice('--checks='.length)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
      const expanded = names.includes('all') ? ['dpr', 'drag', 'contrast'] : names
      const unknown = expanded.filter((name) => !CHECKS.some((check) => check.id === name))
      if (unknown.length > 0) {
        throw new Error(`--checks 里有未知检查：${unknown.join(', ')}（可用 dpr / drag / contrast / all）`)
      }
      expanded.forEach((name) => options.checks.add(name))
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
      '用法：node scripts/ui-shot.cjs [--out=<目录>] [--only=01,03] [--dpr=2] [--suffix=…] [--checks=…]',
      '  --out=<目录>   输出目录，默认 scripts/ui-shots/after（清单里会打印实际使用的绝对路径）',
      '  --only=<编号>  只截指定编号，逗号分隔，例如 --only=03,05,07（01-19）',
      '  --dpr=<n>      像素密度，默认 1，支持 1.25 / 1.5 / 2 等小数（1360x860 -> 2720x1720 @2x）',
      '  --suffix=<s>   文件名后缀（插在 .png 之前），用于同一状态多 DPR 对照',
      '  --checks=<c>   只跑检查：dpr（高 DPI 对照）/ drag（真实拖拽上传）/ contrast（浅色对比度）/ all',
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
  const line = 'easyssh ui-shot fixture line\n'
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
  'cat readme.txt': '这是 EasySSH 的 UI 截图夹具目录，仅供本地测试使用。'
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
  // 关闭指定标签：点标签上的「关闭」按钮，走真实 onClose（会一并关掉底层会话）
  shot.closeTab = (title, kind) => {
    const wanted = kind || 'terminal';
    const tab = Array.from(document.querySelectorAll('.tab')).find((el) => {
      const kindOf = el.querySelector('.tab-dot.sftp') ? 'sftp' : 'terminal';
      const label = shot.normalize((el.querySelector('.tab-title') || {}).textContent || '').trim();
      return kindOf === wanted && label === title;
    });
    if (!tab) return false;
    const button = Array.from(tab.querySelectorAll('.tab-icon')).find(
      (el) => (el.getAttribute('title') || '') === '关闭'
    );
    if (!button) throw new Error('标签没有关闭按钮：' + title);
    button.click();
    return true;
  };
  shot.findConnection = (name) => {    const item = Array.from(document.querySelectorAll('.conn-item')).find((el) => {
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
    // 兜底：当前弹窗底部的关闭按钮都是「取消」，这里再兜一次文案为「关闭」的按钮，
    // 防止将来新增的弹窗只提供「关闭」时一直盖在工作区上
    const closeFoot = Array.from(document.querySelectorAll('.modal-foot button')).find(
      (el) => (el.textContent || '').includes('关闭')
    );
    if (closeFoot) closeFoot.click();
    return true;
  };
  // ---- 主题：只能通过点击 .theme-toggle 触发真实切换（React onClick -> writeThemeMode） ----
  shot.themeState = () => ({
    theme: document.documentElement.dataset.theme || '',
    colorScheme: document.documentElement.style.colorScheme || '',
    stored: window.localStorage.getItem('easyssh:theme') || '',
    toggleTitle: (document.querySelector('.theme-toggle') || {}).title || '',
    toggleIcon: document.querySelector('.theme-toggle svg use')
      ? document.querySelector('.theme-toggle svg use').getAttribute('href') ||
        document.querySelector('.theme-toggle svg use').getAttribute('xlink:href')
      : ''
  });
  shot.clickTheme = () => {
    const el = document.querySelector('.theme-toggle');
    if (!el) throw new Error('侧栏底部缺少 .theme-toggle 按钮');
    el.click();
    return true;
  };
  // ---- 几何与样式读取：像素量测的入口 ----
  shot.rect = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left, right: r.right, bottom: r.bottom };
  };
  shot.styleOf = (selector, props) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error('元素不存在：' + selector);
    const cs = getComputedStyle(el);
    const out = {};
    props.forEach((prop) => { out[prop] = cs.getPropertyValue(prop); });
    return out;
  };
  shot.attr = (selector, name) => {
    const el = document.querySelector(selector);
    return el ? el.getAttribute(name) : null;
  };
  // ---- 连接分组 ----
  shot.groups = () => Array.from(document.querySelectorAll('.conn-group')).map((el) => {
    const head = el.querySelector('.conn-group-head');
    const nameEl = head ? head.querySelector('.conn-group-name') : null;
    const countEl = head ? head.querySelector('.conn-group-count') : null;
    return {
      name: nameEl ? shot.normalize(nameEl.textContent).trim() : '',
      expanded: head ? head.getAttribute('aria-expanded') === 'true' : null,
      count: countEl ? Number(shot.normalize(countEl.textContent).trim()) : 0,
      items: el.querySelectorAll('.conn-item').length,
      itemNames: Array.from(el.querySelectorAll('.conn-name')).map((item) => shot.normalize(item.textContent).trim())
    };
  });
  shot.clickGroupHead = (name) => {
    const head = Array.from(document.querySelectorAll('.conn-group-head')).find(
      (el) => shot.normalize((el.querySelector('.conn-group-name') || {}).textContent || '').trim() === name
    );
    if (!head) throw new Error('未找到分组标题：' + name);
    head.click();
    return true;
  };
  // ---- 会话恢复提示条 ----
  shot.restoreBar = () => {
    const bar = document.querySelector('.workspace .status-bar');
    if (!bar) return null;
    return {
      texts: Array.from(bar.querySelectorAll('.status-text')).map((el) => shot.normalize(el.textContent).trim()),
      actions: Array.from(bar.querySelectorAll('.status-actions button')).map((el) => shot.normalize(el.textContent).trim())
    };
  };
  shot.dismissRestore = () => {
    const button = Array.from(document.querySelectorAll('.status-actions button')).find(
      (el) => (el.textContent || '').includes('忽略')
    );
    if (!button) return false;
    button.click();
    return true;
  };
  // ---- SFTP：虚拟滚动、表头固定与行高量测 ----
  shot.sftpMetrics = () => {
    const panel = document.querySelector('.sftp-panel:not(.hidden)');
    if (!panel) return null;
    const list = panel.querySelector('.sftp-list');
    const head = panel.querySelector('.sftp-head');
    const listRect = list ? list.getBoundingClientRect() : null;
    const headRect = head ? head.getBoundingClientRect() : null;
    const rows = Array.from(list ? list.querySelectorAll('.sftp-row.clickable') : []).map((el) => {
      const r = el.getBoundingClientRect();
      return { path: el.getAttribute('data-path'), top: Math.round(r.top * 100) / 100, height: Math.round(r.height * 100) / 100 };
    });
    return {
      scrollTop: list ? Math.round(list.scrollTop) : 0,
      scrollHeight: list ? list.scrollHeight : 0,
      clientHeight: list ? list.clientHeight : 0,
      listTop: listRect ? Math.round(listRect.top * 100) / 100 : 0,
      headTop: headRect ? Math.round(headRect.top * 100) / 100 : 0,
      headBottom: headRect ? Math.round(headRect.bottom * 100) / 100 : 0,
      headHeight: headRect ? Math.round(headRect.height * 100) / 100 : 0,
      firstPath: rows.length ? rows[0].path : null,
      lastPath: rows.length ? rows[rows.length - 1].path : null,
      rowCount: rows.length,
      rows
    };
  };
  shot.scrollSftp = (top) => {
    const list = document.querySelector('.sftp-panel:not(.hidden) .sftp-list');
    if (!list) throw new Error('SFTP 列表不存在');
    list.scrollTop = top;
    list.dispatchEvent(new Event('scroll', { bubbles: true }));
    return list.scrollTop;
  };
  shot.setPathInput = (value) => shot.setValue('.sftp-panel:not(.hidden) .sftp-path-input', value);
  shot.enterPathInput = () => {
    const input = document.querySelector('.sftp-panel:not(.hidden) .sftp-path-input');
    if (!input) throw new Error('SFTP 路径输入框不存在');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    return true;
  };
  shot.sftpEntries = async () => {
    const input = document.querySelector('.sftp-panel:not(.hidden) .sftp-path-input');
    return input ? input.value : '';
  };
  // ---- 终端几何：跨 DPR 比较行高 / 列宽 / 行列数 ----
  shot.terminalMetrics = () => {
    const host = document.querySelector('.terminal-host:not(.hidden)');
    if (!host) return null;
    const screen = host.querySelector('.xterm-screen');
    const rowsEl = host.querySelector('.xterm-rows');
    if (!screen || !rowsEl) return null;
    const rect = screen.getBoundingClientRect();
    const rowDivs = Array.from(rowsEl.children);
    const rowHeight = rowDivs.length ? rowDivs[0].getBoundingClientRect().height : 0;
    // xterm 的 DOM 渲染器按"同样式连续字符"切 span，所以用 span 宽度 / 字符数反推单元格宽度
    let weighted = 0;
    let weight = 0;
    rowDivs.slice(0, 40).forEach((row) => {
      Array.from(row.children).forEach((span) => {
        const text = span.textContent || '';
        const width = span.getBoundingClientRect().width;
        if (text.length >= 4 && width > 0) {
          weighted += width;
          weight += text.length;
        }
      });
    });
    const cellWidth = weight > 0 ? weighted / weight : 0;
    return {
      dpr: window.devicePixelRatio,
      screenWidth: rect.width,
      screenHeight: rect.height,
      screenTop: rect.top,
      screenLeft: rect.left,
      rowCount: rowDivs.length,
      rowHeight,
      cellWidth,
      colCount: cellWidth > 0 ? Math.round(rect.width / cellWidth) : 0,
      canvasCount: host.querySelectorAll('canvas').length
    };
  };
  // ---- 拖拽探针：记录 dataTransfer 里的真实文件与 webUtils.getPathForFile 的结果 ----
  shot.dragProbe = () => {
    const panel = document.querySelector('.sftp-panel:not(.hidden)');
    if (!panel) throw new Error('SFTP 面板不可见，无法安装拖拽探针');
    if (window.__uiShotDrag && window.__uiShotDrag.off) window.__uiShotDrag.off();
    const state = { events: [], types: [], files: [], paths: [], pathErrors: [], transfers: [], off: null };
    const record = (type) => (event) => {
      state.events.push(type);
      const dt = event.dataTransfer;
      if (!dt) return;
      state.types = Array.from(dt.types || []);
      const files = Array.from(dt.files || []);
      if (files.length) {
        state.files = files.map((file) => ({ name: file.name, size: file.size, type: file.type, lastModified: file.lastModified }));
        state.paths = [];
        state.pathErrors = [];
        files.forEach((file) => {
          try {
            state.paths.push(window.api.system.pathForFile(file));
          } catch (error) {
            state.pathErrors.push(String((error && error.message) || error));
          }
        });
      }
    };
    ['dragenter', 'dragover', 'drop'].forEach((type) => panel.addEventListener(type, record(type), true));
    const offTransfer = window.api.sftp.onTransfer((vo) => {
      state.transfers.push({ direction: vo.direction, name: vo.name, transferred: vo.transferred, total: vo.total, done: vo.done });
    });
    state.off = () => {
      ['dragenter', 'dragover', 'drop'].forEach((type) => panel.removeEventListener(type, record(type), true));
      offTransfer();
    };
    window.__uiShotDrag = state;
    return true;
  };
  shot.dragState = () => (window.__uiShotDrag ? JSON.parse(JSON.stringify({
    events: window.__uiShotDrag.events,
    types: window.__uiShotDrag.types,
    files: window.__uiShotDrag.files,
    paths: window.__uiShotDrag.paths,
    pathErrors: window.__uiShotDrag.pathErrors,
    transfers: window.__uiShotDrag.transfers
  })) : null);
  shot.dragOverlay = () => {
    const el = document.querySelector('.sftp-drop');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { text: shot.normalize(el.textContent).trim(), x: r.x, y: r.y, width: r.width, height: r.height };
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
 * @param {number} dpr 期望的像素密度，决定输出 PNG 的像素尺寸
 * @returns {Promise<{filePath: string, width: number, height: number, bytes: number, diversity: number, dpr: number}>} 截图信息
 */
async function captureScreenshot(cdp, filePath, viewport, dpr) {
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
  return { filePath, width: size.width, height: size.height, bytes: buffer.length, diversity, dpr }
}

// ---------------------------------------------------------------------------
// PNG 解码与像素量测（对比度 / 描边厚度 / 文字清晰度的证据来源）
// ---------------------------------------------------------------------------

/**
 * 解码一张 CDP 截图。
 * 只支持 Chromium 截图会产出的格式：位深 8、非隔行、色彩类型 6(RGBA) 或 2(RGB)，
 * 解析顺序为 IHDR -> IDAT -> IEND，并对每行做 PNG 的 5 种过滤器还原。
 * @param {Buffer} png PNG 文件内容
 * @returns {{width: number, height: number, rgba: Buffer}} 宽高与 RGBA 像素
 */
function decodePng(png) {
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('不是合法 PNG')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body[8]
      colorType = body[9]
      interlace = body[12]
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
    throw new Error(`不支持的 PNG 格式：bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`)
  }
  const channels = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const rgba = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const cur = Buffer.alloc(stride)
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      const x = line[i]
      let value
      if (filter === 0) value = x
      else if (filter === 1) value = x + a
      else if (filter === 2) value = x + b
      else if (filter === 3) value = x + ((a + b) >> 1)
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      } else {
        throw new Error(`未知 PNG 过滤器：${filter}`)
      }
      cur[i] = value & 0xff
    }
    for (let x = 0; x < width; x += 1) {
      const s = x * channels
      const d = (y * width + x) * 4
      rgba[d] = cur[s]
      rgba[d + 1] = cur[s + 1]
      rgba[d + 2] = cur[s + 2]
      rgba[d + 3] = channels === 4 ? cur[s + 3] : 255
    }
    prev = cur
  }
  return { width, height, rgba }
}

/**
 * 读取指定像素的颜色。
 * @param {{width: number, height: number, rgba: Buffer}} img 解码后的图
 * @param {number} x 横坐标（像素）
 * @param {number} y 纵坐标（像素）
 * @returns {{r: number, g: number, b: number, a: number}|null} 颜色，越界返回 null
 */
function pixelAt(img, x, y) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null
  const i = (y * img.width + x) * 4
  return { r: img.rgba[i], g: img.rgba[i + 1], b: img.rgba[i + 2], a: img.rgba[i + 3] }
}

/**
 * 解析 CSS 颜色文本。
 * @param {string} text 形如 rgb(31, 36, 48) / rgba(0, 0, 0, 0.5) 的文本
 * @returns {{r: number, g: number, b: number, a: number}|null} 颜色分量
 */
function parseRgb(text) {
  const matched = String(text ?? '').match(/rgba?\(([^)]+)\)/)
  if (!matched) return null
  const parts = matched[1].split(',').map((value) => Number(value.trim()))
  if (parts.length < 3 || parts.some((value) => !Number.isFinite(value))) return null
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
}

/**
 * 单个颜色通道的相对亮度分量（WCAG 2.1 公式）。
 * @param {number} value 0-255 的通道值
 * @returns {number} 相对亮度分量
 */
function channelLuminance(value) {
  const ratio = value / 255
  return ratio <= 0.03928 ? ratio / 12.92 : Math.pow((ratio + 0.055) / 1.055, 2.4)
}

/**
 * 颜色的相对亮度（WCAG 2.1）。
 * @param {{r: number, g: number, b: number}} color 颜色
 * @returns {number} 相对亮度 0-1
 */
function colorLuminance(color) {
  return (
    0.2126 * channelLuminance(color.r) +
    0.7152 * channelLuminance(color.g) +
    0.0722 * channelLuminance(color.b)
  )
}

/**
 * 两个颜色的 WCAG 对比度。
 * @param {{r: number, g: number, b: number}} a 颜色一
 * @param {{r: number, g: number, b: number}} b 颜色二
 * @returns {number} 1-21 之间的对比度
 */
function contrastRatio(a, b) {
  const la = colorLuminance(a)
  const lb = colorLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * 把带透明度的前景合成到背景上，得到实际呈现的颜色。
 * @param {{r: number, g: number, b: number, a?: number}} fg 前景
 * @param {{r: number, g: number, b: number}} bg 背景
 * @returns {{r: number, g: number, b: number, a: number}} 合成结果
 */
function blendOver(fg, bg) {
  const alpha = fg.a === undefined ? 1 : fg.a
  return {
    r: Math.round(fg.r * alpha + bg.r * (1 - alpha)),
    g: Math.round(fg.g * alpha + bg.g * (1 - alpha)),
    b: Math.round(fg.b * alpha + bg.b * (1 - alpha)),
    a: 1
  }
}

/**
 * 颜色的十六进制表示。
 * @param {{r: number, g: number, b: number}} color 颜色
 * @returns {string} 形如 #1f2430
 */
function toHex(color) {
  return `#${[color.r, color.g, color.b].map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`
}

/**
 * 统计一块矩形区域的像素分布：出现最多的颜色（视为背景）、最暗与最亮的像素。
 * @param {{width: number, height: number, rgba: Buffer}} img 解码后的图
 * @param {{x: number, y: number, width: number, height: number}} rect 区域（像素坐标）
 * @returns {{sampled: number, distinct: number, background: object, darkest: object, lightest: object}} 统计结果
 */
function regionStats(img, rect) {
  const counts = new Map()
  let darkest = null
  let lightest = null
  let sampled = 0
  const x0 = Math.max(0, Math.round(rect.x))
  const y0 = Math.max(0, Math.round(rect.y))
  const x1 = Math.min(img.width, Math.round(rect.x + rect.width))
  const y1 = Math.min(img.height, Math.round(rect.y + rect.height))
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const color = pixelAt(img, x, y)
      if (!color) continue
      sampled += 1
      const key = (color.r << 16) | (color.g << 8) | color.b
      counts.set(key, (counts.get(key) ?? 0) + 1)
      const lum = colorLuminance(color)
      if (!darkest || lum < darkest.lum) darkest = { ...color, lum }
      if (!lightest || lum > lightest.lum) lightest = { ...color, lum }
    }
  }
  let modeKey = 0
  let modeCount = -1
  for (const [key, count] of counts) {
    if (count > modeCount) {
      modeCount = count
      modeKey = key
    }
  }
  return {
    sampled,
    distinct: counts.size,
    background: {
      r: (modeKey >> 16) & 255,
      g: (modeKey >> 8) & 255,
      b: modeKey & 255,
      a: 1,
      share: sampled > 0 ? modeCount / sampled : 0
    },
    darkest,
    lightest
  }
}

/**
 * 文字清晰度代理指标：在给定区域内按亮度把像素分成前景核心 / 过渡 / 背景三类。
 * 纯缩放不会改变三者的占比（分子分母同步按 dpr² 放大），
 * 因此「过渡像素占比升高 + 前景核心占比下降 + 最大对比度下降」可以量化"文字变糊"。
 * @param {{width: number, height: number, rgba: Buffer}} img 解码后的图
 * @param {{x: number, y: number, width: number, height: number}} rect 文字区域（像素坐标）
 * @param {{r: number, g: number, b: number}} fg 前景色（主题声明值）
 * @param {{r: number, g: number, b: number}} bg 背景色（该区域的众数色）
 * @returns {{area: number, coreRatio: number, transitionRatio: number, backgroundRatio: number, maxContrast: number}} 清晰度指标
 */
function textSharpness(img, rect, fg, bg) {
  const fgLum = colorLuminance(fg)
  const bgLum = colorLuminance(bg)
  const span = Math.abs(fgLum - bgLum)
  const darkText = fgLum < bgLum
  const x0 = Math.max(0, Math.round(rect.x))
  const y0 = Math.max(0, Math.round(rect.y))
  const x1 = Math.min(img.width, Math.round(rect.x + rect.width))
  const y1 = Math.min(img.height, Math.round(rect.y + rect.height))
  let core = 0
  let transition = 0
  let background = 0
  let area = 0
  let maxContrast = 1
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const color = pixelAt(img, x, y)
      if (!color) continue
      area += 1
      const lum = colorLuminance(color)
      // 距离背景的亮度差达到整套前景/背景差值的 85% 即视为"文字核心像素"
      const reached = span > 0 ? Math.abs(lum - bgLum) / span : 0
      if (reached >= 0.85) core += 1
      else if (reached >= 0.15) transition += 1
      else background += 1
      const ratio = contrastRatio(color, bg)
      if (ratio > maxContrast) maxContrast = ratio
    }
  }
  return {
    area,
    core,
    transition,
    backgroundCount: background,
    coreRatio: area > 0 ? core / area : 0,
    transitionRatio: area > 0 ? transition / area : 0,
    backgroundRatio: area > 0 ? background / area : 0,
    darkText,
    maxContrast
  }
}

/**
 * 两个颜色的分量差之和，用于判断像素是否"明显不同"。
 * @param {{r: number, g: number, b: number}} a 颜色一
 * @param {{r: number, g: number, b: number}} b 颜色二
 * @returns {number} 差值之和（0-765）
 */
function colorDiff(a, b) {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)
}

/**
 * 量一条 1px 描边（横线或竖线）在给定扫描线上的设备像素厚度。
 * 两侧底色取扫描线两端各 6x8 区域的众数色，中间与两侧底色都不同的连续像素判为描边，
 * 这样即使描边颜色在浅色/深色主题下差异很大也能稳定识别。
 * @param {{width: number, height: number, rgba: Buffer}} img 解码后的图
 * @param {{x: number, y: number, length: number, axis: 'x'|'y', tolerance?: number}} options 扫描参数
 * @returns {{runs: Array<{start: number, length: number, color: string}>, thickness: number, color: object|null, before: object, after: object, strip: string[]}} 量测结果
 */
function measureBorder(img, options) {
  const { x, y, length, axis, tolerance = 14 } = options
  /**
   * 按扫描轴取一块 6x8 参考区域的众数色。
   * @param {number} offset 沿扫描轴的起点偏移
   * @returns {{r: number, g: number, b: number}} 参考底色
   */
  const referenceAt = (offset) => {
    const boxX = axis === 'x' ? x + offset : Math.max(0, x - 3)
    const boxY = axis === 'x' ? Math.max(0, y - 4) : y + offset
    const boxWidth = axis === 'x' ? 6 : 6
    const boxHeight = axis === 'x' ? 8 : 6
    return regionStats(img, { x: boxX, y: boxY, width: boxWidth, height: boxHeight }).background
  }
  const before = referenceAt(-14)
  const after = referenceAt(length - 6)
  const runs = []
  const strip = []
  let run = null
  for (let index = 0; index < length; index += 1) {
    const px = axis === 'x' ? x + index : x
    const py = axis === 'x' ? y : y + index
    const color = pixelAt(img, px, py)
    if (!color) break
    strip.push(toHex(color))
    const isBorder = colorDiff(color, before) > tolerance && colorDiff(color, after) > tolerance
    if (isBorder) {
      if (run) {
        run.length += 1
        run.colors.push(color)
      } else {
        run = { start: index, length: 1, colors: [color] }
        runs.push(run)
      }
    } else {
      run = null
    }
  }
  const longest = runs.slice().sort((a, b) => b.length - a.length)[0] ?? null
  return {
    runs: runs.map((item) => ({
      start: item.start,
      length: item.length,
      color: toHex(averageColor(item.colors))
    })),
    thickness: longest ? longest.length : 0,
    color: longest ? averageColor(longest.colors) : null,
    before,
    after,
    strip
  }
}

/**
 * 在多个候选纵坐标上量侧栏右边框，返回第一个厚度等于 dpr 的结果。
 * 侧栏列表出现滚动条时，其右缘会多出几像素滚动条底色，单点扫描会把滚动条误认成描边；
 * 换到页脚一带（没有滚动条）再量即可绕开。
 * @param {{width: number, height: number, rgba: Buffer}} img 解码后的图
 * @param {number} sidebarRight 侧栏右边界（CSS 像素）
 * @param {number} dpr 像素密度
 * @returns {{chosen: object, attempts: object[]}} 选中的量测结果与全部尝试
 */
function measureSidebarBorder(img, sidebarRight, dpr) {
  const attempts = []
  for (const ratio of [0.35, 0.6, 0.85]) {
    const y = Math.round(img.height * ratio)
    const start = Math.round(sidebarRight * dpr) - 8
    const border = measureBorder(img, { x: start, y, length: 24, axis: 'x' })
    attempts.push({ ratio, y, ...border })
  }
  // 小数密度下厚度不可能是整数 dpr（1.25 倍时 1px 描边只占 1 个完整设备像素 + 部分覆盖），
  // 因此按"与 dpr 的偏差最小"挑扫描位置；侧栏滚动条会让某一行多出几像素底色，偏差大的自然被排除
  const best = attempts
    .slice()
    .sort((a, b) => Math.abs(a.thickness - dpr) - Math.abs(b.thickness - dpr) || a.thickness - b.thickness)[0]
  return { chosen: best, attempts }
}

/**
 * 计算描边的覆盖率加权厚度。
 * 由于像素值 = 底色 + 覆盖率 x (描边色 - 底色)，而 colorDiff 对通道是线性的，
 * 于是「覆盖率 = 该像素与底色的差值 / 描边色与底色的差值」。
 * 1 CSS px 的描边在 dpr 倍图下应恰好等于 dpr 个设备像素；
 * 小数密度下它会摊到相邻两个像素上（部分覆盖），这属于缩放的必然结果，不等于错位或丢失。
 * @param {string[]} strip 扫描线上的十六进制颜色序列
 * @param {{r: number, g: number, b: number}} borderColor 描边色
 * @param {{r: number, g: number, b: number}} before 描边前一侧的底色
 * @param {{r: number, g: number, b: number}} after 描边后一侧的底色
 * @returns {{coverage: number, firstCoveredIndex: number|null, perPixel: number[]}} 覆盖率与逐像素覆盖
 */
function borderCoverage(strip, borderColor, before, after) {
  const denomBefore = colorDiff(borderColor, before)
  const denomAfter = colorDiff(borderColor, after)
  const perPixel = []
  let total = 0
  let firstCoveredIndex = null
  strip.forEach((hex, index) => {
    const color = {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16)
    }
    const candidates = []
    if (denomBefore > 0) candidates.push(colorDiff(color, before) / denomBefore)
    if (denomAfter > 0) candidates.push(colorDiff(color, after) / denomAfter)
    let coverage = Math.min(...candidates.map((value) => Math.max(0, Math.min(1, value))))
    if (coverage < 0.02) coverage = 0
    perPixel.push(Number(coverage.toFixed(2)))
    total += coverage
    if (coverage > 0 && firstCoveredIndex === null) firstCoveredIndex = index
  })
  return {
    coverage: Number(total.toFixed(2)),
    firstCoveredIndex,
    perPixel
  }
}

/**
 * 解析 CSS 颜色文本（同时支持 #rgb / #rrggbb / rgb() / rgba()）。
 * @param {string} text 颜色文本
 * @returns {{r: number, g: number, b: number, a: number}|null} 颜色分量
 */
function parseColorText(text) {
  const value = String(text ?? '').trim()
  if (!value) return null
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const body = hex[1].length === 3 ? hex[1].split('').map((ch) => ch + ch).join('') : hex[1]
    return {
      r: parseInt(body.slice(0, 2), 16),
      g: parseInt(body.slice(2, 4), 16),
      b: parseInt(body.slice(4, 6), 16),
      a: 1
    }
  }
  return parseRgb(value)
}

/**
 * 浅色主题令牌审计：对无法逐个像素采样的界面（空状态、快捷键提示、Toast、搜索栏等），
 * 用页面上实际生效的 CSS 变量值按 WCAG 公式算对比度，作为像素量测的补充。
 * 半透明令牌（如 accent-soft）会先合成到底色上再比较。
 * @param {object} ctx 截图上下文
 * @returns {Promise<Array<{label: string, foreground: string, background: string, ratio: number, verdict: string}>>} 审计结果
 */
async function auditLightTokens(ctx) {
  /** 采样组合：[说明, 文字色令牌, 底色令牌, 底色之下的不透明底色令牌] */
  const pairs = [
    ['空状态标题', '--text', '--bg-surface'],
    ['空状态说明', '--text-muted', '--bg-surface'],
    ['空状态图标/提示', '--text-faint', '--bg-surface'],
    ['快捷键提示 .kbd', '--text-muted', '--bg-raised'],
    ['终端搜索栏文字', '--text', '--bg-raised'],
    ['终端搜索栏计数', '--text-muted', '--bg-raised'],
    ['Toast 正文', '--text', '--bg-raised'],
    ['Toast 语义色仅用于左边框（非文本）', '--success', '--bg-raised'],
    ['Toast 信息色仅用于左边框（非文本）', '--accent', '--bg-raised'],
    ['Toast 失败色仅用于左边框（非文本）', '--danger', '--bg-raised'],
    ['系统安全存储警告', '--warning', '--warning-soft', '--bg-sidebar'],
    ['主机密钥弹窗-旧指纹文字', '--warning', '--bg-input'],
    ['标签栏断线重连图标（非文本）', '--warning', '--bg-sidebar'],
    ['SFTP 提示条（accent-strong）', '--accent-strong', '--accent-soft', '--bg-surface'],
    ['终端搜索栏激活按钮', '--accent-strong', '--accent-soft', '--bg-raised'],
    ['SFTP 文件名悬停', '--accent-strong', '--bg-hover'],
    ['标签栏激活符号（非文本）', '--accent', '--bg-sidebar'],
    ['状态条文案', '--text-muted', '--accent-soft', '--bg-surface'],
    ['弹窗说明 .modal-note', '--text-faint', '--bg-surface'],
    ['次级按钮文字', '--text-muted', '--bg-raised'],
    ['主按钮文字', '--accent-ink', '--accent'],
    ['标签栏未激活标题', '--text-muted', '--bg-sidebar'],
    ['标签栏激活标题', '--text', '--bg-sidebar'],
    ['SFTP 行名（正文）', '--text', '--bg-surface'],
    ['侧栏分组计数', '--text-faint', '--bg-sidebar'],
    ['提示文案 .hint-text', '--text-faint', '--bg-sidebar'],
    ['连接名（正文）', '--text', '--bg-sidebar'],
    ['连接主机行（次要）', '--text-muted', '--bg-sidebar'],
    ['输入框占位符', '--text-faint', '--bg-input'],
    ['表单字段标签', '--text-muted', '--bg-surface']
  ]
  const names = [...new Set(pairs.flatMap((pair) => [pair[1], pair[2], pair[3]].filter(Boolean)))]
  const resolved = JSON.parse(
    await ctx.cdp.evaluate(`(() => {
      const cs = getComputedStyle(document.documentElement);
      const out = {};
      ${JSON.stringify(names)}.forEach((name) => { out[name] = cs.getPropertyValue(name).trim(); });
      return JSON.stringify(out);
    })()`)
  )
  return pairs.map(([label, fgName, bgName, underName]) => {
    const foreground = parseColorText(resolved[fgName])
    let background = parseColorText(resolved[bgName])
    if (background && background.a < 1) {
      const under = underName ? parseColorText(resolved[underName]) : { r: 255, g: 255, b: 255, a: 1 }
      background = blendOver(background, under ?? { r: 255, g: 255, b: 255, a: 1 })
    }
    const ratio =
      foreground && background ? Number(contrastRatio(foreground, background).toFixed(2)) : null
    return {
      label,
      foregroundToken: fgName,
      backgroundToken: bgName,
      foreground: foreground ? toHex(foreground) : null,
      background: background ? toHex(background) : null,
      ratio,
      verdict: ratio === null ? '未采到' : ratio >= 4.5 ? '达标' : ratio >= 3.8 ? '临界不足' : '明显不足'
    }
  })
}

/**
 * 用 DevTools 的强制伪类把元素固定在某个状态（如 :hover）。
 * 它作用的是同一套 CSS，比 CDP 注入鼠标位置稳定（页面执行会清掉后者）。
 * @param {object} cdp CDP 客户端
 * @param {string} selector 目标元素选择器
 * @param {string[]} classes 伪类列表，空数组表示解除
 * @returns {Promise<number|null>} 节点 id，未找到时为 null
 */
async function forcePseudoState(cdp, selector, classes) {
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  const document0 = await cdp.send('DOM.getDocument', { depth: -1 })
  const node = await cdp.send('DOM.querySelector', { nodeId: document0.root.nodeId, selector })
  if (!node?.nodeId) return null
  await cdp.send('CSS.forcePseudoState', { nodeId: node.nodeId, forcedPseudoClasses: classes })
  return node.nodeId
}

/**
 * 打开终端搜索栏（优先 CDP 真实按键，失败时退回页面内合成按键）。
 * @param {object} ctx 截图上下文
 * @returns {Promise<boolean>} 是否打开成功
 */
async function openTerminalSearch(ctx) {
  const focusTerminal = `(() => {
    const textarea = document.querySelector('.terminal-host:not(.hidden) .xterm-helper-textarea');
    if (textarea) textarea.focus();
    return !!textarea && document.activeElement === textarea;
  })()`
  if (!(await ctx.cdp.evaluate(focusTerminal))) return false
  await ctx.cdp.dispatchKey({ key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 2 })
  if (await tryWait(ctx.cdp, `window.__uiShot.has('.term-search')`, 3000)) return true
  await ctx.cdp.evaluate(`(() => {
    const textarea = document.querySelector('.terminal-host:not(.hidden) .xterm-helper-textarea');
    if (!textarea) return false;
    textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true
    }));
    return true;
  })()`)
  return tryWait(ctx.cdp, `window.__uiShot.has('.term-search')`, 3000)
}

/**
 * 计算一条线段上像素的平均色。
 * @param {Array<{r: number, g: number, b: number}>} colors 像素颜色列表
 * @returns {{r: number, g: number, b: number}} 平均色
 */
function averageColor(colors) {
  const total = colors.reduce(
    (acc, color) => ({ r: acc.r + color.r, g: acc.g + color.g, b: acc.b + color.b }),
    { r: 0, g: 0, b: 0 }
  )
  const count = Math.max(1, colors.length)
  return {
    r: Math.round(total.r / count),
    g: Math.round(total.g / count),
    b: Math.round(total.b / count)
  }
}

/**
 * 把 CSS 像素矩形换算成设备像素矩形（截图坐标）。
 * @param {{x: number, y: number, width: number, height: number}} rect CSS 像素矩形
 * @param {number} dpr 像素密度
 * @returns {{x: number, y: number, width: number, height: number}} 设备像素矩形
 */
function toDeviceRect(rect, dpr) {
  return {
    x: rect.x * dpr,
    y: rect.y * dpr,
    width: rect.width * dpr,
    height: rect.height * dpr
  }
}

/**
 * 把量测结果写成一个 JSON 报告文件，便于事后复核与引用。
 * @param {string} outDir 输出目录
 * @param {string} name 报告名（不带扩展名）
 * @param {object} payload 报告内容
 * @returns {string} 报告文件绝对路径
 */
function writeReport(outDir, name, payload) {
  const file = path.join(outDir, `report-${name}.json`)
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return file
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
 * 打开某条连接的编辑表单（点侧栏连接项上的「编辑」按钮，走真实 UI 路径）。
 * @param {object} ctx 截图上下文
 * @param {string} name 连接名称
 * @returns {Promise<void>}
 */
async function openEditForm(ctx, name) {
  await ctx.cdp.evaluate(`window.__uiShot.clickConnAction(${JSON.stringify(name)}, '编辑')`)
  await waitFor(
    ctx.cdp,
    `window.__uiShot.text('.modal-title') === '编辑连接'`,
    `打开「${name}」的编辑表单`
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

/**
 * 重载页面并重新注入辅助脚本（等价于用户重启渲染进程的启动路径）。
 * @param {object} ctx 截图上下文
 * @returns {Promise<void>}
 */
async function reloadPage(ctx) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // 先埋标记：重载后标记消失才算新文档就绪，否则会误判成旧文档已完成
    await ctx.cdp.evaluate(`(window.__uiShotStale = true, setTimeout(() => location.reload(), 30), true)`)
    const reloaded = await tryWait(
      ctx.cdp,
      `typeof window.__uiShotStale === 'undefined' && document.readyState === 'complete'`,
      25000
    )
    if (reloaded) break
    // 首次未成功时打印现场并再试一次：渲染进程繁忙时偶发丢失一次 reload
    const diagnostics = await ctx.cdp
      .evaluate(
        `JSON.stringify({ readyState: document.readyState, stale: typeof window.__uiShotStale, href: location.href })`
      )
      .catch((error) => `诊断失败：${error.message}`)
    console.warn(`[警告] 页面重载未在超时内完成，现场：${diagnostics}`)
    if (attempt === 1) throw new Error(`等待超时：页面重载完成（现场：${diagnostics}）`)
  }
  await waitFor(ctx.cdp, `typeof window.api !== 'undefined'`, '重载后 window.api 可用')
  await ctx.cdp.evaluate(PAGE_HELPERS)
  await ctx.cdp.prepareFocus()
  await waitFor(
    ctx.cdp,
    `window.__uiShot.text('.sidebar-title') === '连接'`,
    '重载后侧边栏渲染完成',
    25000
  )
}

/**
 * 把主题切到目标主题：只通过点击 .theme-toggle 触发，走 React onClick -> writeThemeMode 的真实代码路径。
 * 每次点击都会在浅色/深色之间取反并写入 localStorage，因此最多点 3 次即可同时满足
 * 「data-theme 生效值」与「localStorage 持久化模式」两个条件（覆盖跟随系统等初始状态）。
 * @param {object} ctx 截图上下文
 * @param {'light'|'dark'} target 目标主题
 * @returns {Promise<object>} 切换后的主题状态
 */
async function ensureTheme(ctx, target) {
  const read = async () =>
    JSON.parse(await ctx.cdp.evaluate('JSON.stringify(window.__uiShot.themeState())'))
  let state = await read()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (state.theme === target && state.stored === target) break
    const before = state
    await ctx.cdp.evaluate('window.__uiShot.clickTheme()')
    // 每次点击都会把实际主题取反并写入 localStorage；这里只要求状态确实发生了迁移
    const changed = await tryWait(
      ctx.cdp,
      `(() => {
        const state = window.__uiShot.themeState();
        return state.theme !== ${JSON.stringify(before.theme)} || state.stored !== ${JSON.stringify(before.stored)};
      })()`,
      6000
    )
    if (!changed) {
      throw new Error(
        `点击主题按钮后主题状态没有变化（theme=${before.theme}，stored=${before.stored}）`
      )
    }
    await sleep(150)
    state = await read()
  }
  if (state.theme !== target) throw new Error(`主题切换失败：期望 ${target}，实际 ${state.theme}`)
  if (state.stored !== target) {
    throw new Error(`主题未按真实路径持久化：localStorage 里是 ${state.stored}，期望 ${target}`)
  }
  if (state.colorScheme !== target) {
    throw new Error(`color-scheme 未同步：实际 ${state.colorScheme}，期望 ${target}`)
  }
  if (!state.toggleTitle.includes(target === 'light' ? '浅色' : '深色')) {
    throw new Error(`主题按钮提示文案未更新：${state.toggleTitle}`)
  }
  return state
}

/**
 * 确保存在某连接的终端标签，并激活它；不存在时按真实点击路径新建。
 * @param {object} ctx 截图上下文
 * @param {string} name 连接名
 * @returns {Promise<string|null>} 新建时的会话 id，复用已有标签时返回 null
 */
async function ensureTerminal(ctx, name) {
  const tabs = await readTabs(ctx)
  if (tabs.some((tab) => tab.kind === 'terminal' && tab.title === name)) {
    await ctx.cdp.evaluate(`window.__uiShot.clickTab(${JSON.stringify(name)}, 'terminal')`)
    await waitFor(
      ctx.cdp,
      `window.__uiShot.has('.terminal-host:not(.hidden) .xterm-rows')`,
      `终端「${name}」可见`
    )
    return null
  }
  return openTerminalByName(ctx, name)
}

/**
 * 确保存在某连接的 SFTP 标签并激活；不存在时按真实点击路径新建。
 * @param {object} ctx 截图上下文
 * @param {string} name 连接名
 * @returns {Promise<void>}
 */
async function ensureSftp(ctx, name) {
  const tabs = await readTabs(ctx)
  if (!tabs.some((tab) => tab.kind === 'sftp' && tab.title === name)) {
    await openSftpByName(ctx, name)
  } else {
    await ctx.cdp.evaluate(`window.__uiShot.clickTab(${JSON.stringify(name)}, 'sftp')`)
  }
  await waitFor(ctx.cdp, `window.__uiShot.has('.sftp-panel:not(.hidden)')`, 'SFTP 面板可见', 20000)
}

/**
 * 清掉会话恢复提示条（若存在），避免它混进后续状态的截图。
 * @param {object} ctx 截图上下文
 * @returns {Promise<void>}
 */
async function dismissRestoreBar(ctx) {
  const has = await ctx.cdp.evaluate(`!!document.querySelector('.status-actions button')`)
  if (!has) return
  await ctx.cdp.evaluate('window.__uiShot.dismissRestore()')
  await tryWait(ctx.cdp, `!document.querySelector('.status-actions button')`, 4000)
  // 忽略会清掉磁盘上的快照，稍等一次 IPC 落盘
  await sleep(150)
}

/**
 * 惰性构造 2000 行的远程大目录。
 * 只在需要时注入内存文件系统，避免影响前面几步的目录列表截图。
 * @returns {number} 目录下的文件个数
 */
function ensureBigDir() {
  if (memfs.has(BIG_DIR)) return BIG_DIR_ENTRIES
  memfs.set(BIG_DIR, { type: 'dir', mtime: minutesAgo(4) })
  for (let index = 1; index <= BIG_DIR_ENTRIES; index += 1) {
    const name = `data-${String(index).padStart(4, '0')}.log`
    memfs.set(`${BIG_DIR}/${name}`, {
      type: 'file',
      content: filler(400 + ((index * 37) % 4096)),
      mtime: minutesAgo(index % 1440)
    })
  }
  return BIG_DIR_ENTRIES
}

/**
 * 用 CDP 注入一次携带真实文件路径的拖拽。
 * @param {object} cdp CDP 客户端
 * @param {object} options 参数
 * @param {{x: number, y: number}} options.point 目标坐标（CSS 像素）
 * @param {string} options.filePath 真实存在的本地文件绝对路径
 * @param {boolean} options.intercept 是否先开启 Input.setInterceptDrags
 * @returns {Promise<{intercept: boolean, steps: string[], data: object}>} 注入过程记录
 */
async function dispatchFileDrag(cdp, options) {
  const steps = []
  let intercept = false
  if (options.intercept) {
    // 部分 Chromium 版本要求先开启拖拽拦截，否则 renderer 收不到注入的拖拽事件
    await cdp.send('Input.setInterceptDrags', { enabled: true })
    intercept = true
    steps.push('Input.setInterceptDrags(enabled=true)')
  }
  const data = {
    items: [{ mimeType: 'text/plain', data: '', title: '', baseURL: '' }],
    files: [options.filePath],
    dragOperationsMask: 1
  }
  await cdp.send('Input.dispatchDragEvent', {
    type: 'dragEnter',
    x: options.point.x,
    y: options.point.y,
    data
  })
  steps.push('Input.dispatchDragEvent(dragEnter)')
  await cdp.send('Input.dispatchDragEvent', {
    type: 'dragOver',
    x: options.point.x,
    y: options.point.y,
    data
  })
  steps.push('Input.dispatchDragEvent(dragOver)')
  return { intercept, steps, data }
}

/**
 * 结束一次 CDP 拖拽（drop 或 dragCancel）。
 * @param {object} cdp CDP 客户端
 * @param {{x: number, y: number}} point 目标坐标
 * @param {'drop'|'dragCancel'} type 结束方式
 * @param {object} data 与 dragEnter 相同的数据
 * @returns {Promise<void>}
 */
async function finishFileDrag(cdp, point, type, data) {
  if (type === 'dragCancel') {
    await cdp.send('Input.dispatchDragEvent', { type: 'dragCancel', x: point.x, y: point.y, data })
    return
  }
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: point.x, y: point.y, data })
}

/**
 * 断言虚拟滚动下的行形状：行高一致、行间距等于行高、行不重叠。
 * @param {object} metrics sftpMetrics() 的结果
 * @param {string} label 断言上下文描述
 * @returns {void}
 */
function assertVirtualRowShape(metrics, label) {
  if (!metrics || metrics.rowCount === 0) throw new Error(`${label}：列表里没有任何数据行`)
  const heights = new Set(metrics.rows.map((row) => Math.round(row.height * 100) / 100))
  if (heights.size !== 1) {
    throw new Error(`${label}：行高不一致 ${[...heights].join(' / ')}`)
  }
  const height = [...heights][0]
  if (Math.abs(height - 32) > 0.51) {
    throw new Error(`${label}：行高应为 32px，实际 ${height}px`)
  }
  for (let index = 1; index < metrics.rows.length; index += 1) {
    const delta = metrics.rows[index].top - metrics.rows[index - 1].top
    if (Math.abs(delta - height) > 0.51) {
      throw new Error(
        `${label}：第 ${index} 行与上一行的间距为 ${delta.toFixed(2)}px，与行高 ${height}px 不一致（行重叠或错位）`
      )
    }
  }
  if (metrics.headBottom > metrics.listTop + 0.51) {
    throw new Error(
      `${label}：表头底部 ${metrics.headBottom} 压住了列表顶部 ${metrics.listTop}`
    )
  }
}

// ---------------------------------------------------------------------------
// 专项检查：高 DPI 对照 / 真实拖拽上传 / 浅色主题对比度
// ---------------------------------------------------------------------------

/**
 * 高 DPI 对照：同一终端画面在 1 / 1.25 / 1.5 / 2 四种像素密度下各截一张，
 * 记录 CSS 布局几何（行高、列宽、行列数）与像素指标（分辨率、1px 描边厚度、文字清晰度）。
 * @param {object} ctx 截图上下文
 * @param {string} outDir 输出目录
 * @returns {Promise<object>} 检查报告
 */
async function checkDpr(ctx, outDir) {
  const dir = path.join(outDir, 'dpr')
  fs.mkdirSync(dir, { recursive: true })
  await ctx.cdp.evaluate('window.__uiShot.closeOverlays()')
  await dismissRestoreBar(ctx)
  await ensureTheme(ctx, 'light')
  const hadTerminal = await ctx.cdp.evaluate(`window.__uiShot.closeTab('测试环境', 'terminal')`)
  if (hadTerminal) await sleep(400)
  await applyViewport(ctx.cdp, DEFAULT_VIEWPORT, DPR_SWEEP[0])
  await sleep(400)
  const sessionId = await ensureTerminal(ctx, '测试环境')
  if (!sessionId) throw new Error('高 DPI 对照需要一个全新的终端会话')
  await waitFor(
    ctx.cdp,
    `window.__uiShot.screenText().includes('Welcome to Ubuntu')`,
    '终端欢迎语到达',
    25000
  )
  for (const command of ['ls -lh', 'uptime']) {
    await ctx.cdp.evaluate(
      `(window.api.terminal.write(${JSON.stringify(sessionId)}, ${JSON.stringify(`${command}\n`)}), true)`
    )
    await sleep(400)
  }
  await waitFor(ctx.cdp, `window.__uiShot.screenText().includes('load average')`, '终端命令输出到达')

  const samples = []
  for (const dpr of DPR_SWEEP) {
    await applyViewport(ctx.cdp, DEFAULT_VIEWPORT, dpr)
    // 等 FitAddon 按新尺寸重排、字体按新密度重新栅格化
    await sleep(700)
    const metrics = JSON.parse(
      await ctx.cdp.evaluate('JSON.stringify(window.__uiShot.terminalMetrics())')
    )
    const sidebar = JSON.parse(await ctx.cdp.evaluate(`JSON.stringify(window.__uiShot.rect('.sidebar'))`))
    const rowsRect = JSON.parse(
      await ctx.cdp.evaluate(`JSON.stringify(window.__uiShot.rect('.terminal-host:not(.hidden) .xterm-rows'))`)
    )
    const screenshot = await captureScreenshot(
      ctx.cdp,
      path.join(dir, `03-terminal-dpr${dpr}.png`),
      DEFAULT_VIEWPORT,
      dpr
    )
    const img = decodePng(fs.readFileSync(screenshot.filePath))

    // 1px 描边：侧栏右边框（竖线）与侧栏头部下边框（横线），量它们在设备像素上的实际厚度
    const { chosen: border, attempts: borderAttempts } = measureSidebarBorder(img, sidebar.right, dpr)
    const scanY = border.y
    const headRect = JSON.parse(
      await ctx.cdp.evaluate(`JSON.stringify(window.__uiShot.rect('.sidebar-head'))`)
    )
    const horizontalStart = Math.round(headRect.bottom * dpr) - 6
    // x 取 4px：避开侧栏头部按钮的自身边框，保证扫描线上只有这一条 1px 描边
    const horizontal = measureBorder(img, {
      x: Math.round(4 * dpr),
      y: horizontalStart,
      length: 14,
      axis: 'y'
    })
    const borderDeclared = { r: 226, g: 229, b: 234 }
    const verticalCoverage = borderCoverage(border.strip, borderDeclared, border.before, border.after)
    const horizontalCoverage = borderCoverage(
      horizontal.strip,
      borderDeclared,
      horizontal.before,
      horizontal.after
    )
    // 文字清晰度：取终端前 3 行（欢迎语 + 空行）所在的整块区域做统计
    const textRect = toDeviceRect(
      { x: rowsRect.x, y: rowsRect.y + 2, width: Math.min(rowsRect.width, 520), height: metrics.rowHeight * 3 },
      dpr
    )
    const textStats = regionStats(img, textRect)
    const sharpness = textSharpness(
      img,
      textRect,
      { r: 31, g: 36, b: 48 },
      textStats.background
    )
    samples.push({
      dpr,
      png: { width: screenshot.width, height: screenshot.height, bytes: screenshot.bytes },
      expectedPng: { width: Math.round(DEFAULT_VIEWPORT.width * dpr), height: Math.round(DEFAULT_VIEWPORT.height * dpr) },
      css: {
        rowHeight: metrics.rowHeight,
        cellWidth: metrics.cellWidth,
        rowCount: metrics.rowCount,
        colCount: metrics.colCount,
        screenWidth: metrics.screenWidth,
        screenHeight: metrics.screenHeight
      },
      deviceRowPitch: metrics.rowHeight * dpr,
      deviceCellWidth: metrics.cellWidth * dpr,
      border: {
        thickness: border.thickness,
        scanY,
        attempts: borderAttempts.map((item) => ({ y: item.y, thickness: item.thickness, color: item.color ? toHex(item.color) : null })),
        runs: border.runs,
        strip: border.strip,
        color: border.color ? toHex(border.color) : null,
        before: toHex(border.before),
        after: toHex(border.after),
        // 1 CSS px 的描边在 dpr 倍图下应覆盖 dpr 个设备像素
        coverage: verticalCoverage.coverage,
        expectedCoverage: dpr,
        perPixelCoverage: verticalCoverage.perPixel,
        firstCoveredIndex: verticalCoverage.firstCoveredIndex
      },
      borderHorizontal: {
        thickness: horizontal.thickness,
        runs: horizontal.runs,
        strip: horizontal.strip,
        color: horizontal.color ? toHex(horizontal.color) : null,
        before: toHex(horizontal.before),
        after: toHex(horizontal.after),
        coverage: horizontalCoverage.coverage,
        expectedCoverage: dpr,
        perPixelCoverage: horizontalCoverage.perPixel,
        firstCoveredIndex: horizontalCoverage.firstCoveredIndex
      },
      text: {
        area: sharpness.area,
        core: sharpness.core,
        transition: sharpness.transition,
        // 文字核心像素数除以 dpr²：字形是矢量重栅格化时该值应基本恒定，位图放大则会塌陷
        corePerDpr2: Number((sharpness.core / (dpr * dpr)).toFixed(1)),
        coreRatio: Number(sharpness.coreRatio.toFixed(4)),
        transitionRatio: Number(sharpness.transitionRatio.toFixed(4)),
        maxContrast: Number(sharpness.maxContrast.toFixed(2)),
        background: toHex(textStats.background)
      },
      file: screenshot.filePath
    })
    console.log(
      `[检查] dpr=${dpr} 图 ${screenshot.width}x${screenshot.height}｜CSS 行高 ${metrics.rowHeight}px 列宽 ${metrics.cellWidth.toFixed(3)}px ` +
        `${metrics.colCount}列x${metrics.rowCount}行｜竖描边 覆盖 ${verticalCoverage.coverage}/${dpr} 设备像素（阈值厚度 ${samples[samples.length - 1].border.thickness}）、` +
        `横描边 覆盖 ${horizontalCoverage.coverage}/${dpr}｜文字核心像素 ${sharpness.core}` +
        `（/dpr²=${(sharpness.core / (dpr * dpr)).toFixed(1)}，过渡占比 ${(sharpness.transitionRatio * 100).toFixed(2)}%，最大对比度 ${sharpness.maxContrast.toFixed(2)}）`
    )
  }

  // 结论：CSS 几何是否跨密度一致、1px 描边是否仍为 1 CSS 像素
  const rowHeights = new Set(samples.map((sample) => sample.css.rowHeight))
  const cellWidths = new Set(samples.map((sample) => Number(sample.css.cellWidth.toFixed(2))))
  const colCounts = new Set(samples.map((sample) => sample.css.colCount))
  const report = {
    viewport: DEFAULT_VIEWPORT,
    terminal: 'light 主题，欢迎语 + ls -lh + uptime',
    samples,
    layoutStable: rowHeights.size === 1 && cellWidths.size === 1 && colCounts.size === 1,
    rowHeights: [...rowHeights],
    cellWidths: [...cellWidths],
    colCounts: [...colCounts],
    borderThickness: samples.map(
      (sample) =>
        `${sample.dpr}x:竖覆盖${sample.border.coverage}/${sample.dpr}(阈值厚度${sample.border.thickness}@y=${sample.border.scanY}` +
        `，候选 ${sample.border.attempts.map((item) => `${item.y}:${item.thickness}`).join('/')})` +
        `/横覆盖${sample.borderHorizontal.coverage}/${sample.dpr}`
    ),
    sharpness: samples.map((sample) => ({
      dpr: sample.dpr,
      transitionRatio: sample.text.transitionRatio,
      coreRatio: sample.text.coreRatio,
      corePerDpr2: sample.text.corePerDpr2,
      maxContrast: sample.text.maxContrast
    }))
  }
  const file = writeReport(outDir, 'dpr', report)
  console.log(`[检查] 高 DPI 对照报告：${file}`)
  console.log(
    `[检查] 布局是否跨密度一致：${report.layoutStable ? '一致' : '不一致'}` +
      `（行高 ${report.rowHeights.join('/')}，列宽 ${report.cellWidths.join('/')}，列数 ${report.colCounts.join('/')}）`
  )
  return report
}

/**
 * 真实拖拽上传：用 CDP Input.dispatchDragEvent 注入指向真实临时文件的拖拽，
 * 校验 webUtils.getPathForFile 能否取到路径、文件是否真的写进内存 SFTP 服务。
 * @param {object} ctx 截图上下文
 * @param {string} outDir 输出目录
 * @returns {Promise<object>} 检查报告
 */
async function checkDrag(ctx, outDir) {
  await ctx.cdp.evaluate('window.__uiShot.closeOverlays()')
  await dismissRestoreBar(ctx)
  await applyViewport(ctx.cdp, DEFAULT_VIEWPORT, ctx.dpr)
  await sleep(300)
  await ensureTheme(ctx, 'light')
  await ensureSftp(ctx, '测试环境')
  // 回到 home，保证上传目标目录可预期
  await ctx.cdp.evaluate(`window.__uiShot.setPathInput(${JSON.stringify(FAKE_HOME)})`)
  await ctx.cdp.evaluate('window.__uiShot.enterPathInput()')
  await waitFor(
    ctx.cdp,
    `(() => {
      const input = document.querySelector('.sftp-panel:not(.hidden) .sftp-path-input');
      return !!input && input.value === ${JSON.stringify(FAKE_HOME)};
    })()`,
    'SFTP 面板回到 home'
  )

  // 真实临时文件：内容可校验，路径真实存在；体积取 256KB 让上传分成多块、能观察到进度事件
  const token = `ui-shot-drag-${Date.now()}`
  const fileName = `${token}.txt`
  const localPath = path.join(os.tmpdir(), fileName)
  const head = [
    '# ui-shot 拖拽上传样本',
    'line-01 0123456789',
    'line-02 abcdefghij',
    '中文内容用于校验 UTF-8 传输',
    `token=${token}`
  ].join('\r\n')
  const padding = Buffer.alloc(256 * 1024, 'x')
  const content = Buffer.concat([Buffer.from(`${head}\r\n`, 'utf8'), padding])
  fs.writeFileSync(localPath, content)

  const report = {
    localFile: { path: localPath, bytes: content.length, name: fileName },
    remoteDir: FAKE_HOME,
    attempts: []
  }

  const panelRect = JSON.parse(
    await ctx.cdp.evaluate(`JSON.stringify(window.__uiShot.rect('.sftp-panel:not(.hidden)'))`)
  )
  const point = {
    x: Math.round(panelRect.x + panelRect.width / 2),
    y: Math.round(panelRect.y + panelRect.height / 2)
  }

  await ctx.cdp.evaluate('window.__uiShot.dragProbe()')
  let dropped = false
  let lastError = null
  for (const intercept of [false, true]) {
    try {
      const started = await dispatchFileDrag(ctx.cdp, { point, filePath: localPath, intercept })
      await sleep(300)
      const overlay = JSON.parse(
        await ctx.cdp.evaluate('JSON.stringify(window.__uiShot.dragOverlay())')
      )
      report.attempts.push({
        intercept,
        steps: started.steps,
        overlay,
        injectedFiles: started.data.files
      })
      if (overlay) {
        // 拖拽悬停时的覆盖层是浅色主题的一个观察点，顺手留图
        await captureScreenshot(
          ctx.cdp,
          path.join(outDir, 'drag-overlay.png'),
          DEFAULT_VIEWPORT,
          ctx.dpr
        )
        report.overlayScreenshot = path.join(outDir, 'drag-overlay.png')
      }
      await finishFileDrag(ctx.cdp, point, 'drop', started.data)
      dropped = true
      report.attempts[report.attempts.length - 1].dropped = true
      break
    } catch (error) {
      lastError = error
      report.attempts.push({ intercept, error: String(error.message || error) })
      await finishFileDrag(ctx.cdp, point, 'dragCancel', {
        items: [{ mimeType: 'text/plain', data: '', title: '', baseURL: '' }],
        files: [localPath],
        dragOperationsMask: 1
      }).catch(() => undefined)
    }
  }
  if (!dropped) {
    report.error = `CDP 拖拽注入失败：${String(lastError?.message || lastError)}`
  }

  const dragState = JSON.parse(await ctx.cdp.evaluate('JSON.stringify(window.__uiShot.dragState())'))
  report.dragState = dragState
  report.pathResolved = Boolean(dragState?.paths?.[0])
  report.pathMatchesLocal = dragState?.paths?.[0] === localPath

  // 文件是否真的落到内存 SFTP 服务：面板刷新出的行 + 服务端节点字节数
  const remotePath = `${FAKE_HOME}/${fileName}`
  const appeared = await tryWait(
    ctx.cdp,
    `(() => {
      const input = document.querySelector('.sftp-panel:not(.hidden) .sftp-path-input');
      if (!input || input.value !== ${JSON.stringify(FAKE_HOME)}) return false;
      const text = window.__uiShot.text('.sftp-panel:not(.hidden) .sftp-list');
      return text.includes(${JSON.stringify(fileName)});
    })()`,
    15000
  )
  report.remoteRowVisible = appeared
  // 上传是异步的：等落地后再读一次探针状态，才能看到进度事件
  report.finalDragState = JSON.parse(
    await ctx.cdp.evaluate('JSON.stringify(window.__uiShot.dragState())')
  )
  const node = memfs.get(remotePath)
  report.remoteNode = node
    ? { type: node.type, bytes: node.content.length, matchesLocal: node.content.equals(content) }
    : null
  if (report.remoteNode?.matchesLocal) {
    await captureScreenshot(ctx.cdp, path.join(outDir, 'drag-uploaded.png'), DEFAULT_VIEWPORT, ctx.dpr)
    report.uploadedScreenshot = path.join(outDir, 'drag-uploaded.png')
  }

  // 收尾：删掉本地临时文件与远程测试文件，并让面板刷新回真实列表，避免影响后续截图
  fs.rmSync(localPath, { force: true })
  memfs.delete(remotePath)
  await ctx.cdp.evaluate(
    `(() => { const el = document.querySelector('.sftp-panel:not(.hidden) .sftp-btn'); if (el) el.click(); return true })()`
  )
  await sleep(300)

  const file = writeReport(outDir, 'drag', report)
  console.log(`[检查] 拖拽报告：${file}`)
  console.log(
    `[检查] 拖拽链路：注入事件=${report.dragState?.events?.join('>') || '无'}｜` +
      `dataTransfer.types=${JSON.stringify(report.dragState?.types || [])}｜` +
      `取到路径=${report.pathResolved ? report.dragState.paths[0] : '否'}｜` +
      `上传进度事件=${(report.finalDragState?.transfers || []).length} 条｜` +
      `面板出现文件行=${report.remoteRowVisible}｜` +
      `内存 SFTP 落地=${report.remoteNode ? `${report.remoteNode.bytes} 字节，内容一致=${report.remoteNode.matchesLocal}` : '否'}`
  )
  return report
}

/**
 * 浅色主题对比度：截浅色界面后按元素矩形做像素量测，
 * 抽查正文 / 次要文本 / 表头 / 禁用态 / 描边 / 悬停与拖拽覆盖层，
 * 用 WCAG 2.1 公式给出对比度（正文阈值 4.5:1，非文本 UI 阈值 3:1）。
 * @param {object} ctx 截图上下文
 * @param {string} outDir 输出目录
 * @returns {Promise<object>} 检查报告
 */
async function checkContrast(ctx, outDir) {
  await ctx.cdp.evaluate('window.__uiShot.closeOverlays()')
  await dismissRestoreBar(ctx)
  await applyViewport(ctx.cdp, DEFAULT_VIEWPORT, ctx.dpr)
  await sleep(300)
  await ensureTheme(ctx, 'light')

  const targets = []
  /**
   * 采集一个采样点：读取声明颜色与元素矩形，稍后从对应截图里量实际像素。
   * @param {string} label 采样点名称
   * @param {string} selector CSS 选择器
   * @param {'text'|'border'|'placeholder'} kind 采样类型
   * @param {string} note 备注（阈值与预期）
   * @param {'sidebar'|'sftp'|'hover'|'overlay'} source 从哪张截图取样
   * @param {boolean} [wcagExempt] 是否为 WCAG 豁免项（如禁用态），只记录实测值
   * @returns {Promise<void>}
   */
  const collect = async (label, selector, kind, note, source, wcagExempt) => {
    const info = JSON.parse(
      await ctx.cdp.evaluate(`JSON.stringify({
        rect: window.__uiShot.rect(${JSON.stringify(selector)}),
        style: (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const cs = getComputedStyle(el);
          return {
            color: cs.color,
            background: cs.backgroundColor,
            borderTop: cs.borderTopColor,
            borderBottom: cs.borderBottomColor,
            borderRight: cs.borderRightColor,
            opacity: cs.opacity,
            fontSize: cs.fontSize
          };
        })()
      })`)
    )
    if (!info.rect || !info.style) {
      targets.push({ label, selector, kind, note, source, wcagExempt, missing: true })
      return
    }
    targets.push({ label, selector, kind, note, source, wcagExempt, info })
  }

  // 截图登记表：采样点用 source 键取对应那张图
  const shots = {}
  /**
   * 截图并登记到 source 键上。
   * @param {string} source 采样来源键
   * @param {string} file 输出文件名
   * @returns {Promise<object>} 截图信息
   */
  const shotTo = async (source, file) => {
    shots[source] = await captureScreenshot(ctx.cdp, path.join(outDir, file), DEFAULT_VIEWPORT, ctx.dpr)
    return shots[source]
  }

  // ---- 第一段：浅色侧栏（分组、页脚、搜索框占位符、分隔线）采样后立即截图 ----
  await collect('侧栏-连接名（正文，普通行）', '.conn-item:not(.session-active) .conn-name', 'text', '正文阈值 4.5:1，字重 600', 'sidebar')
  await collect('侧栏-主机行（次要文本，普通行）', '.conn-item:not(.session-active) .conn-sub', 'text', '11px 等宽，阈值 4.5:1', 'sidebar')
  await collect('侧栏-分组标题', '.conn-group-head .conn-group-name', 'text', '12px 600，阈值 4.5:1', 'sidebar')
  await collect('侧栏-分组计数', '.conn-group-count', 'text', '11px text-faint，阈值 4.5:1', 'sidebar')
  await collect('侧栏-页脚（text-faint）', '.sidebar-foot span', 'text', '阈值 4.5:1', 'sidebar')
  await collect('侧栏-搜索框占位符', '.conn-search input', 'placeholder', 'placeholder 用 text-faint，阈值 4.5:1', 'sidebar')
  await collect('侧栏-分隔线描边', '.sidebar', 'border', '非文本 UI 阈值 3:1', 'sidebar')
  await shotTo('sidebar', 'contrast-sidebar.png')

  // ---- 第二段：浅色 SFTP（表头、次要列、禁用态按钮、提示条）----
  await ensureSftp(ctx, '测试环境')
  // 进到根目录：上一级按钮在 cwd='/' 时禁用，正好用来量禁用态
  await ctx.cdp.evaluate(`window.__uiShot.setPathInput('/')`)
  await ctx.cdp.evaluate('window.__uiShot.enterPathInput()')
  await waitFor(
    ctx.cdp,
    `window.__uiShot.has('.sftp-panel:not(.hidden) .sftp-toolbar button:disabled')`,
    '出现禁用态按钮（根目录下「上一级」禁用）',
    15000
  )
  await collect('SFTP-表头文字', '.sftp-panel:not(.hidden) .sftp-head .col-name', 'text', '12px text-faint，阈值 4.5:1', 'sftp')
  await collect('SFTP-表头描边', '.sftp-panel:not(.hidden) .sftp-head', 'border-bottom', '非文本 UI 阈值 3:1', 'sftp')
  await collect('SFTP-大小列（次要）', '.sftp-panel:not(.hidden) .sftp-list .col-size', 'text', '12.5px text-muted，阈值 4.5:1', 'sftp')
  await collect('SFTP-修改时间列（次要）', '.sftp-panel:not(.hidden) .sftp-list .col-time', 'text', '12.5px text-muted，阈值 4.5:1', 'sftp')
  await collect(
    'SFTP-禁用态按钮（上一级）',
    '.sftp-panel:not(.hidden) .sftp-toolbar button:disabled',
    'text',
    'disabled 态：WCAG 1.4.3 豁免，仅记录实测值',
    'sftp',
    true
  )
  await shotTo('sftp', 'contrast-sftp.png')
  // 提示条（.sftp-message：accent on accent-soft）：跳一个不存在的目录就会显示
  await ctx.cdp.evaluate(`window.__uiShot.setPathInput('/ui-shot-no-such-dir')`)
  await ctx.cdp.evaluate('window.__uiShot.enterPathInput()')
  await waitFor(
    ctx.cdp,
    `window.__uiShot.has('.sftp-panel:not(.hidden) .sftp-message')`,
    'SFTP 面板出现提示条',
    15000
  )
  await collect('SFTP-提示条文字', '.sftp-panel:not(.hidden) .sftp-message', 'text', 'accent on accent-soft，阈值 4.5:1', 'sftpMessage')
  await shotTo('sftpMessage', 'contrast-sftp-message.png')
  await ctx.cdp.evaluate(`window.__uiShot.setPathInput(${JSON.stringify(FAKE_HOME)})`)
  await ctx.cdp.evaluate('window.__uiShot.enterPathInput()')
  await tryWait(
    ctx.cdp,
    `!window.__uiShot.has('.sftp-panel:not(.hidden) .sftp-message')`,
    6000
  )
  // 文件名悬停：悬停色从 --accent 改为 --accent-strong，需实测像素
  const nameNode = await forcePseudoState(ctx.cdp, '.sftp-panel:not(.hidden) .sftp-name', ['hover'])
  if (nameNode) {
    await sleep(250)
    await collect('SFTP-文件名悬停', '.sftp-panel:not(.hidden) .sftp-name', 'text', 'accent-strong on bg-hover，阈值 4.5:1', 'nameHover')
    await shotTo('nameHover', 'contrast-sftp-name-hover.png')
    await forcePseudoState(ctx.cdp, '.sftp-panel:not(.hidden) .sftp-name', [])
    await sleep(150)
  } else {
    targets.push({ label: 'SFTP-文件名悬停', selector: '.sftp-name', kind: 'text', note: '未找到文件名元素', missing: true })
  }

  // ---- 第三段：已连接行（非悬停）与标签栏 ----
  const sessionId = await ensureTerminal(ctx, '测试环境')
  if (sessionId) await waitFor(ctx.cdp, `window.__uiShot.screenText().length > 0`, '终端有输出')
  await ctx.cdp.evaluate(`window.__uiShot.clickTab('测试环境', 'terminal')`)
  await sleep(300)
  await collect('侧栏-连接名（正文，已连接行）', '.conn-item.session-active .conn-name', 'text', '已连接行用 accent-soft 底色，阈值 4.5:1', 'active')
  await collect('标签栏-未激活标签标题', '.tab:not(.active) .tab-title', 'text', '阈值 4.5:1', 'active')
  await collect('标签栏-激活标签标题', '.tab.active .tab-title', 'text', '阈值 4.5:1', 'active')
  await shotTo('active', 'contrast-active-row.png')

  // ---- 第三段附：终端搜索栏的激活按钮（文字色从 --accent 改为 --accent-strong）----
  if (await openTerminalSearch(ctx)) {
    await ctx.cdp.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('.term-search-btn')).find(
        (el) => (el.getAttribute('title') || '').includes('区分大小写')
      );
      if (button) button.click();
      return !!button;
    })()`)
    if (await tryWait(ctx.cdp, `window.__uiShot.has('.term-search-btn.active')`, 4000)) {
      await sleep(250)
      await collect('终端搜索栏-激活按钮', '.term-search-btn.active', 'text', 'accent-strong on accent-soft，阈值 4.5:1', 'searchActive')
      await shotTo('searchActive', 'contrast-search-active.png')
    } else {
      targets.push({ label: '终端搜索栏-激活按钮', selector: '.term-search-btn.active', kind: 'text', note: '切换按钮未进入激活态', missing: true })
    }
    await ctx.cdp.evaluate(`(() => {
      const close = Array.from(document.querySelectorAll('.term-search-btn')).find(
        (el) => (el.getAttribute('title') || '').includes('关闭')
      );
      if (close) close.click();
      return !!close;
    })()`)
    await tryWait(ctx.cdp, `!window.__uiShot.has('.term-search')`, 4000)
  } else {
    targets.push({ label: '终端搜索栏-激活按钮', selector: '.term-search-btn.active', kind: 'text', note: '搜索栏未打开', missing: true })
  }

  // ---- 第四段：悬停态（已连接行的悬停底色）----
  const hoverRect = JSON.parse(
    await ctx.cdp.evaluate(`(() => {
      const el = document.querySelector('.conn-item.session-active');
      if (!el) return 'null';
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
    })()`)
  )
  let hoverProbe = null
  if (hoverRect) {
    const point = { x: Math.round(hoverRect.x + 40), y: Math.round(hoverRect.y + 10) }
    /**
     * 读取已连接行在当前悬停态下的实际背景色，用来确认鼠标真的停在行上。
     * @returns {Promise<object|null>} 计算样式快照
     */
    const probe = async () =>
      JSON.parse(
        await ctx.cdp.evaluate(`(() => {
          const el = document.querySelector('.conn-item.session-active');
          if (!el) return 'null';
          const cs = getComputedStyle(el);
          const actions = el.querySelector('.conn-actions');
          return JSON.stringify({
            background: cs.backgroundColor,
            actionsOpacity: actions ? getComputedStyle(actions).opacity : null,
            focusWithin: el.matches(':focus-within'),
            hovered: el.matches(':hover')
          });
        })()`)
      )
    hoverProbe = { before: await probe(), steps: [] }
    await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 })
    await sleep(350)
    hoverProbe.steps.push({ point, state: await probe() })
    // Runtime.evaluate 之后 CDP 注入的鼠标悬停可能丢失，改用 DevTools 的强制伪类把 :hover 固定住
    const hoverNodeId = await forcePseudoState(ctx.cdp, '.conn-item.session-active', ['hover'])
    if (!hoverNodeId) throw new Error('未找到已连接的连接项，无法验证悬停态')
    await sleep(250)
    hoverProbe.forced = await probe()
    hoverProbe.mechanism = hoverProbe.steps[hoverProbe.steps.length - 1].state?.hovered
      ? 'mouseMoved + CSS.forcePseudoState'
      : 'CSS.forcePseudoState（鼠标注入未生效时的兜底）'
    console.log(
      `[检查] 悬停探针：${JSON.stringify(hoverProbe.before)} -> ${JSON.stringify(hoverProbe.forced)}（${hoverProbe.mechanism}）`
    )
    await collect('悬停-已连接行（正文）', '.conn-item.session-active .conn-name', 'text', '悬停态，阈值 4.5:1', 'hover')
    await collect('悬停-已连接行（次要文本）', '.conn-item.session-active .conn-sub', 'text', '悬停态，阈值 4.5:1', 'hover')
    await shotTo('hover', 'contrast-hover-active.png')
    // 解除强制伪类并把鼠标移开，避免影响后续状态
    await forcePseudoState(ctx.cdp, '.conn-item.session-active', [])
    await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 500, buttons: 0 })
    await sleep(200)
  }
  // 悬停采样结束后再回到 SFTP 面板，供拖拽覆盖层使用
  await ctx.cdp.evaluate(`window.__uiShot.clickTab('测试环境', 'sftp')`)
  await waitFor(ctx.cdp, `window.__uiShot.has('.sftp-panel:not(.hidden)')`, '切回 SFTP 面板')

  // 拖拽覆盖层（浅色主题下 .sftp-drop 用的是写死的深色背景），用真实拖拽注入把它调出来
  const token = `ui-shot-contrast-${Date.now()}`
  const localPath = path.join(os.tmpdir(), `${token}.txt`)
  fs.writeFileSync(localPath, 'contrast probe\n', 'utf8')
  const overlayPanel = JSON.parse(
    await ctx.cdp.evaluate(`(() => {
      const el = document.querySelector('.sftp-panel:not(.hidden)');
      if (!el) return 'null';
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
    })()`)
  )
  if (overlayPanel) {
    const point = {
      x: Math.round(overlayPanel.x + overlayPanel.width / 2),
      y: Math.round(overlayPanel.y + overlayPanel.height / 2)
    }
    try {
      const started = await dispatchFileDrag(ctx.cdp, { point, filePath: localPath, intercept: true })
      await sleep(400)
      const overlay = JSON.parse(await ctx.cdp.evaluate('JSON.stringify(window.__uiShot.dragOverlay())'))
      if (overlay) {
        await shotTo('overlay', 'contrast-drag-overlay.png')
        targets.push({
          label: '拖拽覆盖层文字',
          selector: '.sftp-drop',
          kind: 'text',
          note: `浅色主题下的覆盖层提示：${overlay.text}`,
          source: 'overlay',
          info: {
            // 只取文字所在的中部窄条，避免把整块底色的像素算成文字
            rect: {
              x: overlay.x + overlay.width / 2 - 110,
              y: overlay.y + overlay.height / 2 - 10,
              width: 220,
              height: 20
            },
            style: JSON.parse(
              await ctx.cdp.evaluate(`JSON.stringify((() => {
                const el = document.querySelector('.sftp-drop');
                const cs = getComputedStyle(el);
                return { color: cs.color, background: cs.backgroundColor, opacity: '1', fontSize: cs.fontSize };
              })())`)
            )
          }
        })
      }
      await finishFileDrag(ctx.cdp, point, 'dragCancel', started.data)
      // dragCancel 不会触发 dragleave，组件里的覆盖层会一直留着，补一次 dragleave 让它复位
      await ctx.cdp.evaluate(`(() => {
        const panel = document.querySelector('.sftp-panel:not(.hidden)');
        if (!panel) return false;
        panel.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }));
        return true;
      })()`)
      await tryWait(ctx.cdp, `!window.__uiShot.has('.sftp-drop')`, 4000)
      // 关掉拖拽拦截，避免影响后续的鼠标/导航行为
      await ctx.cdp.send('Input.setInterceptDrags', { enabled: false }).catch(() => undefined)
    } catch (error) {
      targets.push({ label: '拖拽覆盖层文字', selector: '.sftp-drop', kind: 'text', error: String(error.message) })
    }
  }
  fs.rmSync(localPath, { force: true })

  // ---- 第五段：连接表单弹窗 ----
  await ctx.cdp.evaluate(`window.__uiShot.click('.sidebar-head .primary-btn[title="新建连接"]')`)
  await waitFor(ctx.cdp, `window.__uiShot.text('.modal-title') === '新建连接'`, '打开新建连接表单')
  // .modal 有 140ms 的入场动画（opacity 0→1），必须等动画结束再采样，否则量到的是半透明中间帧
  await sleep(400)
  await collect('表单-标题', '.modal .modal-title', 'text', '阈值 4.5:1', 'form')
  await collect('表单-字段标签', '.modal .field span', 'text', 'text-muted on 弹窗底色，阈值 4.5:1', 'form')
  await collect('表单-输入框占位符', '.modal .field input', 'placeholder', 'placeholder 用 text-faint，阈值 4.5:1', 'form')
  await collect('表单-取消按钮', '.modal-foot button:not(.primary-btn)', 'text', '次级按钮，阈值 4.5:1', 'form')
  await shotTo('form', 'contrast-form.png')
  await ctx.cdp.evaluate('window.__uiShot.closeOverlays()')
  await tryWait(ctx.cdp, `!window.__uiShot.has('.modal-title')`, 4000)

  // 原第六段（端口转发面板空态 / 运行中 / 已停止徽标）已随该功能移除而删除

  // ---- 第七段：会话恢复提示条（预置快照后重载触发）----
  await ctx.cdp.evaluate(`(async () => {
    const list = await window.api.connections.list();
    const target = list.find((item) => item.name === '测试环境');
    await window.api.session.save({
      tabs: [{ kind: 'terminal', connectionId: target.id }],
      savedAt: Date.now()
    });
    return true;
  })()`)
  await reloadPage(ctx)
  await waitFor(ctx.cdp, `!!window.__uiShot.restoreBar()`, '出现会话恢复提示条', 15000)
  await collect('恢复提示条-文案', '.status-bar .status-text', 'text', '阈值 4.5:1', 'restore')
  await collect('恢复提示条-忽略按钮', '.status-actions .status-btn:not(.primary-btn)', 'text', '次级按钮，阈值 4.5:1', 'restore')
  await shotTo('restore', 'contrast-restore.png')
  await ctx.cdp.evaluate('window.__uiShot.dismissRestore()')
  await sleep(200)

  // 逐点量测：声明颜色算理论对比度，截图像素算实际呈现对比度
  const images = new Map()
  const imageFor = (source) => {
    const shot = shots[source]
    if (!shot) return null
    if (!images.has(shot.filePath)) images.set(shot.filePath, decodePng(fs.readFileSync(shot.filePath)))
    return images.get(shot.filePath)
  }
  const measured = []
  for (const target of targets) {
    if (target.missing || target.error || !target.info) {
      measured.push({ ...target, verdict: '未采到' })
      continue
    }
    const style = target.info.style
    const rect = target.info.rect
    const image = imageFor(target.source)
    if (!image) {
      measured.push({ ...target, verdict: '未采到（缺少截图）' })
      continue
    }
    const declared = parseRgb(style.color)
    const background = parseRgb(style.background)
    const opacity = Number(style.opacity)
    if (target.kind === 'border' || target.kind === 'border-bottom') {
      const vertical = target.kind === 'border'
      // 描边取 3 设备像素宽的窄带里的最极端像素，避免 1px 边界因四舍五入落在相邻像素上而漏检
      const borderPixels = vertical
        ? regionStats(
            image,
            toDeviceRect(
              { x: rect.x + rect.width - 2, y: rect.y + 8, width: 3, height: Math.max(4, rect.height - 16) },
              ctx.dpr
            )
          )
        : regionStats(
            image,
            toDeviceRect(
              { x: rect.x + 20, y: rect.y + rect.height - 2, width: 120, height: 3 },
              ctx.dpr
            )
          )
      const inside = vertical
        ? regionStats(
            image,
            toDeviceRect(
              { x: rect.x + rect.width - 9, y: rect.y + 8, width: 6, height: Math.max(4, rect.height - 16) },
              ctx.dpr
            )
          ).background
        : regionStats(
            image,
            toDeviceRect({ x: rect.x + 20, y: rect.y + rect.height - 9, width: 120, height: 6 }, ctx.dpr)
          ).background
      const outside = vertical
        ? regionStats(
            image,
            toDeviceRect(
              { x: rect.x + rect.width + 1, y: rect.y + 8, width: 6, height: Math.max(4, rect.height - 16) },
              ctx.dpr
            )
          ).background
        : regionStats(
            image,
            toDeviceRect({ x: rect.x + 20, y: rect.y + rect.height + 1, width: 120, height: 6 }, ctx.dpr)
          ).background
      const color = borderPixels.darkest?.lum < borderPixels.lightest?.lum ? borderPixels.darkest : borderPixels.lightest
      const ratioInside = color ? Number(contrastRatio(color, inside).toFixed(2)) : null
      const ratioOutside = color ? Number(contrastRatio(color, outside).toFixed(2)) : null
      const best = Math.max(ratioInside ?? 0, ratioOutside ?? 0)
      measured.push({
        label: target.label,
        selector: target.selector,
        kind: target.kind,
        note: target.note,
        source: target.source,
        declaredRatio: null,
        measuredColor: color ? toHex(color) : null,
        insideBackground: toHex(inside),
        outsideBackground: toHex(outside),
        ratioInside,
        ratioOutside,
        threshold: 3,
        verdict: best >= 3 ? '达标' : best >= 1.15 ? '低于非文本阈值（装饰性）' : '明显不足'
      })
      continue
    }
    // 文本采样点内缩 2px，避开边框与圆角
    const sampleRect = {
      x: rect.x + 2,
      y: rect.y + 2,
      width: Math.max(4, rect.width - 4),
      height: Math.max(4, rect.height - 4)
    }
    const stats = regionStats(image, toDeviceRect(sampleRect, ctx.dpr))
    const effectiveBackground =
      background && background.a > 0 ? blendOver(background, stats.background) : stats.background
    const extreme =
      (stats.darkest?.lum ?? 1) < (stats.lightest?.lum ?? 0) ? stats.darkest : stats.lightest
    // 半透明元素（禁用态 opacity 0.45）要先把声明色按透明度合成到实际底色上再算对比度
    const effectiveDeclared =
      declared && opacity < 1 ? blendOver({ ...declared, a: opacity }, effectiveBackground) : declared
    const entry = {
      label: target.label,
      selector: target.selector,
      kind: target.kind,
      note: target.note,
      source: target.source,
      fontSize: style.fontSize,
      opacity: style.opacity,
      declaredColor: declared ? toHex(declared) : null,
      declaredBackground: background && background.a > 0 ? toHex(background) : null,
      measuredBackground: toHex(stats.background),
      backgroundShare: Number(stats.background.share.toFixed(3)),
      measuredExtreme: extreme ? toHex(extreme) : null,
      declaredRatio:
        effectiveDeclared && target.kind !== 'placeholder'
          ? Number(contrastRatio(effectiveDeclared, effectiveBackground).toFixed(2))
          : null,
      measuredRatio: extreme ? Number(contrastRatio(extreme, stats.background).toFixed(2)) : null,
      effectiveDeclared: effectiveDeclared ? toHex(effectiveDeclared) : null,
      threshold: target.wcagExempt ? null : 4.5,
      wcagExempt: Boolean(target.wcagExempt)
    }
    if (target.wcagExempt) {
      // WCAG 1.4.3 明确豁免"失效（disabled）控件"的文字对比度，这里只记录实测值
      entry.verdict = '不适用（禁用态）'
    } else {
      entry.verdict =
        entry.declaredRatio === null
          ? '仅实测'
          : entry.declaredRatio >= 4.5
            ? '达标'
            : entry.declaredRatio >= 3.8
              ? '临界不足'
              : '明显不足'
    }
    measured.push(entry)
  }

  const tokenAudit = await auditLightTokens(ctx)
  const report = {
    theme: 'light',
    viewport: DEFAULT_VIEWPORT,
    screenshots: Object.fromEntries(Object.entries(shots).map(([key, value]) => [key, value.filePath])),
    thresholds: { text: 4.5, nonText: 3 },
    hoverProbe,
    targets: measured,
    tokenAudit,
    tokenAuditBelowThreshold: tokenAudit.filter((item) => item.ratio !== null && item.ratio < 4.5)
  }
  const file = writeReport(outDir, 'contrast', report)
  console.log(`[检查] 浅色对比度报告：${file}`)
  for (const item of measured) {
    const detail =
      item.kind.startsWith('border')
        ? `描边 ${item.measuredColor}｜内 ${item.insideBackground} ${item.ratioInside} : 1｜外 ${item.outsideBackground} ${item.ratioOutside} : 1`
        : `声明 ${item.declaredColor} on ${item.measuredBackground}｜理论 ${item.declaredRatio ?? '-'} : 1｜实测最值 ${item.measuredExtreme} (${item.measuredRatio ?? '-'} : 1)`
    console.log(`[检查] ${String(item.verdict).padEnd(5, '　')} ${item.label}｜${detail}`)
  }
  console.log(
    `[检查] 令牌审计（像素未覆盖的界面按实际生效令牌值计算）：${tokenAudit
      .map((item) => `${item.label} ${item.ratio} : 1`)
      .join('；')}`
  )
  if (report.tokenAuditBelowThreshold.length > 0) {
    console.log(
      `[检查] 令牌审计低于 4.5:1 的项：${report.tokenAuditBelowThreshold
        .map((item) => `${item.label}（${item.foreground} on ${item.background} = ${item.ratio} : 1）`)
        .join('；')}`
    )
  }
  return report
}

/** 可运行的专项检查表 */
const CHECKS = [
  { id: 'dpr', title: '高 DPI 对照（1 / 1.25 / 1.5 / 2）', requires: ['connections'], run: checkDpr },
  { id: 'drag', title: '真实拖拽上传（CDP Input.dispatchDragEvent）', requires: ['connections'], run: checkDrag },
  {
    id: 'contrast',
    title: '浅色主题对比度像素量测',
    // 分组标题、分组计数属于本轮新增的浅色取样点，先让 14 步把分组建好
    requires: ['connections', '14'],
    run: checkContrast
  }
]

/** 步骤表：phase 为 true 的步骤只准备状态不截图，供 --only 复用前置状态 */const STEPS = [
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
      await ctx.cdp.evaluate(`window.__uiShot.click('.sidebar-head .primary-btn[title="新建连接"]')`)
      await waitFor(
        ctx.cdp,
        `window.__uiShot.text('.modal-title') === '新建连接'`,
        '打开新建连接表单'
      )
      await ctx.cdp.evaluate(`window.__uiShot.setField('名称', '预发布环境')`)
      await ctx.cdp.evaluate(`window.__uiShot.setField('主机', 'staging-01.internal')`)
      await ctx.cdp.evaluate(`window.__uiShot.setField('端口', '22')`)
      await ctx.cdp.evaluate(`window.__uiShot.setField('用户名', 'deploy')`)
      // 表单里有两个下拉框（分组、认证方式），必须按字段标签定位，不能取第一个 select
      await ctx.cdp.evaluate(
        `(() => {
          const field = Array.from(document.querySelectorAll('.modal .field')).find((el) =>
            (el.querySelector('span')?.textContent || '') === '认证方式'
          )
          if (!field) throw new Error('找不到认证方式字段')
          const select = field.querySelector('select')
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
          setter.call(select, 'privateKey')
          select.dispatchEvent(new Event('change', { bubbles: true }))
          return true
        })()`
      )
      await waitFor(
        ctx.cdp,
        `window.__uiShot.text('.modal').includes('私钥文件') && window.__uiShot.text('.modal').includes('私钥口令')`,
        '切换到私钥认证后出现私钥路径与口令字段'
      )
      await ctx.cdp.evaluate(
        `window.__uiShot.setField('私钥文件', 'C:\\\\Users\\\\deploy\\\\.ssh\\\\id_ed25519')`
      )
      await ctx.cdp.evaluate(`window.__uiShot.setField('私钥口令', 'ed25519-passphrase')`)
      const authType = await ctx.cdp.evaluate(`(() => {
        const field = Array.from(document.querySelectorAll('.modal .field')).find((el) =>
          (el.querySelector('span')?.textContent || '') === '认证方式'
        )
        return field ? field.querySelector('select').value : ''
      })()`)
      if (authType !== 'privateKey') throw new Error(`认证方式未切到私钥，实际 ${authType}`)
      await sleep(250)
    }
  },
  {
    id: '09',
    file: '09-toast.png',
    state: `把演示连接「${TOAST_DEMO_CONNECTION}」临时指向 127.0.0.1:${DEAD_PORT}（未监听）后点击连接的错误提示条`,
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
      // 快速连接已按用户要求移除：改用与用户一致的 UI 路径——编辑一条演示连接指向未监听端口，
      // 再点侧栏里的它开终端。截图后由 verify 把配置改回内网地址，避免污染后续状态
      await openEditForm(ctx, TOAST_DEMO_CONNECTION)
      await ctx.cdp.evaluate(`window.__uiShot.setField('主机', '127.0.0.1')`)
      await ctx.cdp.evaluate(`window.__uiShot.setField('端口', '${DEAD_PORT}')`)
      await ctx.cdp.evaluate(`window.__uiShot.click('.modal button[type="submit"]')`)
      await waitFor(ctx.cdp, `!window.__uiShot.has('.modal-title')`, '保存临时改动后的连接', 15000)
      await waitFor(
        ctx.cdp,
        `window.__uiShot.text('.conn-list').includes('@127.0.0.1:${DEAD_PORT}')`,
        '侧栏已显示改到未监听端口的连接'
      )
      await ctx.cdp.evaluate(`window.__uiShot.clickConnection(${JSON.stringify(TOAST_DEMO_CONNECTION)})`)
      await waitFor(ctx.cdp, `window.__uiShot.has('.toast.error')`, '出现错误提示条', 25000)
      const toastText = await ctx.cdp.evaluate(`window.__uiShot.text('.toast-text')`)
      if (!toastText.trim()) throw new Error('错误提示条没有文案')
      console.log(`[信息] 09-toast 提示文案：${toastText.trim()}`)
      await sleep(250)
    },
    /**
     * 截图后把演示连接改回内网地址，保证 10 步之后的画面与本步之外的状态都不被污染。
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async verify(ctx) {
      const demo = SAMPLE_CONNECTIONS.find((item) => item.name === TOAST_DEMO_CONNECTION)
      if (!demo) throw new Error(`预置连接里缺少「${TOAST_DEMO_CONNECTION}」`)
      await ctx.cdp.evaluate('window.__uiShot.closeOverlays()')
      await tryWait(ctx.cdp, `!window.__uiShot.has('.toast')`, 4000)
      await openEditForm(ctx, TOAST_DEMO_CONNECTION)
      await ctx.cdp.evaluate(`window.__uiShot.setField('主机', ${JSON.stringify(demo.host)})`)
      await ctx.cdp.evaluate(`window.__uiShot.setField('端口', '${demo.port}')`)
      await ctx.cdp.evaluate(`window.__uiShot.click('.modal button[type="submit"]')`)
      await waitFor(ctx.cdp, `!window.__uiShot.has('.modal-title')`, '恢复演示连接的原配置', 15000)
      await waitFor(
        ctx.cdp,
        `window.__uiShot.text('.conn-list').includes('@${demo.host}:${demo.port}')`,
        `「${TOAST_DEMO_CONNECTION}」已恢复为 ${demo.host}:${demo.port}`
      )
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
  },
  {
    id: '12',
    file: '12-light.png',
    state: '浅色主题（点击 .theme-toggle 走真实切换路径）下的终端 + 侧栏',
    viewport: 'default',
    requires: ['03'],
    /**
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async prepare(ctx) {
      await ctx.cdp.evaluate('window.__uiShot.closeOverlays()')
      await tryWait(ctx.cdp, `!window.__uiShot.has('.modal-title')`, 3000)
      // 11-min 把视口压到 780x520，这里回到默认视口，否则浅色截图会沿用最小窗口布局
      await applyViewport(ctx.cdp, DEFAULT_VIEWPORT, ctx.dpr)
      await sleep(400)
      await ctx.cdp.evaluate(`window.__uiShot.clickTab('测试环境', 'terminal')`)
      await waitFor(
        ctx.cdp,
        `window.__uiShot.screenText().includes('deploy.sh')`,
        '终端仍保留会话输出'
      )
      // 主题切换必须走真实代码路径：点击 .theme-toggle -> writeThemeMode -> applyTheme
      const state = await ensureTheme(ctx, 'light')
      console.log(
        `[信息] 12-light 主题状态：data-theme=${state.theme} color-scheme=${state.colorScheme} ` +
          `localStorage=${state.stored} 按钮提示=「${state.toggleTitle}」`
      )
      // 主题切换后 xterm 通过 subscribeTheme 热更新配色，等一帧再量
      await sleep(500)
      ctx.lightTerminalRect = JSON.parse(
        await ctx.cdp.evaluate(
          `JSON.stringify(window.__uiShot.rect('.terminal-host:not(.hidden) .xterm-screen'))`
        )
      )
    },
    /**
     * 像素级复查：浅色主题必须真的落到终端底色上，而不是只改了 dataset。
     * @param {object} ctx 截图上下文
     * @param {object} shot 截图信息
     * @returns {void}
     */
    verify(ctx, shot) {
      const img = decodePng(fs.readFileSync(shot.filePath))
      const rect = ctx.lightTerminalRect
        ? toDeviceRect(ctx.lightTerminalRect, shot.dpr)
        : { x: 300 * shot.dpr, y: 200 * shot.dpr, width: 200 * shot.dpr, height: 100 * shot.dpr }
      const stats = regionStats(img, rect)
      const luminance = colorLuminance(stats.background)
      console.log(
        `[信息] 12-light 终端区域众数底色 ${toHex(stats.background)}（占比 ${(stats.background.share * 100).toFixed(1)}%，相对亮度 ${luminance.toFixed(3)}）`
      )
      if (luminance < 0.5) {
        throw new Error(
          `浅色主题下终端底色仍偏暗：${toHex(stats.background)}（相对亮度 ${luminance.toFixed(3)}），` +
            '说明主题只改了容器没改终端配色'
        )
      }
    }
  },
  {
    id: '13',
    file: '13-light-sftp.png',
    state: '浅色主题下的 SFTP 面板（home 目录列表 + 表头 + 禁用态按钮）',
    viewport: 'default',
    requires: ['07', '12'],
    /**
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async prepare(ctx) {
      await ctx.cdp.evaluate('window.__uiShot.closeOverlays()')
      await applyViewport(ctx.cdp, DEFAULT_VIEWPORT, ctx.dpr)
      await sleep(300)
      const state = await ensureTheme(ctx, 'light')
      if (state.theme !== 'light') throw new Error('浅色主题未生效')
      await ensureSftp(ctx, '测试环境')
      await waitFor(
        ctx.cdp,
        `window.__uiShot.count('.sftp-panel:not(.hidden) .sftp-row.clickable') >= 4`,
        '浅色下 SFTP 列表有内容'
      )
      const pathValue = await ctx.cdp.evaluate(
        `document.querySelector('.sftp-panel:not(.hidden) .sftp-path-input').value`
      )
      if (pathValue !== FAKE_HOME) throw new Error(`SFTP 起始目录应为 ${FAKE_HOME}，实际 ${pathValue}`)
      ctx.lightSftpRects = JSON.parse(
        await ctx.cdp.evaluate(`JSON.stringify({
          panel: window.__uiShot.rect('.sftp-panel:not(.hidden)'),
          head: window.__uiShot.rect('.sftp-panel:not(.hidden) .sftp-head'),
          firstRow: window.__uiShot.rect('.sftp-panel:not(.hidden) .sftp-list .sftp-row.clickable')
        })`)
      )
      await sleep(300)
    }
  },
  {
    id: '14',
    file: '14-groups.png',
    state: '侧栏分组：未分组 + 生产环境（已折叠）+ 备份与容灾 + 监控 + 跳板机',
    viewport: 'default',
    requires: ['connections'],
    /**
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async prepare(ctx) {
      await ctx.cdp.evaluate('window.__uiShot.closeOverlays()')
      await applyViewport(ctx.cdp, DEFAULT_VIEWPORT, ctx.dpr)
      await sleep(300)
      // 分组走真实 IPC（connections.assignGroup：读文件 -> 改 -> 原子替换），逐个分组串行写
      const assigned = JSON.parse(
        await ctx.cdp.evaluate(`(async () => {
          const list = await window.api.connections.list();
          const idOf = (name) => {
            const found = list.find((item) => item.name === name);
            if (!found) throw new Error('缺少连接：' + name);
            return found.id;
          };
          const plan = [
            { group: '生产环境', names: ['生产 Web 服务器', '数据库主库'] },
            { group: '跳板机', names: ['跳板机'] },
            { group: '备份与容灾', names: ['备份节点'] },
            { group: '监控', names: ['监控节点'] },
            { group: '', names: ['测试环境'] }
          ];
          for (const item of plan) {
            await window.api.connections.assignGroup({ ids: item.names.map(idOf), group: item.group });
          }
          return JSON.stringify(await window.api.connections.list());
        })()`)
      )
      const grouped = assigned.filter((item) => (item.group ?? '') !== '').length
      if (grouped !== 5) throw new Error(`分组写入不符合预期：已分组 ${grouped} 个，期望 5 个`)
      // 侧栏列表来自 App 挂载时的加载，改动后重载页面等价于重启后的真实加载路径
      await reloadPage(ctx)
      // 重载会让 App 读到上一次自动保存的会话快照并弹出恢复提示条，本步只拍分组，先忽略掉它
      await waitFor(
        ctx.cdp,
        `window.__uiShot.count('.conn-group-head') >= 3`,
        '侧栏出现分组标题',
        15000
      )
      await dismissRestoreBar(ctx)
      const groups = JSON.parse(await ctx.cdp.evaluate('JSON.stringify(window.__uiShot.groups())'))
      const names = groups.map((group) => group.name)
      if (!names.includes('未分组')) throw new Error(`分组里缺少「未分组」：${names.join(' / ')}`)
      for (const expected of ['生产环境', '跳板机', '备份与容灾', '监控']) {
        if (!names.includes(expected)) throw new Error(`分组里缺少「${expected}」：${names.join(' / ')}`)
      }
      // 折叠「生产环境」：点击分组标题，走真实的 toggleGroup
      await ctx.cdp.evaluate(`window.__uiShot.clickGroupHead('生产环境')`)
      await waitFor(
        ctx.cdp,
        `(() => {
          const groups = window.__uiShot.groups();
          const target = groups.find((item) => item.name === '生产环境');
          return !!target && target.expanded === false;
        })()`,
        '「生产环境」分组已折叠'
      )
      const collapsed = JSON.parse(await ctx.cdp.evaluate('JSON.stringify(window.__uiShot.groups())'))
      const target = collapsed.find((item) => item.name === '生产环境')
      if (target.items !== 0) throw new Error(`折叠后的分组仍渲染了 ${target.items} 个连接项`)
      if (target.count !== 2) throw new Error(`折叠分组计数应为 2，实际 ${target.count}`)
      console.log(
        `[信息] 14-groups 分组：${collapsed
          .map((group) => `${group.name}(计数 ${group.count}，可见 ${group.items}${group.expanded === false ? '，已折叠' : ''})`)
          .join(' / ')}`
      )
      await ctx.cdp.evaluate(`(document.querySelector('.sidebar').scrollTop = 0, true)`)
      await sleep(300)
    }
  },
  // 原 15-forward（端口转发面板：1 条运行中 + 1 条已停止规则）已随该功能移除而删除；
  // 编号不复用，16~19 保持原编号以便与历史截图对照
  {
    id: '16',
    file: '16-restore.png',
    state: '会话恢复提示条：预置 3 个标签的快照后重载页面触发',
    viewport: 'default',
    requires: ['14'],
    /**
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async prepare(ctx) {
      await ctx.cdp.evaluate('window.__uiShot.closeOverlays()')
      await tryWait(ctx.cdp, `!window.__uiShot.has('.modal-title')`, 3000)
      await applyViewport(ctx.cdp, DEFAULT_VIEWPORT, ctx.dpr)
      await sleep(200)
      const snapshot = JSON.parse(
        await ctx.cdp.evaluate(`(async () => {
          const list = await window.api.connections.list();
          const idOf = (name) => {
            const found = list.find((item) => item.name === name);
            if (!found) throw new Error('缺少连接：' + name);
            return found.id;
          };
          const payload = {
            tabs: [
              { kind: 'terminal', connectionId: idOf('测试环境') },
              { kind: 'sftp', connectionId: idOf('跳板机') },
              { kind: 'terminal', connectionId: idOf('监控节点') }
            ],
            savedAt: Date.now()
          };
          await window.api.session.save(payload);
          return JSON.stringify(await window.api.session.load());
        })()`)
      )
      if (!snapshot || snapshot.tabs.length !== 3) {
        throw new Error(`预置会话快照失败：${JSON.stringify(snapshot)}`)
      }
      // 重载页面：App 启动时读 session.load()，快照非空即渲染恢复提示条
      await reloadPage(ctx)
      await waitFor(ctx.cdp, `!!window.__uiShot.restoreBar()`, '出现会话恢复提示条', 15000)
      const bar = JSON.parse(await ctx.cdp.evaluate('JSON.stringify(window.__uiShot.restoreBar())'))
      const summary = bar.texts[0] ?? ''
      if (!summary.includes('上次有 3 个会话')) throw new Error(`恢复提示文案不符：${summary}`)
      if (!summary.includes('终端 2') || !summary.includes('文件 1')) {
        throw new Error(`恢复提示的会话分类不符：${summary}`)
      }
      const sources = bar.texts[1] ?? ''
      for (const name of ['测试环境', '跳板机', '监控节点']) {
        if (!sources.includes(name)) throw new Error(`恢复提示缺少来源「${name}」：${sources}`)
      }
      if (!bar.actions.includes('恢复') || !bar.actions.includes('忽略')) {
        throw new Error(`恢复提示的操作按钮不全：${bar.actions.join(' / ')}`)
      }
      console.log(`[信息] 16-restore 提示条：「${summary}」「${sources}」按钮=${bar.actions.join('/')}`)
      await sleep(250)
    }
  },
  {
    id: '17',
    file: '17-hidpi.png',
    state: '--dpr=2 的终端态：2 倍像素密度下分隔带 / 1px 竖线与文字的比例一致性',
    viewport: 'default',
    // 单步覆盖 dpr：整轮以 1 倍跑，只有这一张按 2 倍出图
    dpr: 2,
    requires: ['12'],
    /**
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async prepare(ctx) {
      await ctx.cdp.evaluate('window.__uiShot.closeOverlays()')
      await tryWait(ctx.cdp, `!window.__uiShot.has('.modal-title')`, 3000)
      await dismissRestoreBar(ctx)
      // 先关掉可能残留的终端标签，保证这里拿到的是全新会话 id，能继续灌命令
      const hadTerminal = await ctx.cdp.evaluate(`window.__uiShot.closeTab('测试环境', 'terminal')`)
      if (hadTerminal) await sleep(400)
      await applyViewport(ctx.cdp, DEFAULT_VIEWPORT, 2)
      await sleep(400)
      const sessionId = await ensureTerminal(ctx, '测试环境')
      if (!sessionId) throw new Error('未能建立新的终端会话，无法准备确定性的高 DPI 画面')
      await waitFor(
        ctx.cdp,
        `window.__uiShot.screenText().includes('Welcome to Ubuntu')`,
        '终端显示远端欢迎语',
        25000
      )
      for (const command of ['ls -lh', 'uptime']) {
        await ctx.cdp.evaluate(
          `(window.api.terminal.write(${JSON.stringify(sessionId)}, ${JSON.stringify(`${command}\n`)}), true)`
        )
        await sleep(400)
      }
      await waitFor(ctx.cdp, `window.__uiShot.screenText().includes('load average')`, '终端显示命令输出')
      const dpr = await ctx.cdp.evaluate('window.devicePixelRatio')
      if (dpr !== 2) throw new Error(`期望 devicePixelRatio=2，实际 ${dpr}`)
      const metrics = JSON.parse(
        await ctx.cdp.evaluate('JSON.stringify(window.__uiShot.terminalMetrics())')
      )
      ctx.hidpiMetrics = metrics
      console.log(
        `[信息] 17-hidpi 终端几何：${metrics.colCount} 列 x ${metrics.rowCount} 行，` +
          `单元格 ${metrics.cellWidth.toFixed(3)}x${metrics.rowHeight.toFixed(3)} CSS px（dpr=${metrics.dpr}）`
      )
      // 记录侧栏边界与拖拽手柄列，供截图后量「分隔带宽度」与「1px 竖线在设备像素中的厚度」
      const sidebar = JSON.parse(
        await ctx.cdp.evaluate(`JSON.stringify(window.__uiShot.rect('.sidebar'))`)
      )
      const splitter = JSON.parse(
        await ctx.cdp.evaluate(`JSON.stringify((() => {
          const el = document.querySelector('.splitter')
          const rect = el.getBoundingClientRect()
          const line = getComputedStyle(el, '::before')
          return {
            ...window.__uiShot.rect('.splitter'),
            lineWidth: line.width,
            lineColor: line.backgroundColor
          }
        })())`)
      )
      ctx.hidpiRects = { sidebar, splitter, terminal: ctx.lightTerminalRect }
      await sleep(500)
    },
    /**
     * 像素级复查：整图必须是 2 倍图；
     * 侧栏与工作区之间是 6px 拖拽手柄列（本轮新增）+ 其中居中的 1px 分隔竖线，
     * 因此分别断言「分隔带正好 6 CSS px = 12 设备像素且紧贴侧栏右边界」与
     * 「1px 竖线正好占 2 设备像素且居中」（无错位、无半像素漏色）。
     * @param {object} ctx 截图上下文
     * @param {object} shot 截图信息
     * @returns {Promise<void>}
     */
    async verify(ctx, shot) {
      const expectedWidth = Math.round(DEFAULT_VIEWPORT.width * shot.dpr)
      const expectedHeight = Math.round(DEFAULT_VIEWPORT.height * shot.dpr)
      if (shot.width !== expectedWidth || shot.height !== expectedHeight) {
        throw new Error(
          `2 倍图像素尺寸不符：实际 ${shot.width}x${shot.height}，期望 ${expectedWidth}x${expectedHeight}`
        )
      }
      const img = decodePng(fs.readFileSync(shot.filePath))
      // 侧栏右边界跟随运行时宽度：默认值已从 272 调大到 300，且用户可拖动，
      // 这里再退一步直接读 --sidebar-width，避免任何写死的旧宽度
      const cssSidebarWidth = await ctx.cdp.evaluate(
        `parseFloat(getComputedStyle(document.querySelector('.app')).getPropertyValue('--sidebar-width'))`
      )
      const sidebarRight = ctx.hidpiRects?.sidebar?.right ?? cssSidebarWidth
      const splitterRect = ctx.hidpiRects?.splitter
      if (!splitterRect) throw new Error('17-hidpi 未记录拖拽手柄列现场，无法复核分隔带')
      console.log(
        `[信息] 17-hidpi 侧栏宽度现场：CSS 变量 ${cssSidebarWidth}px，实测右边界 ${sidebarRight}px，` +
          `手柄列 ${splitterRect.width}px（${splitterRect.lineWidth} 的 ${splitterRect.lineColor} 竖线）`
      )

      // 1) 分隔带：从侧栏右边界开始、宽度等于手柄列宽的连续像素都不属于两侧底色
      const bandWidth = Math.round(splitterRect.width * shot.dpr)
      const { chosen: band, attempts } = measureSidebarBorder(img, sidebarRight, shot.dpr)
      console.log(
        `[信息] 17-hidpi 分隔带：设备像素宽度=${band.thickness}（${band.color ? toHex(band.color) : '未检出'}），` +
          `左侧底色 ${toHex(band.before)}，右侧底色 ${toHex(band.after)}，扫描 y=${band.y}，命中段 ${JSON.stringify(band.runs)}`
      )
      if (band.thickness !== bandWidth) {
        throw new Error(
          `拖拽手柄列在 2 倍图下应为 ${bandWidth} 设备像素（${splitterRect.width} CSS px），实际 ${band.thickness}` +
            `（尝试：${attempts.map((item) => `y=${item.y}:${item.thickness}`).join('，')}；命中段 ${JSON.stringify(band.runs)}）`
        )
      }
      // 扫描起点固定在侧栏右边界前 8 设备像素，命中段偏移必须是 8，否则说明分隔带与侧栏错位
      const bandStart = band.runs.length ? band.runs[0].start : null
      if (bandStart !== 8) {
        throw new Error(
          `分隔带未紧贴侧栏右边界：命中段从扫描起点偏移 ${bandStart} 开始，期望 8` +
            `（命中段 ${JSON.stringify(band.runs)}）`
        )
      }

      // 2) 手柄列里居中的 1px 竖线：按覆盖率加权量厚度，dpr=2 时应当正好是 2 个设备像素
      const lineAttempts = []
      const columnStart = Math.round(splitterRect.left * shot.dpr)
      const columnLength = Math.round(splitterRect.width * shot.dpr)
      const lineColor = parseColorText(splitterRect.lineColor)
      if (!lineColor) throw new Error(`无法解析分隔竖线颜色：${splitterRect.lineColor}`)
      for (const ratio of [0.35, 0.6, 0.85]) {
        const y = Math.round(img.height * ratio)
        const strip = []
        for (let index = 0; index < columnLength; index += 1) {
          const color = pixelAt(img, columnStart + index, y)
          if (!color) break
          strip.push(toHex(color))
        }
        // 竖线两侧的底色取该列首尾像素（竖线居中，两端一定在列内底色上）
        const before = parseColorText(strip[1]) ?? parseColorText(strip[0])
        const after = parseColorText(strip[strip.length - 2]) ?? parseColorText(strip[strip.length - 1])
        const measured = borderCoverage(strip, lineColor, before, after)
        lineAttempts.push({ ratio, y, strip, before, after, ...measured })
      }
      const line = lineAttempts
        .slice()
        .sort(
          (a, b) =>
            Math.abs(a.coverage - shot.dpr) - Math.abs(b.coverage - shot.dpr) ||
            a.coverage - b.coverage
        )[0]
      console.log(
        `[信息] 17-hidpi 分隔竖线：覆盖率=${line.coverage}（期望 ${shot.dpr}），` +
          `起始设备像素偏移=${line.firstCoveredIndex}（期望 ${Math.round((columnLength - shot.dpr) / 2)}），` +
          `逐像素覆盖 ${JSON.stringify(line.perPixel)}，扫描 y=${line.y}`
      )
      if (Math.abs(line.coverage - shot.dpr) > 0.3) {
        throw new Error(
          `1px 分隔竖线在 ${shot.dpr} 倍图下的覆盖率应为 ${shot.dpr}，实际 ${line.coverage}` +
            `（逐像素覆盖 ${JSON.stringify(line.perPixel)}；尝试 ${lineAttempts
              .map((item) => `y=${item.y}:${item.coverage}`)
              .join('，')}）`
        )
      }
      const expectedFirst = Math.round((columnLength - shot.dpr) / 2)
      if (line.firstCoveredIndex !== expectedFirst) {
        throw new Error(
          `分隔竖线未居中：首个被覆盖的设备像素偏移 ${line.firstCoveredIndex}，期望 ${expectedFirst}` +
            `（手柄列 ${columnLength} 设备像素，逐像素覆盖 ${JSON.stringify(line.perPixel)}）`
        )
      }
    }
  },
  {
    id: '18',
    file: '18-bigdir.png',
    state: '2000 行目录：虚拟滚动下表头固定、行高一致、滚动可定位',
    viewport: 'default',
    requires: ['12'],
    /**
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async prepare(ctx) {
      const entries = ensureBigDir()
      await ctx.cdp.evaluate('window.__uiShot.closeOverlays()')
      await dismissRestoreBar(ctx)
      await applyViewport(ctx.cdp, DEFAULT_VIEWPORT, ctx.dpr)
      await sleep(300)
      await ensureSftp(ctx, '测试环境')
      // 先独立开一次会话直接列目录，确认服务端真的返回 2000 行（与面板滚动高度互为佐证）
      const serverSide = JSON.parse(
        await ctx.cdp.evaluate(`(async () => {
          const list = await window.api.connections.list();
          const target = list.find((item) => item.name === '测试环境');
          const vo = await window.api.sftp.open({ connectionId: target.id });
          const entries = await window.api.sftp.list(vo.sftpId, ${JSON.stringify(BIG_DIR)});
          await window.api.sftp.close(vo.sftpId);
          return JSON.stringify({
            count: entries.length,
            first: entries.length ? entries[0].path : null,
            last: entries.length ? entries[entries.length - 1].path : null
          });
        })()`)
      )
      if (serverSide.count !== entries) {
        throw new Error(
          `SFTP 服务返回的目录项数量不对：实际 ${serverSide.count}，期望 ${entries}` +
            `（首项 ${serverSide.first}，末项 ${serverSide.last}）`
        )
      }
      // 走路径栏跳转（真实的回车 -> expandRemotePath -> load 路径）
      await ctx.cdp.evaluate(`window.__uiShot.setPathInput(${JSON.stringify(BIG_DIR)})`)
      await ctx.cdp.evaluate('window.__uiShot.enterPathInput()')
      await sleep(600)
      console.log(
        `[信息] 18-bigdir 路径跳转结果：${await ctx.cdp.evaluate(`JSON.stringify({
          pathValue: (document.querySelector('.sftp-panel:not(.hidden) .sftp-path-input') || {}).value,
          message: (document.querySelector('.sftp-panel:not(.hidden) .sftp-message') || {}).textContent || '',
          rowCount: document.querySelectorAll('.sftp-panel:not(.hidden) .sftp-list .sftp-row.clickable').length,
          firstPath: window.__uiShot.sftpMetrics() && window.__uiShot.sftpMetrics().firstPath,
          scrollHeight: window.__uiShot.sftpMetrics() && window.__uiShot.sftpMetrics().scrollHeight
        })`)}`
      )
      await waitFor(
        ctx.cdp,
        `(() => {
          const metrics = window.__uiShot.sftpMetrics();
          return !!metrics && !!metrics.firstPath && metrics.firstPath.indexOf(${JSON.stringify(`${BIG_DIR}/`)}) === 0;
        })()`,
        `SFTP 面板进入 ${BIG_DIR}`,
        25000
      )
      const atTop = JSON.parse(await ctx.cdp.evaluate('JSON.stringify(window.__uiShot.sftpMetrics())'))
      assertVirtualRowShape(atTop, `${entries} 行目录顶部`)
      const expectedHeight = entries * 32 + 8
      if (Math.abs(atTop.scrollHeight - expectedHeight) > 8) {
        throw new Error(
          `虚拟滚动的总高度不对：scrollHeight=${atTop.scrollHeight}，期望约 ${expectedHeight}（${entries} 行 x 32px + 8px 内边距）`
        )
      }
      if (atTop.rowCount > 120) {
        throw new Error(`虚拟滚动失效：一次性渲染了 ${atTop.rowCount} 行`)
      }
      // 滚到底：最后一行必须正好是第 2000 个文件，表头位置不变
      await ctx.cdp.evaluate(`window.__uiShot.scrollSftp(${atTop.scrollHeight})`)
      await waitFor(
        ctx.cdp,
        `(() => {
          const metrics = window.__uiShot.sftpMetrics();
          return !!metrics && metrics.lastPath === ${JSON.stringify(`${BIG_DIR}/data-2000.log`)};
        })()`,
        '滚动到底部后定位到最后一行',
        8000
      )
      const atBottom = JSON.parse(await ctx.cdp.evaluate('JSON.stringify(window.__uiShot.sftpMetrics())'))
      assertVirtualRowShape(atBottom, `${entries} 行目录底部`)
      if (atBottom.headTop !== atTop.headTop || atBottom.listTop !== atTop.listTop) {
        throw new Error(
          `滚动后表头位置发生了变化：headTop ${atTop.headTop} -> ${atBottom.headTop}，listTop ${atTop.listTop} -> ${atBottom.listTop}`
        )
      }
      // 回到中段截图：表头仍在顶部、行内容已换成中段文件，画面能同时证明"表头固定 + 滚动生效"
      await ctx.cdp.evaluate('window.__uiShot.scrollSftp(20000)')
      await waitFor(
        ctx.cdp,
        `(() => {
          const metrics = window.__uiShot.sftpMetrics();
          return !!metrics && metrics.firstPath !== ${JSON.stringify(atTop.firstPath)} && metrics.scrollTop === 20000;
        })()`,
        '滚动到中段',
        8000
      )
      const middle = JSON.parse(await ctx.cdp.evaluate('JSON.stringify(window.__uiShot.sftpMetrics())'))
      assertVirtualRowShape(middle, `${entries} 行目录中段`)
      if (middle.headTop !== atTop.headTop) {
        throw new Error(`中段滚动后表头位置变化：${atTop.headTop} -> ${middle.headTop}`)
      }
      ctx.bigDirMetrics = { entries, atTop, atBottom, middle }
      console.log(
        `[信息] 18-bigdir ${entries} 行：scrollHeight=${atTop.scrollHeight}，DOM 行数 顶部 ${atTop.rowCount} / 中段 ${middle.rowCount} /` +
          ` 底部 ${atBottom.rowCount}，行高=${middle.rows[0]?.height}，表头 top=${middle.headTop} 保持不变，` +
          `中段首行=${middle.firstPath} 末行=${middle.lastPath}`
      )
      await sleep(400)
    }
  },
  {
    id: '19',
    file: '19-light-dialog.png',
    state: '浅色主题下的新建连接表单（已填写主机与用户名）',
    viewport: 'default',
    requires: ['12'],
    /**
     * @param {object} ctx 截图上下文
     * @returns {Promise<void>}
     */
    async prepare(ctx) {
      await ctx.cdp.evaluate('window.__uiShot.closeOverlays()')
      await tryWait(ctx.cdp, `!window.__uiShot.has('.modal-title')`, 3000)
      await dismissRestoreBar(ctx)
      await applyViewport(ctx.cdp, DEFAULT_VIEWPORT, ctx.dpr)
      await sleep(300)
      await ensureTheme(ctx, 'light')
      // 背景切到终端，避免 18 步留下的 2000 行目录列表把弹窗衬得太花
      if ((await readTabs(ctx)).some((tab) => tab.kind === 'terminal')) {
        await ctx.cdp.evaluate(`window.__uiShot.clickTab('测试环境', 'terminal')`)
        await sleep(200)
      }
      await ctx.cdp.evaluate(`window.__uiShot.click('.sidebar-head .primary-btn[title="新建连接"]')`)
      await waitFor(ctx.cdp, `window.__uiShot.text('.modal-title') === '新建连接'`, '打开新建连接表单')
      await ctx.cdp.evaluate(`window.__uiShot.setField('名称', '预发布环境')`)
      await ctx.cdp.evaluate(`window.__uiShot.setField('主机', 'staging-01.internal')`)
      await ctx.cdp.evaluate(`window.__uiShot.setField('端口', '22')`)
      await ctx.cdp.evaluate(`window.__uiShot.setField('用户名', 'deploy')`)
      await ctx.cdp.evaluate(`window.__uiShot.setField('密码', 'staging-password')`)
      const theme = await ctx.cdp.evaluate(`document.documentElement.dataset.theme`)
      if (theme !== 'light') throw new Error(`浅色表单截图要求 data-theme=light，实际 ${theme}`)
      ctx.lightDialogRect = JSON.parse(
        await ctx.cdp.evaluate(`JSON.stringify(window.__uiShot.rect('.modal'))`)
      )
      await sleep(300)
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
  const packaged = path.join(PROJECT_ROOT, 'dist', 'win-unpacked', 'EasySSH.exe')
  if (fs.existsSync(packaged)) {
    return {
      command: packaged,
      args: [`--remote-debugging-port=${CDP_PORT}`],
      mode: '打包产物 dist/win-unpacked'
    }
  }
  throw new Error(
    '既没有设置 E2E_ELECTRON_BIN，也没有 dist/win-unpacked/EasySSH.exe，无法启动 Electron'
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
  // 指定了 --checks 时默认只跑检查；--only=<编号|all> 显式指定时才顺带跑截图
  const requested =
    options.only ??
    (options.checks.size > 0 && !options.allShots ? new Set() : new Set(shotIds))
  const planned = shotIds.filter((id) => requested.has(id))
  const checkList = CHECKS.filter((check) => options.checks.has(check.id))

  const electron = resolveElectron()
  fs.mkdirSync(options.outDir, { recursive: true })
  USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'easyssh-ui-shot-'))
  printHeader(electron, options)
  console.log(`[信息] 本次计划截图：${planned.join(', ') || '（无）'}`)
  console.log(`[信息] 本次计划检查：${checkList.map((check) => check.id).join(', ') || '（无）'}`)

  /**
   * 给输出文件名加后缀，便于同一状态在不同参数下并存。
   * @param {string} file 原始文件名
   * @returns {string} 实际文件名
   */
  const withSuffix = (file) => (options.suffix ? file.replace(/\.png$/, `${options.suffix}.png`) : file)

  // 残留的旧图会让清单失真，先清掉本次要产出的同名文件
  for (const id of planned) {
    const step = STEPS.find((item) => item.id === id)
    fs.rmSync(path.join(options.outDir, withSuffix(step.file)), { force: true })
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
  /** 专项检查报告 */
  const checkReports = []
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
    const env = { ...process.env, EASYSSH_USER_DATA: USER_DATA_DIR }
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
        const filePath = path.join(options.outDir, withSuffix(step.file))
        const expected = VIEWPORTS[step.viewport ?? 'default']
        // 步骤可以覆盖像素密度（17-hidpi 固定 2 倍），否则用全局 --dpr
        const stepDpr = step.dpr ?? options.dpr
        if (stepDpr !== ctx.dpr) {
          await applyViewport(cdp, VIEWPORTS[step.viewport ?? 'default'], stepDpr)
          await sleep(500)
        }
        const shot = await captureScreenshot(cdp, filePath, expected, stepDpr)
        // 小数 DPR 下 Chromium 的四舍五入可能产生 1px 误差，允许 ±1
        if (
          Math.abs(shot.width - expected.width * stepDpr) > 1 ||
          Math.abs(shot.height - expected.height * stepDpr) > 1
        ) {
          throw new Error(
            `截图尺寸不符合预期：实际 ${shot.width}x${shot.height}，` +
              `期望 ${Math.round(expected.width * stepDpr)}x${Math.round(expected.height * stepDpr)}`
          )
        }
        if (step.verify) await step.verify(ctx, shot)
        results.push({ ...shot, id, state: step.state })
        console.log(
          `[完成] ${id} ${path.basename(shot.filePath)}（${shot.width}x${shot.height}，${shot.bytes} 字节，耗时 ${
            Date.now() - startedAt
          }ms）`
        )
      } catch (err) {
        failures.set(id, err)
        console.error(`[失败] ${id} ${withSuffix(step.file)}：${err.message}`)
      }
    }

    // 专项检查：高 DPI / 真实拖拽 / 浅色对比度
    for (const check of checkList) {
      const startedAt = Date.now()
      try {
        // 检查同样依赖预置状态：终端、SFTP、分组等都由步骤表准备
        for (const dependency of check.requires ?? ['connections']) {
          await ensureStep(ctx, dependency)
        }
        const report = await check.run(ctx, options.outDir)
        checkReports.push({ id: check.id, title: check.title, durationMs: Date.now() - startedAt, report })
        console.log(`[完成] 检查 ${check.id}（${check.title}，耗时 ${Date.now() - startedAt}ms）`)
      } catch (err) {
        failures.set(`check:${check.id}`, err)
        console.error(`[失败] 检查 ${check.id}（${check.title}）：${err.message}`)
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

  // 汇总报告：把清单与检查结论一起落盘，便于事后引用
  if (results.length > 0 || checkReports.length > 0) {
    // 把本轮之前的检查报告也索引进来（检查常常单独跑一次，摘要仍要能指到它们）
    const availableReports = ['dpr', 'drag', 'contrast']
      .map((name) => path.join(options.outDir, `report-${name}.json`))
      .filter((file) => fs.existsSync(file))
    const summaryFile = writeReport(options.outDir, 'summary', {
      generatedAt: new Date().toISOString(),
      outDir: options.outDir,
      dpr: options.dpr,
      screenshots: results.map((item) => ({
        id: item.id,
        state: item.state,
        file: item.filePath,
        width: item.width,
        height: item.height,
        bytes: item.bytes
      })),
      checks: checkReports.map((check) => ({ id: check.id, title: check.title, durationMs: check.durationMs })),
      checkReports: availableReports,
      failures: [...failures].map(([id, err]) => ({ id, message: err.message }))
    })
    console.log(`[清单] 汇总报告：${summaryFile}`)
  }

  const totalUnits = planned.length + checkList.length
  if (failures.size > 0) {
    console.error(
      `\n[结果] ${results.length} 张截图 / ${checkReports.length} 项检查成功，${failures.size} 项失败（共 ${totalUnits} 项）；Electron 日志：${logFile}`
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
  console.log(
    `\n[结果] 全部完成：${results.length} 张截图、${checkReports.length} 项检查，输出目录：${options.outDir}`
  )
}

main().catch((err) => {
  console.error(`\n[失败] ${err.message}`)
  console.error(`[提示] 开发态请先 npm run build；E2E_ELECTRON_BIN 需指向可用的 electron.exe`)
  // 走到这里说明主流程在 try/finally 之前就失败了，补一次临时目录清理
  if (USER_DATA_DIR) fs.rmSync(USER_DATA_DIR, { recursive: true, force: true })
  process.exitCode = 1
})
