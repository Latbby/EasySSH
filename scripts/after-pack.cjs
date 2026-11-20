/**
 * electron-builder afterPack 钩子：把打包产物上的强制完整性标签重置为 Medium。
 *
 * 背景：当构建发生在带 `Low Mandatory Level` 强制标签的目录下（例如被 Windows 沙箱
 * 打标的 DSH 工作区），工作区内新建的文件会继承该标签。exe 带 Low 标签时，Windows
 * 创建出的进程会被降到 Low 完整性级别，而 Low IL 进程无法为 Chromium 的沙箱子进程在
 * Medium 目录上配置 ACL，浏览器进程会在主进程 JS 执行之前直接以 0x80000003
 * (STATUS_BREAKPOINT) 退出：表现为双击毫无反应，且没有窗口、没有日志、没有崩溃转储。
 *
 * 该钩子在打包目录组装完成后、生成 zip 之前执行，把 appOutDir 整棵树的完整性标签
 * 重置为 Medium，并校验重置结果，避免把"双击没反应"的产物发出去。
 *
 * 非 Windows 平台直接跳过；未安装 icacls 时跳过并给出提示（此时产物本来也不受该问题影响）。
 */
const { execFileSync } = require('child_process')
const { existsSync, readdirSync } = require('fs')
const { join } = require('path')

/**
 * 读取某个路径的强制完整性标签描述。
 * @param {string} target 目标路径
 * @returns {string} icacls 输出中与 Mandatory Label 相关的行（无标签时为空串）
 */
function readIntegrityLabel(target) {
  const output = execFileSync('icacls', [target], { encoding: 'utf8' })
  return output
    .split(/\r?\n/)
    .filter((line) => line.includes('Mandatory Label'))
    .join(' ')
    .trim()
}

/**
 * afterPack 钩子实现。
 * @param {import('electron-builder').AfterPackContext} context 打包上下文
 * @returns {Promise<void>}
 */
module.exports = async function afterPack(context) {
  // 只有 Windows 需要处理强制完整性标签
  if (context.electronPlatformName !== 'win32') return

  const appOutDir = context.appOutDir
  if (!existsSync(appOutDir)) return

  // icacls 重置整棵产物的标签；/C 表示忽略个别文件错误，/T 表示递归
  execFileSync('icacls', [appOutDir, '/setintegritylevel', 'Medium', '/T', '/C'], {
    stdio: 'pipe'
  })

  // 校验：主进程可执行文件不得残留 Low 标签，否则产物双击必然失败
  const exeName = `${context.packager.appInfo.productFilename}.exe`
  const exePath = join(appOutDir, exeName)
  const label = readIntegrityLabel(existsSync(exePath) ? exePath : appOutDir)
  if (label.includes('Low Mandatory Level')) {
    throw new Error(
      `[after-pack] ${exeName} 仍带 Low 完整性标签，双击启动会被降级为 Low IL 并静默退出：${label}`
    )
  }

  // 产物根目录下的启动器也要一并确认，避免只修了 exe
  const leftovers = readdirSync(appOutDir)
    .filter((name) => name.endsWith('.bat') || name.endsWith('.lnk'))
    .map((name) => `${name}:${readIntegrityLabel(join(appOutDir, name)) || '无标签'}`)
  console.log(`[after-pack] 完整性标签已重置为 Medium，启动器标签：${leftovers.join('、') || '（无）'}`)
}
