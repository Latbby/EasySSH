import { parseHostKeyChanged, type HostKeyChangeVO } from '@shared/errors'

/**
 * 把捕获到的异常整理成可读提示。
 * Electron 的 ipcRenderer.invoke 会把主进程错误包装成
 * "Error invoking remote method 'xxx': Error: 真实信息"，这里剥掉前缀。
 * @param err 捕获到的异常
 * @returns 面向用户的提示文案
 */
export function toMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
}

/**
 * 识别主机密钥变更错误，这类错误需要弹窗让用户核对指纹，而不是简单提示一句。
 * @param err 捕获到的异常
 * @returns 变更详情；不是主机密钥变更错误时返回 null
 */
export function asHostKeyChanged(err: unknown): HostKeyChangeVO | null {
  const raw = err instanceof Error ? err.message : String(err)
  return parseHostKeyChanged(raw)
}
