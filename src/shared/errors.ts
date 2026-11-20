/**
 * 主进程与渲染进程共用的错误编码工具。
 *
 * ipcRenderer.invoke 只能把主进程抛出的异常字符串化后回传，无法携带结构化数据。
 * 主机密钥变更这类需要用户确认的错误，因此把详情编码进 message，
 * 渲染进程再用 {@link parseHostKeyChanged} 还原成可展示的结构。
 */

/** 主机密钥变更错误的前缀标记 */
export const HOST_KEY_CHANGED_PREFIX = 'HOST_KEY_CHANGED:'

/** 主机密钥变更详情，用于提示用户核对新旧指纹 */
export interface HostKeyChangeVO {
  host: string
  port: number
  /** 已记录并信任的指纹 */
  oldFingerprint: string
  /** 本次握手实际收到的指纹 */
  newFingerprint: string
}

/**
 * 把主机密钥变更详情编码成错误信息。
 * @param change 变更详情
 * @returns 带标记的错误信息，可直接作为 Error 的 message
 */
export function encodeHostKeyChanged(change: HostKeyChangeVO): string {
  return `${HOST_KEY_CHANGED_PREFIX}${JSON.stringify(change)}`
}

/**
 * 从错误信息中还原主机密钥变更详情。
 * @param message 错误信息，允许被 Electron 包装过（前缀可能带有 invoke 包装文本）
 * @returns 变更详情；不是主机密钥变更错误时返回 null
 */
export function parseHostKeyChanged(message: string): HostKeyChangeVO | null {
  const index = message.indexOf(HOST_KEY_CHANGED_PREFIX)
  if (index < 0) return null
  try {
    const parsed = JSON.parse(
      message.slice(index + HOST_KEY_CHANGED_PREFIX.length)
    ) as HostKeyChangeVO
    return parsed && parsed.host && parsed.newFingerprint ? parsed : null
  } catch {
    // 信息被截断或篡改时按普通错误处理
    return null
  }
}
