/**
 * 端到端冒烟测试：真实 Electron 进程 + 真实 IPC + 真实 safeStorage + 真实 SSH 会话。
 *
 * 与 verify-ssh.cjs 的区别：那个只验证 ssh2 的调用姿势，本脚本验证整条产品链路——
 *   1. 渲染进程能正常挂载（React 已渲染、无 CSP/JS 报错）
 *   2. connections.save 走通 IPC，落盘后密码必须是密文，列表中不得回传凭据
 *   3. terminal.open 能建立真实会话并收到远端输出（用内置 ssh2 测试服务充当目标机）
 *   4. 中文经「远端 → SSH → 主进程 → IPC → xterm」整条链路无乱码
 *   5. resize 不会抛错
 */
const { Server, Client, utils } = require('ssh2')
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const SSH_PORT = 2222
const CDP_PORT = 9333
const LOG_FILE = path.join(PROJECT_ROOT, 'e2e-electron.log')

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

/** 启动一个本地 SSH 测试服务，充当被测客户端的目标机 */
function startTestServer() {
  const hostKey = utils.generateKeyPairSync('ed25519').private
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
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
      })
    })
  })
  return new Promise((resolve) => server.listen(SSH_PORT, '127.0.0.1', () => resolve(server)))
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
    close: () => socket.close()
  }
}

/**
 * 等待 Electron 的调试端点就绪。
 * @param {number} timeout 超时毫秒数
 * @returns {Promise<string>} 页面 WebSocket 地址
 */
async function waitForPage(timeout = 40000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
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
 * 轮询页面状态直到条件成立。
 * @param {ReturnType<typeof connectCdp>} cdp CDP 客户端
 * @param {string} expression 返回布尔值的表达式
 * @param {string} label 描述
 * @param {number} timeout 超时毫秒数
 */
async function waitForCondition(cdp, expression, label, timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await cdp.evaluate(expression)) {
      pass(label)
      return
    }
    await sleep(200)
  }
  throw new Error(`等待超时：${label}`)
}

async function main() {
  const server = await startTestServer()
  console.log(`[信息] 测试 SSH 服务已启动 127.0.0.1:${SSH_PORT}`)

  // 优先用打包产物验证：它最接近用户双击运行的真实形态
  const packagedExe = path.join(PROJECT_ROOT, 'dist', 'win-unpacked', 'ssh-client.exe')
  const usePackaged = fs.existsSync(packagedExe)
  const command = usePackaged ? packagedExe : require('electron')
  const args = usePackaged
    ? [`--remote-debugging-port=${CDP_PORT}`]
    : ['.', `--remote-debugging-port=${CDP_PORT}`]
  console.log(`[信息] 启动${usePackaged ? '打包产物' : '开发态 Electron'}：${command}`)
  console.log(`[信息] 临时 userData：${USER_DATA_DIR}`)

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
    const wsUrl = await waitForPage()
    cdp = await connectCdp(wsUrl)
    pass('Electron 渲染进程已就绪，调试通道已连通')

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

    const listJson = await cdp.evaluate(`JSON.stringify(await window.api.connections.list())`)
    if (listJson.includes('s3cret-pw')) throw new Error('列表出参泄漏了明文密码')
    if (listJson.includes('secret')) throw new Error('列表出参泄漏了密文字段')
    pass('连接列表出参未泄漏任何凭据字段')

    const rawFile = fs.readFileSync(path.join(USER_DATA_DIR, 'connections.json'), 'utf8')
    if (rawFile.includes('s3cret-pw')) throw new Error('落盘文件包含明文密码')
    if (!rawFile.includes('secret')) throw new Error('落盘文件未包含加密后的凭据字段')
    pass('落盘文件中的密码为密文，明文未落盘')

    // 3. 打开真实 SSH 会话，验证整条终端链路
    await cdp.evaluate(`
      window.__e2e = { data: '', exit: null };
      const decoder = new TextDecoder();
      window.__e2eOffData = window.api.terminal.onData((sid, chunk) => {
        window.__e2e.data += decoder.decode(chunk, { stream: true });
      });
      window.__e2eOffExit = window.api.terminal.onExit((sid, reason) => {
        window.__e2e.exit = reason;
      });
      true;
    `)

    const sessionId = await cdp.evaluate(`
      (await window.api.terminal.open({
        connectionId: ${JSON.stringify(saved.id)},
        cols: 80,
        rows: 24
      })).sessionId
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

    // 7. 页面全程无未捕获异常
    const errors = await cdp.evaluate(`JSON.stringify(window.__e2eErrors)`)
    if (errors !== '[]') throw new Error(`渲染进程出现未捕获异常：${errors}`)
    pass('渲染进程全程无未捕获异常')

    console.log(`\n[结果] 全部通过，共 ${passed} 项`)
  } finally {
    if (cdp) cdp.close()
    // Electron 会派生多个子进程，按进程树强制结束
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    server.close()
    await sleep(500)
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(`\n[失败] ${err.message}`)
  console.error(`[排查] Electron 日志：${LOG_FILE}`)
  process.exitCode = 1
})
