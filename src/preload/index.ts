import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC, type SshClientApi } from '@shared/types'

/**
 * 渲染进程可用的业务 API。
 * 渲染进程不直接接触 Node 与 ssh2，全部能力经此桥接，凭据不出主进程。
 */
const api: SshClientApi = {
  connections: {
    list: () => ipcRenderer.invoke(IPC.connList),
    save: (dto) => ipcRenderer.invoke(IPC.connSave, dto),
    remove: (id) => ipcRenderer.invoke(IPC.connRemove, id)
  },
  system: {
    secureAvailable: () => ipcRenderer.invoke(IPC.secureAvailable),
    pickPrivateKey: () => ipcRenderer.invoke(IPC.pickPrivateKey)
  },
  terminal: {
    open: (dto) => ipcRenderer.invoke(IPC.termOpen, dto),
    write: (sessionId, data) => ipcRenderer.send(IPC.termWrite, sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send(IPC.termResize, sessionId, cols, rows),
    close: (sessionId) => ipcRenderer.send(IPC.termClose, sessionId),
    onData: (listener) => {
      const handler = (_event: unknown, sessionId: string, data: Uint8Array): void =>
        listener(sessionId, data)
      ipcRenderer.on(IPC.termData, handler)
      return () => ipcRenderer.off(IPC.termData, handler)
    },
    onExit: (listener) => {
      const handler = (_event: unknown, sessionId: string, reason: string): void =>
        listener(sessionId, reason)
      ipcRenderer.on(IPC.termExit, handler)
      return () => ipcRenderer.off(IPC.termExit, handler)
    }
  },
  sftp: {
    open: (dto) => ipcRenderer.invoke(IPC.sftpOpen, dto),
    close: (sftpId) => ipcRenderer.send(IPC.sftpClose, sftpId),
    list: (sftpId, path) => ipcRenderer.invoke(IPC.sftpList, sftpId, path),
    upload: (sftpId, remoteDir) => ipcRenderer.invoke(IPC.sftpUpload, sftpId, remoteDir),
    download: (sftpId, remotePath) => ipcRenderer.invoke(IPC.sftpDownload, sftpId, remotePath),
    mkdir: (sftpId, path) => ipcRenderer.invoke(IPC.sftpMkdir, sftpId, path),
    remove: (sftpId, path) => ipcRenderer.invoke(IPC.sftpRemove, sftpId, path),
    rename: (sftpId, oldPath, newPath) =>
      ipcRenderer.invoke(IPC.sftpRename, sftpId, oldPath, newPath)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
