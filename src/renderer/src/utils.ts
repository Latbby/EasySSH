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
