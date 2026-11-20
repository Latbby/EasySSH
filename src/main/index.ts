import { app, shell, BrowserWindow, Menu, safeStorage } from 'electron'
import { appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers, type IpcHandle } from './ipc'
import { migrateLegacyUserData, repairLegacyCredentialKey } from './migrate'

/**
 * 关于强制完整性标签与"双击没反应"的说明。
 *
 * Windows 按文件标签继承强制完整性级别。若打包目录带 `Low Mandatory Level` 标签
 * （例如在被 Windows 沙箱打标过的工作区里构建——沙箱以受限令牌 + Low 完整性派生进程，
 * 它在工作区里新建的文件会继承这个可继承的 Low 标签），EasySSH.exe 也会带上该标签：
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
if (process.env.EASYSSH_USER_DATA) {
  app.setPath('userData', process.env.EASYSSH_USER_DATA)
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
    join(tmpdir(), 'easyssh-startup.log'),
    join(app.getPath('userData'), 'startup.log'),
    join(dirname(process.execPath), 'easyssh-startup.log')
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
  `兼容模式=${process.env.EASYSSH_NO_COMPAT === '1' ? '已关闭' : '开启'} 日志=${resolveLogFile()}`
)

// 应用更名（ssh-client → EasySSH）会把 userData 目录换掉，首次启动时迁移旧数据。
// 数据目录被环境变量显式指定时（自动化测试 / 便携部署）跳过：那种场景下"当前目录"是临时的，
// 把真实用户数据搬进去会污染测试环境。
if (!process.env.EASYSSH_USER_DATA) {
  const migrated = migrateLegacyUserData({
    appData: app.getPath('appData'),
    userData: app.getPath('userData')
  })
  log(`数据目录迁移：${migrated.join('、') || '(无需迁移)'}`)
}

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
    title: 'EasySSH',
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

  /**
   * 判断一段密文能否用当前主密钥解开，供凭据自检使用。
   * @param secret base64 密文
   * @returns 可解密返回 true
   */
  const canDecryptSecret = (secret: string): boolean => {
    try {
      // 系统不支持加密时不做判断，避免把"环境不支持"误判成"密钥不对"
      if (!safeStorage.isEncryptionAvailable()) return true
      return safeStorage.decryptString(Buffer.from(secret, 'base64')).length > 0
    } catch {
      return false
    }
  }

  // 去掉 Electron 的默认菜单：它自带的 View→Zoom 加速键会把 Ctrl+= / Ctrl+- / Ctrl+滚轮
  // 抢去缩放整个页面（界面发虚、终端字号反而不变），而本应用要的是「只缩放终端字号」。
  // 去掉菜单后这些按键完整交给渲染进程；输入框的复制粘贴由 Chromium 原生处理，不受影响。
  Menu.setApplicationMenu(null)

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // 窗口创建前自检一次凭据主密钥：密文解不开时恢复旧密钥并重启，避免用户看到「密码不回显」。
  // 与迁移同理，数据目录被环境变量指定时不做（否则会把真实主密钥写进测试用的临时目录）。
  if (
    !process.env.EASYSSH_USER_DATA &&
    repairLegacyCredentialKey(
      { appData: app.getPath('appData'), userData: app.getPath('userData') },
      canDecryptSecret
    ) === 'repaired'
  ) {
    log('[凭据密钥修复] 旧版密码密文无法用当前主密钥解密，已恢复旧数据目录的主密钥并重启应用')
    app.relaunch()
    app.exit(0)
    return
  }

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
