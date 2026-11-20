import { useEffect, type RefObject } from 'react'

/** 容器内可聚焦元素的匹配式 */
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

/**
 * 把键盘焦点限制在弹窗内，并在关闭时把焦点还给打开它的元素。
 * 没有焦点陷阱时，用户按 Tab 会跑到弹窗背后的界面上，键盘操作等于失控。
 * @param containerRef 弹窗容器引用
 * @param onEscape 按下 Esc 时的回调，通常用于取消并关闭
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  onEscape: () => void
): void {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    // 记录打开弹窗前的焦点，关闭后归还
    const previous = document.activeElement as HTMLElement | null

    /**
     * 处理弹窗内的按键：Esc 关闭，Tab 在首尾之间循环。
     * @param event 键盘事件
     */
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onEscape()
        return
      }
      if (event.key !== 'Tab') return

      const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const current = document.activeElement
      // 焦点跑到弹窗之外（或被浏览器移到地址栏）时拉回弹窗内
      if (!container.contains(current)) {
        event.preventDefault()
        first.focus()
        return
      }
      if (event.shiftKey && current === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && current === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      previous?.focus?.()
    }
  }, [containerRef, onEscape])
}
