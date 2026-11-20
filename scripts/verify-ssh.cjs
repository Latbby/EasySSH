/**
 * SSH 链路验证脚本（不依赖 Electron，可直接用 node 运行）。
 *
 * 目的：本机没有可用的 sshd，因此用 ssh2 自带的 Server 起一个 127.0.0.1:2222 的测试服务，
 * 再按 src/main/ssh.ts 中完全相同的调用方式建立客户端连接，验证以下几件容易写错的事：
 *   1. shell 通道能否正常打开并双向通信
 *   2. 开 shell 时携带的 cols / rows 是否正确送达服务端 PTY
 *   3. setWindow 的参数顺序是否为 (rows, cols, ...)，次序写反会导致远端全屏程序错行
 *   4. UTF-8 多字节字符按原始字节透传后能否完整还原（决定中文是否乱码）
 */
const { Server, Client, utils } = require('ssh2')
const { generateHostKey } = require('./host-key.cjs')

const PORT = 2222
const HOST = '127.0.0.1'

/** 服务端观测到的 PTY 请求与窗口变更信息 */
const observed = { pty: null, windowChange: null }

/** 客户端累计收到的输出 */
let received = ''

let passed = 0

/**
 * 打印一条通过项。
 * @param {string} message 描述
 */
function pass(message) {
  passed += 1
  console.log(`[通过] ${message}`)
}

/**
 * 轮询等待条件成立，用于等待异步到达的数据。
 * @param {() => boolean} predicate 判定函数
 * @param {string} label 描述
 * @param {number} timeout 超时毫秒数
 * @returns {Promise<void>}
 */
function waitFor(predicate, label, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        pass(label)
        resolve()
      } else if (Date.now() - start > timeout) {
        clearInterval(timer)
        reject(new Error(`等待超时：${label}`))
      }
    }, 50)
  })
}

/** 本地测试 SSH 服务，不做凭据校验，只负责回显 */
function startTestServer() {
  const hostKey = generateHostKey()
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      // 测试服务不校验用户名密码，直接接受
      ctx.accept()
    })

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()

        session.on('pty', (acceptPty, _rejectPty, info) => {
          observed.pty = info
          acceptPty()
        })

        session.on('window-change', (acceptChange, _rejectChange, info) => {
          observed.windowChange = info
          if (acceptChange) acceptChange()
        })

        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          stream.write('欢迎使用测试 SSH 服务\r\n')
          stream.on('data', (chunk) => {
            const text = chunk.toString('utf8')
            // 收到中文即回一个明确的成功标记，用于验证多字节字符往返无误
            if (text.includes('中文测试')) {
              stream.write('OK:收到中文\r\n')
              return
            }
            stream.write(text)
          })
        })
      })
    })
  })

  return new Promise((resolve) => {
    server.listen(PORT, HOST, () => resolve(server))
  })
}

async function main() {
  const server = await startTestServer()
  console.log(`[信息] 测试 SSH 服务已启动 ${HOST}:${PORT}`)

  const client = new Client()
  const ready = new Promise((resolve, reject) => {
    client.once('ready', resolve)
    client.once('error', reject)
  })
  // 以下连接参数与 src/main/ssh.ts 的 acquire() 保持一致
  client.connect({
    host: HOST,
    port: PORT,
    username: 'tester',
    password: 'any',
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    hostVerifier: () => true
  })
  await ready
  pass('连接建立与认证成功')

  const stream = await new Promise((resolve, reject) => {
    client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, channel) =>
      err ? reject(err) : resolve(channel)
    )
  })
  pass('shell 通道打开成功')

  stream.on('data', (chunk) => {
    received += chunk.toString('utf8')
  })
  stream.stderr.on('data', (chunk) => {
    received += chunk.toString('utf8')
  })

  await waitFor(() => received.includes('欢迎使用测试 SSH 服务'), '收到服务端欢迎语')

  // 验证 PTY 请求携带的初始尺寸
  await waitFor(() => observed.pty !== null, '收到 PTY 请求')
  if (observed.pty.cols !== 80 || observed.pty.rows !== 24) {
    throw new Error(`PTY 尺寸不符，期望 80x24，实际 ${observed.pty.cols}x${observed.pty.rows}`)
  }
  pass(`PTY 初始尺寸正确（${observed.pty.cols}x${observed.pty.rows}，term=${observed.pty.term}）`)

  // 验证中文往返：客户端发 UTF-8，服务端按 utf8 解码后回标记
  stream.write('echo 中文测试\n')
  await waitFor(() => received.includes('OK:收到中文'), 'UTF-8 中文往返无乱码')

  // 验证窗口尺寸同步，重点确认 setWindow 的参数顺序是 (rows, cols, ...)
  stream.setWindow(40, 120, 0, 0)
  await waitFor(() => observed.windowChange !== null, '窗口变更事件送达服务端')
  if (observed.windowChange.cols !== 120 || observed.windowChange.rows !== 40) {
    throw new Error(
      `setWindow 参数顺序有误，期望 cols=120 rows=40，实际 cols=${observed.windowChange.cols} rows=${observed.windowChange.rows}`
    )
  }
  pass(`窗口尺寸同步正确（cols=${observed.windowChange.cols}, rows=${observed.windowChange.rows}）`)

  stream.close()
  client.end()
  server.close()
  console.log(`\n[结果] 全部通过，共 ${passed} 项`)
}

main().catch((err) => {
  console.error(`\n[失败] ${err.message}`)
  process.exitCode = 1
})
