import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionVO, ForwardRuleDTO, ForwardRuleVO, ForwardType } from '@shared/types'
import type { ToastKind } from '../types'
import { toMessage } from '../utils'
import { useFocusTrap } from '../useFocusTrap'
import Icon from './Icon'

interface Props {
  /** 面板是否可见；关闭时不渲染任何内容，焦点陷阱与订阅随挂载/卸载自动处理 */
  open: boolean
  /** 关闭面板 */
  onClose(): void
  /** 已保存的连接列表，供选择隧道走哪条连接 */
  connections: ConnectionVO[]
  /** 全局提示，与 App 的提示条保持一致 */
  onNotify(kind: ToastKind, text: string): void
}

/** 状态徽标文案 */
const STATUS_TEXT: Record<ForwardRuleVO['status'], string> = {
  running: '运行中',
  stopped: '已停止',
  error: '错误'
}

/** 转发类型的中文名，用于成功提示 */
const TYPE_LABEL: Record<ForwardType, string> = {
  local: '本地转发',
  remote: '远程转发',
  dynamic: '动态转发'
}

/**
 * 规则 id 到创建时使用的连接 id。
 * 规则出参里不含 connectionId（契约已冻结），而重新启动一条已停止的规则必须带上原连接，
 * 因此把面板创建规则时的选择记在模块级：面板关掉再打开、组件重新挂载都不会丢。
 */
const ruleConnections = new Map<string, string>()

/**
 * 把规则拼成一行可读的转发描述。
 * @param rule 规则出参
 * @returns 形如「本地 127.0.0.1:8080 → 远端 10.0.0.5:80」的描述
 */
function describeRule(rule: ForwardRuleVO): string {
  if (rule.type === 'dynamic') return `动态 ${rule.localHost}:${rule.localPort} (SOCKS5)`
  if (rule.type === 'remote') {
    return `远端 ${rule.localHost}:${rule.localPort} → 本地 ${rule.remoteHost}:${rule.remotePort}`
  }
  return `本地 ${rule.localHost}:${rule.localPort} → 远端 ${rule.remoteHost}:${rule.remotePort}`
}

/**
 * 校验并转换端口输入。
 * @param text 输入框文本
 * @returns 合法端口，非法时返回 null
 */
