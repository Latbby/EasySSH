import { useEffect, useLayoutEffect, useRef, useState } from 'react'

interface Props {
  /** 右键位置（视口坐标），超出窗口时会贴边收拢 */
  x: number
  y: number
  /** 当前是否有选中内容，无选中时“复制”置灰 */
  canCopy: boolean
  /** 复制选中内容 */
  onCopy(): void
  /** 粘贴剪贴板内容 */
  onPaste(): void
  /** 全选终端内容 */
  onSelectAll(): void
  /** 打开搜索栏 */
  onFind(): void
  /** 清屏 */
  onClear(): void
  /** 关闭菜单 */
  onClose(): void
}

/**
 * 终端右键菜单。
 * 菜单本身只负责渲染与关闭时机（点击外部、Esc、滚动），
 * 关闭时机都由本组件监听，动作由上层执行。
 * @param props 见 Props
 * @returns 菜单元素
 */
function TerminalContextMenu({
  x,
  y,
  canCopy,
  onCopy,
  onPaste,
  onSelectAll,
  onFind,
  onClear,
  onClose
}: Props): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // 首帧绘制前量出真实尺寸并贴边收拢，避免菜单在窗口右下角被截断
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const { width, height } = menu.getBoundingClientRect()
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - height - 4))
    })
  }, [x, y])

  // 点击外部、Esc、滚动都关闭菜单；scroll 不冒泡，需要捕获阶段监听才能收到容器内滚动
  useEffect(() => {
    const handleMouseDown = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // 菜单是当前最上层交互：Esc 只用于关闭菜单，同时阻止把 ESC 发给远端
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('mousedown', handleMouseDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('scroll', onClose, true)
    window.addEventListener('wheel', onClose, true)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('scroll', onClose, true)
      window.removeEventListener('wheel', onClose, true)
    }
  }, [onClose])

  /**
   * 菜单项点击统一收口：先关菜单再执行动作，避免菜单残留遮挡终端。
   * @param action 菜单项动作
   * @returns 点击处理函数
   */
  const pick = (action: () => void) => (): void => {
    onClose()
    action()
  }

  return (
    <div className="ctx-menu" ref={menuRef} style={{ left: pos.x, top: pos.y }}>
      <button className="ctx-menu-item" disabled={!canCopy} onClick={pick(onCopy)}>
        复制
        <span className="ctx-menu-shortcut">Ctrl+Shift+C</span>
      </button>
      <button className="ctx-menu-item" onClick={pick(onPaste)}>
        粘贴
        <span className="ctx-menu-shortcut">Ctrl+Shift+V</span>
      </button>
      <div className="ctx-menu-sep" />
      <button className="ctx-menu-item" onClick={pick(onSelectAll)}>
        全选
      </button>
      <button className="ctx-menu-item" onClick={pick(onFind)}>
        查找
        <span className="ctx-menu-shortcut">Ctrl+F</span>
      </button>
      <button className="ctx-menu-item" onClick={pick(onClear)}>
        清屏
      </button>
    </div>
  )
}

export default TerminalContextMenu
