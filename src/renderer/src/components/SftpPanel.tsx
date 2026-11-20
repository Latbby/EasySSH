import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { SftpEntryVO, SftpTransferVO } from '@shared/types'
import Icon from './Icon'
import type { IconName } from './Icon'
import { toMessage } from '../utils'

interface Props {
  sftpId: string
  /** 面板起始目录，登录后的 home */
  home: string
  /** 是否为当前激活标签，非激活时隐藏 */
  active: boolean
}

/** 可调整宽度的三个数据列 */
type ColumnKey = 'name' | 'size' | 'time'

/** 三列宽度：名称列自适应剩余空间，所以这里只存一个最小宽度 */
interface ColumnWidths {
  name: number
  size: number
  time: number
}

/** 默认列宽：名称列取最小宽度，大小与时间沿用样式表里的定宽 */
const DEFAULT_WIDTHS: ColumnWidths = { name: 120, size: 96, time: 136 }

/** 各列最小宽度，拖到边界即停，避免把列拖没 */
const MIN_WIDTHS: ColumnWidths = { name: 120, size: 72, time: 120 }

/** 操作列宽度：文件行有下载/编辑/重命名/删除四个 28px 图标按钮，留够不挤压图标 */
const ACTIONS_WIDTH = 128

/** 列表行高（px），虚拟滚动按固定行高换算上下占位高度 */
const ROW_HEIGHT = 32

/** 可视区上下各多渲染的行数，滚动时不容易看到空白 */
const OVERSCAN = 6

/** 新建目录行占一行普通行高 */
const NEWDIR_HEIGHT = ROW_HEIGHT

/** 各行单元格共有样式，宽度相关属性再按列追加 */
const BASE_CELL_STYLE: CSSProperties = { position: 'relative' }

/** 列宽拖拽手柄的内联样式，展示细节（命中区宽度、悬停竖线）由 .col-resizer 负责 */
const RESIZER_STYLE: CSSProperties = { cursor: 'col-resize' }

/** 操作列样式：固定宽度，拖拽其它列不影响它 */
const ACTIONS_STYLE: CSSProperties = {
  width: ACTIONS_WIDTH,
  flex: `0 0 ${ACTIONS_WIDTH}px`
}

/** 批次内的单个文件：已传字节用于累计总进度，total 为 0 表示服务端未给大小 */
interface TransferFile {
  /** 批次内文件标识，见 transferLabel */
  label: string
  /** 已传输字节数 */
  transferred: number
  /** 总字节数，0 表示服务端未提供 */
  total: number
  /** 该文件是否已完成 */
  done: boolean
}

/** 传输进度聚合状态：连续多个文件合批显示，单文件仍用原有文案 */
interface TransferAggregate {
  /** 当前文件名，单文件文案与批次提示都用它 */
  name: string
  /** 传输方向 */
  direction: 'upload' | 'download'
  /** 本批次已出现的文件，按出现顺序排列 */
  files: TransferFile[]
  /** 批次的总文件数，取历史最大值，避免同一批文件数来回跳 */
  totalCount: number
}

/**
 * 传输事件的批次标识：方向 + 文件名。
 * 同一个文件的多次进度上报标识相同，据此把连续上报归并到同一条记录。
 * @param vo 传输进度出参
 * @returns 批次内文件标识
 */
function transferLabel(vo: SftpTransferVO): string {
  return `${vo.direction}:${vo.name}`
}

/**
 * 计算虚拟滚动可视区。
 * 行高固定，所以「首行 = 滚动距离 / 行高」，上下各多留几行做过渡。
 * @param scrollTop 列表滚动距离
 * @param viewportHeight 列表可视高度，未知时按窗口高度兜底
 * @param length 数据总行数
 * @param offset 数据行之上的固定内容高度（如新建目录行）
 * @returns 需要渲染的区间与上下占位高度
 */
