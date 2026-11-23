/**
 * 按键注入语义探针（开发辅助，不参与 npm run verify）。
 *
 * 用途：回答「用 CDP 模拟真实键盘时该怎么发事件」这一个问题，避免 e2e 用错口径后误判产品缺陷。
 * 做法：起一个隐藏的 Electron 窗口，页面里加载仓库自带的 @xterm/xterm（UMD 构建），
 * 挂一个终端实例并把 onData 收到的字节暴露到 window.__data；
 * 然后通过 CDP 分别用三种口径注入按键，打印 xterm 实际收到的字节：
 *   A. keyDown（带 text）+ keyUp      —— 与 Puppeteer keyboard.press 一致
 *   B. keyDown（带 text）+ char + keyUp —— 另一种常见写法
 *   C. Input.insertText               —— 等价输入法上屏
 *
 * 本机实测（Electron 38 / Chromium 140）结论：
 *   A 每个键只产生 1 个字节（含空格、大写、回车），B 会产生 2 个字节（xterm 的 keydown 与
 *   keypress 各发一次），因此 e2e 的「终端真实键盘输入」用例采用 A 口径；C 用于中文上屏。
 *
 * 用法：
 *   node scripts/probe-key-input.cjs
 *   # 工作区被 Windows 沙箱打标时，node_modules 里的 electron.exe 起不来，可指向 %TEMP% 副本：
 *   $env:E2E_ELECTRON_BIN="$env:TEMP\e2e-electron-dist\electron.exe"; node scripts/probe-key-input.cjs
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

/** 调试端口：与 e2e（9333）、ui-shot（9455）错开，便于并发排查 */
const CDP_PORT = 9466
/** xterm UMD 构建，页面直接以 file:// 引用，保证探针测的是产品同款版本 */
const XTERM_LIB = path.resolve(__dirname, '../node_modules/@xterm/xterm/lib/xterm.js')
const XTERM_CSS = path.resolve(__dirname, '../node_modules/@xterm/xterm/css/xterm.css')

/**
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 生成探针页面与主进程脚本，写入临时目录。
 * @returns {{main: string, workDir: string}} 主进程脚本路径与临时目录
 */
function writeProbeApp() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyssh-key-probe-'))
  const htmlPath = path.join(workDir, 'probe.html')
  fs.writeFileSync(
    htmlPath,
    `<!doctype html><html><head><meta charset="utf-8" />
<link rel="stylesheet" href="file:///${XTERM_CSS.replace(/\\/g, '/')}" />
<style>body{margin:0}#t{width:800px;height:300px}</style>
<script src="file:///${XTERM_LIB.replace(/\\/g, '/')}"></script></head>
<body><div id="t"></div><script>
window.__data = '';
const term = new window.Terminal({ fontSize: 14, scrollback: 1000 });
term.open(document.getElementById('t'));
term.onData((data) => { window.__data += data; });
</script></body></html>`,
    'utf8'
  )
  const mainPath = path.join(workDir, 'main.js')
  fs.writeFileSync(
    mainPath,
    `const { app, BrowserWindow } = require('electron')
const path = require('path')
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 900, height: 400, show: false })
  win.loadFile(path.join(__dirname, 'probe.html'))
})
`,
    'utf8'
  )
  return { main: mainPath, workDir }
}

/**
 * 等待 Electron 调试端点就绪。
 * @param {number} timeout 超时毫秒数
 * @returns {Promise<string>} 页面 WebSocket 地址
 */
async function waitForPage(timeout = 30000) {
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
    await sleep(200)
  }
  throw new Error('等待 Electron 调试端点超时')
}

/**
 * 极简 CDP 客户端（只用到 Runtime.evaluate 与 Input.*）。
 * @param {string} wsUrl 页面 WebSocket 地址
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
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  return {
    send,
    /**
     * 在页面里执行表达式并取回结果。
     * @param {string} expression 表达式
     * @returns {Promise<any>} 结果
     */
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      })
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
      }
      return result.result.value
    },
    close: () => socket.close()
  }
}

/** 探针使用的按键描述，取自 e2e 里的键盘用例 */
const KEYS = {
  e: { key: 'e', code: 'KeyE', vk: 69, text: 'e' },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  upper: { key: 'Z', code: 'KeyZ', vk: 90, text: 'Z', modifiers: 8 },
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' }
}

