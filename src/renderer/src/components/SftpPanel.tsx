import { useCallback, useEffect, useRef, useState } from 'react'
import type { SftpEntryVO, SftpTransferVO } from '@shared/types'
import { toMessage } from '../utils'

interface Props {
  sftpId: string
  /** 面板起始目录，登录后的 home */
  home: string
  /** 是否为当前激活标签，非激活时隐藏 */
  active: boolean
}

/**
 * 取远程路径的父目录。远程路径始终使用正斜杠，不能走 path.dirname。
 * @param path 远程绝对路径
 * @returns 父目录路径
 */
function parentPath(path: string): string {
  if (path === '/') return '/'
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

/**
 * 拼接远程路径。
 * @param dir 目录
 * @param name 名称
 * @returns 拼接后的路径
 */
function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

/**
 * 归一化远程路径中的 . 与 .. 段，并合并重复斜杠。
 * 用户可能在路径栏里手敲 .. 回退，这里只做字符串层面的处理，不访问远端。
 * @param path 待归一化的路径
 * @returns 归一化后的路径
 */
function normalizeRemotePath(path: string): string {
  const stack: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return `/${stack.join('/')}`
}

/**
 * 把路径栏里的输入展开成远端绝对路径。
 * 支持 ~ 与 ~/ 开头（展开为登录 home）、/ 开头（绝对路径）、
 * 相对路径（按当前目录拼接）以及手敲的 . / ..。
 * @param input 用户输入的路径
 * @param cwd 当前展示目录
 * @param home 登录后的 home 目录
 * @returns 展开后的绝对路径
 */
function expandRemotePath(input: string, cwd: string, home: string): string {
  const text = input.trim()
  if (!text) return cwd
  if (text === '~') return home || '/'
  if (text.startsWith('~/')) return normalizeRemotePath(joinPath(home || '/', text.slice(2)))
  if (text.startsWith('/')) return normalizeRemotePath(text)
  return normalizeRemotePath(joinPath(cwd, text))
}

/**
 * 把字节数格式化成可读大小。
 * @param size 字节数
 * @returns 展示文案
 */
function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * 格式化修改时间。
 * @param mtime 毫秒时间戳，0 表示服务端未提供
 * @returns 展示文案
 */
function formatTime(mtime: number): string {
  if (!mtime) return '-'
  const date = new Date(mtime)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 目录项图标。
 * @param entry 目录项
 * @returns 图标字符
 */
function entryIcon(entry: SftpEntryVO): string {
  if (entry.type === 'directory') return '📁'
  if (entry.type === 'symlink') return '🔗'
  return '📄'
}

/**
 * SFTP 文件面板：浏览远程目录，支持上传、下载、重命名、删除与新建目录。
 * 交互约定：单击选中、双击打开（目录进入、文件下载），选中后 Enter 打开、F5 刷新；
 * 路径栏可直接编辑跳转，本地面板内可拖拽文件到当前目录上传。
 * @param props 见 Props
 * @returns 面板元素
 */
function SftpPanel({ sftpId, home, active }: Props): React.JSX.Element {
  const [cwd, setCwd] = useState(home)
  const [entries, setEntries] = useState<SftpEntryVO[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  /** 当前选中的目录项路径，支持 Enter 打开 */
  const [selected, setSelected] = useState<string | null>(null)
  /** 正在重命名的目录项路径，非空时该行显示内联输入框 */
  const [renaming, setRenaming] = useState<string | null>(null)
  /** 是否显示新建目录行内输入 */
  const [creating, setCreating] = useState(false)
  /** 传输进度，null 表示不显示进度区 */
  const [progress, setProgress] = useState<SftpTransferVO | null>(null)
  /** 是否显示拖拽上传覆盖层 */
  const [dropping, setDropping] = useState(false)

  const panelRef = useRef<HTMLDivElement>(null)
  const pathInputRef = useRef<HTMLInputElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const newDirInputRef = useRef<HTMLInputElement>(null)
  /** 拖拽进出计数：dragleave 会在子元素间反复触发，必须靠计数判断是否真的离开面板 */
  const dragDepthRef = useRef(0)
  /** 最近一次变更的 cwd，供事件回调读取最新值而不必重建监听 */
  const cwdRef = useRef(cwd)
  /** 进度区隐藏定时器，完成后保留 1.5 秒 */
  const progressTimerRef = useRef<number | null>(null)

  useEffect(() => {
    cwdRef.current = cwd
  }, [cwd])

  /**
   * 加载指定目录。
   * @param path 远程目录路径
   */
  const load = useCallback(
    async (path: string): Promise<void> => {
      setBusy(true)
      setMessage(null)
      try {
        const list = await window.api.sftp.list(sftpId, path)
        setEntries(list)
        setCwd(path)
        // 切目录后旧的选中项与行内编辑都不再有效
        setSelected(null)
        setRenaming(null)
        setCreating(false)
      } catch (err) {
        // 跳转失败保留原目录，只提示错误
        setMessage(toMessage(err))
      } finally {
        setBusy(false)
      }
    },
    [sftpId]
  )

  // 首次挂载加载 home 目录，之后由用户操作驱动导航；这里不改 busy，避免列表首屏闪“没有内容”
  useEffect(() => {
    window.api.sftp
      .list(sftpId, home)
      .then(setEntries)
      .catch((err) => setMessage(toMessage(err)))
  }, [sftpId, home])

  // 订阅当前会话的传输进度；组件卸载时取消订阅，避免后台标签继续触发状态更新
  useEffect(() => {
    const unsubscribe = window.api.sftp.onTransfer((vo) => {
      // 同一条连接可能开多个面板，只处理本会话的事件
      if (vo.sftpId !== sftpId) return

      if (progressTimerRef.current !== null) {
        window.clearTimeout(progressTimerRef.current)
        progressTimerRef.current = null
      }
      setProgress(vo)
      if (vo.done) {
        // 完成后进度条保留 1.5 秒再隐藏，让用户看到 100%
        progressTimerRef.current = window.setTimeout(() => {
          progressTimerRef.current = null
          setProgress(null)
        }, 1500)
        // 文件已落盘，刷新面板当前所在目录以展示最新大小与时间
        void load(cwdRef.current)
      }
    })
    return () => {
      unsubscribe()
      if (progressTimerRef.current !== null) {
        window.clearTimeout(progressTimerRef.current)
        progressTimerRef.current = null
      }
    }
  }, [sftpId, load])

  // 进入重命名后自动聚焦并选中文件名（去掉扩展名前的主体部分），方便直接改写
  useEffect(() => {
    const input = renameInputRef.current
    if (!input) return
    input.focus()
    const dot = input.value.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length)
  }, [renaming])

  // 新建目录行内输入自动聚焦
  useEffect(() => {
    if (creating) newDirInputRef.current?.focus()
  }, [creating])

  /**
   * 下载单个文件，保存位置由主进程弹框选择。
   * @param entry 目录项
   */
  const download = async (entry: SftpEntryVO): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const done = await window.api.sftp.download(sftpId, entry.path)
      if (done) setMessage(`已下载 ${entry.name}`)
    } catch (err) {
      setMessage(toMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 打开目录项：目录进入，文件走保存框下载。双击或选中后按 Enter 触发。
   * @param entry 目录项
   */
  const openEntry = async (entry: SftpEntryVO): Promise<void> => {
    if (busy) return
    if (entry.type === 'directory') await load(entry.path)
    else await download(entry)
  }

  /**
   * 路径栏回车跳转：把输入展开成绝对路径后加载，失败时保留原目录并由 load 提示错误。
   */
  const submitPath = async (): Promise<void> => {
    const input = pathInputRef.current
    if (!input) return
    const target = expandRemotePath(input.value, cwd, home)
    if (target === cwd) {
      // 目标就是当前目录，等价于刷新；把输入框还原成 cwd 显示
      input.value = cwd
      await load(cwd)
      return
    }
    await load(target)
    // 跳转成功时 input 已随 cwd 重渲染为新路径，失败时保持用户输入，两种情况下都无需回写
  }

  /** 选择本地文件上传到当前目录 */
  const upload = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const names = await window.api.sftp.upload(sftpId, cwd)
      if (names.length) {
        setMessage(`已上传 ${names.join('、')}`)
        await load(cwd)
      }
    } catch (err) {
      setMessage(toMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 用本地绝对路径列表上传到当前目录，供拖拽上传复用。
   * @param localPaths 本地文件绝对路径列表
   */
  const uploadLocalPaths = async (localPaths: string[]): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const names = await window.api.sftp.uploadPaths({ sftpId, remoteDir: cwd, localPaths })
      if (names.length) {
        setMessage(`已上传 ${names.join('、')}`)
        await load(cwd)
      } else {
        setMessage('没有文件被上传')
      }
    } catch (err) {
      setMessage(toMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /** 提交新建目录的行内输入 */
  const submitNewDir = async (): Promise<void> => {
    const input = newDirInputRef.current
    const name = input?.value.trim()
    if (!name) {
      setCreating(false)
      return
    }
    setCreating(false)
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      await window.api.sftp.mkdir(sftpId, joinPath(cwd, name))
      await load(cwd)
    } catch (err) {
      setMessage(toMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 删除文件或目录。
   * @param entry 目录项
   */
  const remove = async (entry: SftpEntryVO): Promise<void> => {
    if (busy) return
    if (!window.confirm(`确认删除「${entry.name}」？`)) return
    setBusy(true)
    setMessage(null)
    try {
      await window.api.sftp.remove(sftpId, entry.path)
      await load(cwd)
    } catch (err) {
      setMessage(toMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 提交重命名的行内输入。
   * @param entry 目录项
   */
  const submitRename = async (entry: SftpEntryVO): Promise<void> => {
    const input = renameInputRef.current
    const name = input?.value.trim()
    setRenaming(null)
    if (!name || name === entry.name || busy) return
    setBusy(true)
    setMessage(null)
    try {
      await window.api.sftp.rename(sftpId, entry.path, joinPath(cwd, name))
      await load(cwd)
    } catch (err) {
      setMessage(toMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 拖拽进入面板：只对携带文件的拖拽提示上传，并阻止默认行为以便接收 drop。
   * @param event React 拖拽事件
   */
  const onDragEnter = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    if (!event.dataTransfer.types.includes('Files')) return
    dragDepthRef.current += 1
    setDropping(true)
  }

  /**
   * 拖拽悬停：必须阻止默认行为，否则浏览器不会派发 drop。
   * @param event React 拖拽事件
   */
  const onDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    if (event.dataTransfer.types.includes('Files')) event.dataTransfer.dropEffect = 'copy'
  }

  /**
   * 拖拽离开：子元素之间移动也会触发 dragleave，靠计数归零才算真正离开面板。
   * @param event React 拖拽事件
   */
  const onDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDropping(false)
  }

  /**
   * 放下文件：把浏览器 File 换成磁盘绝对路径后调用 uploadPaths 上传到当前目录。
   * @param event React 拖拽事件
   */
  const onDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragDepthRef.current = 0
    setDropping(false)
    const files = Array.from(event.dataTransfer.files)
    const localPaths = files
      .map((file) => window.api.system.pathForFile(file))
      .filter((path) => path.length > 0)
    if (localPaths.length === 0) {
      setMessage('没有取到可上传的本地文件路径，请改用「上传」按钮选择文件')
      return
    }
    void uploadLocalPaths(localPaths)
  }

  /**
   * 面板级快捷键：选中行 Enter 打开、F5 刷新。行内编辑时交给输入框自己处理。
   * @param event React 键盘事件
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (renaming || creating) return
    if (event.key === 'F5') {
      event.preventDefault()
      void load(cwd)
      return
    }
    if (event.key !== 'Enter') return
    const entry = entries.find((item) => item.path === selected)
    if (!entry) return
    void openEntry(entry)
  }

  /** 传输进度文案：有总大小时显示百分比，服务端未提供大小时退回已传输字节 */
  const progressText = (): string => {
    if (!progress) return ''
    const action = progress.direction === 'upload' ? '上传' : '下载'
    const size =
      progress.total > 0
        ? `${Math.min(100, Math.round((progress.transferred / progress.total) * 100))}%`
        : `已传输 ${formatSize(progress.transferred)}`
    return `${action} ${progress.name} ${size}`
  }

  /** 进度条填充宽度百分比 */
  const progressPercent = (): number => {
    if (!progress || progress.total <= 0) return 0
    return Math.min(100, Math.round((progress.transferred / progress.total) * 100))
  }

  return (
    <div
      className={active ? 'sftp-panel' : 'sftp-panel hidden'}
      ref={panelRef}
      onKeyDown={onKeyDown}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="sftp-toolbar">
        <button
          className="icon-btn"
          title="上一级"
          onClick={() => load(parentPath(cwd))}
          disabled={busy || cwd === '/'}
        >
          ↑
        </button>
        <input
          className="sftp-path-input"
          ref={pathInputRef}
          key={cwd}
          defaultValue={cwd}
          title="回车跳转，支持 ~ 与相对路径"
          spellCheck={false}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submitPath()
            } else if (event.key === 'Escape') {
              // Esc 放弃编辑，还原成当前目录
              event.currentTarget.value = cwd
              event.currentTarget.blur()
            }
          }}
          onBlur={(event) => {
            // 失焦一律还原为当前 cwd 显示，未提交的输入不保留
            event.currentTarget.value = cwd
          }}
        />
        <button className="sftp-btn" onClick={() => load(cwd)} disabled={busy}>
          刷新
        </button>
        <button className="sftp-btn" onClick={upload} disabled={busy}>
          上传
        </button>
        <button className="sftp-btn" onClick={() => setCreating(true)} disabled={busy}>
          新建目录
        </button>
      </div>

      {progress && (
        <div className="sftp-progress">
          <span>{progressText()}</span>
          <div className="sftp-progress-track">
            <div className="sftp-progress-fill" style={{ width: `${progressPercent()}%` }} />
          </div>
        </div>
      )}

      {message && <p className="sftp-message">{message}</p>}

      <div className="sftp-row sftp-head">
        <span className="col-name">名称</span>
        <span className="col-size">大小</span>
        <span className="col-time">修改时间</span>
        <span className="col-actions" />
      </div>

      <div className="sftp-list">
        {creating && (
          <div className="sftp-newdir">
            <input
              ref={newDirInputRef}
              placeholder="新目录名称，回车确认，Esc 取消"
              spellCheck={false}
              onKeyDown={(event) => {
                // 行内编辑的按键不冒泡给面板，避免 Enter 同时命中面板级快捷键
                event.stopPropagation()
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void submitNewDir()
                } else if (event.key === 'Escape') {
                  setCreating(false)
                }
              }}
            />
          </div>
        )}

        {entries.map((entry) => (
          <div
            className={`sftp-row clickable${selected === entry.path ? ' selected' : ''}`}
            key={entry.path}
            onClick={() => {
              // 单击只负责选中，行内按钮与输入框会自行阻止冒泡
              setSelected(entry.path)
            }}
            onDoubleClick={() => {
              // 正在改名的行不因双击触发打开
              if (renaming === entry.path) return
              void openEntry(entry)
            }}
          >
            {renaming === entry.path ? (
              <input
                className="col-name sftp-rename-input"
                ref={renameInputRef}
                defaultValue={entry.name}
                spellCheck={false}
                onKeyDown={(event) => {
                  // 行内编辑的按键不冒泡给面板，避免 Enter 同时命中面板级快捷键
                  event.stopPropagation()
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void submitRename(entry)
                  } else if (event.key === 'Escape') {
                    setRenaming(null)
                  }
                }}
                onBlur={() => setRenaming(null)}
              />
            ) : (
              <button
                className="col-name sftp-name"
                // 只负责选中，双击交给行上的 onDoubleClick 统一处理，避免同一次双击打开两次
                onClick={() => setSelected(entry.path)}
                title={entry.type === 'directory' ? `进入 ${entry.name}` : `下载 ${entry.name}`}
              >
                <span className="sftp-icon">{entryIcon(entry)}</span>
                <span className="sftp-name-text">{entry.name}</span>
              </button>
            )}
            <span className="col-size">{entry.type === 'file' ? formatSize(entry.size) : '-'}</span>
            <span className="col-time">{formatTime(entry.mtime)}</span>
            <span className="col-actions">
              {entry.type === 'file' && (
                <button
                  className="icon-btn"
                  title="下载"
                  onClick={(event) => {
                    event.stopPropagation()
                    void download(entry)
                  }}
                  disabled={busy}
                >
                  ↓
                </button>
              )}
              <button
                className="icon-btn"
                title="重命名"
                onClick={(event) => {
                  // 阻止冒泡，避免点按钮时把该行切换成选中态又触发面板级快捷键
                  event.stopPropagation()
                  setSelected(entry.path)
                  setRenaming(entry.path)
                }}
                disabled={busy}
              >
                ✎
              </button>
              <button
                className="icon-btn danger"
                title="删除"
                onClick={(event) => {
                  event.stopPropagation()
                  void remove(entry)
                }}
                disabled={busy}
              >
                ×
              </button>
            </span>
          </div>
        ))}

        {entries.length === 0 && !busy && <p className="hint-text">这里没有内容</p>}
      </div>

      {dropping && <div className="sftp-drop">松开鼠标上传到 {cwd}</div>}
    </div>
  )
}

export default SftpPanel
