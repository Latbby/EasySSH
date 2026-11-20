import type { HostKeyChangeVO } from '@shared/errors'

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
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <h2 className="modal-title">主机密钥已变更</h2>

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

        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
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
