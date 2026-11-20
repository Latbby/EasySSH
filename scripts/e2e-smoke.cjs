/**
 * 端到端冒烟测试：真实 Electron 进程 + 真实 IPC + 真实 safeStorage + 真实 SSH 会话。
 *
 * 与 verify-ssh.cjs 的区别：那个只验证 ssh2 的调用姿势，本脚本验证整条产品链路——
 *   1. 渲染进程能正常挂载（React 已渲染、无 CSP/JS 报错）
 *   2. connections.save 走通 IPC，落盘后密码必须是密文，列表中不得回传凭据
 *   3. terminal.open 能建立真实会话并收到远端输出（用内置 ssh2 测试服务充当目标机）
 *   4. 中文经「远端 → SSH → 主进程 → IPC → xterm」整条链路无乱码
 *   5. resize 不会抛错
 *   6. 快速连接：输入框回车能真实连上目标并出现新标签
 *   7. 终端搜索：Ctrl+F 展开搜索栏，关键词命中计数随输入变化
 *   8. SFTP 路径栏：打开面板后可编辑跳转目录
 *   9. Toast：失败操作出现带分级类名的提示，点击可关闭
 *  10. 主机密钥变更：换掉服务端密钥后弹窗展示真实新旧指纹，确认信任后重连成功
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

const PROJECT_ROOT = path.resolve(__dirname, '..')
const SSH_PORT = 2222
const CDP_PORT = 9333
const LOG_FILE = path.join(PROJECT_ROOT, 'e2e-electron.log')
/** 假想目标机的 home 目录，与内存文件系统保持一致 */
const FAKE_HOME = '/home'

