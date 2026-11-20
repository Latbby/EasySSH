import type { AppToast } from '../types'

interface Props {
  /** 待展示的提示，kind 决定配色 */
  toast: AppToast
  /** 关闭提示，自动关闭计时器由调用方维护 */
  onClose(): void
}

/**
 * 提示条，点击整条或右侧关闭按钮都可关闭。
 * @param props 见 Props
 * @returns 提示条元素
 */
function Toast({ toast, onClose }: Props): React.JSX.Element {
  return (
    <div className={`toast ${toast.kind}`} onClick={onClose} title="点击关闭">
      <span className="toast-text">{toast.text}</span>
      <button
        type="button"
        className="toast-close"
        onClick={(event) => {
          // 阻止冒泡，否则根元素的点击会再触发一次关闭
          event.stopPropagation()
          onClose()
        }}
      >
        ×
      </button>
    </div>
  )
}

export default Toast