function toPort(text: string): number | null {
  const port = Number(text)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

/**
 * 转发面板弹窗本体。
 * 只在可见时挂载，useFocusTrap 才能在挂载后拿到真实容器；Esc 关闭、Tab 循环由它统一处理。
 * @param props 见 Props（不含 open）
 * @returns 弹窗元素
 */
function ForwardDialog({ onClose, connections, onNotify }: Omit<Props, 'open'>): React.JSX.Element {
  /** 弹窗容器：Esc 关闭与 Tab 循环交给焦点陷阱 */
  const dialogRef = useRef<HTMLDivElement>(null)

  const [rules, setRules] = useState<ForwardRuleVO[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [type, setType] = useState<ForwardType>('local')
  const [localHost, setLocalHost] = useState('127.0.0.1')
  const [localPort, setLocalPort] = useState('8080')
  const [remoteHost, setRemoteHost] = useState('127.0.0.1')
  const [remotePort, setRemotePort] = useState('80')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 回调与关闭函数都经 ref 转发：父组件每次渲染换新函数也不会重装焦点陷阱与订阅
  const closeRef = useRef(onClose)
  const notifyRef = useRef(onNotify)
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])
  useEffect(() => {
    notifyRef.current = onNotify
  }, [onNotify])

  const handleClose = useCallback((): void => closeRef.current(), [])
  const notify = useCallback(
    (kind: ToastKind, text: string): void => notifyRef.current(kind, text),
    []
  )

  useFocusTrap(dialogRef, handleClose)

  /** 拉取规则列表，以主进程状态为准 */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setRules(await window.api.forward.list())
    } catch (err) {
      notify('error', toMessage(err))
    }
  }, [notify])

  // 打开面板时先同步一次列表，避免显示上一次打开时的旧状态
  useEffect(() => {
    window.api.forward
      .list()
      .then(setRules)
      .catch((err) => notify('error', toMessage(err)))
  }, [notify])

  // 订阅规则状态变化实时刷新；卸载时取消订阅
  useEffect(() => {
    return window.api.forward.onEvent((vo: ForwardRuleVO) => {
      setRules((prev) => {
        if (!prev.some((item) => item.id === vo.id)) return [...prev, vo]
        return prev.map((item) => (item.id === vo.id ? vo : item))
      })
    })
  }, [])

  /**
   * 启动或停止一条规则。
   * 已停止的规则按原连接重启，规则出参里没有连接信息，所以要从模块级缓存里取。
   * @param rule 目标规则
   */
  const toggleRule = async (rule: ForwardRuleVO): Promise<void> => {
    try {
      if (rule.status === 'running') {
        await window.api.forward.stop(rule.id)
      } else {
        const known = ruleConnections.get(rule.id)
        if (!known) {
          notify('error', '无法确定该规则使用的连接，请删除后重新添加')
          return
        }
        const vo = await window.api.forward.start({
          id: rule.id,
          connectionId: known,
          type: rule.type,
          localHost: rule.localHost,
          localPort: rule.localPort,
          remoteHost: rule.remoteHost,
          remotePort: rule.remotePort
        })
        if (vo.status === 'error') notify('error', vo.message ?? '启动转发失败')
      }
      await refresh()
    } catch (err) {
      notify('error', toMessage(err))
    }
  }

  /**
   * 删除一条规则，删除前二次确认。
   * @param rule 目标规则
   */
  const removeRule = async (rule: ForwardRuleVO): Promise<void> => {
    if (!window.confirm(`确认删除转发规则「${rule.title}」？`)) return
    try {
      await window.api.forward.remove(rule.id)
      ruleConnections.delete(rule.id)
      await refresh()
    } catch (err) {
      notify('error', toMessage(err))
    }
  }

  /**
   * 提交新增规则：本地校验端口后调用 start，成功或失败都刷新列表。
   * @param event 表单事件
   */
  const handleStart = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setError(null)

    if (!connectionId) {
      setError('请先选择要使用的连接')
      return
    }
    const listenPort = toPort(localPort)
    if (listenPort === null) {
      setError('监听端口必须是 1-65535 之间的整数')
      return
    }

    const dto: ForwardRuleDTO = {
      connectionId,
      type,
      localHost: localHost.trim() || '127.0.0.1',
      localPort: listenPort
    }
    // 动态转发由客户端在 SOCKS5 握手时指定目标，不需要目标地址
    if (type !== 'dynamic') {
      const targetPort = toPort(remotePort)
      if (!remoteHost.trim()) {
        setError('目标地址不能为空')
        return
      }
      if (targetPort === null) {
        setError('目标端口必须是 1-65535 之间的整数')
        return
      }
      dto.remoteHost = remoteHost.trim()
      dto.remotePort = targetPort
    }

    setBusy(true)
    try {
      const vo = await window.api.forward.start(dto)
      // 无论成功还是失败都记住这条规则用的连接，失败后用户还能在列表里直接点「启动」重试
      ruleConnections.set(vo.id, connectionId)
      if (vo.status === 'error') {
        notify('error', vo.message ?? '启动转发失败')
      } else {
        notify('success', `已启动${TYPE_LABEL[type]}：${describeRule(vo)}`)
      }
      await refresh()
    } catch (err) {
      // 连接配置被删、端口被占用等都由主进程转成可读文案，这里就地展示
      setError(toMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-mask" onClick={handleClose}>
      <div
        className="modal modal-wide"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fwd-panel-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <h2 className="modal-title" id="fwd-panel-title">
            端口转发
          </h2>
        </div>

        <div className="modal-body">
          {/* 规则列表：标题、转发描述、状态、累计连接数与启停删除操作 */}
          <div className="fwd-list">
            {rules.length === 0 ? (
              <p className="fwd-empty">还没有转发规则，在下面填写后点「启动转发」即可建立隧道</p>
            ) : (
              rules.map((rule) => (
                <div className="fwd-row" key={rule.id}>
                  <div className="fwd-main">
                    <div className="fwd-title">{rule.title}</div>
                    <div className="fwd-desc">{describeRule(rule)}</div>
                    {rule.message && <p className="form-error">{rule.message}</p>}
                  </div>
                  <span className={`fwd-status ${rule.status}`}>{STATUS_TEXT[rule.status]}</span>
                  <span className="fwd-desc">连接 {rule.connections}</span>
                  <div className="fwd-actions">
                    <button type="button" onClick={() => void toggleRule(rule)}>
                      {rule.status === 'running' ? '停止' : '启动'}
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      title="删除规则"
                      aria-label="删除规则"
                      onClick={() => void removeRule(rule)}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* 新增表单：类型决定字段含义，动态转发不需要目标地址 */}
          <form className="fwd-form" onSubmit={handleStart}>
            <div className="fwd-grid">
              <label className="fwd-field">
                <span>连接</span>
                <select
                  value={connectionId}
                  onChange={(event) => setConnectionId(event.target.value)}
                  autoFocus
                >
                  <option value="">请选择连接</option>
                  {connections.map((vo) => (
                    <option key={vo.id} value={vo.id}>
                      {vo.name || `${vo.username}@${vo.host}`}
                    </option>
                  ))}
                </select>
              </label>

              <label className="fwd-field">
                <span>类型</span>
                <select
                  value={type}
                  onChange={(event) => setType(event.target.value as ForwardType)}
                >
                  <option value="local">本地转发 -L</option>
                  <option value="remote">远程转发 -R</option>
                  <option value="dynamic">动态转发 -D（SOCKS5）</option>
                </select>
              </label>

              <label className="fwd-field">
                <span>{type === 'remote' ? '远端监听地址' : '本地监听地址'}</span>
                <input
                  value={localHost}
                  onChange={(event) => setLocalHost(event.target.value)}
                  placeholder="127.0.0.1"
                />
              </label>

              <label className="fwd-field">
                <span>{type === 'remote' ? '远端监听端口' : '本地监听端口'}</span>
                <input
                  value={localPort}
                  onChange={(event) => setLocalPort(event.target.value)}
                  placeholder="8080"
                />
              </label>

              {type !== 'dynamic' && (
                <>
                  <label className="fwd-field">
                    <span>{type === 'remote' ? '本地目标地址' : '目标地址（远端可达）'}</span>
                    <input
                      value={remoteHost}
                      onChange={(event) => setRemoteHost(event.target.value)}
                      placeholder="127.0.0.1"
                    />
                  </label>

                  <label className="fwd-field">
                    <span>{type === 'remote' ? '本地目标端口' : '目标端口'}</span>
                    <input
                      value={remotePort}
                      onChange={(event) => setRemotePort(event.target.value)}
                      placeholder="80"
                    />
                  </label>
                </>
              )}
            </div>

            {error && <p className="form-error">{error}</p>}

            <div className="modal-actions">
              <button type="submit" className="primary-btn" disabled={busy}>
                {busy ? '启动中…' : '启动转发'}
              </button>
            </div>
          </form>
        </div>

        <div className="modal-foot">
          <button type="button" onClick={handleClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 端口转发管理面板。
 * 可见时挂载弹窗本体，隐藏时完全不渲染，避免常驻订阅与焦点陷阱。
 * @param props 见 Props
 * @returns 面板元素或 null
 */
function ForwardPanel({ open, onClose, connections, onNotify }: Props): React.JSX.Element | null {
  if (!open) return null
  return <ForwardDialog onClose={onClose} connections={connections} onNotify={onNotify} />
}

export default ForwardPanel
