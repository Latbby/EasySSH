import { useEffect, useState } from 'react'
import type { AuthType, ConnectionVO, SaveConnectionDTO } from '@shared/types'
import { toMessage } from '../utils'

interface Props {
  /** 编辑时传入已有连接，新增时为空 */
  initial?: ConnectionVO
  /** 新增模式：标题显示「新建连接」，提交时不带 id；复制连接会传空 id 的草稿，同样按新增处理 */
  isNew?: boolean
  /** 提交保存，由本组件负责把错误展示在表单内 */
  onSubmit(dto: SaveConnectionDTO): Promise<void>
  /** 取消并关闭表单 */
  onCancel(): void
}

/**
 * 连接配置表单，新增与编辑共用。
 * @param props 见 Props
 * @returns 表单弹窗元素
 */
function ConnectionForm({ initial, isNew, onSubmit, onCancel }: Props): React.JSX.Element {
  // isNew 为真或草稿 id 为空都算新增：复制连接传进来的 draft 就是没有 id 的
  const isCreate = isNew === true || !initial?.id
  // 「清除凭据」只对已保存的连接有意义，新增与复制场景下没有可清除的凭据
  const hasStoredCredential = !isCreate && initial?.hasCredential === true

  const [name, setName] = useState(initial?.name ?? '')
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(String(initial?.port ?? 22))
  const [username, setUsername] = useState(initial?.username ?? '')
  const [authType, setAuthType] = useState<AuthType>(initial?.authType ?? 'password')
  // 密码与口令永不回填，只以"留空即不修改"的语义提交
  const [password, setPassword] = useState('')
  const [privateKeyPath, setPrivateKeyPath] = useState(initial?.privateKeyPath ?? '')
  const [passphrase, setPassphrase] = useState('')
  const [clearCredential, setClearCredential] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Esc 关闭表单：监听挂在 window 上，焦点不在表单内时也能关闭
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  /** 弹出系统文件选择框挑选私钥文件 */
  const pickPrivateKey = async (): Promise<void> => {
    const picked = await window.api.system.pickPrivateKey()
    if (picked) setPrivateKeyPath(picked)
  }

  /**
   * 提交表单。
   * @param event 表单事件
   */
  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()

    const portNumber = Number(port)
    if (!host.trim() || !username.trim()) {
      setError('主机与用户名不能为空')
      return
    }
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      setError('端口必须是 1-65535 之间的整数')
      return
    }

    setBusy(true)
    setError(null)
    try {
      await onSubmit({
        id: isCreate ? undefined : initial?.id,
        name: name.trim() || `${username.trim()}@${host.trim()}`,
        host: host.trim(),
        port: portNumber,
        username: username.trim(),
        authType,
        privateKeyPath: authType === 'privateKey' ? privateKeyPath.trim() || undefined : undefined,
        // 留空的凭据不提交，避免编辑连接时误清空已保存的密码
        // 勾选「清除已保存的凭据」后提交空串即清除语义，密码与私钥口令一并清掉
        password: clearCredential ? '' : authType === 'password' && password ? password : undefined,
        passphrase: clearCredential
          ? ''
          : authType === 'privateKey' && passphrase
            ? passphrase
            : undefined
      })
    } catch (err) {
      setError(toMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-mask" onClick={onCancel}>
      {/* 表单内文本框回车会走浏览器隐式提交，等价于点「保存」 */}
      <form className="modal" onClick={(event) => event.stopPropagation()} onSubmit={handleSubmit}>
        <h2 className="modal-title">{isCreate ? '新建连接' : '编辑连接'}</h2>

        <label className="field">
          <span>名称</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="留空则使用 用户名@主机"
          />
        </label>

        <div className="field-row">
          <label className="field grow">
            <span>主机</span>
            <input
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="192.168.1.10 或 example.com"
            />
          </label>
          <label className="field port-field">
            <span>端口</span>
            <input value={port} onChange={(event) => setPort(event.target.value)} />
          </label>
        </div>

        <label className="field">
          <span>用户名</span>
          <input value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>

        <label className="field">
          <span>认证方式</span>
          <select
            value={authType}
            onChange={(event) => setAuthType(event.target.value as AuthType)}
          >
            <option value="password">密码</option>
            <option value="privateKey">私钥</option>
          </select>
        </label>

        {authType === 'password' ? (
          <label className="field">
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={
                clearCredential
                  ? '已勾选清除，保存后密码被清空'
                  : hasStoredCredential
                    ? '留空表示保留已保存的密码'
                    : '可选'
              }
            />
          </label>
        ) : (
          <>
            <label className="field">
              <span>私钥文件</span>
              <div className="field-row">
                <input
                  className="grow"
                  value={privateKeyPath}
                  onChange={(event) => setPrivateKeyPath(event.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                />
                <button type="button" onClick={pickPrivateKey}>
                  选择
                </button>
              </div>
            </label>
            <label className="field">
              <span>私钥口令</span>
              <input
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                placeholder={
                  clearCredential
                    ? '已勾选清除，保存后口令被清空'
                    : hasStoredCredential
                      ? '留空表示保留已保存的口令'
                      : '私钥未加密时留空'
                }
              />
            </label>
          </>
        )}

        {hasStoredCredential && (
          <label className="field">
            <span className="field-row">
              <input
                type="checkbox"
                checked={clearCredential}
                onChange={(event) => setClearCredential(event.target.checked)}
              />
              <span>清除已保存的凭据（同时清除密码与私钥口令，保存后生效）</span>
            </span>
          </label>
        )}

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="primary-btn" disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </div>
  )
}

export default ConnectionForm
