/**
 * 远程文件编辑：把远程文件下载到系统临时目录，用默认程序打开，保存后自动回传。
 *
 * 为什么不用编辑器集成：用户手上的编辑器五花八门，能覆盖全部场景的做法就是「用系统默认程序打开本地副本」，
 * 再监听本地文件的保存动作把内容推回远端。临时文件按 SFTP 会话隔离，同名文件复用，
 * 便于用户反复编辑同一个文件，也能在会话关闭后保留现场。
 */
import { app, shell } from 'electron'
import { dirname, basename, join } from 'path'
import { mkdirSync, watch, type FSWatcher } from 'fs'
import type { SFTPWrapper } from 'ssh2'
import type { EditSessionVO } from '@shared/types'
import { toReadableError } from './errors'

/** 本地保存到回传之间的等待时间（毫秒）：编辑器保存会连发多次事件，必须防抖 */
const SAVE_DEBOUNCE_MS = 800

/** 编辑会话出参中的固定字段 */
interface EditBase {
  sftpId: string
  remotePath: string
  /** 本地临时文件绝对路径 */
  localPath: string
}

/** 一次远程编辑会话 */
interface EditSession extends EditBase {
  /** SFTP 通道，回传时使用；会话关闭后它可能已失效，回传失败会如实上报 */
  sftp: SFTPWrapper
  /** 临时文件所在目录的监听器 */
  watcher?: FSWatcher
  /** 防抖计时器 */
  timer: ReturnType<typeof setTimeout> | null
  /** 正在回传 */
  uploading: boolean
  /** 回传期间又发生了改动，完成后需要补一次 */
  dirty: boolean
}

/** 编辑会话缓存，key 为「sftpId + 远程路径」 */
const sessions = new Map<string, EditSession>()

/**
 * 拼接会话缓存键。
 * @param sftpId SFTP 会话 id
 * @param remotePath 远程文件绝对路径
 * @returns 缓存键
 */
function cacheKey(sftpId: string, remotePath: string): string {
  return `${sftpId}\u0000${remotePath}`
}

/**
 * 计算本地临时文件路径：%TEMP%/easyssh-edit/<sftpId>/<文件名>。
 * 按会话分目录可以避免同名文件互相覆盖，临时文件本身不随会话关闭删除。
 * @param sftpId SFTP 会话 id
 * @param remotePath 远程文件绝对路径
 * @returns 本地绝对路径
 */
function localFilePath(sftpId: string, remotePath: string): string {
  return join(app.getPath('temp'), 'easyssh-edit', sftpId, basename(remotePath))
}

/**
 * 组装一个编辑会话出参。
 * @param base 会话固定字段
 * @param state 会话状态
 * @param message 出错时的中文说明
 * @returns 编辑会话出参
 */
function report(base: EditBase, state: EditSessionVO['state'], message?: string): EditSessionVO {
  return {
    sftpId: base.sftpId,
    remotePath: base.remotePath,
    localPath: base.localPath,
    state,
    message
  }
}

/**
 * 上传本地临时文件内容，覆盖远程文件。
 * @param session 编辑会话
 * @returns 上传完成的 Promise
 */
function upload(session: EditSession): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // 通道已失效时 fastPut 可能同步抛错，Promise 执行器里的抛出同样会转成 reject
    session.sftp.fastPut(session.localPath, session.remotePath, (err) =>
      err ? reject(toReadableError(err, `回传 ${session.remotePath}`)) : resolve()
    )
  })
}

/**
 * 安排一次防抖回传。
 * @param session 编辑会话
 * @param onEvent 状态上报回调
 */
function schedule(session: EditSession, onEvent: (vo: EditSessionVO) => void): void {
  if (session.timer) clearTimeout(session.timer)
  session.timer = setTimeout(() => {
    session.timer = null
    void flush(session, onEvent)
  }, SAVE_DEBOUNCE_MS)
}