/**
 * 按指定口径注入一个按键。
 * @param {object} cdp CDP 客户端
 * @param {object} spec 按键描述
 * @param {boolean} withChar 是否额外补一个 char 事件
 */
async function pressKey(cdp, spec, withChar) {
  const base = {
    modifiers: spec.modifiers || 0,
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk
  }
  await cdp.send('Input.dispatchKeyEvent', {
    ...base,
    type: 'keyDown',
    text: spec.text,
    unmodifiedText: spec.text
  })
  if (withChar) {
    await cdp.send('Input.dispatchKeyEvent', {
      ...base,
      type: 'char',
      text: spec.text,
      unmodifiedText: spec.text
    })
  }
  await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
}

async function main() {
  if (!fs.existsSync(XTERM_LIB)) {
    throw new Error(`找不到 xterm 构建：${XTERM_LIB}（请先 npm install）`)
  }
  const { main: mainPath, workDir } = writeProbeApp()
  const electron = process.env.E2E_ELECTRON_BIN || require('electron')
  const env = { ...process.env }
  // 本环境默认注入 ELECTRON_RUN_AS_NODE=1，会让 Electron 退化成纯 Node
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [mainPath, `--remote-debugging-port=${CDP_PORT}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env
  })

  let cdp = null
  const results = []
  try {
    cdp = await connectCdp(await waitForPage())
    await cdp.send('Page.bringToFront')
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await sleep(800)
    const focused = await cdp.evaluate(`(() => {
      const textarea = document.querySelector('.xterm-helper-textarea')
      if (textarea) textarea.focus()
      return document.activeElement === textarea
    })()`)
    if (!focused) throw new Error('xterm 输入区未能获得焦点')

    /**
     * 跑一轮「注入 → 读取 xterm 收到的字节」。
     * @param {string} label 口径描述
     * @param {string[]} names 按键名序列
     * @param {boolean} withChar 是否补 char 事件
     * @returns {Promise<string>} xterm 收到的字节
     */
    const runCase = async (label, names, withChar) => {
      await cdp.evaluate(`window.__data = ''; true`)
      for (const name of names) await pressKey(cdp, KEYS[name], withChar)
      const data = await cdp.evaluate('window.__data')
      results.push({ label, withChar, data })
      console.log(`[探针] ${label} → xterm 收到 ${JSON.stringify(data)}`)
      return data
    }

    const a = await runCase('A keyDown(text)+keyUp：e / 空格 / Shift+Z / 回车', ['e', 'space', 'upper', 'enter'], false)
    const b = await runCase('B keyDown(text)+char+keyUp：同样四个键', ['e', 'space', 'upper', 'enter'], true)
    await cdp.evaluate(`window.__data = ''; true`)
    await cdp.send('Input.insertText', { text: '中文上屏' })
    await sleep(200)
    const c = await cdp.evaluate('window.__data')
    results.push({ label: 'C Input.insertText：中文上屏', withChar: false, data: c })
    console.log(`[探针] C Input.insertText → xterm 收到 ${JSON.stringify(c)}`)

    // 结论断言：A 口径不重复、不丢字符；B 口径会重复（因此 e2e 不能补 char）
    const checks = [
      [a === 'e Z\r', `A 口径逐字节正确（期望 "e Z\\r"，实际 ${JSON.stringify(a)}）`],
      [
        b.length === a.length * 2,
        `B 口径每个字符被发了两遍（期望长度 ${a.length * 2}，实际 ${b.length}，实际内容 ${JSON.stringify(b)}）`
      ],
      [c === '中文上屏', `C 口径中文原样上屏（实际 ${JSON.stringify(c)}）`]
    ]
    for (const [ok, message] of checks) {
      if (!ok) throw new Error(`探针结论不符：${message}`)
      console.log(`[通过] ${message}`)
    }
    console.log('\n[结论] 真实按键注入用 keyDown(text)+keyUp；额外补 char 会让 xterm 重复发送字符。')
  } finally {
    if (cdp) cdp.close()
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(`\n[失败] ${err.message}`)
  process.exitCode = 1
})
