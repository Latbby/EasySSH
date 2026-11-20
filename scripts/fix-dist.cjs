/**
 * 打包后处理：清理 zip 暂存目录并把产物的强制完整性标签重置为 Medium。
 *
 * 背景（线上真实踩到）：工作区目录带可继承的 `Low Mandatory Level` 标签，
 * electron-builder 打 zip 时会在 dist 下生成同名暂存目录 `<name>-<version>-win\`，
 * 其中的文件会继承 Low 标签（afterPack 只重置了 win-unpacked）。而 Windows
 * 「全部解压缩」的默认目标**正好**是与压缩包同名的目录，于是用户解压后拿到的
 * EasySSH.exe 带 Low 标签 —— 双击后 Chromium 沙箱初始化失败，进程以
 * 0x80000003(STATUS_BREAKPOINT) 静默退出，表现为"点了『仍要运行』却毫无反应"。
 *
 * 处理：
 *   1. 删除 dist 下的 zip 暂存目录（分发包只需要 zip 与 win-unpacked），
 *      避免用户解压时落进一个 Low 标签目录；
 *   2. 把 dist 下所有产物的标签重置为 Medium，并逐个校验 exe。
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const DIST = path.resolve(__dirname, '../dist')

/**
 * 读取文件的强制完整性标签。
 * @param target 文件或目录
 * @returns 标签名，例如 `Medium Mandatory Level`；没有标签时返回空串
 */
function integrityLabel(target) {
  try {
    const output = execFileSync('icacls', [target], { encoding: 'utf8' })
    const line = output.split('\n').find((item) => item.includes('Mandatory Label'))
    if (!line) return ''
    const matched = line.match(/Mandatory Label\\([^:]+)/)
    return matched ? matched[1].trim() : ''
  } catch {
    return ''
  }
}

/**
 * 把整棵目录的标签重置为 Medium。
 * @param target 目标目录
 */
function resetLabels(target) {
  execFileSync('icacls', [target, '/setintegritylevel', 'Medium', '/T', '/C'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/** 主流程 */
function main() {
  if (!fs.existsSync(DIST)) {
    console.log('[fix-dist] dist 不存在，跳过')
    return
  }

  // 1. 删除 zip 暂存目录：分发包只保留 zip 与 win-unpacked
  for (const entry of fs.readdirSync(DIST, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'win-unpacked') continue
    if (!/-win$|-mac$|-linux$/.test(entry.name)) continue
    const target = path.join(DIST, entry.name)
    fs.rmSync(target, { recursive: true, force: true })
    console.log(`[fix-dist] 已删除 zip 暂存目录 ${entry.name}`)
  }

  // 2. 重置标签（win-unpacked 由 afterPack 处理过，这里再兜一次，覆盖 zip 里的同名残留）
  const appDir = path.join(DIST, 'win-unpacked')
  if (fs.existsSync(appDir)) {
    resetLabels(appDir)
    console.log('[fix-dist] 已把 dist/win-unpacked 的完整性标签重置为 Medium')
  }
  for (const file of fs.readdirSync(DIST)) {
    if (!file.endsWith('.zip')) continue
    try {
      execFileSync('icacls', [path.join(DIST, file), '/setintegritylevel', 'Medium'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      // zip 标签不影响解压结果，失败不阻断
    }
  }

  // 3. 校验：产物里的每个 exe 都不能是 Low
  const bad = []
  if (fs.existsSync(appDir)) {
    for (const file of fs.readdirSync(appDir)) {
      if (!file.toLowerCase().endsWith('.exe')) continue
      const label = integrityLabel(path.join(appDir, file))
      if (label.startsWith('Low')) bad.push(`${file}（${label}）`)
    }
  }
  if (bad.length > 0) {
    console.error(`[fix-dist] 以下产物仍是 Low 标签，双击会静默退出：${bad.join('、')}`)
    process.exitCode = 1
    return
  }
  console.log('[fix-dist] 校验通过：dist/win-unpacked 下的 exe 均为 Medium 或未设标签')
}

main()