/**
 * 回传一次本地改动，并把结果上报为 saved / error。
 * 回传期间又发生改动时记录 dirty，结束后再补一次，避免连续快速保存丢内容。
 * @param session 编辑会话
 * @param onEvent 状态上报回调
 */
async function flush(session: EditSession, onEvent: (vo: EditSessionVO) => void): Promise<void> {
  if (session.uploading) {
    session.dirty = true
    return
  }
  session.uploading = true
  try {
    await upload(session)
    onEvent(report(session, 'saved'))
  } catch (err) {
    onEvent(report(session, 'error', err instanceof Error ? err.message : String(err)))
  } finally {
    session.uploading = false
    if (session.dirty) {
      session.dirty = false
      schedule(session, onEvent)
    }
  }
}

/**
 * 用系统默认程序打开远程文件，保存后自动回传远端。
 *
 * 同一 SFTP 会话下的同一路径重复调用只会重新打开本地副本，不会再次下载，
 * 否则用户正在编辑的内容会被远端版本覆盖。任何失败都以 state='error' + 中文 message 返回，
 * 同时通过 onEvent 上报，不向 IPC 层抛异常。
 * @param sftp 已打开的 SFTP 通道
 * @param sftpId SFTP 会话 id
 * @param remotePath 远程文件绝对路径
 * @param onEvent 会话状态上报回调，由 ipc 层广播给渲染进程
 * @returns 本次编辑会话出参
 */
export async function editRemoteFile(
  sftp: SFTPWrapper,
  sftpId: string,
  remotePath: string,
  onEvent: (vo: EditSessionVO) => void
): Promise<EditSessionVO> {
  const cached = sessions.get(cacheKey(sftpId, remotePath))
  // 失败时也要给出本地路径，方便用户自己去找文件
  const base: EditBase = {
    sftpId,
    remotePath,
    localPath: cached?.localPath ?? localFilePath(sftpId, remotePath)
  }

  try {
    if (!cached) {
      mkdirSync(dirname(base.localPath), { recursive: true })
      await new Promise<void>((resolve, reject) => {
        sftp.fastGet(remotePath, base.localPath, (err) =>
          err ? reject(toReadableError(err, `下载 ${remotePath}`)) : resolve()
        )
      })
      console.log(`[EasySSH] 远程编辑临时文件：${base.localPath}，保存后自动回传 ${remotePath}`)
    }

    const openError = await shell.openPath(base.localPath)
    if (openError) {
      const failed = report(base, 'error', `无法用系统默认程序打开：${openError}`)
      onEvent(failed)
      return failed
    }

    if (!cached) {
      const session: EditSession = {
        ...base,
        sftp,
        timer: null,
        uploading: false,
        dirty: false
      }
      // 监听所在目录而不是文件本身：编辑器保存常是「写临时文件再改名覆盖」，监听文件会在改名后失效
      session.watcher = watch(dirname(base.localPath), (_event, filename) => {
        if (filename && filename !== basename(base.localPath)) return
        schedule(session, onEvent)
      })
      sessions.set(cacheKey(sftpId, remotePath), session)
    }

    const opened = report(base, 'opened')
    onEvent(opened)
    return opened
  } catch (err) {
    const failed = report(base, 'error', err instanceof Error ? err.message : String(err))
    onEvent(failed)
    return failed
  }
}

/**
 * 关闭某个 SFTP 会话下的全部编辑监听。
 * SFTP 会话关闭后应调用它，否则之后的一次保存只会在失效通道上回传并报错；
 * 本地临时文件保留，用户随时可以再打开查看。
 * @param sftpId SFTP 会话 id
 */
export function closeEditSessions(sftpId: string): void {
  for (const [key, session] of [...sessions]) {
    if (session.sftpId !== sftpId) continue
    if (session.timer) clearTimeout(session.timer)
    session.watcher?.close()
    sessions.delete(key)
  }
}
