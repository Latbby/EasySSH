import { app, shell, BrowserWindow } from 'electron'
import { appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers, type IpcHandle } from './ipc'

/**
 * 启动日志文件，放在系统临时目录。
 * GUI 应用没有控制台，启动期异常只会表现为"双击没反应"，因此关键节点与异常都要落盘，
 * 用户取回这个文件即可定位问题。
 */
const startupLogFile = join(tmpdir(), 'ssh-client-startup.log')

/**
 * 追加一条启动日志，写入失败绝不影响应用启动。
 * @param message 日志内容
 */
function log(message: string): void {
  try {
    appendFileSync(startupLogFile, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {
    // 忽略写入失败
  }
}

log(`=== 主进程开始执行 pid=${process.pid} ===`)
log(`exe=${process.execPath}`)
log(`electron=${process.versions.electron} node=${process.versions.node} packaged=${app.isPackaged}`)

// 未捕获异常必须落盘，否则用户只会看到窗口一闪而过或完全没有反应
process.on('uncaughtException', (error) => {
  log(`[未捕获异常] ${error?.stack || String(error)}`)
})
process.on('unhandledRejection', (reason) => {
  log(`[未处理的 Promise 拒绝] ${reason instanceof Error ? reason.stack : String(reason)}`)
})

// 允许通过环境变量覆盖数据目录，便于自动化测试与便携部署，必须在 app ready 之前设置
if (process.env.SSH_CLIENT_USER_DATA) {
  app.setPath('userData', process.env.SSH_CLIENT_USER_DATA)
}

/** IPC 句柄，应用退出时用它释放全部 SSH 连接 */
let ipcHandle: IpcHandle | undefined

function createWindow(): void {
  log('开始创建窗口')
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
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
