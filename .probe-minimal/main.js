// 用于对照实验的最小 Electron 应用：只开一个窗口，不含任何项目代码。
// 如果它也无法启动，说明问题在 Electron 运行时或系统环境，而不是我们的代码。
const { app, BrowserWindow } = require('electron')

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 480, height: 320 })
  win.loadURL('data:text/html,<h1>minimal ok</h1>')
})
