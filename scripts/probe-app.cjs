/**
 * 应用启动探测脚本。
 *
 * 用途：明确区分「可执行文件启动即崩溃」「启动后持续运行」「压根没能启动」三种情况。
 * 直接双击或经 PowerShell 启动时，这三种情况的表现都是"窗口一闪"或"命令卡住"，难以判断，
 * 这里用 Node 的 spawn 观察退出码与存活状态，把结论说清楚。
 *
 * 用法：node scripts/probe-app.cjs [可执行文件路径] [观察毫秒数]
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const target = process.argv[2] || path.resolve(__dirname, '../dist/win-unpacked/EasySSH.exe')
const lookMs = Number(process.argv[3] || 10000)
/** 目标之后的参数原样传给被测程序，例如 electron.exe 需要把应用目录作为第一个参数 */
const extraArgs = process.argv.slice(4)
const logPath = path.resolve(__dirname, '../probe-app.log')

if (!fs.existsSync(target)) {
  console.error(`[失败] 目标文件不存在：${target}`)
  process.exit(1)
}

/** 用临时目录承接 userData，避免污染真实的用户配置 */
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyssh-probe-'))
const logFd = fs.openSync(logPath, 'w')

const env = { ...process.env }
// 本环境默认注入 ELECTRON_RUN_AS_NODE=1，会让 Electron 退化成纯 Node 运行
delete env.ELECTRON_RUN_AS_NODE
env.EASYSSH_USER_DATA = userDataDir

console.log(`[探测] 目标：${target}`)
console.log(`[探测] 观察时长：${lookMs} ms`)
console.log(`[探测] userData：${userDataDir}`)

const child = spawn(target, extraArgs, { stdio: ['ignore', logFd, logFd], env })

let settled = false

/**
 * 收尾：结束整棵进程树并输出应用自身日志。
 * @param {number} code 脚本退出码
 * @param {string} summary 结论
 */
function finish(code, summary) {
  if (settled) return
  settled = true
  console.log(`[结论] ${summary}`)
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })

  try {
    const output = fs.readFileSync(logPath, 'utf8').trim()
    console.log(`[应用输出]\n${output || '(无任何输出)'}`)
  } catch {
    console.log('[应用输出] (日志文件不可读)')
  }

  // userData 里如果生成了配置文件，说明主进程已经跑到注册 IPC 之后了
  const dataFiles = fs.existsSync(userDataDir) ? fs.readdirSync(userDataDir) : []
  console.log(
    `[userData 产物] ${dataFiles.length ? dataFiles.join('、') : '(空，主进程可能未完成初始化)'}`
  )

  fs.rmSync(userDataDir, { recursive: true, force: true })
  fs.rmSync(logPath, { force: true })
  process.exit(code)
}

child.on('error', (err) => finish(1, `启动失败（spawn error）：${err.message}`))

child.on('exit', (code, signal) => {
  const hex = code === null ? '' : ` (0x${(code >>> 0).toString(16).toUpperCase()})`
  finish(0, `进程已退出：code=${code}${hex} signal=${signal} —— 启动阶段即终止，未保持运行`)
})

setTimeout(() => finish(0, '观察期内进程始终存活 —— 应用启动成功并可正常运行'), lookMs)
