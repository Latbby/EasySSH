import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import TerminalSearchBar from './TerminalSearchBar'
import TerminalContextMenu from './TerminalContextMenu'
import {
  DEFAULT_FONT_SIZE,
  readFontSize,
  stepFontSize,
  subscribeFontSize,
  writeFontSize
} from '../terminalPrefs'

interface Props {
  sessionId: string
  /** 是否为当前激活标签；非激活时容器隐藏，切回时需要重新校准尺寸 */
  active: boolean
  /** 会话断开提示，有值时追加到终端输出 */
  exitReason?: string
  /** 注册写入函数，由上层把该会话的输出精确投递到这里 */
  registerWriter(sessionId: string, writer: (data: Uint8Array) => void): void
  /** 注销写入函数 */
  unregisterWriter(sessionId: string): void
}

/**
 * 判断是否为 App 级全局快捷键。
 * 这些键位由上层处理：终端拦住它们不让其透传到远端，同时不打断事件冒泡，保证全局监听仍能收到。
 * @param event 键盘事件
 * @returns 属于 App 级快捷键时返回 true
 */
function isAppShortcut(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase()
  // Ctrl+Tab / Ctrl+Shift+Tab：切换标签
  if (event.ctrlKey && event.key === 'Tab') return true
  // Alt+1..9：直达第 n 个标签
  if (event.altKey && /^[1-9]$/.test(event.key)) return true
  // Ctrl+Shift+W：关闭当前标签；Ctrl+N：新建连接
  if (event.ctrlKey && event.shiftKey && key === 'w') return true
  if (event.ctrlKey && !event.shiftKey && key === 'n') return true
  return false
}

/**
 * 单个终端标签的渲染容器。
 * 组件挂载时创建 xterm 实例，标签切换通过显隐而非卸载完成，避免丢失回滚缓冲。
 * 搜索栏、右键菜单与终端内快捷键都在本组件内闭环，不影响 App 级全局快捷键。
 * @param props 见 Props
 * @returns 终端容器元素
 */
