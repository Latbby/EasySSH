import { ElectronAPI } from '@electron-toolkit/preload'
import type { SshClientApi } from '../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: SshClientApi
  }
}
