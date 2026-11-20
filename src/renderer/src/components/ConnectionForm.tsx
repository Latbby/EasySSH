import { useEffect, useRef, useState } from 'react'
import type { AuthType, ConnectionVO, SaveConnectionDTO } from '@shared/types'
import { toMessage } from '../utils'
import { useFocusTrap } from '../useFocusTrap'
import Icon from './Icon'

interface Props {
  /** 编辑时传入已有连接，新增时为空 */
  initial?: ConnectionVO
  /** 新增模式：标题显示「新建连接」，提交时不带 id；复制连接会传空 id 的草稿，同样按新增处理 */
  isNew?: boolean
  /**
   * 复制连接时传入源连接 id：表单会从源连接读取已保存的凭据并回显，
   * 用户直接保存即可让副本带上同样的密码 / 私钥口令。
   */
  inheritedCredentialFrom?: string
  /** 复制连接的源连接展示名，用于提示文案 */
  inheritedCredentialName?: string
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
function ConnectionForm({
  initial,
  isNew,
  inheritedCredentialFrom,
  inheritedCredentialName,
  onSubmit,
  onCancel
}: Props): React.JSX.Element {
  // isNew 为真或草稿 id 为空都算新增：复制连接传进来的 draft 就是没有 id 的
  const isCreate = isNew === true || !initial?.id
  // 「清除凭据」只对已保存的连接有意义，新增与复制场景下没有可清除的凭据
  const hasStoredCredential = !isCreate && initial?.hasCredential === true
  // 复制连接：草稿本身没有 id，凭据从源连接读取并回显，保证副本能直接连上
  const inheritsCredential = Boolean(inheritedCredentialFrom) && initial?.hasCredential === true

  const [name, setName] = useState(initial?.name ?? '')
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(String(initial?.port ?? 22))
  const [username, setUsername] = useState(initial?.username ?? '')
  // 分组名可留空，空串表示未分组
  const [group, setGroup] = useState(initial?.group ?? '')
  const [authType, setAuthType] = useState<AuthType>(initial?.authType ?? 'password')
  // 密码与口令在编辑已保存凭据的连接时由主进程回显，回显值原样提交即等价于不改动
  const [password, setPassword] = useState('')
  const [privateKeyPath, setPrivateKeyPath] = useState(initial?.privateKeyPath ?? '')
  const [passphrase, setPassphrase] = useState('')
  /** 两个密码框是否明文显示，由各自的小眼睛按钮切换 */
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [passphraseVisible, setPassphraseVisible] = useState(false)
  /** 已保存凭据是否回显完成：未完成时输入框留空的语义仍是「保留」，文案按此提示 */
  const [credentialEchoed, setCredentialEchoed] = useState(false)
  const [clearCredential, setClearCredential] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** 弹窗容器：Esc 关闭、Tab 循环与关闭后归还焦点都由焦点陷阱统一处理 */
  const modalRef = useRef<HTMLFormElement>(null)
  /** 遮罩按下、松开标记：只有两者都落在遮罩上才关闭，避免在表单里拖选文字时误关弹窗 */
  const pressOnMaskRef = useRef(false)
  const releaseOnMaskRef = useRef(false)

  useFocusTrap(modalRef, onCancel)

  // 编辑已保存连接、或复制连接时，按需拉取明文回显，让用户看到库里实际存着的那份
  useEffect(() => {
    const sourceId = hasStoredCredential ? initial?.id : inheritedCredentialFrom
    if (!sourceId || (!hasStoredCredential && !inheritsCredential)) return
    let alive = true
    void window.api.connections
      .getCredential(sourceId)
      .then((vo) => {
        // 弹窗已关闭或已换连接时丢弃结果，避免对已卸载组件 setState
        if (!alive) return
        // 只回填非空项：某项为空说明这条连接没存它，输入框保持为空
        if (vo.password) setPassword(vo.password)
        if (vo.passphrase) setPassphrase(vo.passphrase)
        setCredentialEchoed(true)
      })
      .catch(() => {
        // 读取失败不弹错：输入框留空仍按「保留已保存的凭据」提交，不影响用户重新输入
      })
    return () => {
      alive = false
    }
  }, [hasStoredCredential, inheritsCredential, initial?.id, inheritedCredentialFrom])

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
        // 分组名两端空白无意义，空串即「未分组」，由 store 统一归一化
        group: group.trim(),
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

  // 回显成功后输入框本身就有值，占位文案只在没取到凭据时才会露出来
  const passwordPlaceholder = clearCredential
    ? '已勾选清除，保存后密码被清空'
    : hasStoredCredential
      ? credentialEchoed
        ? '已回显，可修改'
        : '留空表示保留已保存的密码'
      : inheritsCredential
        ? '已从原连接带入，可修改'
        : '可选'
  const passphrasePlaceholder = clearCredential
    ? '已勾选清除，保存后口令被清空'
    : hasStoredCredential
      ? credentialEchoed
        ? '已回显，可修改'
        : '留空表示保留已保存的口令'
      : inheritsCredential
        ? '已从原连接带入，可修改'
        : '私钥未加密时留空'

  return (
    <div
      className="modal-mask"
      onMouseDown={(event) => {
        // 只记「落点是否就是遮罩本身」，表单内部的按下不算
        pressOnMaskRef.current = event.target === event.currentTarget
      }}
      onMouseUp={(event) => {
        releaseOnMaskRef.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        // click 的目标是按下点与松开点的最近公共祖先：在输入框里按下、拖到遮罩上松开时
        // 目标也会是遮罩，所以必须按下与松开都落在遮罩上才关闭
        const onMask = pressOnMaskRef.current && releaseOnMaskRef.current
        pressOnMaskRef.current = false
        releaseOnMaskRef.current = false
        if (onMask && event.target === event.currentTarget) onCancel()
      }}
    >
      {/* 表单内文本框回车会走浏览器隐式提交，等价于点「保存」 */}
      <form
        className="modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="conn-form-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="modal-head">
          <h2 className="modal-title" id="conn-form-title">
            {isCreate ? '新建连接' : '编辑连接'}
          </h2>
        </div>

        <div className="modal-body">
          {inheritsCredential && (
            <p className="modal-note">
              已从「{inheritedCredentialName || '原连接'}
              」带入密码与私钥口令，直接保存即可让副本沿用； 清空输入框则副本不保存凭据。
            </p>
          )}

          <label className="field">
            <span>名称</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="留空则使用 用户名@主机"
              // 打开表单即聚焦第一个输入框，键盘用户不必先点一下
              autoFocus
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
            <span>分组</span>
            <input
              value={group}
              onChange={(event) => setGroup(event.target.value)}
              placeholder="留空表示未分组"
            />
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
              <div className="field-row">
                <input
                  className="grow"
                  type={passwordVisible ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={passwordPlaceholder}
                />
                {/* 小眼睛：只在本次弹窗内切换明文，不改变提交内容 */}
                <button
                  type="button"
                  className="icon-btn"
                  title={passwordVisible ? '隐藏密码' : '显示密码'}
                  aria-label={passwordVisible ? '隐藏密码' : '显示密码'}
                  aria-pressed={passwordVisible}
                  onClick={() => setPasswordVisible((prev) => !prev)}
                >
                  <Icon name={passwordVisible ? 'eye-off' : 'eye'} size={14} />
                </button>
              </div>
            </label>
          ) : (
            <>
              <label className="field">
                <span>私钥文件</span>
                <div className="field-row">
                  <input
                    className="grow mono-input"
                    value={privateKeyPath}
                    onChange={(event) => setPrivateKeyPath(event.target.value)}
                    placeholder="~/.ssh/id_ed25519"
                  />
                  <button type="button" title="选择私钥文件" onClick={pickPrivateKey}>
                    <Icon name="folder" size={14} />
                    选择
                  </button>
                </div>
              </label>
              <label className="field">
                <span>私钥口令</span>
                <div className="field-row">
                  <input
                    className="grow"
                    type={passphraseVisible ? 'text' : 'password'}
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                    placeholder={passphrasePlaceholder}
                  />
                  {/* 小眼睛：只在本次弹窗内切换明文，不改变提交内容 */}
                  <button
                    type="button"
                    className="icon-btn"
                    title={passphraseVisible ? '隐藏口令' : '显示口令'}
                    aria-label={passphraseVisible ? '隐藏口令' : '显示口令'}
                    aria-pressed={passphraseVisible}
                    onClick={() => setPassphraseVisible((prev) => !prev)}
                  >
                    <Icon name={passphraseVisible ? 'eye-off' : 'eye'} size={14} />
                  </button>
                </div>
              </label>
            </>
          )}

          {hasStoredCredential && (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={clearCredential}
                onChange={(event) => setClearCredential(event.target.checked)}
              />
              <span>清除已保存的凭据（同时清除密码与私钥口令，保存后生效）</span>
            </label>
          )}

          {error && <p className="form-error">{error}</p>}
        </div>

        <div className="modal-foot">
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