function TerminalView({
  sessionId,
  active,
  exitReason,
  registerWriter,
  unregisterWriter
}: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  /** 搜索 addon：与终端实例同生命周期，构造一次后在挂载时加载进终端 */
  const [search] = useState(() => new SearchAddon())
  /** 当前是否为激活标签，供键盘回调读取，避免为此重建 xterm 实例 */
  const activeRef = useRef(active)
  /** 非激活期间收到的字号，等容器可见后再应用 */
  const pendingFontSizeRef = useRef<number | null>(null)
  /** 菜单已展开时再次右键则置位，跳过随后的 contextmenu，实现“再次右键关闭” */
  const skipContextRef = useRef(false)

  /** 搜索栏是否展开 */
  const [searchOpen, setSearchOpen] = useState(false)
  /** 自增用于搜索栏已展开时重新聚焦输入框 */
  const [searchFocusTick, setSearchFocusTick] = useState(0)
  /** 右键菜单位置，null 表示未展开 */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  /** 打开菜单那一刻是否有选中内容，决定“复制”是否可用 */
  const [menuCanCopy, setMenuCanCopy] = useState(false)

  /**
   * 复制选中内容到系统剪贴板，无选中时不动作。
   * @returns 无
   */
  const copySelection = useCallback(async (): Promise<void> => {
    const term = termRef.current
    const selection = term?.getSelection() ?? ''
    if (!selection) return
    try {
      await window.api.system.writeClipboard(selection)
    } catch {
      // 剪贴板写入失败不打断终端交互
    }
    // 确认后把焦点交还终端，便于右键菜单操作后继续输入
    termRef.current?.focus()
  }, [])

  /**
   * 把系统剪贴板内容粘贴到终端，由 xterm 负责转义并发送远端。
   * @returns 无
   */
  const pasteClipboard = useCallback(async (): Promise<void> => {
    try {
      const text = await window.api.system.readClipboard()
      if (text) termRef.current?.paste(text)
    } catch {
      // 剪贴板读取失败时忽略
    }
    // 右键菜单路径下按钮已被移除，这里统一把焦点交还终端
    termRef.current?.focus()
  }, [])

  /**
   * 展开搜索栏并聚焦输入框；已展开时重新聚焦。
   * @returns 无
   */
  const openSearch = useCallback((): void => {
    setSearchOpen(true)
    setSearchFocusTick((tick) => tick + 1)
  }, [])

  /**
   * 关闭搜索栏并把焦点交还终端。
   * @returns 无
   */
  const closeSearch = useCallback((): void => {
    setSearchOpen(false)
    termRef.current?.focus()
  }, [])

  /**
   * 收起右键菜单。
   * @returns 无
   */
  const closeMenu = useCallback((): void => {
    setMenuAt(null)
  }, [])

  /**
   * 全选终端内容。
   * @returns 无
   */
  const selectAll = useCallback((): void => {
    const term = termRef.current
    if (!term) return
    term.selectAll()
    term.focus()
  }, [])

  /**
   * 清屏：只清本地回滚缓冲，不向远端发送清屏指令。
   * @returns 无
   */
  const clearScreen = useCallback((): void => {
    const term = termRef.current
    if (!term) return
    term.clear()
    term.focus()
  }, [])

  /**
   * 应用字号：字号变化后必须重新 fit，并把新的行列数同步给远端 PTY。
   * @param term 终端实例
   * @param fit 尺寸 addon
   * @param size 目标字号
   * @returns 无
   */
  const applyFontSize = useCallback(
    (term: Terminal, fit: FitAddon, size: number): void => {
      term.options.fontSize = size
      try {
        fit.fit()
        window.api.terminal.resize(sessionId, term.cols, term.rows)
      } catch {
        // 容器尚未完成布局时忽略
      }
    },
    [sessionId]
  )

  /**
   * 鼠标按下：中键粘贴；菜单展开时再次右键则先收起菜单。
   * @param event 鼠标事件
   * @returns 无
   */
  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    // 鼠标中键粘贴，兼容 Linux 终端习惯
    if (event.button === 1) {
      event.preventDefault()
      pasteClipboard()
      return
    }
    if (event.button === 2) {
      // 每次右键都重新判定：菜单展开时本次右键只用于关闭，不再弹出新菜单
      skipContextRef.current = menuAt !== null
      if (menuAt) setMenuAt(null)
    }
  }

  /**
   * 右键：拦截浏览器默认菜单与 xterm 的右键选词，改为自定义菜单。
   * @param event 鼠标事件
   * @returns 无
   */
  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    // 本次右键只用于关闭菜单
    if (skipContextRef.current) {
      skipContextRef.current = false
      return
    }
    setMenuCanCopy(termRef.current?.hasSelection() ?? false)
    setMenuAt({ x: event.clientX, y: event.clientY })
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      cursorBlink: true,
      // 搜索高亮与命中计数依赖 decorations，而 decorations 属 proposed API，
      // 不开这个开关，输入关键词时 registerDecoration 会直接抛错并让整棵 React 树崩掉
      allowProposedApi: true,
      // 沿用上次保存的字号
      fontSize: readFontSize(),
      scrollback: 5000,
      // 右键交给自定义菜单，禁止 xterm 的“右键选词”默认行为
      rightClickSelectsWord: false,
      // 显式给出含中日韩等宽字体的字体栈，否则中文、制表符与表格会对不齐
      fontFamily:
        '"Cascadia Mono", "JetBrains Mono", Consolas, Menlo, "Microsoft YaHei Mono", "Noto Sans Mono CJK SC", monospace',
      theme: {
        // 与界面令牌保持同一套色板：终端底色略深于面板底色，形成"屏幕"层次
        background: '#15181f',
        foreground: '#e7eaf0',
        cursor: '#6d9bff',
        cursorAccent: '#15181f',
        selectionBackground: 'rgba(109, 155, 255, 0.3)'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.loadAddon(search)
    term.open(host)

    termRef.current = term
    fitRef.current = fit

    // 终端内快捷键统一在这里拦截：返回 false 阻止 xterm 把按键当普通输入发给远端
    term.attachCustomKeyEventHandler((event) => {
      // 非 keydown 事件（如 keypress）交给 xterm 自行处理
      if (event.type !== 'keydown') return true
      // App 级全局快捷键：拦住远端但不影响 App 全局监听。
      // 返回 false 让 xterm 不再把按键编码发给远端（否则 Ctrl+Shift+W 会变成 ^W、
      // Alt+数字 会变成 ESC+数字）；preventDefault 只取消浏览器默认行为，不中断冒泡，
      // window 上的 App 监听（Ctrl+Tab / Ctrl+Shift+Tab / Alt+1..9 / Ctrl+Shift+W / Ctrl+N）照常触发
      if (isAppShortcut(event)) {
        event.preventDefault()
        return false
      }
      // Ctrl/Shift+Insert 是传统终端的复制粘贴键位，不受 Ctrl+Shift 组合限制
      if (event.key === 'Insert' && (event.ctrlKey || event.shiftKey)) {
        event.preventDefault()
        if (event.shiftKey) pasteClipboard()
        else copySelection()
        return false
      }
      // 其余快捷键都要求 Ctrl，且不与 Alt/Meta 组合
      if (!event.ctrlKey || event.altKey || event.metaKey) return true
      const key = event.key.toLowerCase()
      // Ctrl+F / Ctrl+Shift+F：展开并聚焦搜索栏
      if (key === 'f') {
        event.preventDefault()
        openSearch()
        return false
      }
      // Ctrl+Shift+C：复制选中内容；无选中时不复制，但仍然吞掉按键，避免把 ^C 发给远端
      if (event.shiftKey && key === 'c') {
        event.preventDefault()
        copySelection()
        return false
      }
      // Ctrl+Shift+V：粘贴
      if (event.shiftKey && key === 'v') {
        event.preventDefault()
        pasteClipboard()
        return false
      }
      // Ctrl+= / Ctrl++ 放大，Ctrl+- 缩小，Ctrl+0 复位
      if (event.key === '=' || event.key === '+') {
        event.preventDefault()
        stepFontSize(1)
        return false
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        stepFontSize(-1)
        return false
      }
      if (event.key === '0') {
        event.preventDefault()
        writeFontSize(DEFAULT_FONT_SIZE)
        return false
      }
      return true
    })

    // 键盘输入直送远端
    const inputSub = term.onData((data) => window.api.terminal.write(sessionId, data))
    // 远端输出按会话 id 精确投递，原始字节交给 xterm 自身解码
    registerWriter(sessionId, (data) => term.write(data))

    try {
      fit.fit()
      window.api.terminal.resize(sessionId, term.cols, term.rows)
    } catch {
      // 首次渲染时容器可能尚未完成布局，留待尺寸监听补偿
    }

    return () => {
      unregisterWriter(sessionId)
      inputSub.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [
    sessionId,
    registerWriter,
    unregisterWriter,
    search,
    copySelection,
    pasteClipboard,
    openSearch
  ])

  // 激活状态同步到 ref：键盘回调与字号订阅读取 ref，避免重建 xterm 实例
  useEffect(() => {
    activeRef.current = active
  }, [active])

  // 仅在激活状态下监听尺寸变化：隐藏容器的尺寸为 0，此时校准会得到非法行列数
  useEffect(() => {
    const host = hostRef.current
    const term = termRef.current
    const fit = fitRef.current
    if (!active || !host || !term || !fit) return

    // 非激活期间只记录字号，容器可见后再应用，避免 xterm 在 0 尺寸下测不准字体
    const pending = pendingFontSizeRef.current
    if (pending !== null) {
      pendingFontSizeRef.current = null
      if (term.options.fontSize !== pending) term.options.fontSize = pending
    }

    const sync = (): void => {
      try {
        fit.fit()
        window.api.terminal.resize(sessionId, term.cols, term.rows)
      } catch {
        // 容器尚未完成布局时忽略
      }
    }

    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(host)
    return () => observer.disconnect()
  }, [active, sessionId])

  // 字号变化（本标签或其它标签触发）时重排并同步远端 PTY 行列数
  useEffect(() => {
    const unsubscribe = subscribeFontSize((size) => {
      const term = termRef.current
      const fit = fitRef.current
      if (!term || !fit || term.options.fontSize === size) return
      // 非激活标签容器不可见，xterm 量不出字体尺寸，先记下来等切回时统一应用
      if (!activeRef.current) {
        pendingFontSizeRef.current = size
        return
      }
      applyFontSize(term, fit, size)
    })
    return unsubscribe
  }, [sessionId, applyFontSize])

  // 会话断开时补一行提示，便于区分主动退出与异常断开
  useEffect(() => {
    if (!exitReason) return
    termRef.current?.write(`\r\n\x1b[33m[${exitReason}]\x1b[0m\r\n`)
  }, [exitReason])

  return (
    <div
      className={active ? 'terminal-host' : 'terminal-host hidden'}
      ref={hostRef}
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
    >
      {searchOpen && (
        <TerminalSearchBar search={search} focusTick={searchFocusTick} onClose={closeSearch} />
      )}

      {menuAt && (
        <TerminalContextMenu
          x={menuAt.x}
          y={menuAt.y}
          canCopy={menuCanCopy}
          onCopy={copySelection}
          onPaste={pasteClipboard}
          onSelectAll={selectAll}
          onFind={openSearch}
          onClear={clearScreen}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}

export default TerminalView
