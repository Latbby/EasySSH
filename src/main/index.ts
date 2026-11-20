import { app, shell, BrowserWindow } from 'electron'
import { appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers, type IpcHandle } from './ipc'

/**
 * 关于强制完整性标签与"双击没反应"的说明。
 *
 * Windows 按文件标签继承强制完整性级别。若打包目录带 `Low Mandatory Level` 标签
 * （例如在被 Windows 沙箱打标过的工作区里构建——沙箱以受限令牌 + Low 完整性派生进程，
 * 它在工作区里新建的文件会继承这个可继承的 Low 标签），ssh-client.exe 也会带上该标签：
 * 此时即使只是普通双击，Windows 也会把进程降到 Low 完整性级别。Low IL 进程无法为 Chromium
 * 的沙箱子进程在 %TEMP%、%APPDATA% 这类 Medium 目录上配置 ACL，浏览器进程会在本文件执行
 * 之前以 0x80000003(STATUS_BREAKPOINT) 退出，表现为双击毫无反应，且没有窗口、没有日志、
 * 没有崩溃转储。
 *
 * 修复：打包结束后把整棵产物的标签重置为 Medium，已由 electron-builder 的 afterPack 钩子
 * (scripts/after-pack.cjs) 自动完成，重置失败会让构建直接报错。
 *
 * 注意：`app.commandLine.appendSwitch('no-sandbox')` 实测**无效** —— 该开关作用于本文件
 * 执行之前的沙箱初始化阶段，只能通过真实命令行参数传入。start.bat / start.lnk 因此保留
 * --no-sandbox 作为兜底启动方式，但标签正常时直接双击 exe 即可运行。
 */

// 允许通过环境变量覆盖数据目录，便于自动化测试与便携部署，必须在 app ready 之前设置
if (process.env.SSH_CLIENT_USER_DATA) {
  app.setPath('userData', process.env.SSH_CLIENT_USER_DATA)
}

/** 选定并缓存的日志文件路径 */
let logFile: string | undefined

/**
 * 依次尝试可写的日志位置并缓存第一个成功的。
 * GUI 应用没有控制台，启动期异常只会表现为"双击没反应"，因此日志必须落到能取回的地方。
 * @returns 可写的日志文件路径，全部不可写时返回 undefined
 */
function resolveLogFile(): string | undefined {
  if (logFile) return logFile
  const candidates = [
    join(tmpdir(), 'ssh-client-startup.log'),
    join(app.getPath('userData'), 'startup.log'),
    join(dirname(process.execPath), 'ssh-client-startup.log')
  ]
  for (const candidate of candidates) {
    try {
      appendFileSync(candidate, '', 'utf8')
      logFile = candidate
      return candidate
    } catch {
      // 该位置不可写，继续尝试下一个
    }
  }
  return undefined
}

/**
 * 追加一条启动日志，写入失败绝不影响应用启动。
 * @param message 日志内容
 */
function log(message: string): void {
  const target = resolveLogFile()
  if (!target) return
  try {
    appendFileSync(target, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {
    // 忽略写入失败
  }
}

log(`=== 主进程开始执行 pid=${process.pid} ===`)
log(`exe=${process.execPath}`)
log(
  `electron=${process.versions.electron} node=${process.versions.node} packaged=${app.isPackaged}`
)
log(
  `兼容模式=${process.env.SSH_CLIENT_NO_COMPAT === '1' ? '已关闭' : '开启'} 日志=${resolveLogFile()}`
)

// 未捕获异常必须落盘，否则用户只会看到窗口一闪而过或完全没有反应
process.on('uncaughtException', (error) => {
  log(`[未捕获异常] ${error?.stack || String(error)}`)
})
process.on('unhandledRejection', (reason) => {
  log(`[未处理的 Promise 拒绝] ${reason instanceof Error ? reason.stack : String(reason)}`)
})

/** IPC 句柄，应用退出时用它释放全部 SSH 连接 */
let ipcHandle: IpcHandle | undefined

function createWindow(): void {
  log('开始创建窗口')
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 780,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    // 与界面底色一致，避免窗口出现到首帧渲染之间闪一下白底
    backgroundColor: '#0e1015',
    title: 'SSH 客户端',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    log('ready-to-show 已触发，显示窗口')
    mainWindow.show()
  })

  // 兜底：渲染进程若迟迟完不成首帧，窗口会一直保持隐藏，用户看到的就是"双击没反应"
  setTimeout(() => {
    if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      log('等待 ready-to-show 超时，强制显示窗口')
      mainWindow.show()
    }
  }, 5000)

  // 渲染进程的加载失败与控制台输出都要记录，否则只能看到白屏
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    log(`[渲染进程加载失败] code=${code} desc=${description} url=${url}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`[渲染进程退出] ${JSON.stringify(details)}`)
  })
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    log(`[渲染进程控制台 level=${level}] ${message}`)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const url = process.env['ELECTRON_RENDERER_URL']
    log(`开发模式，加载 ${url}`)
    mainWindow.loadURL(url).catch((err) => log(`[加载页面失败] ${err}`))
  } else {
    const page = join(__dirname, '../renderer/index.html')
    log(`生产模式，加载 ${page}`)
    mainWindow.loadFile(page).catch((err) => log(`[加载页面失败] ${err}`))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  log('app ready')

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 注册连接管理、终端与 SFTP 相关 IPC，退出时统一释放底层连接
  try {
    ipcHandle = registerIpcHandlers()
    log('IPC 注册完成')
  } catch (error) {
    log(`[IPC 注册失败] ${error instanceof Error ? error.stack : String(error)}`)
    throw error
  }

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  log('全部窗口已关闭')
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 退出前关闭所有 SSH 连接，避免远端残留会话
app.on('before-quit', () => {
  log('应用即将退出')
  ipcHandle?.dispose()
})
