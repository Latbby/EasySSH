import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import {
  IPC,
  type SshClientApi,
  type SftpTransferVO,
  type EditSessionVO,
  type ForwardRuleVO
} from '@shared/types'

/**
 * 渲染进程可用的业务 API。
 * 渲染进程不直接接触 Node 与 ssh2，全部能力经此桥接，凭据不出主进程。
 */
const api: SshClientApi = {
  connections: {
    list: () => ipcRenderer.invoke(IPC.connList),
    save: (dto) => ipcRenderer.invoke(IPC.connSave, dto),
    remove: (id) => ipcRenderer.invoke(IPC.connRemove, id),
    assignGroup: (dto) => ipcRenderer.invoke(IPC.connAssignGroup, dto),
    importFromFile: () => ipcRenderer.invoke(IPC.connImport),
    exportToFile: () => ipcRenderer.invoke(IPC.connExport)
  },
  system: {
    secureAvailable: () => ipcRenderer.invoke(IPC.secureAvailable),
    pickPrivateKey: () => ipcRenderer.invoke(IPC.pickPrivateKey),
    defaultUsername: () => ipcRenderer.invoke(IPC.defaultUsername),
    readClipboard: () => ipcRenderer.invoke(IPC.clipboardRead),
    writeClipboard: (text) => ipcRenderer.invoke(IPC.clipboardWrite, text),
    trustHostKey: (host, port) => ipcRenderer.invoke(IPC.trustHostKey, host, port),
    // 拖拽上传需要把浏览器 File 换成磁盘绝对路径，这个转换只在 preload 侧可用
    pathForFile: (file) => webUtils.getPathForFile(file as File)
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
    uploadPaths: (dto) => ipcRenderer.invoke(IPC.sftpUploadPaths, dto),
    download: (sftpId, remotePath) => ipcRenderer.invoke(IPC.sftpDownload, sftpId, remotePath),
    mkdir: (sftpId, path) => ipcRenderer.invoke(IPC.sftpMkdir, sftpId, path),
    remove: (sftpId, path) => ipcRenderer.invoke(IPC.sftpRemove, sftpId, path),
    rename: (sftpId, oldPath, newPath) =>
      ipcRenderer.invoke(IPC.sftpRename, sftpId, oldPath, newPath),
    onTransfer: (listener) => {
      const handler = (_event: unknown, vo: SftpTransferVO): void => listener(vo)
      ipcRenderer.on(IPC.sftpTransfer, handler)
      return () => ipcRenderer.off(IPC.sftpTransfer, handler)
    },
    edit: (sftpId, remotePath) => ipcRenderer.invoke(IPC.sftpEdit, sftpId, remotePath),
    onEditEvent: (listener) => {
      const handler = (_event: unknown, vo: EditSessionVO): void => listener(vo)
      ipcRenderer.on(IPC.sftpEditEvent, handler)
      return () => ipcRenderer.off(IPC.sftpEditEvent, handler)
    }
  },
  forward: {
    list: () => ipcRenderer.invoke(IPC.forwardList),
    start: (dto) => ipcRenderer.invoke(IPC.forwardStart, dto),
    stop: (id) => ipcRenderer.invoke(IPC.forwardStop, id),
    remove: (id) => ipcRenderer.invoke(IPC.forwardRemove, id),
    onEvent: (listener) => {
      const handler = (_event: unknown, vo: ForwardRuleVO): void => listener(vo)
      ipcRenderer.on(IPC.forwardEvent, handler)
      return () => ipcRenderer.off(IPC.forwardEvent, handler)
    }
  },
  session: {
    save: (snapshot) => ipcRenderer.invoke(IPC.sessionSave, snapshot),
    load: () => ipcRenderer.invoke(IPC.sessionLoad),
    clear: () => ipcRenderer.invoke(IPC.sessionClear)
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