/** 使用临时 userData 目录，避免污染真实用户配置 */
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-client-e2e-'))

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
  }
}
true;
`

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
  const hostKeyA = utils.generateKeyPairSync('ed25519').private
  const fingerprintA = fingerprintOf(hostKeyA)
  let server = await startTestServer(hostKeyA)
  console.log(`[信息] 测试 SSH 服务已启动 127.0.0.1:${SSH_PORT}（主机密钥 A 指纹 ${fingerprintA}）`)

  // 优先用打包产物验证：它最接近用户双击运行的真实形态
  const packagedExe = path.join(PROJECT_ROOT, 'dist', 'win-unpacked', 'ssh-client.exe')
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
  const env = { ...process.env, SSH_CLIENT_USER_DATA: USER_DATA_DIR }
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

    // 2. 保存连接，验证 IPC + 加密落盘
    const saved = await cdp.evaluate(`
      window.api.connections.save({
        name: 'E2E 测试机',
        host: '127.0.0.1',
        port: ${SSH_PORT},
        username: 'tester',
        authType: 'password',
        password: 's3cret-pw'
      })
    `)
    if (!saved?.id) throw new Error('保存连接未返回 id')
    pass(`连接保存成功（id=${saved.id.slice(0, 8)}…）`)

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
    // 7. 快速连接：写入地址回车，应真实连上测试服务并出现新标签
    // -----------------------------------------------------------------------
    const quickAddress = `127.0.0.1:${SSH_PORT}`
    const sessionsBefore = await cdp.evaluate(`window.__e2e.sessions.length`)
    await cdp.evaluate(
      `window.__e2eUI.setValue('.quick-connect input', ${JSON.stringify(quickAddress)})`
    )
    const quickInputValue = await cdp.evaluate(
      `document.querySelector('.quick-connect input').value`
    )
    if (quickInputValue !== quickAddress) {
      throw new Error(`快速连接输入框未被驱动，期望 ${quickAddress}，实际 ${quickInputValue}`)
    }
    pass('快速连接输入框可写入地址（React 受控输入被正确驱动）')

    await cdp.evaluate(`window.__e2eUI.pressEnter('.quick-connect input')`)
    await waitForCondition(
      cdp,
      `window.__e2eUI.tabs().some((title) => title.includes('@127.0.0.1'))`,
      '快速连接回车后出现新终端标签'
    )
    const quickTitle = await cdp.evaluate(
      `window.__e2eUI.tabs().find((title) => title.includes('@127.0.0.1'))`
    )
    console.log(`[信息] 快速连接标签标题：${quickTitle}`)

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
      throw new Error(`快速连接后终端未显示远端欢迎语（首屏输出丢失）：现场=${state}`)
    }
    pass('快速连接的终端显示远端欢迎语（首屏输出未丢失）')

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

    const quickEchoMarker = 'E2E-QUICK-ECHO-OK'
    await cdp.evaluate(
      `window.api.terminal.write(${JSON.stringify(activeSessionId)}, ${JSON.stringify(
        `echo ${quickEchoMarker}\n`
      )}), true`
    )
    await waitForCondition(
      cdp,
      `window.__e2eUI.screenText().includes('${quickEchoMarker}')`,
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
    // -----------------------------------------------------------------------
    const deadPort = 59998
    // 先点掉可能残留的成功提示，避免把旧提示当成本次失败的提示
    await cdp.evaluate(`(() => {
      const el = document.querySelector('.toast')
      if (el) el.click()
      return true
    })()`)
    await waitFor(cdp, `!document.querySelector('.toast')`, 3000)
    await cdp.evaluate(
      `window.__e2eUI.setValue('.quick-connect input', ${JSON.stringify(`127.0.0.1:${deadPort}`)})`
    )
    await cdp.evaluate(`window.__e2eUI.pressEnter('.quick-connect input')`)
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

    const hostKeyB = utils.generateKeyPairSync('ed25519').private
    const fingerprintB = fingerprintOf(hostKeyB)
    await closeServer(server)
    server = await startTestServer(hostKeyB)
    console.log(`[信息] 测试 SSH 服务已更换主机密钥并重启（指纹 B ${fingerprintB}）`)

    // 用与前面不同的用户名，保证底层连接复用键不同、必须重新握手
    const hostKeyAddress = `e2e-hk@127.0.0.1:${SSH_PORT}`
    const hkSessionsBefore = await cdp.evaluate(`window.__e2e.sessions.length`)
    await cdp.evaluate(
      `window.__e2eUI.setValue('.quick-connect input', ${JSON.stringify(hostKeyAddress)})`
    )
    await cdp.evaluate(`window.__e2eUI.pressEnter('.quick-connect input')`)
    await waitForCondition(
      cdp,
      `document.querySelector('.modal-title')?.textContent === '主机密钥已变更'`,
      '主机密钥变更后弹出确认弹窗'
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
    const offlineAddress = `e2e-hk-offline@127.0.0.1:${SSH_PORT}`
    await cdp.evaluate(
      `window.__e2eUI.setValue('.quick-connect input', ${JSON.stringify(offlineAddress)})`
    )
    await cdp.evaluate(`window.__e2eUI.pressEnter('.quick-connect input')`)
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
    await cdp.evaluate(
      `window.__e2eUI.setValue('.quick-connect input', ${JSON.stringify(hostKeyAddress)})`
    )
    await cdp.evaluate(`window.__e2eUI.pressEnter('.quick-connect input')`)
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
      `window.__e2eUI.tabs().some((title) => title.includes('e2e-hk@127.0.0.1'))`,
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
    // 12.1 窗口标题跟随当前标签
    if (!(await waitFor(cdp, `document.title === 'e2e-hk@127.0.0.1 · SSH 客户端'`, 5000))) {
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
    if (!menuText.includes('复制') || !menuText.includes('查找') || !menuText.includes('清屏')) {
      throw new Error(`右键菜单项不完整：${menuText}`)
    }
    pass(`右键菜单项完整（${menuText}）`)
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
      `window.localStorage.getItem('ssh-client:font-size') === '15'`,
      'Ctrl+= 放大字号并持久化为 15'
    )
    await cdp.dispatchKey({ key: '0', code: 'Digit0', windowsVirtualKeyCode: 48, modifiers: 2 })
    await waitForCondition(
      cdp,
      `window.localStorage.getItem('ssh-client:font-size') === '14'`,
      'Ctrl+0 把字号复位为默认值 14'
    )

    // -----------------------------------------------------------------------
    // 13. 终端搜索：Ctrl+F 展开搜索栏，命中计数随关键词变化
    // 放在最后执行：搜索栏一旦因产品缺陷不可用，不会挡住前面的用例取证
    // -----------------------------------------------------------------------
    const searchMarker = 'E2E-SEARCH-MARKER-2026'
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
