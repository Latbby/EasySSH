import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

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
 * 单个终端标签的渲染容器。
 * 组件挂载时创建 xterm 实例，标签切换通过显隐而非卸载完成，避免丢失回滚缓冲。
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

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      scrollback: 5000,
      // 显式给出含中日韩等宽字体的字体栈，否则中文、制表符与表格会对不齐
      fontFamily:
        '"Cascadia Mono", "JetBrains Mono", Consolas, Menlo, "Microsoft YaHei Mono", "Noto Sans Mono CJK SC", monospace',
      theme: {
        background: '#1b1d23',
        foreground: '#d7dae0',
        cursor: '#7aa2f7',
        selectionBackground: '#3b4261'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(host)

    termRef.current = term
    fitRef.current = fit

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
  }, [sessionId, registerWriter, unregisterWriter])

  // 仅在激活状态下监听尺寸变化：隐藏容器的尺寸为 0，此时校准会得到非法行列数
  useEffect(() => {
    const host = hostRef.current
    const term = termRef.current
    const fit = fitRef.current
    if (!active || !host || !term || !fit) return

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

  // 会话断开时补一行提示，便于区分主动退出与异常断开
  useEffect(() => {
    if (!exitReason) return
    termRef.current?.write(`\r\n\x1b[33m[${exitReason}]\x1b[0m\r\n`)
  }, [exitReason])

  return <div className={active ? 'terminal-host' : 'terminal-host hidden'} ref={hostRef} />
}

export default TerminalView
