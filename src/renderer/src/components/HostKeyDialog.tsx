import { useRef } from 'react'
import type { HostKeyChangeVO } from '@shared/errors'
import { useFocusTrap } from '../useFocusTrap'

interface Props {
  /** 主机密钥变更详情，含新旧指纹 */
  change: HostKeyChangeVO
  /** 正在写入信任记录 */
  busy: boolean
  /** 用户核对后确认信任新指纹 */
  onTrust(): void
  /** 放弃本次连接 */
  onCancel(): void
}

/**
 * 主机密钥变更确认弹窗。
 * 指纹变化既可能来自服务器重装，也可能是中间人攻击，因此必须让用户核对后再决定，
 * 而不是像过去那样只抛出一句无法处理的错误。
 * @param props 见 Props
 * @returns 弹窗元素
 */
function HostKeyDialog({ change, busy, onTrust, onCancel }: Props): React.JSX.Element {
  /** 弹窗容器：Esc 关闭与 Tab 循环交给焦点陷阱 */
  const dialogRef = useRef<HTMLDivElement>(null)
  /** 遮罩按下/松开标记：只有两次都落在遮罩本身才关闭，避免在弹窗内拖选文字时误关 */
  const pressOnMaskRef = useRef(false)
  const releaseOnMaskRef = useRef(false)

  useFocusTrap(dialogRef, onCancel)

  return (
    <div
      className="modal-mask"
      onMouseDown={(event) => {
        pressOnMaskRef.current = event.target === event.currentTarget
      }}
      onMouseUp={(event) => {
        releaseOnMaskRef.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        const clickedMask =
          pressOnMaskRef.current && releaseOnMaskRef.current && event.target === event.currentTarget
        pressOnMaskRef.current = false
        releaseOnMaskRef.current = false
        if (clickedMask) onCancel()
      }}
    >
      <div
        className="modal modal-wide"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-key-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <h2 className="modal-title" id="host-key-title">
            主机密钥已变更
          </h2>
        </div>

        <div className="modal-body">
          <p className="modal-note">
            {change.host}:{change.port} 本次返回的主机密钥与本机记录不一致。
            服务器重装、更换密钥都会这样，但也可能是中间人攻击。请先与服务器管理员核对下面
            的新指纹，确认无误后再继续。
          </p>

          <div className="fp-table">
            <div className="fp-row">
              <span className="fp-label">本机已记录的指纹</span>
              <span className="fp-value old">{change.oldFingerprint}</span>
            </div>
            <div className="fp-row">
              <span className="fp-label">本次连接收到的指纹</span>
              <span className="fp-value new">{change.newFingerprint}</span>
            </div>
          </div>
        </div>

        <div className="modal-foot">
          {/* 默认聚焦「取消连接」：安全敏感的弹窗不应让回车直接触发信任 */}
          <button type="button" onClick={onCancel} autoFocus>
            取消连接
          </button>
          <button type="button" className="primary-btn" onClick={onTrust} disabled={busy}>
            {busy ? '处理中…' : '信任新密钥并连接'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default HostKeyDialog
