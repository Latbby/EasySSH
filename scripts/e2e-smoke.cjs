/**
 * 端到端冒烟测试：真实 Electron 进程 + 真实 IPC + 真实 safeStorage + 真实 SSH 会话。
 *
 * 与 verify-ssh.cjs 的区别：那个只验证 ssh2 的调用姿势，本脚本验证整条产品链路——
 *   1. 渲染进程能正常挂载（React 已渲染、无 CSP/JS 报错）
 *   2. 「新建连接」表单 → connections.save 走通 IPC，落盘后密码必须是密文，列表中不得回传凭据
 *   3. terminal.open 能建立真实会话并收到远端输出（用内置 ssh2 测试服务充当目标机）
 *   4. 中文经「远端 → SSH → 主进程 → IPC → xterm」整条链路无乱码
 *   5. resize 不会抛错
 *   6. 打开已保存会话：点击侧栏里的连接项能真实连上目标并出现新标签
 *   7. 终端搜索：Ctrl+F 展开搜索栏，关键词命中计数随输入变化
 *   8. SFTP 路径栏：打开面板后可编辑跳转目录
 *   9. Toast：失败操作出现带分级类名的提示，点击可关闭
 *  10. 主机密钥变更：换掉服务端密钥后弹窗展示真实新旧指纹，确认信任后重连成功
 *  11. 本轮新增功能（见文件内 12.x / 15 编号）：主题切换与终端配色跟随、连接分组折叠与移动、
 *      SFTP 列宽拖拽、2000 行大目录虚拟滚动、远程编辑入口与失败提示、
 *      会话恢复提示条与恢复动作
 *  12. 用户要求移除快速连接 / 导入导出 / 端口转发后补齐的覆盖（见 1.1、8.1、8.2）：
 *      三项功能的入口与接口在打包产物中确实不存在、
 *      编辑连接回显已保存凭据（含「小眼睛」明文切换与「不改动保存不误清」）、
 *      弹窗遮罩只在按下与松开都落在遮罩本身时才关闭（ConnectionForm / HostKeyDialog / 移动到分组）
 *  13. 本轮（task-24）四项使用反馈的独立验证（见 12.13~12.16）：
 *      SFTP 单击目录即进入 / 单击文件只选中（服务端 OPENDIR 计数证明只列一次目录）、
 *      侧栏可拖动分配宽度（最小 240 / 最大 min(560, 窗口宽-480) 钳制、localStorage 持久化、
 *      双击与 Home 复位、方向键微调、窄视口收拢、重新加载后按持久化值恢复）、
 *      终端 Ctrl+滚轮缩放（.term-hud 出现并约 1s 后消失、devicePixelRatio 不变证明没有整页缩放、
 *      右键菜单「放大/缩小/复位字号」三项可用、Ctrl+= 与 Ctrl+0 仍生效）、
 *      复制连接把手动保存的密码一并带给副本（保存后 hasCredential 为真且再次打开仍是原值）
 *
 * 注意：脚本优先使用 dist/win-unpacked 下的打包产物，若该产物早于本轮源码改动，
 * 新增用例会因为跑的是旧代码而失败；验证新代码前请先把 dist 目录改名让脚本回退到 out/ 开发态。
 * 另外，被 Windows 沙箱打标过的工作区里 node_modules/electron/dist/electron.exe 带 Low Mandatory Level
 * 标签，开发态 Electron 会在加载应用前以 0x80000003 退出；此时可用环境变量 E2E_ELECTRON_BIN
 * 指向一份复制到 %TEMP%（Medium 完整性）的 electron 目录，例如：
 *   robocopy node_modules\electron\dist %TEMP%\e2e-electron-dist /E
 *   $env:E2E_ELECTRON_BIN="$env:TEMP\e2e-electron-dist\electron.exe"
 */
const { Server, Client, utils } = require('ssh2')
const { spawn, spawnSync } = require('child_process')
const { createHash } = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { generateHostKey } = require('./host-key.cjs')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const SSH_PORT = 2222
const CDP_PORT = 9333
const LOG_FILE = path.join(PROJECT_ROOT, 'e2e-electron.log')
/** 假想目标机的 home 目录，与内存文件系统保持一致 */
const FAKE_HOME = '/home'
/** 大目录用例的文件数量：验证虚拟滚动不会把 2000 行都塞进 DOM */
const MANY_FILES = 2000

/** 使用临时 userData 目录，避免污染真实用户配置 */
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'easyssh-e2e-'))

let passed = 0

/**
 * 记录一条通过项。
 * @param {string} message 描述
 */
function pass(message) {
  passed += 1
  console.log(`[通过] ${message}`)
}

