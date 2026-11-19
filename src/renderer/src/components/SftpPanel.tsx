import { useCallback, useEffect, useState } from 'react'
import type { SftpEntryVO } from '@shared/types'
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
 * @param props 见 Props
 * @returns 面板元素
 */
function SftpPanel({ sftpId, home, active }: Props): React.JSX.Element {
  const [cwd, setCwd] = useState(home)
  const [entries, setEntries] = useState<SftpEntryVO[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // 首次挂载加载 home 目录，之后由用户操作驱动导航
  useEffect(() => {
    window.api.sftp
      .list(sftpId, home)
      .then(setEntries)
      .catch((err) => setMessage(toMessage(err)))
  }, [sftpId, home])

  /**
   * 加载指定目录。
   * @param path 远程目录路径
   */
  const load = useCallback(
    async (path: string): Promise<void> => {
      setBusy(true)
      setMessage(null)
      try {
        setEntries(await window.api.sftp.list(sftpId, path))
        setCwd(path)
      } catch (err) {
        setMessage(toMessage(err))
      } finally {
        setBusy(false)
      }
    },
    [sftpId]
  )

  /**
   * 下载单个文件，保存位置由主进程弹框选择。
   * @param entry 目录项
   */
  const download = async (entry: SftpEntryVO): Promise<void> => {
    setBusy(true)
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
   * 点击目录项：目录则进入，文件则下载。
   * @param entry 目录项
   */
  const openEntry = async (entry: SftpEntryVO): Promise<void> => {
    if (entry.type === 'directory') await load(entry.path)
    else await download(entry)
  }

  /** 选择本地文件上传到当前目录 */
  const upload = async (): Promise<void> => {
    setBusy(true)
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

  /** 在当前目录下新建子目录 */
  const makeDir = async (): Promise<void> => {
    const name = window.prompt('新目录名称')
    if (!name) return
    setBusy(true)
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
    if (!window.confirm(`确认删除「${entry.name}」？`)) return
    setBusy(true)
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
   * 重命名文件或目录。
   * @param entry 目录项
   */
  const rename = async (entry: SftpEntryVO): Promise<void> => {
    const name = window.prompt('新的名称', entry.name)
    if (!name || name === entry.name) return
    setBusy(true)
    try {
      await window.api.sftp.rename(sftpId, entry.path, joinPath(cwd, name))
      await load(cwd)
    } catch (err) {
      setMessage(toMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={active ? 'sftp-panel' : 'sftp-panel hidden'}>
      <div className="sftp-toolbar">
        <button
          className="icon-btn"
          title="上一级"
          onClick={() => load(parentPath(cwd))}
          disabled={busy || cwd === '/'}
        >
          ↑
        </button>
        <span className="sftp-path" title={cwd}>
          {cwd}
        </span>
        <button className="sftp-btn" onClick={() => load(cwd)} disabled={busy}>
          刷新
        </button>
        <button className="sftp-btn" onClick={upload} disabled={busy}>
          上传
        </button>
        <button className="sftp-btn" onClick={makeDir} disabled={busy}>
          新建目录
        </button>
      </div>

      {message && <p className="sftp-message">{message}</p>}

      <div className="sftp-row sftp-head">
        <span className="col-name">名称</span>
        <span className="col-size">大小</span>
        <span className="col-time">修改时间</span>
        <span className="col-actions" />
      </div>

      <div className="sftp-list">
        {entries.map((entry) => (
          <div className="sftp-row" key={entry.path}>
            <button
              className="col-name sftp-name"
              onClick={() => openEntry(entry)}
              title={entry.type === 'directory' ? `进入 ${entry.name}` : `下载 ${entry.name}`}
            >
              <span className="sftp-icon">{entryIcon(entry)}</span>
              <span className="sftp-name-text">{entry.name}</span>
            </button>
            <span className="col-size">{entry.type === 'file' ? formatSize(entry.size) : '-'}</span>
            <span className="col-time">{formatTime(entry.mtime)}</span>
            <span className="col-actions">
              {entry.type === 'file' && (
                <button
                  className="icon-btn"
                  title="下载"
                  onClick={() => download(entry)}
                  disabled={busy}
                >
                  ↓
                </button>
              )}
              <button
                className="icon-btn"
                title="重命名"
                onClick={() => rename(entry)}
                disabled={busy}
              >
                ✎
              </button>
              <button
                className="icon-btn danger"
                title="删除"
                onClick={() => remove(entry)}
                disabled={busy}
              >
                ×
              </button>
            </span>
          </div>
        ))}

        {entries.length === 0 && !busy && <p className="hint-text">这里没有内容</p>}
      </div>
    </div>
  )
}

export default SftpPanel
