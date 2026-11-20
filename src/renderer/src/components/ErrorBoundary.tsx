import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  /** 捕获到的错误信息，null 表示渲染正常 */
  message: string | null
}

/**
 * 顶层错误边界。
 * React 在渲染或副作用阶段抛出未捕获异常时会卸载整棵树，用户看到的就是白屏；
 * 这里兜底展示错误原因与「重新加载」按钮，用户能自救，排查时也有线索。
 */
class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null }

  /**
   * 由错误派生兜底状态。
   * @param error 捕获到的错误
   * @returns 新的状态
   */
  static getDerivedStateFromError(error: Error): State {
    return { message: error.message || String(error) }
  }

  /**
   * 记录组件栈，便于定位是哪个组件抛出的。
   * @param error 捕获到的错误
   * @param info React 提供的附加信息
   */
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[界面异常]', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.message === null) return this.props.children
    return (
      <div className="empty-state">
        <p className="empty-title">界面出现异常</p>
        <p className="empty-hint">{this.state.message}</p>
        <button className="primary-btn" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </div>
    )
  }
}

export default ErrorBoundary