/**
 * 断言条件成立，不成立直接抛错（退出码非零）。
 * @param {boolean} condition 条件
 * @param {string} message 描述
 */
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`)
  pass(message)
}

/**
 * 取 DOM 表达式的结果，失败时返回 null（用于页面重新加载这种上下文会短暂失效的场景）。
 * @param {ReturnType<typeof connectCdp>} cdp CDP 客户端
 * @param {string} expression 表达式
 * @returns {Promise<any>} 结果或 null
 */
async function tryEvaluate(cdp, expression) {
  try {
    return await cdp.evaluate(expression)
  } catch {
    return null
  }
}

/**
 * 轮询等待条件成立，容忍 CDP 的瞬时失败（页面重新加载期间执行上下文会被替换）。
 * @param {ReturnType<typeof connectCdp>} cdp CDP 客户端
 * @param {string} expression 返回布尔值的表达式
 * @param {string} label 描述
 * @param {number} timeout 超时毫秒数
 */
async function waitForTolerant(cdp, expression, label, timeout = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await tryEvaluate(cdp, expression)) {
      pass(label)
      return
    }
    await sleep(200)
  }
  throw new Error(`等待超时：${label}`)
}

/**
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// 测试服务端：内存文件系统 + shell + sftp
// ---------------------------------------------------------------------------

/** SFTP 协议状态码，取自协议定义 */
const SFTP_STATUS = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4 }

/** 文件类型掩码 */
const S_IFDIR = 0o040000
const S_IFREG = 0o100000

/** 内存文件系统：绝对路径 -> 节点。用于让 SFTP 用例在真实协议上跑通 */
const memfs = new Map()
memfs.set('/', { type: 'dir' })
memfs.set(FAKE_HOME, { type: 'dir' })
memfs.set(`${FAKE_HOME}/readme.txt`, { type: 'file', content: Buffer.from('hello sftp') })
memfs.set('/root-file.txt', { type: 'file', content: Buffer.from('root level file') })
// 大目录：虚拟滚动用例需要一个 2000 项的目录，页面上只应渲染其中一小部分行
memfs.set(`${FAKE_HOME}/many`, { type: 'dir' })
for (let index = 0; index < MANY_FILES; index += 1) {
  memfs.set(`${FAKE_HOME}/many/f-${String(index).padStart(4, '0')}.txt`, {
    type: 'file',
    content: Buffer.from(`file ${index}`)
  })
}
// 单击进入目录用例：一个只有一项的小目录，避免与 2000 行虚拟滚动用例互相干扰
memfs.set(`${FAKE_HOME}/e2e-dir`, { type: 'dir' })
memfs.set(`${FAKE_HOME}/e2e-dir/inside.txt`, { type: 'file', content: Buffer.from('inside dir') })
// 第二个小目录与它的子目录：用于取证 500ms 防误触窗口对「换一个目录再点」的影响
memfs.set(`${FAKE_HOME}/e2e-dir2`, { type: 'dir' })
memfs.set(`${FAKE_HOME}/e2e-dir2/sub`, { type: 'dir' })
memfs.set(`${FAKE_HOME}/e2e-dir2/sub/deep.txt`, { type: 'file', content: Buffer.from('deep') })

/**
 * SFTP 服务端请求计数。
 * 「一次单击只列一次目录」「单击文件不会走下载路径」这类断言必须在协议层取证：
 * 渲染进程内部实现（例如 load 是否重复调用）随时可能变，服务端收到的请求才是用户可感知的事实。
 */
const sftpStats = { opendir: 0, open: 0 }

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
    const rest = fullPath.slice(prefix.length)
    // 只取直接子项，更深层级由下一级目录负责
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
  const now = Math.floor(Date.now() / 1000)
  return {
    mode: (node.type === 'dir' ? S_IFDIR : S_IFREG) | 0o644,
    size: node.type === 'file' ? node.content.length : 0,
    uid: 0,
    gid: 0,
    atime: now,
    mtime: now
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
        attrs: { mode: S_IFDIR | 0o755, size: 0, uid: 0, gid: 0, atime: 0, mtime: 0 }
      }
    ])
  })

  sftp.on('OPENDIR', (reqid, target) => {
    // 计数点在真实协议处理器里：面板每次列目录必然产生一次 OPENDIR
    sftpStats.opendir += 1
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
        longname: `${node.type === 'dir' ? 'd' : '-'}rw-r--r-- 1 u u ${
          node.type === 'file' ? node.content.length : 0
        } Jan 1 00:00 ${name}`,
        attrs: attrsOf(node)
      }))
    )
  })

  sftp.on('OPEN', (reqid, filename, flags) => {
    // 下载 / 远程编辑都要先 OPEN 远端文件，用它佐证「单击文件没有触发下载」
    sftpStats.open += 1
    const target = normalizePath(filename)
    const canWrite = (flags & 0x02) !== 0
    let node = memfs.get(target)
    if (!node && canWrite) {
      node = { type: 'file', content: Buffer.alloc(0) }
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
    memfs.set(full, { type: 'dir' })
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

/**
 * 计算服务端主机密钥的 OpenSSH 风格 SHA256 指纹。
 * hostVerifier 收到的公钥 blob 与服务端私钥解析出的 getPublicSSH() 完全一致，
 * 因此这里算出的指纹就是弹窗里应当展示的真实指纹。
 * @param {string} privateKey 主机私钥
 * @returns {string} 形如 SHA256:xxxx 的指纹
 */
function fingerprintOf(privateKey) {
  const parsed = utils.parseKey(privateKey)
  if (parsed instanceof Error) throw new Error(`解析主机密钥失败：${parsed.message}`)
  return `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`
}

/** 服务端当前仍打开着的客户端连接，重启服务端时要主动断开 */
const activeClients = new Set()

/**
 * 启动一个本地 SSH 测试服务，充当被测客户端的目标机。
 * @param {string} hostKey 主机私钥，换密钥即可模拟服务器重装
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
        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          stream.write('E2E-欢迎使用测试 SSH 服务\r\n')
          stream.on('data', (chunk) => {
            const text = chunk.toString('utf8')
            if (text.includes('中文测试')) {
              stream.write('E2E-OK:收到中文\r\n')
              return
            }
            stream.write(text)
          })
        })
        // SFTP 面板用例需要真实 sftp 子系统
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
 * 通过 CDP 与渲染进程交互的极简客户端。
 * @param {string} wsUrl 调试端点地址
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
   * @returns {Promise<any>}
   */
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })

  return {
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
     * 无头/后台运行时窗口可能没有系统焦点，不做这步按键会被丢弃。
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
    /**
     * 发送一条任意 CDP 命令（Input / Emulation 等域）。
     * @param {string} method 方法名
     * @param {Record<string, unknown>} params 参数
     * @returns {Promise<any>}
     */
    sendCommand(method, params = {}) {
      return send(method, params)
    },
    /**
     * 注入一条真实鼠标事件。
     * 与页面内合成 MouseEvent 的区别：真实输入管线会同时产生 pointerdown/pointermove/pointerup，
     * 具备真实 pointerId，因此 setPointerCapture 之类的实现才能被如实测到。
     * @param {string} type 事件类型，如 mousePressed / mouseMoved / mouseReleased / mouseWheel
     * @param {Record<string, unknown>} params 其余参数（x / y / button / buttons / clickCount 等）
     * @returns {Promise<void>}
     */
    async dispatchMouse(type, params = {}) {
      await send('Input.dispatchMouseEvent', { type, ...params })
    },
    /**
     * 派发一次 Ctrl+滚轮（modifiers=2 即 Ctrl），用于终端字号缩放用例。
     * @param {{x: number, y: number, deltaY: number}} options 光标位置与滚动量（向上滚为负）
     * @returns {Promise<void>}
     */
    async dispatchCtrlWheel({ x, y, deltaY }) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: 0,
        deltaY,
        modifiers: 2
      })
    },
    /**
     * 覆盖视口尺寸（用于窄窗口收拢用例）。
     * deviceScaleFactor 传当前真实值：既完成视口覆盖，又不改变 devicePixelRatio，
     * 否则后面的「Ctrl+滚轮不得触发整页缩放」断言会被这次覆盖干扰。
     * @param {number} width 视口宽
     * @param {number} height 视口高
     * @param {number} deviceScaleFactor 设备像素比
     * @returns {Promise<void>}
     */
    async setViewport(width, height, deviceScaleFactor) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor,
        mobile: false
      })
    },
    /**
     * 取消视口覆盖，恢复真实窗口尺寸。
     * @returns {Promise<void>}
     */
    async clearViewport() {
      await send('Emulation.clearDeviceMetricsOverride')
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
async function waitForPage(timeout = 40000, exitCodeOf = () => null) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    // 进程已经退出就不可能再有调试端点，直接报出退出码，避免白等 40 秒
    const exitCode = exitCodeOf()
    if (exitCode !== null && exitCode !== undefined) {
      throw new Error(
        `Electron 进程启动后立即退出（exitCode=${exitCode}，0x80000003 表示 STATUS_BREAKPOINT）。` +
          '常见原因：1) 环境注入了 ELECTRON_RUN_AS_NODE=1；' +
          '2) 可执行文件带 Low Mandatory Level 标签（被 Windows 沙箱打标过的工作区），' +
          '浏览器进程会在加载应用前退出，可把 node_modules/electron/dist 复制到 %TEMP% 后用 E2E_ELECTRON_BIN 指向副本。'
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

/**
 * 轮询页面状态直到条件成立，超时返回 false。
 * 需要分支处理（而不是直接判失败）的场景用它。
 * @param {ReturnType<typeof connectCdp>} cdp CDP 客户端
 * @param {string} expression 返回布尔值的表达式
 * @param {number} timeout 超时毫秒数
 * @returns {Promise<boolean>} 是否在超时前成立
 */
async function waitFor(cdp, expression, timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await cdp.evaluate(expression)) return true
    await sleep(200)
  }
  return false
}

/**
 * 轮询页面状态直到条件成立，超时抛错并计为通过项。
 * @param {ReturnType<typeof connectCdp>} cdp CDP 客户端
 * @param {string} expression 返回布尔值的表达式
 * @param {string} label 描述
 * @param {number} timeout 超时毫秒数
 */
async function waitForCondition(cdp, expression, label, timeout = 15000) {
  if (await waitFor(cdp, expression, timeout)) {
    pass(label)
    return
  }
  throw new Error(`等待超时：${label}`)
}

/** 页面内交互辅助函数，注入一次后供各用例复用 */
const PAGE_HELPERS = `
window.__e2eUI = {
  // React 受控输入必须走原生 setter + input 事件，直接改 value 不会触发 onChange
  setValue(selector, value) {
    const el = document.querySelector(selector)
    if (!el) throw new Error('元素不存在：' + selector)
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  },
  // 非受控输入（SFTP 路径栏）直接赋值即可
  setUncontrolledValue(selector, value) {
    const el = document.querySelector(selector)
    if (!el) throw new Error('元素不存在：' + selector)
    el.value = value
    return el.value
  },
  pressEnter(selector) {
    const el = document.querySelector(selector)
    if (!el) throw new Error('元素不存在：' + selector)
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', bubbles: true, cancelable: true
    }))
    return true
  },
  // 按字段名（label 里的首个 span 文案）设置表单输入框
  setField(labelText, value) {
    const labels = Array.from(document.querySelectorAll('.modal .field'))
    const field = labels.find((item) => {
      const span = item.querySelector('span')
      return span && span.textContent.trim() === labelText
    })
    if (!field) throw new Error('未找到表单字段：' + labelText)
    const input = field.querySelector('input')
    if (!input) throw new Error('表单字段没有输入框：' + labelText)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  },
  click(selector) {
    const el = document.querySelector(selector)
    if (!el) throw new Error('元素不存在：' + selector)
    el.click()
    return true
  },
  clickByText(selector, text) {
    const el = Array.from(document.querySelectorAll(selector)).find(
      (item) => (item.textContent || '').includes(text)
    )
    if (!el) throw new Error('未找到包含文本「' + text + '」的元素：' + selector)
    el.click()
    return true
  },
  tabs() {
    return Array.from(document.querySelectorAll('.tab-title')).map((el) => el.textContent)
  },
  // xterm 的 DOM 渲染器把空格渲染成不间断空格，比较文本前先还原
  normalizeText(value) {
    return String(value == null ? '' : value).replace(/\\u00a0/g, ' ')
  },
  screenText() {
    const host = document.querySelector('.terminal-host:not(.hidden) .xterm-rows')
    return this.normalizeText(host ? host.textContent : '')
  },
  // 最近一次收到远端数据的会话，即刚打开的那个终端（由用例在 onData 里登记）
  lastSessionId() {
    const list = (window.__e2e && window.__e2e.sessions) || []
    return list.length ? list[list.length - 1] : null
  },
  text(selector) {
    return (document.querySelector(selector) || {}).textContent || ''
  },
  // 当前可见的 SFTP / 终端面板内的元素：多个标签同时挂载，必须限定到激活的那个
  visible(selector) {
    return document.querySelector('.sftp-panel:not(.hidden) ' + selector) ||
      document.querySelector('.terminal-host:not(.hidden) ' + selector)
  },
  // 按名称定位侧栏连接项：名称取 .conn-name 的文本（已连接时内含一个无文字的绿点）
  findConnection(name) {
    const item = Array.from(document.querySelectorAll('.conn-item')).find((el) => {
      const label = el.querySelector('.conn-name')
      return label && this.normalizeText(label.textContent).trim() === name
    })
    if (!item) throw new Error('未找到连接项：' + name)
    return item
  },
  // 点击连接项主体，走与用户一致的「点侧栏已保存连接开终端」路径
  openConnection(name) {
    const item = this.findConnection(name)
    const main = item.querySelector('.conn-main')
    if (!main) throw new Error('连接项没有打开入口：' + name)
    main.click()
    return true
  },
  // 点击连接项上的操作按钮（按 title 匹配，如「编辑」「SFTP 文件管理」）
  clickConnectionAction(name, actionTitle) {
    const item = this.findConnection(name)
    const button = Array.from(item.querySelectorAll('.icon-btn')).find(
      (el) => (el.getAttribute('title') || '') === actionTitle
    )
    if (!button) throw new Error('连接项「' + name + '」上没有按钮：' + actionTitle)
    button.click()
    return true
  },
  // 读取弹窗表单里某个字段的输入框状态：值、类型、小眼睛按钮的 title 与 aria-pressed
  fieldState(labelText) {
    const field = Array.from(document.querySelectorAll('.modal .field')).find((item) => {
      const span = item.querySelector('span')
      return span && this.normalizeText(span.textContent).trim() === labelText
    })
    if (!field) throw new Error('未找到表单字段：' + labelText)
    const input = field.querySelector('input')
    if (!input) throw new Error('表单字段没有输入框：' + labelText)
    const eye = field.querySelector('button.icon-btn')
    return {
      value: input.value,
      type: input.type,
      placeholder: input.placeholder,
      hasEye: !!eye,
      eyeTitle: eye ? eye.getAttribute('title') || '' : '',
      eyePressed: eye ? eye.getAttribute('aria-pressed') : null
    }
  },
  // 点击字段右侧的小眼睛按钮（密码 / 私钥口令）
  clickFieldEye(labelText) {
    const field = Array.from(document.querySelectorAll('.modal .field')).find((item) => {
      const span = item.querySelector('span')
      return span && this.normalizeText(span.textContent).trim() === labelText
    })
    if (!field) throw new Error('未找到表单字段：' + labelText)
    const eye = field.querySelector('button.icon-btn')
    if (!eye) throw new Error('字段右侧没有小眼睛按钮：' + labelText)
    eye.click()
    return true
  },
  /**
   * 模拟弹窗遮罩上的按下/松开组合，复现用户报的「在弹窗里长按后松手，弹窗消失」。
   * kind='inside-to-mask'：在弹窗内按下，松开与 click 落到遮罩上（真实浏览器里 click 的目标
   *   是按下点与松开点的最近公共祖先，也就是遮罩本身）；
   * kind='mask-only'：按下、松开、click 全落在遮罩上。
   */
  maskGesture(kind) {
    const mask = document.querySelector('.modal-mask')
    if (!mask) throw new Error('页面上没有弹窗遮罩')
    const inner = mask.querySelector('.modal')
    if (!inner) throw new Error('弹窗遮罩里没有 .modal')
    const fire = (target, type) =>
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
    if (kind === 'inside-to-mask') fire(inner, 'mousedown')
    else fire(mask, 'mousedown')
    fire(mask, 'mouseup')
    fire(mask, 'click')
    return true
  },
  // 激活最后一个终端标签：新增用例会把激活标签切到 SFTP 面板，而屏幕文本只存在于可见终端里
  activateLastTerminalTab() {
    const tabs = Array.from(document.querySelectorAll('.tab')).filter((el) => {
      const badge = el.querySelector('.tab-kind')
      return badge && badge.textContent.trim() === '>_'
    })
    if (!tabs.length) throw new Error('没有终端标签')
    tabs[tabs.length - 1].click()
    return true
  }
}
true;
`

/**
 * 通过「新建连接」表单创建一条连接。
 * 快速连接移除后，需要真实 UI 路径产生侧栏连接项时统一走这里：
 * 表单提交会触发 App 的 refresh()，新连接立刻出现在侧栏里，不需要重载页面。
 * @param {ReturnType<typeof connectCdp>} cdp CDP 客户端
 * @param {{name: string, host: string, port: number, username: string, password?: string}} dto 连接要素
 */
async function createConnectionViaForm(cdp, dto) {
  // 上一次用例可能留着弹窗，先关掉，避免字段定位到旧表单
  if (await cdp.evaluate(`!!document.querySelector('.modal-title')`)) {
    await cdp.evaluate(`window.__e2eUI.clickByText('.modal-foot button', '取消')`)
    await waitForCondition(cdp, `!document.querySelector('.modal-title')`, '关闭残留弹窗')
  }
  await cdp.evaluate(`window.__e2eUI.click('.sidebar-head .primary-btn')`)
  await waitForCondition(
    cdp,
    `document.querySelector('.modal-title')?.textContent === '新建连接'`,
    `点击「+ 新建」打开连接表单（${dto.name}）`
  )
  await cdp.evaluate(`window.__e2eUI.setField('名称', ${JSON.stringify(dto.name)})`)
  await cdp.evaluate(`window.__e2eUI.setField('主机', ${JSON.stringify(dto.host)})`)
  await cdp.evaluate(`window.__e2eUI.setField('端口', ${JSON.stringify(String(dto.port))})`)
  await cdp.evaluate(`window.__e2eUI.setField('用户名', ${JSON.stringify(dto.username)})`)
  // 需要保存凭据时补填密码（默认认证方式就是密码）
  if (dto.password) {
    await cdp.evaluate(`window.__e2eUI.setField('密码', ${JSON.stringify(dto.password)})`)
  }
  await cdp.evaluate(`window.__e2eUI.click('.modal button[type="submit"]')`)
  await waitForCondition(cdp, `!document.querySelector('.modal-title')`, `提交后弹窗关闭（${dto.name}）`)
  await waitForCondition(
    cdp,
    `Array.from(document.querySelectorAll('.conn-name')).some((el) => el.textContent.includes(${JSON.stringify(dto.name)}))`,
    `侧栏出现新连接「${dto.name}」（提交后列表自动刷新）`
  )
}

/**
 * 采集终端渲染现场信息：终端容器尺寸、行数、屏幕文本与 IPC 层累计数据里的欢迎语次数。
 * 欢迎语次数用于区分「输出没到渲染进程」与「输出到了但没进终端缓冲区」两类问题。
 * @param {ReturnType<typeof connectCdp>} cdp CDP 客户端
 * @returns {Promise<string>} JSON 文本
 */
async function dumpScreenState(cdp) {
  return cdp.evaluate(`(() => {
    const hosts = Array.from(document.querySelectorAll('.terminal-host'))
    const active = document.querySelector('.terminal-host:not(.hidden)')
    const rows = active ? active.querySelector('.xterm-rows') : null
    const screen = active ? active.querySelector('.xterm-screen') : null
    return JSON.stringify({
      hostCount: hosts.length,
      hosts: hosts.map((host) => ({
        cls: host.className,
        size: [host.clientWidth, host.clientHeight],
        行数: host.querySelectorAll('.xterm-rows > div').length,
        文本长度: (host.querySelector('.xterm-rows') || {}).textContent
          ? host.querySelector('.xterm-rows').textContent.length
          : 0
      })),
      screenSize: screen ? [screen.clientWidth, screen.clientHeight] : null,
      当前屏幕文本: rows ? rows.textContent.slice(-80) : null,
      IPC累计欢迎语次数: (window.__e2e.data.match(/E2E-欢迎使用测试 SSH 服务/g) || []).length
    })
  })()`)
}

async function main() {
  // 服务端主机密钥由脚本掌握，才能拿真实 SHA256 指纹去核对弹窗展示值
  const hostKeyA = generateHostKey()
  const fingerprintA = fingerprintOf(hostKeyA)
  let server = await startTestServer(hostKeyA)
  console.log(`[信息] 测试 SSH 服务已启动 127.0.0.1:${SSH_PORT}（主机密钥 A 指纹 ${fingerprintA}）`)

  // 优先用打包产物验证：它最接近用户双击运行的真实形态
  const packagedExe = path.join(PROJECT_ROOT, 'dist', 'win-unpacked', 'EasySSH.exe')
  const usePackaged = fs.existsSync(packagedExe)
  // 开发态默认用 node_modules 里的 electron，可用 E2E_ELECTRON_BIN 指向副本
  // （工作区被沙箱打标时 node_modules/electron/dist/electron.exe 带 Low 完整性标签，无法启动）
  const devElectron = process.env.E2E_ELECTRON_BIN || require('electron')
  const command = usePackaged ? packagedExe : devElectron
  const args = usePackaged
    ? [`--remote-debugging-port=${CDP_PORT}`]
    : ['.', `--remote-debugging-port=${CDP_PORT}`]
  console.log(`[信息] 启动${usePackaged ? '打包产物' : '开发态 Electron'}：${command}`)
  console.log(`[信息] 临时 userData：${USER_DATA_DIR}`)
  if (usePackaged) {
    // 打包产物可能早于本轮源码改动，导致新用例跑在旧代码上
    const devMain = path.join(PROJECT_ROOT, 'out', 'main', 'index.js')
    if (fs.existsSync(devMain) && fs.statSync(devMain).mtimeMs > fs.statSync(packagedExe).mtimeMs) {
      console.log('[警告] 打包产物早于 out/ 最新构建，可能掩盖本轮改动；验证新代码请先把 dist 改名后重跑')
    }
  }

  // 输出重定向到文件而非管道，便于排查启动失败
  const logFd = fs.openSync(LOG_FILE, 'w')
  const env = { ...process.env, EASYSSH_USER_DATA: USER_DATA_DIR }
  // 本环境默认注入 ELECTRON_RUN_AS_NODE=1，会让 Electron 退化成纯 Node 运行，必须剔除
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(command, args, {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', logFd, logFd],
    env
  })

  let cdp
  try {
    const wsUrl = await waitForPage(40000, () => child.exitCode)
    cdp = await connectCdp(wsUrl)
    pass('Electron 渲染进程已就绪，调试通道已连通')
    // 注入页面内交互辅助函数，并让后续 CDP 按键能被当成前台输入
    await cdp.prepareFocus()
    await cdp.evaluate(PAGE_HELPERS)

    // 1. 渲染层挂载检查，同时确认页面没有抛出未捕获异常
    await cdp.evaluate(`
      window.__e2eErrors = [];
      window.addEventListener('error', (event) => window.__e2eErrors.push(String(event.message)));
      true;
    `)
    await waitForCondition(
      cdp,
      `document.querySelector('.sidebar-title')?.textContent === '连接'`,
      'React 界面已挂载（侧边栏渲染成功）'
    )

    // 1.1 用户要求移除的三项功能不得在打包产物里留任何入口或接口
    const removed = JSON.parse(
      await cdp.evaluate(
        `JSON.stringify({
          quickConnect: !!document.querySelector('.quick-connect'),
          sidebarActions: !!document.querySelector('.sidebar-actions'),
          importButton: !!document.querySelector('.sidebar button[title*="导入"]'),
          exportButton: !!document.querySelector('.sidebar button[title*="导出"]'),
          importFn: typeof window.api.connections.importFromFile,
          exportFn: typeof window.api.connections.exportToFile,
          forwardApi: typeof window.api.forward
        })`
      )
    )
    assert(!removed.quickConnect, '侧栏不再有快速连接卡片（.quick-connect 不存在）')
    assert(
      !removed.sidebarActions && !removed.importButton && !removed.exportButton,
      `侧栏不再有导入 / 导出操作行（现场 ${JSON.stringify(removed)}）`
    )
    assert(
      removed.importFn === 'undefined' && removed.exportFn === 'undefined',
      'window.api.connections 上不再暴露导入 / 导出接口'
    )
    assert(removed.forwardApi === 'undefined', 'window.api 上不再暴露端口转发接口（forward:*）')

    // 2. 保存连接，验证 IPC + 加密落盘。
    //    快速连接移除后，后续用例都走「点侧栏已保存连接」的真实 UI 路径，因此这里改用
    //    「新建连接」表单保存（底层仍是同一个 connections.save IPC），侧栏才会立刻出现连接项
    await createConnectionViaForm(cdp, {
      name: 'E2E 测试机',
      host: '127.0.0.1',
      port: SSH_PORT,
      username: 'tester',
      password: 's3cret-pw'
    })
    const saved = JSON.parse(
      await cdp.evaluate(
        `(async () => JSON.stringify((await window.api.connections.list()).find((vo) => vo.name === 'E2E 测试机') ?? null))()`
      )
    )
    if (!saved?.id) throw new Error('保存连接未返回 id')
    pass(`连接通过「新建」表单保存成功（id=${saved.id.slice(0, 8)}…）`)

    // Runtime.evaluate 的表达式不支持顶层 await，需要包一层 async IIFE 再配合 awaitPromise
    const listJson = await cdp.evaluate(
      `(async () => JSON.stringify(await window.api.connections.list()))()`
    )
    if (listJson.includes('s3cret-pw')) throw new Error('列表出参泄漏了明文密码')
    if (listJson.includes('secret')) throw new Error('列表出参泄漏了密文字段')
    pass('连接列表出参未泄漏任何凭据字段')

    const rawFile = fs.readFileSync(path.join(USER_DATA_DIR, 'connections.json'), 'utf8')
    if (rawFile.includes('s3cret-pw')) throw new Error('落盘文件包含明文密码')
    if (!rawFile.includes('secret')) throw new Error('落盘文件未包含加密后的凭据字段')
    pass('落盘文件中的密码为密文，明文未落盘')

    // 3. 打开真实 SSH 会话，验证整条终端链路
    await cdp.evaluate(`
      window.__e2e = { data: '', exit: null, sessions: [] };
      const decoder = new TextDecoder();
      window.__e2eOffData = window.api.terminal.onData((sid, chunk) => {
        // 记录出现过的会话 id，供后续用例定位刚打开的那个终端
        if (!window.__e2e.sessions.includes(sid)) window.__e2e.sessions.push(sid);
        window.__e2e.data += decoder.decode(chunk, { stream: true });
      });
      window.__e2eOffExit = window.api.terminal.onExit((sid, reason) => {
        window.__e2e.exit = reason;
      });
      true;
    `)

    const sessionId = await cdp.evaluate(`
      (async () => (await window.api.terminal.open({
        connectionId: ${JSON.stringify(saved.id)},
        cols: 80,
        rows: 24
      })).sessionId)()
    `)
    if (!sessionId) throw new Error('打开终端未返回 sessionId')
    pass(`SSH 会话已建立（sessionId=${sessionId.slice(0, 8)}…）`)

    await waitForCondition(
      cdp,
      `window.__e2e.data.includes('E2E-欢迎使用测试 SSH 服务')`,
      '终端收到远端输出'
    )

    // 4. 中文往返：远端 → SSH → 主进程 → IPC → 页面解码
    await cdp.evaluate(
      `window.api.terminal.write(${JSON.stringify(sessionId)}, 'echo 中文测试\\n'), true`
    )
    await waitForCondition(
      cdp,
      `window.__e2e.data.includes('E2E-OK:收到中文')`,
      '中文经整条链路往返无乱码'
    )

    // 5. resize 不应抛错
    await cdp.evaluate(`window.api.terminal.resize(${JSON.stringify(sessionId)}, 100, 30), true`)
    pass('终端尺寸同步调用成功')

    // 6. 关闭会话应触发退出事件
    await cdp.evaluate(`window.api.terminal.close(${JSON.stringify(sessionId)}), true`)
    await waitForCondition(cdp, `window.__e2e.exit !== null`, '关闭会话后收到退出事件')

    // -----------------------------------------------------------------------
    // 7. 打开已保存会话：点击侧栏里的连接项，应真实连上测试服务并出现新标签
    //    （快速连接已按用户要求移除，这里改为点击已保存连接的 UI 路径）
    // -----------------------------------------------------------------------
    const sessionsBefore = await cdp.evaluate(`window.__e2e.sessions.length`)
    await cdp.evaluate(`window.__e2eUI.openConnection('E2E 测试机')`)
    await waitForCondition(
      cdp,
      `window.__e2eUI.tabs().some((title) => title.includes('E2E 测试机'))`,
      '点击侧栏已保存连接后出现新终端标签'
    )
    const openedTitle = await cdp.evaluate(
      `window.__e2eUI.tabs().find((title) => title.includes('E2E 测试机'))`
    )
    console.log(`[信息] 点击已保存连接打开的标签标题：${openedTitle}`)

    // 建成后首屏输出必须落到终端：远端欢迎语在会话建立瞬间发出，早于终端组件挂载
    // （lead 已在 App 层做「写入函数注册前的输出缓冲 + 注册时回放」）
    if (
      !(await waitFor(
        cdp,
        `window.__e2eUI.screenText().includes('E2E-欢迎使用测试 SSH 服务')`,
        10000
      ))
    ) {
      const state = await dumpScreenState(cdp)
      throw new Error(`点击已保存连接后终端未显示远端欢迎语（首屏输出丢失）：现场=${state}`)
    }
    pass('点击已保存连接打开的终端显示远端欢迎语（首屏输出未丢失）')

    // 通过 onData 登记过的会话 id 定位刚打开的这个终端
    await waitForCondition(
      cdp,
      `window.__e2e.sessions.length > ${sessionsBefore}`,
      '渲染进程收到新会话的远端数据（会话确实建立）'
    )
    const activeSessionId = await cdp.evaluate(`window.__e2eUI.lastSessionId()`)
    if (!activeSessionId) {
      throw new Error('未能定位新打开的终端会话，无法继续验证终端输出链路')
    }
    pass(`新终端会话 id 可定位（${String(activeSessionId).slice(0, 8)}…）`)

    const savedEchoMarker = 'E2E-SAVED-ECHO-OK'
    await cdp.evaluate(
      `window.api.terminal.write(${JSON.stringify(activeSessionId)}, ${JSON.stringify(
        `echo ${savedEchoMarker}\n`
      )}), true`
    )
    await waitForCondition(
      cdp,
      `window.__e2eUI.screenText().includes('${savedEchoMarker}')`,
      '终端挂载后的远端输出能写入并渲染到界面'
    )

    // -----------------------------------------------------------------------
    // 8. 界面新建连接：为 SFTP 用例准备列表项，同时验证表单提交后列表自动刷新
    // -----------------------------------------------------------------------
    await cdp.evaluate(`window.__e2eUI.click('.sidebar-head .primary-btn')`)
    await waitForCondition(
      cdp,
      `document.querySelector('.modal-title')?.textContent === '新建连接'`,
      '点击「+ 新建」打开连接表单'
    )
    await cdp.evaluate(`window.__e2eUI.setField('名称', 'E2E 界面连接')`)
    await cdp.evaluate(`window.__e2eUI.setField('主机', '127.0.0.1')`)
    await cdp.evaluate(`window.__e2eUI.setField('端口', '${SSH_PORT}')`)
    await cdp.evaluate(`window.__e2eUI.setField('用户名', 'tester')`)
    const formValues = await cdp.evaluate(`(() => {
      const read = (label) => {
        const field = Array.from(document.querySelectorAll('.modal .field')).find((item) => {
          const span = item.querySelector('span')
          return span && span.textContent.trim() === label
        })
        const input = field ? field.querySelector('input') : null
        return input ? input.value : null
      }
      return JSON.stringify({ 名称: read('名称'), 主机: read('主机'), 端口: read('端口'), 用户名: read('用户名') })
    })()`)
    if (
      !formValues.includes('127.0.0.1') ||
      !formValues.includes(String(SSH_PORT)) ||
      !formValues.includes('tester')
    ) {
      throw new Error(`表单字段未被正确驱动：${formValues}`)
    }
    pass(`新建连接表单字段写入正确（${formValues}）`)
    await cdp.evaluate(`window.__e2eUI.click('.modal button[type="submit"]')`)
    await waitForCondition(cdp, `!document.querySelector('.modal-title')`, '提交表单后弹窗关闭')
    await waitForCondition(
      cdp,
      `document.querySelectorAll('.conn-item').length >= 1`,
      '提交后连接列表自动刷新并出现连接项'
    )

    // -----------------------------------------------------------------------
    // 8.1 编辑连接回显已保存凭据：回显 → 小眼睛切明文 → 不改动保存后凭据未被误清
    // -----------------------------------------------------------------------
    await cdp.evaluate(`window.__e2eUI.clickConnectionAction('E2E 测试机', '编辑')`)
    await waitForCondition(
      cdp,
      `document.querySelector('.modal-title')?.textContent === '编辑连接'`,
      '点击「编辑」打开编辑连接表单'
    )
    // 凭据回显走异步 IPC（connections.getCredential），等密码框拿到值再断言
    // （表达式自带 try/catch：字段尚未渲染时返回 false 继续轮询，而不是直接抛错）
    const passwordEchoed = `(() => {
      try {
        return window.__e2eUI.fieldState('密码').value === 's3cret-pw'
      } catch {
        return false
      }
    })()`
    await waitForCondition(cdp, passwordEchoed, '编辑表单回显了已保存的密码（密码框 value 非空）')
    const pwdMasked = JSON.parse(
      await cdp.evaluate(`JSON.stringify(window.__e2eUI.fieldState('密码'))`)
    )
    if (pwdMasked.type !== 'password') {
      throw new Error(`密码框初始应为掩码类型，实际 type=${pwdMasked.type}`)
    }
    if (pwdMasked.eyePressed !== 'false' || !pwdMasked.eyeTitle.includes('显示')) {
      throw new Error(`小眼睛初始态不符：${JSON.stringify(pwdMasked)}`)
    }
    pass(`密码框默认掩码显示，小眼睛提示「${pwdMasked.eyeTitle}」（aria-pressed=false）`)

    await cdp.evaluate(`window.__e2eUI.clickFieldEye('密码')`)
    const pwdShown = JSON.parse(
      await cdp.evaluate(`JSON.stringify(window.__e2eUI.fieldState('密码'))`)
    )
    if (pwdShown.type !== 'text' || pwdShown.value !== 's3cret-pw') {
      throw new Error(`点小眼睛后未切到明文：${JSON.stringify(pwdShown)}`)
    }
    if (pwdShown.eyePressed !== 'true' || !pwdShown.eyeTitle.includes('隐藏')) {
      throw new Error(`小眼睛按下态未同步：${JSON.stringify(pwdShown)}`)
    }
    pass(`点小眼睛后密码框切明文且内容为真实密码（type=text，aria-pressed=true）`)

    await cdp.evaluate(`window.__e2eUI.clickFieldEye('密码')`)
    const pwdBack = JSON.parse(
      await cdp.evaluate(`JSON.stringify(window.__e2eUI.fieldState('密码'))`)
    )
    if (pwdBack.type !== 'password' || pwdBack.eyePressed !== 'false') {
      throw new Error(`再次点小眼睛未切回掩码：${JSON.stringify(pwdBack)}`)
    }
    pass('再次点小眼睛切回掩码（type=password，aria-pressed=false）')

    // 不改密码直接保存：留空的语义必须是「保留已保存的密码」，不能变成清空
    await cdp.evaluate(`window.__e2eUI.click('.modal button[type="submit"]')`)
    await waitForCondition(cdp, `!document.querySelector('.modal-title')`, '不改动直接保存后弹窗关闭')
    const credentialAfterSave = await cdp.evaluate(
      `(async () => JSON.stringify(await window.api.connections.getCredential(${JSON.stringify(saved.id)})))()`
    )
    if (!credentialAfterSave.includes('s3cret-pw')) {
      throw new Error(`不改动保存后凭据被清掉了：getCredential 返回 ${credentialAfterSave}`)
    }
    pass(`不改动保存后凭据仍在（getCredential 回读 ${credentialAfterSave}）`)

    await cdp.evaluate(`window.__e2eUI.clickConnectionAction('E2E 测试机', '编辑')`)
    await waitForCondition(
      cdp,
      `document.querySelector('.modal-title')?.textContent === '编辑连接'`,
      '再次打开编辑表单（验证回显未被误清）'
    )
    await waitForCondition(
      cdp,
      passwordEchoed,
      '再次打开编辑表单仍回显已保存的密码（未被误清）'
    )

    // -----------------------------------------------------------------------
    // 8.2 弹窗遮罩只在「按下与松开都落在遮罩本身」时才关闭
    //     （修用户报的「在弹窗里长按后松手，弹窗消失」）
    // -----------------------------------------------------------------------
    const openModalTitle = `document.querySelector('.modal-title')?.textContent ?? ''`
    // 在弹窗内按下（用户场景：在输入框里长按/拖选文字），松开与 click 落到遮罩上：不得关闭
    await cdp.evaluate(`window.__e2eUI.maskGesture('inside-to-mask')`)
    await sleep(200)
    if ((await cdp.evaluate(openModalTitle)) !== '编辑连接') {
      throw new Error('在弹窗内按下、在遮罩上松手时弹窗被误关（用户报告的缺陷）')
    }
    pass('在弹窗内按下、在遮罩上松手不会误关弹窗（仍为「编辑连接」）')

    // 全程落在遮罩上：应当关闭
    await cdp.evaluate(`window.__e2eUI.maskGesture('mask-only')`)
    await waitForCondition(
      cdp,
      `!document.querySelector('.modal-title')`,
      '按下与松开都落在遮罩上时弹窗正常关闭'
    )

    // -----------------------------------------------------------------------
    // 9. SFTP 路径栏：打开面板后可编辑跳转
    // -----------------------------------------------------------------------
    await cdp.evaluate(`window.__e2eUI.click('.conn-item .icon-btn[title="SFTP 文件管理"]')`)
    await waitForCondition(
      cdp,
      `!!document.querySelector('.sftp-path-input')`,
      'SFTP 面板已打开（.sftp-path-input 出现）'
    )
    const sftpShownPath = await cdp.evaluate(`document.querySelector('.sftp-path-input').value`)
    if (sftpShownPath !== FAKE_HOME) {
      throw new Error(`SFTP 初始目录应为 ${FAKE_HOME}，实际 ${sftpShownPath}`)
    }
    pass(`SFTP 路径栏显示登录 home（${sftpShownPath}）`)

    await cdp.evaluate(`window.__e2eUI.setUncontrolledValue('.sftp-path-input', '/')`)
    await cdp.evaluate(`window.__e2eUI.pressEnter('.sftp-path-input')`)
    await waitForCondition(
      cdp,
      `document.querySelector('.sftp-path-input')?.value === '/'`,
      '路径栏输入 / 回车后跳转到根目录'
    )
    await waitForCondition(
      cdp,
      `(document.querySelector('.sftp-list')?.textContent ?? '').includes('root-file.txt')`,
      'SFTP 列表展示根目录下的文件（确认跳转真实生效）'
    )

    // -----------------------------------------------------------------------
    // 10. Toast：失败操作出现带分级类名的中文提示，点击可关闭
    //     快速连接移除后，失败路径改为「新建一条指向未监听端口的连接，再点它开终端」
    // -----------------------------------------------------------------------
    const deadPort = 59998
    await createConnectionViaForm(cdp, {
      name: 'E2E 未监听端口',
      host: '127.0.0.1',
      port: deadPort,
      username: 'tester'
    })
    // 先点掉可能残留的成功提示，避免把旧提示当成本次失败的提示
    await cdp.evaluate(`(() => {
      const el = document.querySelector('.toast')
      if (el) el.click()
      return true
    })()`)
    await waitFor(cdp, `!document.querySelector('.toast')`, 3000)
    await cdp.evaluate(`window.__e2eUI.openConnection('E2E 未监听端口')`)
    await waitForCondition(cdp, `!!document.querySelector('.toast')`, '连接不可用端口后出现 Toast 提示')
    const toastClass = await cdp.evaluate(`document.querySelector('.toast').className`)
    if (!/\berror\b/.test(toastClass)) {
      throw new Error(`Toast 未带 error 分级类名，实际 class=${toastClass}`)
    }
    pass(`Toast 带 error 分级类名（class=${toastClass}）`)
    const toastText = await cdp.evaluate(`document.querySelector('.toast-text').textContent`)
    if (!toastText.includes('目标端口未开放')) {
      throw new Error(`Toast 文案不是中文化的连接错误：${toastText}`)
    }
    pass(`Toast 文案为中文错误提示（${toastText}）`)
    await cdp.evaluate(`(document.querySelector('.toast').click(), true)`)
    await waitForCondition(cdp, `!document.querySelector('.toast')`, '点击 Toast 后提示立即关闭')

    // -----------------------------------------------------------------------
    // 11. 主机密钥变更：换掉服务端密钥后弹窗展示真实指纹，确认信任后重连成功
    // -----------------------------------------------------------------------
    const knownHostsFile = path.join(USER_DATA_DIR, 'known_hosts.json')
    const knownBefore = JSON.parse(fs.readFileSync(knownHostsFile, 'utf8'))
    if (knownBefore[`127.0.0.1:${SSH_PORT}`] !== fingerprintA) {
      throw new Error(
        `首次连接未按 TOFU 记录主机 A 的指纹：${knownBefore[`127.0.0.1:${SSH_PORT}`]}`
      )
    }
    pass('首次连接后 known_hosts.json 记录了主机 A 的真实 SHA256 指纹')

    const hostKeyB = generateHostKey()
    const fingerprintB = fingerprintOf(hostKeyB)
    await closeServer(server)
    server = await startTestServer(hostKeyB)
    console.log(`[信息] 测试 SSH 服务已更换主机密钥并重启（指纹 B ${fingerprintB}）`)

    // 主机密钥变更流程需要一条指向测试 SSH 服务的已保存连接：先按真实 UI 建好，
    // 再点它开会话。这条连接此前从未连接过，复用键（连接 id）在连接池里不存在，必然重新握手
    await createConnectionViaForm(cdp, {
      name: 'E2E 密钥变更机',
      host: '127.0.0.1',
      port: SSH_PORT,
      username: 'e2e-hk'
    })
    const hkSessionsBefore = await cdp.evaluate(`window.__e2e.sessions.length`)
    await cdp.evaluate(`window.__e2eUI.openConnection('E2E 密钥变更机')`)
    await waitForCondition(
      cdp,
      `document.querySelector('.modal-title')?.textContent === '主机密钥已变更'`,
      '点击已保存连接后弹出主机密钥变更确认弹窗'
    )
    const shownOld = await cdp.evaluate(`document.querySelector('.fp-value.old').textContent`)
    const shownNew = await cdp.evaluate(`document.querySelector('.fp-value.new').textContent`)
    if (shownOld !== fingerprintA || shownNew !== fingerprintB) {
      throw new Error(
        `弹窗指纹与服务端真实指纹不一致：弹窗 ${shownOld} / ${shownNew}，真实 ${fingerprintA} / ${fingerprintB}`
      )
    }
    pass('弹窗展示的新旧指纹与两次服务端密钥的真实 SHA256 一致')
    if (JSON.parse(fs.readFileSync(knownHostsFile, 'utf8'))[`127.0.0.1:${SSH_PORT}`] !== fingerprintA) {
      throw new Error('未确认前 known_hosts.json 已被改写，存在静默信任新密钥的问题')
    }
    pass('未确认前 known_hosts.json 仍保存旧指纹，没有静默信任')

    // 11.0 主机密钥弹窗同样只认「按下与松开都落在遮罩上」：在弹窗内按下、遮罩上松手不得关闭
    await cdp.evaluate(`window.__e2eUI.maskGesture('inside-to-mask')`)
    await sleep(200)
    if (
      (await cdp.evaluate(`document.querySelector('.modal-title')?.textContent ?? ''`)) !==
      '主机密钥已变更'
    ) {
      throw new Error('主机密钥弹窗在「弹窗内按下、遮罩上松手」时被误关')
    }
    pass('主机密钥弹窗不会因在弹窗内按下、遮罩上松手而误关')

    // 11.x 用户先取消弹窗：待确认记录仍然存在，随后用于验证「服务端下线不得误报密钥变更」
    await cdp.evaluate(`window.__e2eUI.clickByText('.modal-foot button', '取消连接')`)
    await waitForCondition(cdp, `!document.querySelector('.modal-title')`, '取消连接后弹窗关闭')
    if (JSON.parse(fs.readFileSync(knownHostsFile, 'utf8'))[`127.0.0.1:${SSH_PORT}`] !== fingerprintA) {
      throw new Error('取消连接后 known_hosts.json 被改写，取消不应产生任何持久化副作用')
    }
    pass('取消连接后 known_hosts.json 仍保存旧指纹')

    // 11.y 待确认记录存在时让服务端下线：必须给中文 ECONNREFUSED，不得再弹「主机密钥已变更」
    await closeServer(server)
    server = null
    await cdp.evaluate(`window.__e2eUI.openConnection('E2E 密钥变更机')`)
    await waitForCondition(
      cdp,
      `!!document.querySelector('.toast.error')`,
      '待确认记录存在且服务端下线时出现错误提示'
    )
    const offlineToast = await cdp.evaluate(`document.querySelector('.toast-text').textContent`)
    if (!offlineToast.includes('目标端口未开放')) {
      throw new Error(`服务端下线时的提示不是中文 ECONNREFUSED：${offlineToast}`)
    }
    if (await cdp.evaluate(`!!document.querySelector('.modal-title')`)) {
      throw new Error('服务端下线（ECONNREFUSED）时仍然弹出了主机密钥变更确认框，属于误报')
    }
    pass(`服务端下线时给出中文 ECONNREFUSED 且未误报密钥变更（${offlineToast}）`)
    await cdp.evaluate(`(document.querySelector('.toast').click(), true)`)
    await waitFor(cdp, `!document.querySelector('.toast')`, 3000)

    // 11.z 服务端恢复（仍是密钥 B）后重连：待确认记录应再次触发确认弹窗
    server = await startTestServer(hostKeyB)
    await cdp.evaluate(`window.__e2eUI.openConnection('E2E 密钥变更机')`)
    await waitForCondition(
      cdp,
      `document.querySelector('.modal-title')?.textContent === '主机密钥已变更'`,
      '服务端恢复后再次弹出主机密钥变更确认弹窗'
    )
    const reShownNew = await cdp.evaluate(`document.querySelector('.fp-value.new').textContent`)
    if (reShownNew !== fingerprintB) {
      throw new Error(`再次弹出的弹窗新指纹与真实指纹不一致：${reShownNew} / ${fingerprintB}`)
    }
    pass('再次弹出的弹窗仍展示服务端 B 的真实指纹')

    await cdp.evaluate(`window.__e2eUI.clickByText('.modal-foot button', '信任新密钥并连接')`)
    await waitForCondition(cdp, `!document.querySelector('.modal-title')`, '确认信任后弹窗关闭')
    await waitForCondition(
      cdp,
      `window.__e2eUI.tabs().some((title) => title.includes('E2E 密钥变更机'))`,
      '确认信任后自动重连成功并新建标签'
    )
    // 重连后的终端也应看到欢迎语（同 7b 的缓冲回放路径）
    if (
      !(await waitFor(
        cdp,
        `window.__e2eUI.screenText().includes('E2E-欢迎使用测试 SSH 服务')`,
        10000
      ))
    ) {
      const state = await dumpScreenState(cdp)
      throw new Error(`确认信任后重连的终端未显示远端欢迎语（首屏输出丢失）：现场=${state}`)
    }
    pass('确认信任后重连的终端显示远端欢迎语（首屏输出未丢失）')
    // 用同一会话回显一段文本，确认「确认信任 → 重连」确实建立了可用会话
    await waitForCondition(
      cdp,
      `window.__e2e.sessions.length > ${hkSessionsBefore}`,
      '确认信任后的重连会话确实建立'
    )
    const hkSessionId = await cdp.evaluate(`window.__e2eUI.lastSessionId()`)
    if (!hkSessionId) throw new Error('确认信任后未能定位新会话的 sessionId')
    await cdp.evaluate(
      `window.api.terminal.write(${JSON.stringify(hkSessionId)}, 'echo E2E-HK-OK\\n'), true`
    )
    await waitForCondition(
      cdp,
      `window.__e2eUI.screenText().includes('E2E-HK-OK')`,
      '确认信任后重连的会话可收发数据'
    )
    const knownAfter = JSON.parse(fs.readFileSync(knownHostsFile, 'utf8'))
    if (knownAfter[`127.0.0.1:${SSH_PORT}`] !== fingerprintB) {
      throw new Error(
        `确认信任后 known_hosts.json 未更新为新指纹：${knownAfter[`127.0.0.1:${SSH_PORT}`]}`
      )
    }
    pass('确认信任后 known_hosts.json 更新为主机 B 的真实 SHA256 指纹')

    // -----------------------------------------------------------------------
    // 12. 其它本轮新增交互的冒烟检查：窗口标题、连接搜索过滤、复制连接、右键菜单、字号持久化
    // -----------------------------------------------------------------------
    // 12.1 窗口标题跟随当前标签（标签标题是已保存连接的名称）
    if (!(await waitFor(cdp, `document.title === 'E2E 密钥变更机 · EasySSH'`, 5000))) {
      const currentTitle = await cdp.evaluate(`document.title`)
      throw new Error(`窗口标题未跟随当前标签，实际=${currentTitle}`)
    }
    pass('窗口标题跟随当前标签')

    // 12.2 连接搜索过滤：无匹配时列表清空，清空关键字后恢复
    const connCountBefore = await cdp.evaluate(`document.querySelectorAll('.conn-item').length`)
    if (connCountBefore < 1) throw new Error('连接列表为空，无法验证搜索过滤')
    await cdp.evaluate(`window.__e2eUI.setValue('.conn-search input', 'ZZZ-不存在的连接-7788')`)
    await waitForCondition(
      cdp,
      `document.querySelectorAll('.conn-item').length === 0`,
      '搜索无匹配时连接列表清空'
    )
    await cdp.evaluate(`window.__e2eUI.setValue('.conn-search input', '')`)
    await waitForCondition(
      cdp,
      `document.querySelectorAll('.conn-item').length === ${connCountBefore}`,
      '清空搜索关键字后列表恢复'
    )

    // 12.3 复制连接：以原配置生成带「副本」后缀的新建草稿
    await cdp.evaluate(`window.__e2eUI.click('.conn-item .icon-btn[title="复制连接"]')`)
    await waitForCondition(
      cdp,
      `document.querySelector('.modal-title')?.textContent === '新建连接'`,
      '点「复制连接」打开新建表单'
    )
    const draftName = await cdp.evaluate(`(() => {
      const field = Array.from(document.querySelectorAll('.modal .field')).find((item) => {
        const span = item.querySelector('span')
        return span && span.textContent.trim() === '名称'
      })
      const input = field ? field.querySelector('input') : null
      return input ? input.value : null
    })()`)
    if (!draftName || !draftName.includes('副本')) {
      throw new Error(`复制连接的草稿名称不符合预期：${draftName}`)
    }
    pass(`复制连接生成草稿（名称=${draftName}）`)
    await cdp.evaluate(`window.__e2eUI.clickByText('.modal-foot button', '取消')`)
    await waitForCondition(cdp, `!document.querySelector('.modal-title')`, '取消后新建表单关闭')

    // 12.4 终端右键菜单：出现完整菜单项，Esc 可关闭
    await cdp.evaluate(`(() => {
      const host = document.querySelector('.terminal-host:not(.hidden)')
      host.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 200, clientY: 200
      }))
      return true
    })()`)
    await waitForCondition(cdp, `!!document.querySelector('.ctx-menu')`, '右键终端弹出上下文菜单')
    const menuText = await cdp.evaluate(
      `Array.from(document.querySelectorAll('.ctx-menu-item')).map((el) => el.textContent).join('|')`
    )
    if (
      !menuText.includes('复制') ||
      !menuText.includes('查找') ||
      !menuText.includes('清屏') ||
      !menuText.includes('放大字号') ||
      !menuText.includes('缩小字号') ||
      !menuText.includes('复位字号')
    ) {
      throw new Error(`右键菜单项不完整：${menuText}`)
    }
    pass(`右键菜单项完整（含放大 / 缩小 / 复位字号）：${menuText}`)
    await cdp.evaluate(
      `(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`
    )
    await waitForCondition(cdp, `!document.querySelector('.ctx-menu')`, 'Esc 关闭右键菜单')

    // 12.5 字号快捷键：Ctrl+= 放大并持久化，Ctrl+0 复位
    // 快捷键由 xterm 的键盘处理器拦截，必须先让终端输入区拿到焦点
    const focusActiveTerminal = `(() => {
      const textarea = document.querySelector('.terminal-host:not(.hidden) .xterm-helper-textarea')
      if (textarea) textarea.focus()
      return !!textarea && document.activeElement === textarea
    })()`
    if (!(await cdp.evaluate(focusActiveTerminal))) {
      throw new Error('激活终端的输入区无法获得焦点，无法测试字号快捷键')
    }
    await cdp.dispatchKey({ key: '=', code: 'Equal', windowsVirtualKeyCode: 187, modifiers: 2 })
    await waitForCondition(
      cdp,
      `window.localStorage.getItem('easyssh:font-size') === '15'`,
      'Ctrl+= 放大字号并持久化为 15'
    )
    await cdp.dispatchKey({ key: '0', code: 'Digit0', windowsVirtualKeyCode: 48, modifiers: 2 })
    await waitForCondition(
      cdp,
      `window.localStorage.getItem('easyssh:font-size') === '14'`,
      'Ctrl+0 把字号复位为默认值 14'
    )

    // -----------------------------------------------------------------------
    // 12.6 主题：点击切换浅 / 深色、终端配色跟随、localStorage 持久化、右键回到跟随系统
    // -----------------------------------------------------------------------
    const themeProbe = `JSON.stringify({
      mode: window.localStorage.getItem('easyssh:theme'),
      theme: document.documentElement.dataset.theme,
      colorScheme: document.documentElement.style.colorScheme,
      systemDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
      terminal: (function () {
        var host = document.querySelector('.terminal-host:not(.hidden)')
        if (!host) return null
        var xterm = host.querySelector('.xterm')
        var viewport = host.querySelector('.xterm-viewport')
        var rows = host.querySelector('.xterm-rows')
        var spans = rows
          ? Array.from(rows.querySelectorAll('span')).filter(function (el) {
              return el.textContent.trim()
            })
          : []
        var textColors = {}
        spans.slice(0, 40).forEach(function (el) {
          textColors[getComputedStyle(el).color] = true
        })
        return {
          xtermBg: xterm ? getComputedStyle(xterm).backgroundColor : null,
          xtermColor: xterm ? getComputedStyle(xterm).color : null,
          viewportBg: viewport ? getComputedStyle(viewport).backgroundColor : null,
          viewportInline: viewport ? viewport.style.backgroundColor : null,
          rowsBg: rows ? getComputedStyle(rows).backgroundColor : null,
          textColors: Object.keys(textColors)
        }
      })()
    })`
    const themeBefore = JSON.parse(await cdp.evaluate(themeProbe))
    console.log(`[信息] 切换前主题现场：${JSON.stringify(themeBefore)}`)
    // 用户从未显式选择过主题时 localStorage 为空，读取语义等价于 system，这里两者都接受
    assert(
      themeBefore.mode === null || themeBefore.mode === 'system',
      `首次启动的主题模式为 system（localStorage=${JSON.stringify(themeBefore.mode)} 表示未显式选择）`
    )
    assert(
      themeBefore.theme === (themeBefore.systemDark ? 'dark' : 'light'),
      `跟随系统时 data-theme 等于系统偏好（${themeBefore.theme}，系统深色=${themeBefore.systemDark}）`
    )
    /** 各主题下终端应有的前景色（TerminalView.tsx 里的 LIGHT/DARK_TERMINAL_THEME.foreground） */
    const TERMINAL_FOREGROUND = { dark: 'rgb(231, 234, 240)', light: 'rgb(31, 36, 48)' }

    await cdp.evaluate(`window.__e2eUI.click('.theme-toggle')`)
    const themeFlipped = JSON.parse(await cdp.evaluate(themeProbe))
    const flippedExpected = themeBefore.theme === 'light' ? 'dark' : 'light'
    assert(
      themeFlipped.theme === flippedExpected && themeFlipped.mode === flippedExpected,
      `点击主题按钮后在显式主题间切换并持久化（mode=${themeFlipped.mode}，data-theme=${themeFlipped.theme}）`
    )
    assert(
      themeFlipped.colorScheme === flippedExpected,
      `color-scheme 同步为 ${themeFlipped.colorScheme}（原生控件与滚动条跟随主题）`
    )
    const flippedColor = TERMINAL_FOREGROUND[flippedExpected]
    assert(
      JSON.stringify(themeFlipped.terminal).includes(flippedColor),
      `终端配色跟随主题变为 ${flippedColor}（probe=${JSON.stringify(themeFlipped.terminal)}）`
    )

    await cdp.evaluate(`window.__e2eUI.click('.theme-toggle')`)
    const themeBack = JSON.parse(await cdp.evaluate(themeProbe))
    const backColor = TERMINAL_FOREGROUND[themeBefore.theme]
    assert(
      themeBack.theme === themeBefore.theme && themeBack.mode === themeBefore.theme,
      `再次点击切回 ${themeBack.theme} 并持久化（mode=${themeBack.mode}）`
    )
    assert(
      JSON.stringify(themeBack.terminal).includes(backColor),
      `终端配色随第二次切换变为 ${backColor}（probe=${JSON.stringify(themeBack.terminal)}）`
    )
    assert(
      JSON.stringify(themeBack.terminal) !== JSON.stringify(themeFlipped.terminal),
      '两次切换之间终端配色现场确实发生变化（不是只换了页面令牌）'
    )

    await cdp.evaluate(`(() => {
      const el = document.querySelector('.theme-toggle')
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }))
      return true
    })()`)
    const themeSystem = JSON.parse(await cdp.evaluate(themeProbe))
    assert(
      themeSystem.mode === 'system' &&
        themeSystem.theme === (themeSystem.systemDark ? 'dark' : 'light'),
      `Shift+点击回到跟随系统（mode=${themeSystem.mode}，data-theme=${themeSystem.theme}）`
    )
    // 把主题固定为显式深色：后面的「重新加载」用例要验证主题持久化
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = JSON.parse(await cdp.evaluate(themeProbe))
      if (current.mode === 'dark') break
      await cdp.evaluate(`window.__e2eUI.click('.theme-toggle')`)
    }
    const themeDark = JSON.parse(await cdp.evaluate(themeProbe))
    assert(themeDark.mode === 'dark', `主题已固定为显式深色，供重启持久化用例使用（mode=${themeDark.mode}）`)

    // -----------------------------------------------------------------------
    // 12.7 连接分组：移动到分组、分组标题出现、折叠与展开、IPC 回读
    // -----------------------------------------------------------------------
    await cdp.evaluate(`window.__e2eUI.click('.conn-item .icon-btn[title="移动到分组…"]')`)
    await waitForCondition(
      cdp,
      `document.querySelector('.modal-title')?.textContent === '移动到分组'`,
      '点击「移动到分组…」打开分组弹窗'
    )
    // 12.7a 第三个带遮罩的弹窗同样只在「按下与松开都落在遮罩上」时才关闭
    await cdp.evaluate(`window.__e2eUI.maskGesture('inside-to-mask')`)
    await sleep(200)
    if (
      (await cdp.evaluate(`document.querySelector('.modal-title')?.textContent ?? ''`)) !==
      '移动到分组'
    ) {
      throw new Error('移动到分组弹窗在「弹窗内按下、遮罩上松手」时被误关')
    }
    pass('移动到分组弹窗不会因在弹窗内按下、遮罩上松手而误关')
    // 分组已改为下拉框：选「＋ 新建分组…」哨兵项，再填新分组名称
    await cdp.evaluate(`(() => {
      const select = document.querySelector('.modal select')
      if (!select) throw new Error('移动到分组弹窗里没有分组下拉框')
      const option = Array.from(select.options).find((item) => item.textContent.includes('新建分组'))
      if (!option) throw new Error('下拉框缺少「新建分组…」选项')
      // React 受控组件必须走原生 value setter + change 事件才能被感知
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setter.call(select, option.value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await cdp.evaluate(`window.__e2eUI.setField('新分组名称', 'E2E 分组')`)
    await cdp.evaluate(`window.__e2eUI.click('.modal-foot button[type="submit"]')`)
    await waitForCondition(cdp, `!document.querySelector('.modal-title')`, '保存分组后弹窗关闭')
    await waitForCondition(
      cdp,
      `Array.from(document.querySelectorAll('.conn-group-name')).some((el) => el.textContent === 'E2E 分组')`,
      '侧栏出现分组标题「E2E 分组」'
    )
    const groupFromIpc = await cdp.evaluate(
      `(async () => JSON.stringify((await window.api.connections.list()).map((vo) => [vo.name, vo.group ?? null])))()`
    )
    if (!groupFromIpc.includes('"E2E 分组"')) {
      throw new Error(`分组未落盘，IPC 回读结果为 ${groupFromIpc}`)
    }
    pass(`分组经 store 落盘且 IPC 回读一致（${groupFromIpc}）`)
    const groupsFromIpc = await cdp.evaluate(
      `(async () => JSON.stringify(await window.api.connections.groups()))()`
    )
    if (!groupsFromIpc.includes('E2E 分组')) {
      throw new Error(`分组未登记到分组列表，groups() 回读为 ${groupsFromIpc}`)
    }
    pass(`下拉框新建的分组已登记到分组列表（groups() = ${groupsFromIpc}）`)

    const itemsBeforeCollapse = await cdp.evaluate(`document.querySelectorAll('.conn-item').length`)
    if (itemsBeforeCollapse < 2) {
      throw new Error(`连接项不足，无法验证分组折叠（当前 ${itemsBeforeCollapse} 项）`)
    }
    await cdp.evaluate(`window.__e2eUI.clickByText('.conn-group-head', 'E2E 分组')`)
    await waitForCondition(
      cdp,
      `document.querySelectorAll('.conn-item').length === ${itemsBeforeCollapse - 1}`,
      `折叠分组后该组连接从列表隐藏（${itemsBeforeCollapse} → ${itemsBeforeCollapse - 1} 项）`
    )
    await cdp.evaluate(`window.__e2eUI.clickByText('.conn-group-head', 'E2E 分组')`)
    await waitForCondition(
      cdp,
      `document.querySelectorAll('.conn-item').length === ${itemsBeforeCollapse}`,
      '再次点击分组标题后展开，连接重新出现'
    )

    // 12.7b 新建空分组：侧栏按钮 → 命名弹窗 → 空分组以计数 0 立即出现
    await cdp.evaluate(`window.__e2eUI.click('.sidebar-head-actions .icon-btn[title="新建分组"]')`)
    await waitForCondition(
      cdp,
      `document.querySelector('.modal-title')?.textContent === '新建分组'`,
      '点击「新建分组」打开命名弹窗'
    )
    await cdp.evaluate(`window.__e2eUI.setField('分组名', 'E2E 空分组')`)
    await cdp.evaluate(`window.__e2eUI.click('.modal-foot button[type="submit"]')`)
    await waitForCondition(
      cdp,
      `Array.from(document.querySelectorAll('.conn-group-name')).some((el) => el.textContent === 'E2E 空分组')`,
      '新建的空分组立即出现在侧栏'
    )
    const emptyGroupCount = await cdp.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.conn-group-head')).find((el) =>
        el.textContent.includes('E2E 空分组')
      )
      return row ? (row.querySelector('.conn-group-count')?.textContent ?? '') : null
    })()`)
    assert(emptyGroupCount === '0', `空分组计数显示为 0（实际 ${emptyGroupCount}）`)

    // 12.7c 重命名分组：分组行聚焦后出现操作按钮 → 改名 → 侧栏与 groups() 同步更新
    await cdp.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.conn-group-head')).find((el) =>
        el.textContent.includes('E2E 空分组')
      )
      if (!row) throw new Error('找不到空分组行')
      // 分组操作按钮在行获得焦点时出现；React 监听的是委托的 focusin
      row.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      return true
    })()`)
    await waitForCondition(
      cdp,
      `!!document.querySelector('.conn-group-tools .icon-btn[title^="重命名分组"]')`,
      '分组行聚焦后出现重命名与删除按钮'
    )
    await cdp.evaluate(`window.__e2eUI.click('.conn-group-tools .icon-btn[title^="重命名分组"]')`)
    await waitForCondition(
      cdp,
      `document.querySelector('.modal-title')?.textContent === '重命名分组'`,
      '打开重命名分组弹窗'
    )
    await cdp.evaluate(`window.__e2eUI.setField('分组名', 'E2E 空分组-改')`)
    await cdp.evaluate(`window.__e2eUI.click('.modal-foot button[type="submit"]')`)
    await waitForCondition(
      cdp,
      `Array.from(document.querySelectorAll('.conn-group-name')).some((el) => el.textContent === 'E2E 空分组-改')`,
      '重命名后侧栏显示新分组名'
    )
    const renamedGroups = await cdp.evaluate(
      `(async () => JSON.stringify(await window.api.connections.groups()))()`
    )
    if (!renamedGroups.includes('E2E 空分组-改') || renamedGroups.includes('"E2E 空分组"')) {
      throw new Error(`重命名未同步到分组列表：groups() = ${renamedGroups}`)
    }
    pass(`重命名分组已同步到主进程分组列表（groups() = ${renamedGroups}）`)

    // 12.7d 删除分组：确认弹窗 → 分组从侧栏消失
    await cdp.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.conn-group-head')).find((el) =>
        el.textContent.includes('E2E 空分组-改')
      )
      if (!row) throw new Error('找不到待删除分组行')
      row.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      return true
    })()`)
    await waitForCondition(
      cdp,
      `!!document.querySelector('.conn-group-tools .icon-btn[title^="删除分组"]')`,
      '分组行出现删除按钮'
    )
    await cdp.evaluate(`window.__e2eUI.click('.conn-group-tools .icon-btn[title^="删除分组"]')`)
    await waitForCondition(
      cdp,
      `document.querySelector('.modal-title')?.textContent === '删除分组'`,
      '打开删除分组确认弹窗'
    )
    await cdp.evaluate(`window.__e2eUI.click('.modal-foot button[type="submit"]')`)
    await waitForCondition(
      cdp,
      `!Array.from(document.querySelectorAll('.conn-group-name')).some((el) => el.textContent === 'E2E 空分组-改')`,
      '删除后该分组从侧栏消失'
    )
    const groupsAfterRemove = await cdp.evaluate(
      `(async () => JSON.stringify(await window.api.connections.groups()))()`
    )
    if (groupsAfterRemove.includes('E2E 空分组-改')) {
      throw new Error(`删除后分组仍登记在列表中：${groupsAfterRemove}`)
    }
    pass(`删除分组已同步到主进程分组列表（groups() = ${groupsAfterRemove}）`)

    // -----------------------------------------------------------------------
    // 12.8 导入 / 导出：该功能已按用户要求移除，相关用例与 verify-config-io.cjs 一并删除，
    //      编号不复用，便于与历史报告对照
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // 12.9 SFTP 列宽拖拽：拖动改变列宽、表头与数据行对齐、最小宽度钳制、双击复位
    // -----------------------------------------------------------------------
    // 主机密钥变更用例重启过服务端，测试 9 打开的 SFTP 会话已随底层连接释放，
    // 因此先关掉失效标签，再重新打开一个可用的 SFTP 面板（顺带验证标签关闭与重开）
    const staleSftpTab = await cdp.evaluate(`(() => {
      const tab = Array.from(document.querySelectorAll('.tab')).find((el) => {
        const badge = el.querySelector('.tab-kind')
        return badge && badge.textContent.trim() === '⇅'
      })
      if (!tab) return false
      const close = tab.querySelector('.tab-icon')
      if (close) close.click()
      return true
    })()`)
    if (staleSftpTab) {
      await waitForCondition(
        cdp,
        `document.querySelectorAll('.sftp-panel').length === 0`,
        '关闭已被服务端重启带走的 SFTP 标签'
      )
    }
    await cdp.evaluate(`window.__e2eUI.click('.conn-item .icon-btn[title="SFTP 文件管理"]')`)
    await waitForCondition(
      cdp,
      `!!document.querySelector('.sftp-panel:not(.hidden) .sftp-path-input')`,
      '重新打开 SFTP 面板（后续用例限定在可见面板内）'
    )
    const resizerShape = JSON.parse(
      await cdp.evaluate(
        `(() => {
          const head = document.querySelector('.sftp-panel:not(.hidden) .sftp-head')
          return JSON.stringify({
            resizers: head.querySelectorAll('.col-resizer').length,
            sizeWidth: head.querySelector('.col-size').style.width
          })
        })()`
      )
    )
    assert(resizerShape.resizers === 3, `表头有 3 个列宽拖拽手柄（实际 ${resizerShape.resizers}）`)
    assert(resizerShape.sizeWidth === '96px', `size 列初始宽度为 96px（实际 ${resizerShape.sizeWidth}）`)

    /**
     * 在可见 SFTP 表头上拖动第 index 个列宽手柄。
     * @param {number} index 手柄序号
     * @param {number} deltaX 水平位移
     */
    const dragResizer = (index, deltaX) =>
      cdp.evaluate(`(() => {
        const head = document.querySelector('.sftp-panel:not(.hidden) .sftp-head')
        const resizer = head.querySelectorAll('.col-resizer')[${index}]
        resizer.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true, cancelable: true, clientX: 500, clientY: 100
        }))
        document.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, clientX: ${500 + deltaX}, clientY: 100
        }))
        document.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true, clientX: ${500 + deltaX}, clientY: 100
        }))
        return true
      })()`)

    await dragResizer(1, 40)
    const afterDrag = JSON.parse(
      await cdp.evaluate(
        `(() => {
          const panel = document.querySelector('.sftp-panel:not(.hidden)')
          const head = panel.querySelector('.sftp-head')
          const row = panel.querySelector('.sftp-row.clickable')
          return JSON.stringify({
            headWidth: head.querySelector('.col-size').style.width,
            rowWidth: row ? row.querySelector('.col-size').style.width : null
          })
        })()`
      )
    )
    assert(
      afterDrag.headWidth === '136px',
      `向右拖动 40px 后 size 列宽为 136px（实际 ${afterDrag.headWidth}）`
    )
    assert(
      afterDrag.rowWidth === afterDrag.headWidth,
      `表头与数据行共用同一列宽，保持对齐（数据行 ${afterDrag.rowWidth}）`
    )

    await dragResizer(1, -1000)
    const clamped = await cdp.evaluate(
      `document.querySelector('.sftp-panel:not(.hidden) .sftp-head .col-size').style.width`
    )
    assert(clamped === '72px', `向左大幅拖动被钳制在该列最小宽度 72px（实际 ${clamped}）`)

    await cdp.evaluate(`(() => {
      const head = document.querySelector('.sftp-panel:not(.hidden) .sftp-head')
      head.querySelectorAll('.col-resizer')[1].dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true })
      )
      return true
    })()`)
    const reset = await cdp.evaluate(
      `document.querySelector('.sftp-panel:not(.hidden) .sftp-head .col-size').style.width`
    )
    assert(reset === '96px', `双击手柄恢复默认列宽 96px（实际 ${reset}）`)

    // -----------------------------------------------------------------------
    // 12.10 SFTP 大目录虚拟滚动：2000 项目录只渲染窗口内的行
    // -----------------------------------------------------------------------
    await cdp.evaluate(
      `window.__e2eUI.setUncontrolledValue('.sftp-panel:not(.hidden) .sftp-path-input', '${FAKE_HOME}/many')`
    )
    await cdp.evaluate(`window.__e2eUI.pressEnter('.sftp-panel:not(.hidden) .sftp-path-input')`)
    await waitForCondition(
      cdp,
      `(document.querySelector('.sftp-panel:not(.hidden) .sftp-list')?.textContent ?? '').includes('f-0000.txt')`,
      `大目录（${MANY_FILES} 项）加载完成`
    )
    const virtualState = JSON.parse(
      await cdp.evaluate(
        `(() => {
          const panel = document.querySelector('.sftp-panel:not(.hidden)')
          const list = panel.querySelector('.sftp-list')
          const spacers = panel.querySelectorAll('.sftp-virtual-spacer')
          return JSON.stringify({
            domRows: panel.querySelectorAll('.sftp-row.clickable').length,
            spacerTop: spacers[0] ? spacers[0].style.height : null,
            scrollHeight: list.scrollHeight,
            clientHeight: list.clientHeight
          })
        })()`
      )
    )
    assert(
      virtualState.domRows > 0 && virtualState.domRows < 100,
      `${MANY_FILES} 行目录只渲染 ${virtualState.domRows} 行 DOM（远小于 ${MANY_FILES}）`
    )
    assert(
      virtualState.scrollHeight >= MANY_FILES * 32,
      `虚拟列表用占位高度表达全部内容（scrollHeight=${virtualState.scrollHeight}，${MANY_FILES}×32px）`
    )

    const scrollPerf = JSON.parse(
      await cdp.evaluate(`(async () => {
        const panel = document.querySelector('.sftp-panel:not(.hidden)')
        const list = panel.querySelector('.sftp-list')
        const start = performance.now()
        list.scrollTop = list.scrollHeight
        let found = false
        while (performance.now() - start < 3000) {
          await new Promise(function (resolve) { requestAnimationFrame(resolve) })
          const rows = Array.from(panel.querySelectorAll('.sftp-row.clickable'))
          if (rows.some(function (el) { return el.textContent.includes('f-1999.txt') })) {
            found = true
            break
          }
        }
        return JSON.stringify({
          elapsed: performance.now() - start,
          found: found,
          domRows: panel.querySelectorAll('.sftp-row.clickable').length
        })
      })()`)
    )
    assert(
      scrollPerf.found === true,
      `${MANY_FILES} 行目录滚动到底部后渲染出末尾文件 f-1999.txt（耗时 ${scrollPerf.elapsed.toFixed(1)}ms）`
    )
    assert(
      scrollPerf.elapsed < 1500,
      `滚动到底部的响应时间 ${scrollPerf.elapsed.toFixed(1)}ms 低于 1500ms 阈值`
    )
    assert(
      scrollPerf.domRows < 100,
      `滚动后 DOM 行数仍只有 ${scrollPerf.domRows} 行（虚拟滚动持续生效）`
    )
    console.log(
      `[数据] 虚拟滚动：${MANY_FILES} 行目录滚动到底部耗时 ${scrollPerf.elapsed.toFixed(1)}ms，DOM 行数 ${scrollPerf.domRows}`
    )

    // -----------------------------------------------------------------------
    // 12.11 远程编辑：入口按钮存在；远端文件读不到时面板给出可读中文提示
    // （成功路径会用系统默认程序打开本地副本，在自动化环境里会真的拉起编辑器，故不触发）
    // -----------------------------------------------------------------------
    await cdp.evaluate(
      `window.__e2eUI.setUncontrolledValue('.sftp-panel:not(.hidden) .sftp-path-input', '${FAKE_HOME}')`
    )
    await cdp.evaluate(`window.__e2eUI.pressEnter('.sftp-panel:not(.hidden) .sftp-path-input')`)
    await waitForCondition(
      cdp,
      `(document.querySelector('.sftp-panel:not(.hidden) .sftp-list')?.textContent ?? '').includes('readme.txt')`,
      'SFTP 回到 /home 并列出 readme.txt'
    )
    assert(
      await cdp.evaluate(
        `!!document.querySelector('.sftp-panel:not(.hidden) [data-path="${FAKE_HOME}/readme.txt"] .icon-btn[title="用系统程序编辑"]')`
      ),
      '远程编辑入口存在（每行都有「用系统程序编辑」按钮）'
    )
    // 从脚本侧删掉这个远端文件，模拟「面板列出来的文件已经不可读」
    const readmeNode = memfs.get(`${FAKE_HOME}/readme.txt`)
    memfs.delete(`${FAKE_HOME}/readme.txt`)
    await cdp.evaluate(
      `window.__e2eUI.click('.sftp-panel:not(.hidden) [data-path="${FAKE_HOME}/readme.txt"] .icon-btn[title="用系统程序编辑"]')`
    )
    await waitForCondition(
      cdp,
      `(document.querySelector('.sftp-panel:not(.hidden) .sftp-message')?.textContent ?? '').includes('readme.txt')`,
      '远端文件不可读时面板给出针对该文件的提示'
    )
    const editMessage = await cdp.evaluate(
      `document.querySelector('.sftp-panel:not(.hidden) .sftp-message').textContent`
    )
    assert(
      /[\u4e00-\u9fff]/.test(editMessage) && editMessage.includes('readme.txt'),
      `远程编辑失败提示已中文化且指明文件（${editMessage}）`
    )
    memfs.set(`${FAKE_HOME}/readme.txt`, readmeNode)

    // -----------------------------------------------------------------------
    // 12.12 端口转发面板：该功能已按用户要求移除，相关用例与 verify-forward.cjs 一并删除
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // 12.13 SFTP 单击进入目录：目录单击即进入（且只列一次目录），文件单击只选中不导航
    //      「单击文件未触发下载」的取证限制：下载会先弹原生保存框（主进程 dialog.showSaveDialog），
    //      e2e 里既无法判断框是否弹出、也无法点掉它，因此以「路径未变 + 行进入选中态 +
    //      服务端未收到 OPEN 文件请求」作为判据；真正会弹框的路径（双击文件）不在自动化里触发。
    // -----------------------------------------------------------------------

    /**
     * 让可见 SFTP 面板跳转到指定目录，并等到该目录的内容渲染出来。
     * 同时用于把「上一次点击留下的选中态与目录」重置到已知状态。
     * 结尾会等过产品里的 500ms 防误触窗口：路径栏回车同样会刷新 lastLoadAt，
     * 若紧接着就合成单击，会被当成「双击的第二下」而被忽略（这是产品设计，不是缺陷）。
     * @param {string} dir 目标绝对路径
     * @param {string} expectText 目录内容里应当出现的一段文本
     * @returns {Promise<void>}
     */
    const gotoRemoteDir = async (dir, expectText) => {
      await cdp.evaluate(
        `window.__e2eUI.setUncontrolledValue('.sftp-panel:not(.hidden) .sftp-path-input', ${JSON.stringify(dir)})`
      )
      await cdp.evaluate(`window.__e2eUI.pressEnter('.sftp-panel:not(.hidden) .sftp-path-input')`)
      await waitForCondition(
        cdp,
        `document.querySelector('.sftp-panel:not(.hidden) .sftp-path-input')?.value === ${JSON.stringify(dir)}` +
          ` && (document.querySelector('.sftp-panel:not(.hidden) .sftp-list')?.textContent ?? '').includes(${JSON.stringify(expectText)})`,
        `SFTP 面板停在 ${dir} 并列出 ${expectText}`
      )
      // 等过 500ms 防误触窗口，模拟真实用户的点击间隔
      await sleep(650)
    }

    await gotoRemoteDir(FAKE_HOME, 'e2e-dir')
    const sftpRowsReady = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        目录行: !!document.querySelector('.sftp-panel:not(.hidden) [data-path="${FAKE_HOME}/e2e-dir"]'),
        文件行: !!document.querySelector('.sftp-panel:not(.hidden) [data-path="${FAKE_HOME}/readme.txt"]')
      })`)
    )
    assert(
      sftpRowsReady.目录行 && sftpRowsReady.文件行,
      `目录行与文件行都在列表里（${JSON.stringify(sftpRowsReady)}）`
    )

    // 单击目录行：服务端 OPENDIR 计数证明「一次单击只列一次目录」
    const opendirBeforeDirClick = sftpStats.opendir
    const dirClick = JSON.parse(
      await cdp.evaluate(`(async () => {
        const row = document.querySelector('.sftp-panel:not(.hidden) [data-path="${FAKE_HOME}/e2e-dir"]')
        if (!row) throw new Error('目录行不存在')
        const title = row.querySelector('.sftp-name')?.getAttribute('title') ?? ''
        const timeline = []
        const sample = (label) => timeline.push({
          label,
          inDom: row.isConnected,
          selected: row.classList.contains('selected')
        })
        row.click()
        sample('click 返回时')
        // React 对离散事件的刷新时机可能是微任务也可能是宏任务，而「选中」在导航完成后会被重置，
        // 因此用一个很短的采样时间线捕捉：只要在行被新目录内容替换前观察到选中态即可
        for (const delay of [1, 2, 4, 8, 16, 32]) {
          await new Promise((resolve) => setTimeout(resolve, delay))
          sample('+' + delay + 'ms')
          if (timeline.some((item) => item.selected) || !row.isConnected) break
        }
        return JSON.stringify({ title, timeline })
      })()`)
    )
    await waitForCondition(
      cdp,
      `document.querySelector('.sftp-panel:not(.hidden) .sftp-path-input')?.value === '${FAKE_HOME}/e2e-dir'`,
      '单击目录行后路径栏进入该目录'
    )
    await waitForCondition(
      cdp,
      `(document.querySelector('.sftp-panel:not(.hidden) .sftp-list')?.textContent ?? '').includes('inside.txt')`,
      '目录内容加载完成（列表出现 inside.txt）'
    )
    const opendirAfterDirClick = sftpStats.opendir
    const selectedObserved = dirClick.timeline.some((item) => item.selected)
    assert(
      selectedObserved,
      `单击目录行时该行先进入选中态（采样时间线 ${JSON.stringify(dirClick.timeline)}）`
    )
    assert(
      dirClick.title === `单击进入 e2e-dir`,
      `目录行的 title 提示「单击进入」（实际「${dirClick.title}」）`
    )
    assert(
      opendirAfterDirClick - opendirBeforeDirClick === 1,
      `单击目录只触发一次列目录请求（服务端 OPENDIR 计数 ${opendirBeforeDirClick} → ${opendirAfterDirClick}）`
    )

    // 双击目录不得进两层：真实双击的第二次 click 带 detail=2，实现据此忽略第二下
    await gotoRemoteDir(FAKE_HOME, 'readme.txt')
    const opendirBeforeDoubleClick = sftpStats.opendir
    await cdp.evaluate(`(() => {
      const row = document.querySelector('.sftp-panel:not(.hidden) [data-path="${FAKE_HOME}/e2e-dir"]')
      if (!row) throw new Error('目录行不存在')
      const options = { bubbles: true, cancelable: true }
      // 真实双击的浏览器事件序列：click(detail=1) → click(detail=2) → dblclick(detail=2)。
      // detail 必须显式给出：合成事件默认是 0，而实现正是靠 detail>1 忽略第二下
      row.dispatchEvent(new MouseEvent('click', { ...options, detail: 1 }))
      row.dispatchEvent(new MouseEvent('click', { ...options, detail: 2 }))
      row.dispatchEvent(new MouseEvent('dblclick', { ...options, detail: 2 }))
      return true
    })()`)
    await waitForCondition(
      cdp,
      `document.querySelector('.sftp-panel:not(.hidden) .sftp-path-input')?.value === '${FAKE_HOME}/e2e-dir'`,
      '双击目录（第二下 detail=2）也只进入一层'
    )
    assert(
      sftpStats.opendir - opendirBeforeDoubleClick === 1,
      `双击目录只产生一次列目录请求（服务端 OPENDIR 计数 ${opendirBeforeDoubleClick} → ${sftpStats.opendir}，第二下被 detail 判定忽略）`
    )

    // 返回上级后立刻再进同一个目录也必须生效：旧实现用「最近一次加载时刻 + 500ms 窗口」
    // 防误触，会把这一下吞掉，用户连点两个目录时第一下看起来没反应
    await cdp.evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('.sftp-panel:not(.hidden) .icon-btn'))
        .find((item) => item.getAttribute('title') === '上一级')
      if (!btn) throw new Error('上一级按钮不存在')
      btn.click()
      return true
    })()`)
    await waitForCondition(
      cdp,
      `document.querySelector('.sftp-panel:not(.hidden) .sftp-path-input')?.value === '${FAKE_HOME}'`,
      '返回上级目录成功'
    )
    const opendirBeforeQuickSecondClick = sftpStats.opendir
    await cdp.evaluate(`(() => {
      const row = document.querySelector('.sftp-panel:not(.hidden) [data-path="${FAKE_HOME}/e2e-dir"]')
      if (!row) throw new Error('目录行不存在')
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
      return true
    })()`)
    await waitForCondition(
      cdp,
      `document.querySelector('.sftp-panel:not(.hidden) .sftp-path-input')?.value === '${FAKE_HOME}/e2e-dir'`,
      '返回上级后紧接着单击目录仍能进入（不被防误触逻辑吞掉）'
    )
    assert(
      sftpStats.opendir - opendirBeforeQuickSecondClick === 1,
      `紧接着的第二次目录单击仍只列目录一次（OPENDIR ${opendirBeforeQuickSecondClick} → ${sftpStats.opendir}）`
    )

    // 观察（只取证、不判定）：500ms 防误触窗口的基准是「最近一次目录加载时刻」，而不是
    // 「刚被点进的那一行」。因此用户在 500ms 内换一个目录再点，这一次点击也会被吞掉。
    await gotoRemoteDir(FAKE_HOME, 'e2e-dir2')
    const opendirBeforeFastSecond = sftpStats.opendir
    await cdp.evaluate(
      `document.querySelector('.sftp-panel:not(.hidden) [data-path="${FAKE_HOME}/e2e-dir2"]').click()`
    )
    await waitForCondition(
      cdp,
      `document.querySelector('.sftp-panel:not(.hidden) .sftp-path-input')?.value === '${FAKE_HOME}/e2e-dir2'` +
        ` && (document.querySelector('.sftp-panel:not(.hidden) .sftp-list')?.textContent ?? '').includes('sub')`,
      '单击 e2e-dir2 进入该目录（用于观察防误触窗口）'
    )
    const opendirAfterEnterDir2 = sftpStats.opendir
    // 紧接着（远小于 500ms）点击里面的另一个目录 sub
    await cdp.evaluate(
      `document.querySelector('.sftp-panel:not(.hidden) [data-path="${FAKE_HOME}/e2e-dir2/sub"]').click()`
    )
    await sleep(400)
    const fastSecondPath = await cdp.evaluate(
      `document.querySelector('.sftp-panel:not(.hidden) .sftp-path-input')?.value ?? null`
    )
    const fastSecondSwallowed =
      fastSecondPath === `${FAKE_HOME}/e2e-dir2` && sftpStats.opendir === opendirAfterEnterDir2
    console.log(
      `[观察] 500ms 防误触窗口内点击另一个目录：${
        fastSecondSwallowed ? '被吞掉（需再点一次）' : '未被吞掉'
      }，路径=${fastSecondPath}，OPENDIR ${opendirAfterEnterDir2} → ${sftpStats.opendir}`
    )
    // 过了窗口再点一次必须正常进入，证明只是延迟生效而不是点击失效
    // （若第二次点击并未被吞掉，此时已经在 sub 目录里，行不存在即无需再点）
    await sleep(300)
    await cdp.evaluate(`(() => {
      const row = document.querySelector('.sftp-panel:not(.hidden) [data-path="${FAKE_HOME}/e2e-dir2/sub"]')
      if (row) row.click()
      return !!row
    })()`)
    await waitForCondition(
      cdp,
      `document.querySelector('.sftp-panel:not(.hidden) .sftp-path-input')?.value === '${FAKE_HOME}/e2e-dir2/sub'` +
        ` && (document.querySelector('.sftp-panel:not(.hidden) .sftp-list')?.textContent ?? '').includes('deep.txt')`,
      '过防误触窗口后再点同一目录可正常进入（点击未失效）'
    )

    // 单击文件：只选中，不改变路径，也不走下载（不产生 OPEN）
    await gotoRemoteDir(FAKE_HOME, 'readme.txt')
    const opendirBeforeFileClick = sftpStats.opendir
    const openBeforeFileClick = sftpStats.open
    const fileClick = JSON.parse(
      await cdp.evaluate(`(async () => {
        const row = document.querySelector('.sftp-panel:not(.hidden) [data-path="${FAKE_HOME}/readme.txt"]')
        if (!row) throw new Error('文件行不存在')
        row.click()
        // 留出足够时间：若单击真的会触发下载，这里就会等到原生保存框或至少一次 OPEN
        await new Promise((resolve) => setTimeout(resolve, 400))
        return JSON.stringify({
          path: document.querySelector('.sftp-panel:not(.hidden) .sftp-path-input')?.value ?? null,
          selected: row.classList.contains('selected')
        })
      })()`)
    )
    assert(
      fileClick.path === FAKE_HOME,
      `单击文件后路径不变，仍停留在 ${FAKE_HOME}（实际 ${fileClick.path}，下载路径未被触发）`
    )
    assert(fileClick.selected === true, '单击文件后该行进入选中态（文件单击只选中）')
    assert(
      sftpStats.opendir === opendirBeforeFileClick && sftpStats.open === openBeforeFileClick,
      `单击文件未触发列目录也未打开文件（OPENDIR ${opendirBeforeFileClick}→${sftpStats.opendir}，OPEN ${openBeforeFileClick}→${sftpStats.open}）`
    )

    // -----------------------------------------------------------------------
    // 12.14 侧栏宽度：拖动分配、最小 / 最大钳制、localStorage 持久化、双击与 Home 复位、
    //       方向键微调、窄视口收拢（用 CDP 真实鼠标事件，pointerId 真实，setPointerCapture 才会生效）
    // -----------------------------------------------------------------------
    /** 侧栏宽度 CSS 变量的读取表达式，供多处断言复用 */
    const sidebarCssWidth = `getComputedStyle(document.querySelector('.app')).getPropertyValue('--sidebar-width').trim()`

    /**
     * 读取侧栏宽度现场（CSS 变量 / 实际像素宽 / localStorage / 窗口宽与上限 / 分隔条可访问性）。
     * @returns {Promise<object>} 现场快照
     */
    const readSidebarState = async () =>
      JSON.parse(
        await cdp.evaluate(`JSON.stringify((() => {
          const app = document.querySelector('.app')
          const sidebar = document.querySelector('.sidebar')
          const splitter = document.querySelector('.splitter')
          return {
            cssVar: app ? getComputedStyle(app).getPropertyValue('--sidebar-width').trim() : null,
            sidebarWidth: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : null,
            stored: window.localStorage.getItem('easyssh:sidebar-width'),
            innerWidth: window.innerWidth,
            maxAllowed: Math.max(240, Math.min(560, window.innerWidth - 486)),
            dragging: !!splitter && splitter.classList.contains('dragging'),
            bodyResizing: document.body.classList.contains('resizing'),
            ariaNow: splitter ? splitter.getAttribute('aria-valuenow') : null,
            role: splitter ? splitter.getAttribute('role') : null,
            ariaLabel: splitter ? splitter.getAttribute('aria-label') : null,
            tabIndex: splitter ? splitter.tabIndex : null
          }
        })())`)
      )

    /**
     * 分隔条当前的屏幕坐标（其 x 随侧栏宽度移动，每次拖动前都要重新取）。
     * @returns {Promise<{x: number, y: number}>} 视口坐标
     */
    const splitterPointNow = async () =>
      JSON.parse(
        await cdp.evaluate(`JSON.stringify((() => {
          const rect = document.querySelector('.splitter').getBoundingClientRect()
          return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2)
          }
        })())`)
      )

    /**
     * 用真实鼠标事件把分隔条拖到 targetX（等价用户按住分隔条拖动）。
     * @param {number} targetX 目标 x（视口坐标；侧栏贴着窗口左边，x 即目标宽度）
     * @param {{expectDragClass?: boolean}} [options] 是否把「进入拖动态」也记为一条断言
     * @returns {Promise<{during: object, expectedDuring: number}>} 松手前的现场与期望宽度
     */
    const dragSplitterTo = async (targetX, options = {}) => {
      const from = await splitterPointNow()
      await cdp.dispatchMouse('mousePressed', {
        x: from.x,
        y: from.y,
        button: 'left',
        buttons: 1,
        clickCount: 1
      })
      const dragStarted = await waitFor(
        cdp,
        `document.querySelector('.splitter').classList.contains('dragging') &&
         document.body.classList.contains('resizing')`,
        3000
      )
      if (options.expectDragClass) {
        assert(dragStarted === true, '按住分隔条后进入拖动态（.splitter.dragging 与 body.resizing 同步）')
      }
      // 分两次移动，避免一次瞬移掩盖 pointermove 的连续性
      await cdp.dispatchMouse('mouseMoved', {
        x: Math.round((from.x + targetX) / 2),
        y: from.y,
        button: 'left',
        buttons: 1
      })
      await cdp.dispatchMouse('mouseMoved', {
        x: targetX,
        y: from.y,
        button: 'left',
        buttons: 1
      })
      const moved = await readSidebarState()
      const expectedDuring = Math.min(Math.max(Math.round(targetX), 240), moved.maxAllowed)
      await waitFor(cdp, `${sidebarCssWidth} === '${expectedDuring}px'`, 2000)
      const during = await readSidebarState()
      await cdp.dispatchMouse('mouseReleased', {
        x: targetX,
        y: from.y,
        button: 'left',
        buttons: 0,
        clickCount: 1
      })
      await waitFor(cdp, `!document.querySelector('.splitter').classList.contains('dragging')`, 3000)
      return { during, expectedDuring }
    }

    const sidebarInitial = await readSidebarState()
    assert(
      sidebarInitial.cssVar === '300px' && sidebarInitial.sidebarWidth === 300,
      `侧栏默认宽度为 300px（CSS 变量 ${sidebarInitial.cssVar}，实测 ${sidebarInitial.sidebarWidth}px；本轮由 272 调大）`
    )
    assert(
      sidebarInitial.stored === null,
      `首次启动没有残留的 localStorage 宽度（stored=${JSON.stringify(sidebarInitial.stored)}，默认值来自代码）`
    )
    assert(
      sidebarInitial.role === 'separator' &&
        sidebarInitial.ariaLabel === '调整侧栏宽度' &&
        sidebarInitial.tabIndex === 0,
      `分隔条是可聚焦的分隔符（role=${sidebarInitial.role}，aria-label=${sidebarInitial.ariaLabel}，tabIndex=${sidebarInitial.tabIndex}）`
    )

    // 拖动到 360：拖动中实时跟随，松手才落盘
    const firstDrag = await dragSplitterTo(360, { expectDragClass: true })
    assert(
      firstDrag.during.cssVar === '360px' && firstDrag.during.stored === null,
      `拖动过程中宽度实时跟随到 ${firstDrag.during.cssVar}，此时尚未落盘（stored=${JSON.stringify(firstDrag.during.stored)}）`
    )
    const afterFirstDrag = await readSidebarState()
    assert(
      afterFirstDrag.sidebarWidth === 360 && afterFirstDrag.ariaNow === '360',
      `松手后侧栏实际宽度为 360px（实测 ${afterFirstDrag.sidebarWidth}px，aria-valuenow=${afterFirstDrag.ariaNow}）`
    )
    assert(
      afterFirstDrag.stored === '360',
      `松手后宽度写入 localStorage（stored=${afterFirstDrag.stored}）`
    )

    // 钳制：拖到极小 → 240，拖到极大 → min(560, 窗口宽-486)（486 = 480 工作区保底 + 6 分隔条）
    await dragSplitterTo(100)
    const clampedMin = await readSidebarState()
    assert(
      clampedMin.cssVar === '240px' && clampedMin.stored === '240',
      `拖到极小被钳制在最小宽度 240px（实测 ${clampedMin.cssVar}，持久化 ${clampedMin.stored}）`
    )
    await dragSplitterTo(clampedMin.innerWidth - 2)
    const clampedMax = await readSidebarState()
    assert(
      clampedMax.cssVar === `${clampedMax.maxAllowed}px` &&
        clampedMax.stored === String(clampedMax.maxAllowed),
      `拖到极大被钳制在 min(560, 窗口宽-486)=${clampedMax.maxAllowed}px（窗口宽 ${clampedMax.innerWidth}，实测 ${clampedMax.cssVar}）`
    )

    // 窄视口收拢：560 → min(560, 900-486) = 414
    const dprBeforeNarrow = await cdp.evaluate(`window.devicePixelRatio`)
    const wideInnerWidth = clampedMax.innerWidth
    await cdp.setViewport(900, 680, dprBeforeNarrow)
    await waitForCondition(
      cdp,
      `window.innerWidth === 900 && ${sidebarCssWidth} === '414px'`,
      '窗口变窄到 900px 后侧栏从 560px 收拢到 414px（min(560, 900-486)）'
    )
    const narrowState = await readSidebarState()
    assert(
      narrowState.sidebarWidth === 414,
      `窄视口下侧栏实际宽度为 414px（视口 ${narrowState.innerWidth}px，实测 ${narrowState.sidebarWidth}px）`
    )
    await cdp.clearViewport()
    await waitForCondition(
      cdp,
      `window.innerWidth === ${wideInnerWidth}`,
      `取消视口覆盖后窗口宽度恢复到 ${wideInnerWidth}px`
    )
    const restoredState = await readSidebarState()
    assert(
      restoredState.sidebarWidth === 414 && restoredState.sidebarWidth <= restoredState.maxAllowed,
      `视口恢复后侧栏保持收拢结果 414px（不会自动弹回 560，当前上限 ${restoredState.maxAllowed}px）`
    )

    // 双击复位到 300
    const resetPoint = await splitterPointNow()
    const clickPair = async (clickCount) => {
      await cdp.dispatchMouse('mousePressed', {
        x: resetPoint.x,
        y: resetPoint.y,
        button: 'left',
        buttons: 1,
        clickCount
      })
      await cdp.dispatchMouse('mouseReleased', {
        x: resetPoint.x,
        y: resetPoint.y,
        button: 'left',
        buttons: 0,
        clickCount
      })
    }
    await clickPair(1)
    await clickPair(2)
    let doubleClickReset = await waitFor(cdp, `${sidebarCssWidth} === '300px'`, 2500)
    if (!doubleClickReset) {
      console.log('[信息] CDP 双击序列未触发 dblclick，退回页面内合成 dblclick 复核（断言的行为不变）')
      await cdp.evaluate(`(() => {
        document.querySelector('.splitter').dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, cancelable: true })
        )
        return true
      })()`)
      doubleClickReset = await waitFor(cdp, `${sidebarCssWidth} === '300px'`, 2500)
    }
    if (!doubleClickReset) throw new Error('双击分隔条未能复位到默认宽度 300px')
    pass('双击分隔条复位到默认宽度 300px')
    const afterReset = await readSidebarState()
    assert(
      afterReset.stored === '300' && afterReset.sidebarWidth === 300,
      `双击复位同时持久化（localStorage=${afterReset.stored}，实测 ${afterReset.sidebarWidth}px）`
    )

    // 方向键微调：ArrowRight +16、ArrowLeft -16、Home 复位
    const splitterFocused = await cdp.evaluate(`(() => {
      const splitter = document.querySelector('.splitter')
      splitter.focus()
      return document.activeElement === splitter
    })()`)
    if (!splitterFocused) throw new Error('分隔条无法获得焦点，无法验证键盘微调')
    await cdp.dispatchKey({ key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
    await waitForCondition(cdp, `${sidebarCssWidth} === '316px'`, 'ArrowRight 把侧栏加宽 16px 到 316px')
    await cdp.dispatchKey({ key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
    await waitForCondition(cdp, `${sidebarCssWidth} === '332px'`, '再按 ArrowRight 到 332px')
    await cdp.dispatchKey({ key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 })
    await waitForCondition(cdp, `${sidebarCssWidth} === '316px'`, 'ArrowLeft 把侧栏收窄 16px 回到 316px')
    await cdp.dispatchKey({ key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 })
    await waitForCondition(cdp, `${sidebarCssWidth} === '300px'`, 'Home 键复位到默认宽度 300px')

    // 停在非默认宽度 332：15 节的页面重新加载用例会断言「宽度按 localStorage 恢复」
    await cdp.dispatchKey({ key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
    await waitForCondition(cdp, `${sidebarCssWidth} === '316px'`, '键盘微调后停在 316px')
    await cdp.dispatchKey({ key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
    await waitForCondition(cdp, `${sidebarCssWidth} === '332px'`, '键盘微调后停在 332px（供重新加载持久化断言）')
    const finalSidebar = await readSidebarState()
    assert(
      finalSidebar.stored === '332' && finalSidebar.sidebarWidth === 332,
      `侧栏宽度持久化为 332（localStorage=${finalSidebar.stored}，实测 ${finalSidebar.sidebarWidth}px）`
    )

    // -----------------------------------------------------------------------
    // 12.15 复制连接带上已保存凭据：表单回显源连接密码 → 直接保存 → 副本 hasCredential 为真
    //       → 落盘有密文 → 再次打开副本编辑表单密码仍是原值
    //       （测试服务端接受任意认证，所以「副本能连上」不能证明凭据被复制，
    //        必须用 getCredential 解密回读与密文落盘来取证）
    // -----------------------------------------------------------------------
    const sourceCredential = JSON.parse(
      await cdp.evaluate(
        `(async () => JSON.stringify(await window.api.connections.getCredential(${JSON.stringify(saved.id)})))()`
      )
    )
    assert(
      sourceCredential.password === 's3cret-pw',
      `源连接「E2E 测试机」确实存有密码（getCredential 回读 password=${JSON.stringify(sourceCredential.password)}）`
    )
    await cdp.evaluate(`window.__e2eUI.clickConnectionAction('E2E 测试机', '复制连接')`)
    await waitForCondition(
      cdp,
      `document.querySelector('.modal-title')?.textContent === '新建连接'`,
      '点「复制连接」打开新建表单'
    )
    // 回显走异步 IPC（connections.getCredential），等密码框拿到值再断言
    const copyPasswordEchoed = `(() => {
      try {
        return window.__e2eUI.fieldState('密码').value === 's3cret-pw'
      } catch {
        return false
      }
    })()`
    await waitForCondition(
      cdp,
      copyPasswordEchoed,
      '复制表单的密码框回显了源连接已保存的密码（value 为原值，不是占位符）'
    )
    const copyDraft = JSON.parse(
      await cdp.evaluate(`(() => JSON.stringify({
        名称: window.__e2eUI.fieldState('名称').value,
        主机: window.__e2eUI.fieldState('主机').value,
        端口: window.__e2eUI.fieldState('端口').value,
        用户名: window.__e2eUI.fieldState('用户名').value,
        密码类型: window.__e2eUI.fieldState('密码').type,
        提示: (document.querySelector('.modal-note')?.textContent ?? '').replace(/\\s+/g, ' ').trim()
      }))()`)
    )
    assert(
      copyDraft.名称 === 'E2E 测试机 副本',
      `复制草稿名称为「E2E 测试机 副本」（实际 ${copyDraft.名称}）`
    )
    assert(
      copyDraft.主机 === '127.0.0.1' &&
        copyDraft.端口 === String(SSH_PORT) &&
        copyDraft.用户名 === 'tester',
      `副本沿用源连接的主机 / 端口 / 用户名（${copyDraft.主机}:${copyDraft.端口}，${copyDraft.用户名}）`
    )
    assert(
      copyDraft.密码类型 === 'password' &&
        copyDraft.提示.includes('已从「E2E 测试机」') &&
        copyDraft.提示.includes('副本'),
      `表单提示明确告知凭据已从源连接带入（${copyDraft.提示}）`
    )
    await cdp.evaluate(`window.__e2eUI.click('.modal button[type="submit"]')`)
    await waitForCondition(cdp, `!document.querySelector('.modal-title')`, '保存副本后弹窗关闭')
    await waitForCondition(
      cdp,
      `Array.from(document.querySelectorAll('.conn-name')).some((el) => el.textContent.trim() === 'E2E 测试机 副本')`,
      '侧栏出现副本连接「E2E 测试机 副本」'
    )
    const copyVo = JSON.parse(
      await cdp.evaluate(
        `(async () => JSON.stringify((await window.api.connections.list()).find((vo) => vo.name === 'E2E 测试机 副本') ?? null))()`
      )
    )
    if (!copyVo?.id) throw new Error('副本保存后未在连接列表中找到')
    assert(
      copyVo.id !== saved.id,
      `副本是独立记录（副本 id=${copyVo.id.slice(0, 8)}… 与源 id=${saved.id.slice(0, 8)}… 不同）`
    )
    assert(
      copyVo.hasCredential === true,
      `副本 hasCredential 为真（connections.list 回读 hasCredential=${copyVo.hasCredential}）`
    )
    const copyCredential = JSON.parse(
      await cdp.evaluate(
        `(async () => JSON.stringify(await window.api.connections.getCredential(${JSON.stringify(copyVo.id)})))()`
      )
    )
    assert(
      copyCredential.password === 's3cret-pw',
      `副本凭据经主进程解密回读仍是原密码（getCredential password=${JSON.stringify(copyCredential.password)}）`
    )
    const rawConnections = JSON.parse(
      fs.readFileSync(path.join(USER_DATA_DIR, 'connections.json'), 'utf8')
    )
    const copyRow = rawConnections.find((row) => row.id === copyVo.id)
    if (!copyRow) throw new Error('落盘文件里找不到副本记录')
    assert(
      typeof copyRow.secret === 'string' && copyRow.secret.length > 0 && copyRow.secret !== 's3cret-pw',
      `副本在落盘文件里带密文字段（secret 长度 ${copyRow.secret ? copyRow.secret.length : 0}，明文未落盘）`
    )
    await cdp.evaluate(`window.__e2eUI.clickConnectionAction('E2E 测试机 副本', '编辑')`)
    await waitForCondition(
      cdp,
      `document.querySelector('.modal-title')?.textContent === '编辑连接'`,
      '打开副本的编辑表单'
    )
    await waitForCondition(
      cdp,
      copyPasswordEchoed,
      '再次打开副本编辑表单时密码仍是原值（凭据真的落在了副本上）'
    )
    await cdp.evaluate(`window.__e2eUI.clickByText('.modal-foot button', '取消')`)
    await waitForCondition(cdp, `!document.querySelector('.modal-title')`, '取消后编辑表单关闭')

    // -----------------------------------------------------------------------
    // 12.16 终端字号缩放：Ctrl+滚轮放大 → 顶部 .term-hud 出现并约 1s 后消失；
    //       devicePixelRatio 全程不变（证明 Ctrl+滚轮没有被 Chromium 抢去整页缩放）；
    //       右键菜单「放大 / 缩小 / 复位字号」三项可用；Ctrl+= / Ctrl+0 仍生效
    // -----------------------------------------------------------------------
    await cdp.evaluate(`window.__e2eUI.activateLastTerminalTab()`)
    await waitForCondition(
      cdp,
      `!!document.querySelector('.terminal-host:not(.hidden) .xterm-rows')`,
      '切回终端标签（字号缩放用例需要可见终端）'
    )
    /** 缩放现场：持久化字号、xterm 实际字号与行高、缩放提示、devicePixelRatio */
    const zoomProbe = `JSON.stringify((() => {
      const host = document.querySelector('.terminal-host:not(.hidden)')
      const rows = host ? host.querySelector('.xterm-rows') : null
      const firstRow = rows ? rows.querySelector('div') : null
      const hud = host ? host.querySelector('.term-hud') : null
      const screen = host ? host.querySelector('.xterm-screen') : null
      return {
        stored: window.localStorage.getItem('easyssh:font-size'),
        rowsFontSize: rows ? getComputedStyle(rows).fontSize : null,
        rowHeight: firstRow ? Number(firstRow.getBoundingClientRect().height.toFixed(2)) : null,
        screenHeight: screen ? Number(screen.getBoundingClientRect().height.toFixed(2)) : null,
        hud: hud ? hud.textContent : null,
        dpr: window.devicePixelRatio
      }
    })())`
    /**
     * 在页面内用 rAF 高频轮询（只存在约 900ms 的 .term-hud 用 CDP 轮询会漏掉）。
     * @param {string} expression 命中时返回真值的表达式
     * @param {number} timeout 超时毫秒数
     * @returns {Promise<any>} 命中值；超时返回 null
     */
    const waitInPageFor = (expression, timeout = 3000) =>
      tryEvaluate(
        cdp,
        `(async () => {
          const deadline = performance.now() + ${timeout}
          while (performance.now() < deadline) {
            const value = (${expression})
            if (value) return value
            await new Promise((resolve) => requestAnimationFrame(resolve))
          }
          return null
        })()`
      )
    /** 可见终端中心的屏幕坐标（滚轮必须落在终端上才会被终端捕获） */
    const terminalPoint = async () =>
      JSON.parse(
        await cdp.evaluate(`JSON.stringify((() => {
          const rect = document.querySelector('.terminal-host:not(.hidden)').getBoundingClientRect()
          return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2)
          }
        })())`)
      )
    const zoomBaseline = JSON.parse(await cdp.evaluate(zoomProbe))
    assert(
      zoomBaseline.stored === '14' && zoomBaseline.hud === null,
      `缩放前字号基线为 14 且没有残留提示（stored=${zoomBaseline.stored}，hud=${JSON.stringify(zoomBaseline.hud)}）`
    )
    const zoomPoint = await terminalPoint()
    const wheelAt = Date.now()
    await cdp.dispatchCtrlWheel({ x: zoomPoint.x, y: zoomPoint.y, deltaY: -120 })
    const hudAfterZoomIn = await waitInPageFor(
      `(() => {
        const hud = document.querySelector('.terminal-host:not(.hidden) .term-hud')
        return hud ? hud.textContent : null
      })()`
    )
    const zoomedIn = JSON.parse(await cdp.evaluate(zoomProbe))
    assert(
      zoomedIn.stored === '15',
      `Ctrl+滚轮向上滚一格把字号从 14 放大到 15 并持久化（localStorage=${zoomedIn.stored}）`
    )
    assert(
      zoomedIn.dpr === zoomBaseline.dpr,
      `缩放后 devicePixelRatio 仍为 ${zoomedIn.dpr}（Ctrl+滚轮没有被 Chromium 抢去整页缩放）`
    )
    assert(
      zoomedIn.rowHeight > zoomBaseline.rowHeight ||
        zoomedIn.rowsFontSize !== zoomBaseline.rowsFontSize,
      `终端实际渲染随之变化（行高 ${zoomBaseline.rowHeight} → ${zoomedIn.rowHeight}px，行字号 ${zoomBaseline.rowsFontSize} → ${zoomedIn.rowsFontSize}）`
    )
    assert(
      hudAfterZoomIn === '字号 15',
      `放大后终端顶部出现缩放提示 .term-hud（文案「${hudAfterZoomIn}」）`
    )
    const hudGone = await waitFor(
      cdp,
      `!document.querySelector('.terminal-host:not(.hidden) .term-hud')`,
      5000
    )
    const hudAliveMs = Date.now() - wheelAt
    if (!hudGone) throw new Error('缩放提示 .term-hud 超过 5s 仍未消失')
    assert(
      hudAliveMs >= 500 && hudAliveMs <= 4000,
      `缩放提示自动消失（从滚轮派发到消失实测 ${hudAliveMs}ms，源码设定 900ms）`
    )

    await cdp.dispatchCtrlWheel({ x: zoomPoint.x, y: zoomPoint.y, deltaY: 120 })
    const hudAfterZoomOut = await waitInPageFor(
      `(() => {
        const hud = document.querySelector('.terminal-host:not(.hidden) .term-hud')
        return hud ? hud.textContent : null
      })()`
    )
    const zoomedOut = JSON.parse(await cdp.evaluate(zoomProbe))
    assert(
      zoomedOut.stored === '14',
      `Ctrl+滚轮向下滚一格把字号缩回默认值 14（localStorage=${zoomedOut.stored}）`
    )
    assert(
      hudAfterZoomOut === '字号已复位',
      `缩回默认字号时提示文案为「字号已复位」（实际「${hudAfterZoomOut}」）`
    )

    /** 在可见终端上右键展开上下文菜单 */
    const openTerminalMenu = async (label) => {
      await cdp.evaluate(`(() => {
        const host = document.querySelector('.terminal-host:not(.hidden)')
        host.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: 240, clientY: 240
        }))
        return true
      })()`)
      await waitForCondition(cdp, `!!document.querySelector('.ctx-menu')`, label)
    }

    await openTerminalMenu('右键终端弹出上下文菜单（字号菜单项用例）')
    const zoomMenuItems = await cdp.evaluate(
      `Array.from(document.querySelectorAll('.ctx-menu-item')).map((el) => el.textContent.trim()).join('|')`
    )
    assert(
      zoomMenuItems.includes('放大字号') &&
        zoomMenuItems.includes('缩小字号') &&
        zoomMenuItems.includes('复位字号'),
      `右键菜单包含字号三项（${zoomMenuItems}）`
    )
    await cdp.evaluate(`window.__e2eUI.clickByText('.ctx-menu-item', '放大字号')`)
    await waitForCondition(
      cdp,
      `window.localStorage.getItem('easyssh:font-size') === '15' && !document.querySelector('.ctx-menu')`,
      '点「放大字号」后字号变为 15，且菜单收起'
    )
    await openTerminalMenu('再次右键弹出菜单（复位字号）')
    await cdp.evaluate(`window.__e2eUI.clickByText('.ctx-menu-item', '复位字号')`)
    await waitForCondition(
      cdp,
      `window.localStorage.getItem('easyssh:font-size') === '14' && !document.querySelector('.ctx-menu')`,
      '点「复位字号」后字号回到默认值 14，且菜单收起'
    )
    await openTerminalMenu('再次右键弹出菜单（缩小字号）')
    await cdp.evaluate(`window.__e2eUI.clickByText('.ctx-menu-item', '缩小字号')`)
    const hudAfterMenuZoomOut = await waitInPageFor(
      `(() => {
        const hud = document.querySelector('.terminal-host:not(.hidden) .term-hud')
        return hud ? hud.textContent : null
      })()`
    )
    await waitForCondition(
      cdp,
      `window.localStorage.getItem('easyssh:font-size') === '13' && !document.querySelector('.ctx-menu')`,
      '点「缩小字号」后字号变为 13，且菜单收起'
    )
    // 右键菜单触发的缩放与快捷键 / 滚轮共用同一条 HUD 提示链路
    assert(
      hudAfterMenuZoomOut === '字号 13',
      `右键菜单缩放同样弹出提示（实际「${hudAfterMenuZoomOut}」）`
    )

    // Ctrl+= / Ctrl+0 仍生效（若 Electron 默认菜单还在，Ctrl+= 会被菜单加速键抢走，既不改字号也会整页缩放）
    if (!(await cdp.evaluate(focusActiveTerminal))) {
      throw new Error('激活终端的输入区无法获得焦点，无法复验字号快捷键')
    }
    const dprBeforeShortcut = await cdp.evaluate(`window.devicePixelRatio`)
    await cdp.dispatchKey({ key: '=', code: 'Equal', windowsVirtualKeyCode: 187, modifiers: 2 })
    await waitForCondition(
      cdp,
      `window.localStorage.getItem('easyssh:font-size') === '14'`,
      'Ctrl+= 仍能把字号从 13 放大到 14（Ctrl+= 未被默认菜单抢走）'
    )
    const dprAfterShortcut = await cdp.evaluate(`window.devicePixelRatio`)
    assert(
      dprAfterShortcut === dprBeforeShortcut,
      `快捷键缩放后 devicePixelRatio 仍为 ${dprAfterShortcut}（整页未被缩放）`
    )
    await cdp.dispatchKey({ key: '0', code: 'Digit0', windowsVirtualKeyCode: 48, modifiers: 2 })
    await waitForCondition(
      cdp,
      `window.localStorage.getItem('easyssh:font-size') === '14' &&
       document.querySelector('.terminal-host:not(.hidden) .term-hud')?.textContent === '字号已复位'`,
      'Ctrl+0 复位并弹出「字号已复位」提示（快捷键链路完好）'
    )

    // -----------------------------------------------------------------------
    // 13. 终端搜索：Ctrl+F 展开搜索栏，命中计数随关键词变化
    // 放在最后执行：搜索栏一旦因产品缺陷不可用，不会挡住前面的用例取证
    // -----------------------------------------------------------------------
    const searchMarker = 'E2E-SEARCH-MARKER-2026'
    // 新增用例结束在 SFTP 标签上，先切回终端标签，搜索栏与屏幕文本都只针对可见终端
    await cdp.evaluate(`window.__e2eUI.activateLastTerminalTab()`)
    await waitForCondition(
      cdp,
      `!!document.querySelector('.terminal-host:not(.hidden) .xterm-rows')`,
      '切回终端标签（搜索用例需要可见终端）'
    )
    const searchSessionId = await cdp.evaluate(`window.__e2eUI.lastSessionId()`)
    if (!searchSessionId) throw new Error('未能定位当前终端会话，无法准备搜索用例的文本')
    await cdp.evaluate(
      `window.api.terminal.write(${JSON.stringify(searchSessionId)}, ${JSON.stringify(
        `echo ${searchMarker}\n`
      )}), true`
    )
    await waitForCondition(
      cdp,
      `window.__e2eUI.screenText().includes('${searchMarker}')`,
      '搜索用例的可搜索文本已写入并渲染到终端'
    )

    const focusTerminal = `(() => {
      const textarea = document.querySelector('.terminal-host:not(.hidden) .xterm-helper-textarea')
      if (textarea) textarea.focus()
      return !!textarea
    })()`
    if (!(await cdp.evaluate(focusTerminal))) throw new Error('找不到激活终端的输入区，无法测试搜索')
    // 优先用 CDP 注入真实按键（走浏览器输入管线，等价用户按 Ctrl+F）
    await cdp.dispatchKey({ key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 2 })
    let searchOpened = await waitFor(cdp, `!!document.querySelector('.term-search')`, 4000)
    if (!searchOpened) {
      console.log('[信息] CDP 真实按键未打开搜索栏，退回页面内合成键盘事件重试')
      await cdp.evaluate(`(() => {
        const textarea = document.querySelector('.terminal-host:not(.hidden) .xterm-helper-textarea')
        if (!textarea) return false
        textarea.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true
        }))
        return true
      })()`)
      searchOpened = await waitFor(cdp, `!!document.querySelector('.term-search')`, 4000)
    }
    if (!searchOpened) {
      throw new Error('Ctrl+F 未能展开终端搜索栏（CDP 真实按键与页面内合成事件均未生效）')
    }
    pass('Ctrl+F 展开终端搜索栏（.term-search 出现）')

    await cdp.evaluate(
      `window.__e2eUI.setValue('.term-search-input', ${JSON.stringify(searchMarker)})`
    )
    const countOk = await waitFor(
      cdp,
      `/第 \\d+\\/\\d+ 项|共 \\d+ 项/.test(document.querySelector('.term-search-count')?.textContent ?? '')`,
      8000
    )
    if (!countOk) {
      const countText = await cdp.evaluate(
        `document.querySelector('.term-search-count')?.textContent ?? '<计数元素不存在>'`
      )
      const pageErrors = await cdp.evaluate(`JSON.stringify(window.__e2eErrors)`)
      const rootState = await cdp.evaluate(
        `JSON.stringify({ 应用仍挂载: !!document.querySelector('.app'), 根节点内容长度: (document.getElementById('root') || {}).innerHTML ? document.getElementById('root').innerHTML.length : 0 })`
      )
      throw new Error(
        `输入关键词后命中计数未出现：计数文案=${JSON.stringify(countText)}，${rootState}，页面未捕获异常=${pageErrors}`
      )
    }
    const hitCount = await cdp.evaluate(`document.querySelector('.term-search-count').textContent`)
    pass(`输入已存在于终端缓冲区的关键词后显示命中计数（${hitCount}）`)

    await cdp.evaluate(`window.__e2eUI.setValue('.term-search-input', 'ZZZ-绝不存在的关键字-9f3a')`)
    await waitForCondition(
      cdp,
      `document.querySelector('.term-search-count')?.textContent === '无结果'`,
      '换成不存在的关键词后计数文案变为「无结果」'
    )
    await cdp.evaluate(`window.__e2eUI.click('.term-search > .term-search-btn:last-child')`)
    await waitForCondition(cdp, `!document.querySelector('.term-search')`, '关闭搜索栏后元素消失')

    // 14. 页面全程无未捕获异常，且根节点未被卸载（白屏回归防线）
    const errors = await cdp.evaluate(`JSON.stringify(window.__e2eErrors)`)
    if (errors !== '[]') throw new Error(`渲染进程出现未捕获异常：${errors}`)
    pass('渲染进程全程无未捕获异常')
    const rootState = JSON.parse(
      await cdp.evaluate(
        `JSON.stringify({
          应用仍挂载: !!document.querySelector('.app'),
          根节点内容长度: (document.getElementById('root') || {}).innerHTML
            ? document.getElementById('root').innerHTML.length
            : 0
        })`
      )
    )
    if (!rootState.应用仍挂载 || rootState.根节点内容长度 === 0) {
      throw new Error(`渲染根节点被卸载，出现白屏：${JSON.stringify(rootState)}`)
    }
    pass(`渲染根节点保持挂载（内容长度 ${rootState.根节点内容长度}）`)

    // -----------------------------------------------------------------------
    // 15. 会话恢复：写入快照后重新加载页面，验证提示条、恢复动作、主题持久化与忽略
    // 放在最后执行：重新加载会重建执行上下文，前面的用例必须已经跑完
    // -----------------------------------------------------------------------
    const sessionFile = path.join(USER_DATA_DIR, 'session.json')
    // 等过 App 的 800ms 防抖写入窗口，避免它把下面这份快照覆盖掉
    await sleep(1200)
    const snapshotSave = `(async () => {
      await window.api.session.save({
        tabs: [{ kind: 'terminal', connectionId: ${JSON.stringify(saved.id)} }],
        savedAt: Date.now()
      })
      return true
    })()`
    await cdp.evaluate(snapshotSave)
    const snapshotOnDisk = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
    assert(
      snapshotOnDisk.tabs.length === 1 &&
        snapshotOnDisk.tabs[0].kind === 'terminal' &&
        snapshotOnDisk.tabs[0].connectionId === saved.id,
      `会话快照已落盘且只含类型与连接 id（${JSON.stringify(snapshotOnDisk.tabs)}）`
    )
    if (JSON.stringify(snapshotOnDisk).includes('s3cret-pw')) {
      throw new Error('会话快照里出现了凭据内容')
    }
    pass('会话快照不含任何凭据')

    /** 重新加载页面并在需要时重建 CDP 连接 */
    const reloadAndRemount = async (label) => {
      try {
        await cdp.evaluate(`location.reload()`)
      } catch {
        // reload 会让当前执行上下文立即失效，这里忽略掉是预期行为
      }
      await sleep(500)
      if (!(await tryEvaluate(cdp, `!!document.querySelector('.sidebar-title')`))) {
        // 调试会话随上下文失效时重新连一次，避免后续用例无声失败
        const wsUrl = await waitForPage(20000, () => child.exitCode)
        cdp.close()
        cdp = await connectCdp(wsUrl)
        await cdp.prepareFocus()
      }
      await waitForTolerant(
        cdp,
        `document.querySelector('.sidebar-title')?.textContent === '连接'`,
        label
      )
      await cdp.evaluate(PAGE_HELPERS)
      // 重新加载后页面是全新的，未捕获异常收集器需要重新挂上
      await cdp.evaluate(
        `window.__e2eErrors = []; window.addEventListener('error', (event) => window.__e2eErrors.push(String(event.message))); true`
      )
    }

    await reloadAndRemount('重新加载后应用重新挂载（会话恢复场景）')
    await waitForCondition(
      cdp,
      `document.documentElement.dataset.theme === 'dark' && window.localStorage.getItem('easyssh:theme') === 'dark'`,
      '重新加载后主题仍按持久化值生效（localStorage 持久化）'
    )
    // 12.14 把侧栏停在 332px 并写入 localStorage，重新加载后应当按持久化值恢复
    await waitForCondition(
      cdp,
      `getComputedStyle(document.querySelector('.app')).getPropertyValue('--sidebar-width').trim() === '332px' &&
       Math.round(document.querySelector('.sidebar').getBoundingClientRect().width) === 332`,
      '重新加载后侧栏宽度按 localStorage 恢复为 332px（宽度持久化生效）'
    )
    await waitForCondition(
      cdp,
      `!!document.querySelector('.status-bar .status-btn.primary-btn')`,
      '启动时出现会话恢复提示条（含「恢复」按钮）'
    )
    const restoreSummary = await cdp.evaluate(`document.querySelector('.status-text').textContent`)
    assert(
      restoreSummary.includes('上次有 1 个会话') && restoreSummary.includes('终端 1 / 文件 0'),
      `提示条按类型统计上次会话（${restoreSummary}）`
    )
    const restoreSources = await cdp.evaluate(
      `document.querySelectorAll('.status-bar .status-text')[1].textContent`
    )
    assert(
      restoreSources.includes('E2E 测试机'),
      `提示条列出会话来源连接名（${restoreSources}）`
    )

    await cdp.evaluate(`window.__e2eUI.clickByText('.status-actions button', '恢复')`)
    await waitForCondition(
      cdp,
      `window.__e2eUI.tabs().some((title) => title.includes('E2E 测试机'))`,
      '点击「恢复」后重开了上次的终端标签'
    )
    await waitForCondition(
      cdp,
      `window.__e2eUI.screenText().includes('E2E-欢迎使用测试 SSH 服务')`,
      '恢复出来的终端收到远端欢迎语（会话真实可用）'
    )
    await waitForCondition(
      cdp,
      `!document.querySelector('.status-bar .status-btn')`,
      '恢复完成后提示条自动消失'
    )
    assert(!fs.existsSync(sessionFile), '恢复后快照被清除，下次启动不再追问')

    // 15.b 忽略路径：再写一份快照并重新加载，点「忽略」应当清掉快照
    // 先等过 App 的 800ms 防抖写入窗口，避免它把下面这份快照覆盖掉（否则用例会随机失败）
    await sleep(1200)
    const sftpSnapshot = `(async () => {
      await window.api.session.save({
        tabs: [{ kind: 'sftp', connectionId: ${JSON.stringify(saved.id)} }],
        savedAt: Date.now()
      })
      return true
    })()`
    await cdp.evaluate(sftpSnapshot)
    const sftpSnapshotOnDisk = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
    assert(
      sftpSnapshotOnDisk.tabs.length === 1 && sftpSnapshotOnDisk.tabs[0].kind === 'sftp',
      `第二次会话快照已落盘（${JSON.stringify(sftpSnapshotOnDisk.tabs)}）`
    )
    await reloadAndRemount('第二次重新加载后应用重新挂载（忽略路径）')
    await waitForCondition(
      cdp,
      `!!document.querySelector('.status-bar .status-btn')`,
      '第二次启动同样出现会话恢复提示条'
    )
    const sftpSummary = await cdp.evaluate(`document.querySelector('.status-text').textContent`)
    assert(
      sftpSummary.includes('终端 0 / 文件 1'),
      `提示条按类型统计 SFTP 标签（${sftpSummary}）`
    )
    await cdp.evaluate(`window.__e2eUI.clickByText('.status-actions button', '忽略')`)
    await waitForCondition(
      cdp,
      `!document.querySelector('.status-bar .status-btn')`,
      '点「忽略」后提示条消失'
    )
    await waitForCondition(
      cdp,
      `(async () => (await window.api.session.load()) === null)()`,
      '忽略后快照被真实清除（IPC 读回 null）'
    )

    // 16. 重新加载后的收尾检查：无未捕获异常、根节点未卸载
    const errorsAfterReload = await cdp.evaluate(`JSON.stringify(window.__e2eErrors)`)
    if (errorsAfterReload !== '[]') {
      throw new Error(`会话恢复流程（含页面重新加载）出现未捕获异常：${errorsAfterReload}`)
    }
    pass('会话恢复流程（含两次页面重新加载）全程无未捕获异常')
    const rootAfterReload = JSON.parse(
      await cdp.evaluate(
        `JSON.stringify({
          应用仍挂载: !!document.querySelector('.app'),
          根节点内容长度: (document.getElementById('root') || {}).innerHTML
            ? document.getElementById('root').innerHTML.length
            : 0
        })`
      )
    )
    if (!rootAfterReload.应用仍挂载 || rootAfterReload.根节点内容长度 === 0) {
      throw new Error(`重新加载后渲染根节点被卸载：${JSON.stringify(rootAfterReload)}`)
    }
    pass(`重新加载后根节点仍挂载（内容长度 ${rootAfterReload.根节点内容长度}）`)

    console.log(`\n[结果] 全部通过，共 ${passed} 项`)
  } finally {
    if (cdp) cdp.close()
    // Electron 会派生多个子进程，按进程树强制结束
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    await closeServer(server)
    await sleep(500)
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(`\n[失败] ${err.message}`)
  console.error(`[排查] Electron 日志：${LOG_FILE}`)
  process.exitCode = 1
})