function calcVirtualRange(
  scrollTop: number,
  viewportHeight: number,
  length: number,
  offset: number
): { start: number; end: number; top: number; bottom: number } {
  const viewport = viewportHeight > 0 ? viewportHeight : 600
  // 数据行整体向下偏移 offset，算可视行时要先扣掉这段固定内容
  const relative = Math.max(0, scrollTop - offset)
  const start = Math.max(0, Math.floor(relative / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(length, Math.ceil((relative + viewport) / ROW_HEIGHT) + OVERSCAN)
  return {
    start,
    end,
    top: start * ROW_HEIGHT,
    bottom: Math.max(0, (length - end) * ROW_HEIGHT)
  }
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
 * 目录项图标名。目录、符号链接、普通文件各用一种线性图标，替代原先的 emoji 字符。
 * @param entry 目录项
 * @returns 图标名
 */
function entryIcon(entry: SftpEntryVO): IconName {
  if (entry.type === 'directory') return 'folder'
  if (entry.type === 'symlink') return 'link'
  return 'file'
}

/**
 * SFTP 文件面板：浏览远程目录，支持上传、下载、重命名、删除、新建目录与远程编辑。
 * 交互约定：单击选中、双击打开（目录进入、文件下载），选中后 Enter 打开、F5 刷新；
 * 路径栏可直接编辑跳转，本地面板内可拖拽文件到当前目录上传。
 * 表头三列可拖拽调整宽度，双击手柄恢复默认；列表按固定行高做虚拟滚动，只渲染可视行。
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
  /** 传输进度聚合状态，null 表示不显示进度区 */
  const [progress, setProgress] = useState<TransferAggregate | null>(null)
  /** 是否显示拖拽上传覆盖层 */
  const [dropping, setDropping] = useState(false)
  /** 三列当前宽度，同时作用于表头与所有数据行 */
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(DEFAULT_WIDTHS)
  /** 列表滚动距离，虚拟滚动按它切片 */
  const [scrollTop, setScrollTop] = useState(0)
  /** 列表可视高度，由 ResizeObserver 维护 */
  const [viewportHeight, setViewportHeight] = useState(0)

  const pathInputRef = useRef<HTMLInputElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const newDirInputRef = useRef<HTMLInputElement>(null)
  /** 滚动容器，用于监听滚动与读取可视高度 */
  const listRef = useRef<HTMLDivElement>(null)
  /** 拖拽进出计数：dragleave 会在子元素间反复触发，必须靠计数判断是否真的离开面板 */
  const dragDepthRef = useRef(0)
  /** 最近一次变更的 cwd，供事件回调读取最新值而不必重建监听 */
  const cwdRef = useRef(cwd)
  /** 进度区隐藏定时器，完成后保留 1.5 秒 */
  const progressTimerRef = useRef<number | null>(null)
  /** 传输进度聚合明细，事件回调里读写，不进 state 避免每次进度事件都重建数组 */
  const transferRef = useRef<TransferAggregate | null>(null)

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

  // 切换会话或目录后回到顶部；cwd 只在加载成功后更新，所以目录没变时（刷新）不会重置滚动位置
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    list.scrollTop = 0
    setScrollTop(0)
  }, [sftpId, cwd])

  // 记录列表可视高度；侧栏折叠、窗口缩放都可能改变它
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const measure = (): void => setViewportHeight(list.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [])

  /** 滚动时只更新切片起点，DOM 里始终只有可视区的行 */
  const onListScroll = (event: React.UIEvent<HTMLDivElement>): void => {
    setScrollTop(event.currentTarget.scrollTop)
  }

  // 订阅当前会话的传输进度；组件卸载时取消订阅，避免后台标签继续触发状态更新
  useEffect(() => {
    const unsubscribe = window.api.sftp.onTransfer((vo) => {
      // 同一条连接可能开多个面板，只处理本会话的事件
      if (vo.sftpId !== sftpId) return

      if (progressTimerRef.current !== null) {
        window.clearTimeout(progressTimerRef.current)
        progressTimerRef.current = null
      }

      // 连续多个文件时按批次聚合，单文件时批次里只有自己
      const label = transferLabel(vo)
      const previous = transferRef.current
      let aggregate: TransferAggregate
      if (!previous) {
        aggregate = {
          name: vo.name,
          direction: vo.direction,
          files: [{ label, transferred: vo.transferred, total: vo.total, done: vo.done }],
          totalCount: 1
        }
      } else {
        aggregate = previous
        const current = aggregate.files[aggregate.files.length - 1]
        // 标识相同且上一个文件尚未完成，说明还是同一个文件的进度上报；
        // 文件名重复但上一个已完成，则视为新的一次传输
        if (current.label === label && !current.done) {
          current.transferred = vo.transferred
          current.total = vo.total
          current.done = vo.done
        } else {
          aggregate.files.push({
            label,
            transferred: vo.transferred,
            total: vo.total,
            done: vo.done
          })
          // 总文件数取历史最大值，避免同一批里 n 来回跳
          aggregate.totalCount = Math.max(aggregate.totalCount, aggregate.files.length)
        }
        aggregate.name = vo.name
      }
      transferRef.current = aggregate
      setProgress({
        ...aggregate,
        files: aggregate.files.map((file) => ({ ...file }))
      })

      if (vo.done) {
        // 完成后进度条保留 1.5 秒再隐藏，让用户看到 100%
        progressTimerRef.current = window.setTimeout(() => {
          progressTimerRef.current = null
          transferRef.current = null
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

  // 订阅远程编辑会话状态：只提示本面板的 sftpId，卸载时取消订阅
  useEffect(() => {
    const unsubscribe = window.api.sftp.onEditEvent((vo) => {
      if (vo.sftpId !== sftpId) return
      if (vo.state === 'saved') setMessage(`已回传保存内容：${vo.remotePath}`)
      else if (vo.state === 'error') setMessage(vo.message || `编辑失败：${vo.remotePath}`)
    })
    return () => unsubscribe()
  }, [sftpId])

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
   * 用系统默认程序打开远程文件编辑，保存后由主进程自动回传。
   * @param entry 目录项
   */
  const edit = async (entry: SftpEntryVO): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const session = await window.api.sftp.edit(sftpId, entry.path)
      if (session.state === 'error') setMessage(session.message || `打开失败：${entry.name}`)
      else if (session.state === 'saved') setMessage(`已回传保存内容：${entry.name}`)
      else setMessage(`已用系统程序打开 ${entry.name}`)
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
   * 修改某一列的宽度，结果不小于该列最小宽度。
   * @param key 列标识
   * @param width 目标宽度
   */
  const applyColumnWidth = (key: ColumnKey, width: number): void => {
    const next = Math.max(MIN_WIDTHS[key], Math.round(width))
    setColumnWidths((prev) => (prev[key] === next ? prev : { ...prev, [key]: next }))
  }

  /**
   * 调整列宽：拖动期间监听 document 上的 mousemove，松开即解绑；
   * 只有拖拽本身会改变宽度，单击手柄不会触发任何交互。
   * @param key 列标识
   * @param event 手柄上的鼠标按下事件
   */
  const startResize = (key: ColumnKey, event: React.MouseEvent<HTMLSpanElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = columnWidths[key]
    const onMove = (moveEvent: MouseEvent): void => {
      applyColumnWidth(key, startWidth + moveEvent.clientX - startX)
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  /**
   * 双击手柄恢复该列默认宽度。
   * @param key 列标识
   * @param event 手柄上的双击事件
   */
  const resetColumnWidth = (key: ColumnKey, event: React.MouseEvent<HTMLSpanElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    applyColumnWidth(key, DEFAULT_WIDTHS[key])
  }

  /**
   * 单元格内联样式：表头与数据行都用它，保证三列宽度严格对齐。
   * @param key 列标识
   * @returns 内联样式
   */
  const cellStyle = (key: ColumnKey): CSSProperties => {
    if (key === 'name') return { ...BASE_CELL_STYLE, flex: '1 1 0', minWidth: columnWidths.name }
    return {
      ...BASE_CELL_STYLE,
      width: columnWidths[key],
      flex: `0 0 ${columnWidths[key]}px`
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
   * 面板级快捷键：选中行 Enter 打开、F5 刷新、上下键移动选中。
   * 行内编辑时交给输入框自己处理，避免回车被面板抢走。
   * @param event React 键盘事件
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (renaming || creating) return
    if (event.key === 'F5') {
      event.preventDefault()
      void load(cwd)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (entries.length === 0) return
      event.preventDefault()
      const index = entries.findIndex((item) => item.path === selected)
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = Math.min(entries.length - 1, Math.max(0, index < 0 ? 0 : index + step))
      const entry = entries[next]
      setSelected(entry.path)
      // 键盘选中后把该行滚进可视区，虚拟滚动下这一行可能还没渲染
      const row = listRef.current?.querySelector(`[data-path="${CSS.escape(entry.path)}"]`)
      row?.scrollIntoView({ block: 'nearest' })
      return
    }
    if (event.key !== 'Enter') return
    const entry = entries.find((item) => item.path === selected)
    if (!entry) return
    void openEntry(entry)
  }

  /**
   * 传输进度文案：单文件沿用原样，连续多文件显示「第 i/n 个文件 · 总进度 xx%」。
   * 主进程按文件上报，n 取已出现过的文件数，所以同一批里 n 只增不减。
   */
  const progressText = (): string => {
    if (!progress) return ''
    const action = progress.direction === 'upload' ? '上传' : '下载'
    const percent = progressPercent()
    const current = progress.files[progress.files.length - 1]
    if (progress.files.length > 1) {
      const batchTotal = progress.files.reduce(
        (sum, file) => sum + (file.total > 0 ? file.total : 0),
        0
      )
      const size = batchTotal > 0 ? `${percent}%` : `已传输 ${formatSize(current.transferred)}`
      return `第 ${progress.files.length}/${progress.totalCount} 个文件 · 总进度 ${size}`
    }
    const size = current.total > 0 ? `${percent}%` : `已传输 ${formatSize(current.transferred)}`
    return `${action} ${progress.name} ${size}`
  }

  /**
   * 进度条填充宽度百分比：单文件按本文件算；
   * 多文件按整批算，已完成的文件计整文件大小、其余计已传字节，
   * 总大小只统计服务端给了大小的已知文件（主进程逐个文件上报，拿不到整批总量）。
   */
  const progressPercent = (): number => {
    if (!progress) return 0
    const current = progress.files[progress.files.length - 1]
    const currentPercent =
      current.total > 0 ? Math.min(100, Math.round((current.transferred / current.total) * 100)) : 0
    if (progress.files.length <= 1) return currentPercent
    // 整批总大小只统计服务端给了大小的文件；已完成文件按整文件大小计入，其余按已传字节计
    const batchTotal = progress.files.reduce(
      (sum, file) => sum + (file.total > 0 ? file.total : 0),
      0
    )
    if (batchTotal <= 0) return currentPercent
    const transferred = progress.files.reduce(
      (sum, file) => sum + (file.done && file.total > 0 ? file.total : file.transferred),
      0
    )
    return Math.min(100, Math.round((transferred / batchTotal) * 100))
  }

  // 虚拟滚动切片：新建目录行占一行，数据行之上的固定内容用 offset 表示
  const virtual = calcVirtualRange(
    scrollTop,
    viewportHeight,
    entries.length,
    creating ? NEWDIR_HEIGHT : 0
  )
  const visibleEntries = entries.slice(virtual.start, virtual.end)

  return (
    <div
      className={active ? 'sftp-panel' : 'sftp-panel hidden'}
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
          <Icon name="arrow-up" size={14} />
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
        <span className="col-name" style={cellStyle('name')}>
          名称
          <span
            className="col-resizer"
            style={RESIZER_STYLE}
            title="拖动调整列宽，双击恢复默认"
            onMouseDown={(event) => startResize('name', event)}
            onDoubleClick={(event) => resetColumnWidth('name', event)}
          />
        </span>
        <span className="col-size" style={cellStyle('size')}>
          大小
          <span
            className="col-resizer"
            style={RESIZER_STYLE}
            title="拖动调整列宽，双击恢复默认"
            onMouseDown={(event) => startResize('size', event)}
            onDoubleClick={(event) => resetColumnWidth('size', event)}
          />
        </span>
        <span className="col-time" style={cellStyle('time')}>
          修改时间
          <span
            className="col-resizer"
            style={RESIZER_STYLE}
            title="拖动调整列宽，双击恢复默认"
            onMouseDown={(event) => startResize('time', event)}
            onDoubleClick={(event) => resetColumnWidth('time', event)}
          />
        </span>
        <span className="col-actions" style={ACTIONS_STYLE} />
      </div>

      <div className="sftp-list" ref={listRef} onScroll={onListScroll}>
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

        {/* 上方占位：把已滚出可视区的行撑出来，保证滚动条长度与真实行数一致 */}
        <div className="sftp-virtual-spacer" style={{ height: virtual.top }} aria-hidden="true" />

        {visibleEntries.map((entry) => (
          <div
            className={`sftp-row clickable${selected === entry.path ? ' selected' : ''}`}
            key={entry.path}
            data-path={entry.path}
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
                style={cellStyle('name')}
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
                style={cellStyle('name')}
                // 只负责选中，双击交给行上的 onDoubleClick 统一处理，避免同一次双击打开两次
                onClick={() => setSelected(entry.path)}
                title={entry.type === 'directory' ? `进入 ${entry.name}` : `下载 ${entry.name}`}
              >
                <span className="sftp-icon">
                  <Icon name={entryIcon(entry)} size={14} />
                </span>
                <span className="sftp-name-text">{entry.name}</span>
              </button>
            )}
            <span className="col-size" style={cellStyle('size')}>
              {entry.type === 'file' ? formatSize(entry.size) : '-'}
            </span>
            <span className="col-time" style={cellStyle('time')}>
              {formatTime(entry.mtime)}
            </span>
            <span className="col-actions" style={ACTIONS_STYLE}>
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
                  <Icon name="download" size={14} />
                </button>
              )}
              {entry.type === 'file' && (
                <button
                  className="icon-btn"
                  title="用系统程序编辑"
                  onClick={(event) => {
                    event.stopPropagation()
                    void edit(entry)
                  }}
                  disabled={busy}
                >
                  <Icon name="external" size={14} />
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
                <Icon name="edit" size={14} />
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
                <Icon name="trash" size={14} />
              </button>
            </span>
          </div>
        ))}

        {/* 下方占位：补上尚未渲染的行高 */}
        <div
          className="sftp-virtual-spacer"
          style={{ height: virtual.bottom }}
          aria-hidden="true"
        />

        {entries.length === 0 && !busy && <p className="hint-text">这里没有内容</p>}
      </div>

      {dropping && <div className="sftp-drop">松开鼠标上传到 {cwd}</div>}
    </div>
  )
}

export default SftpPanel
