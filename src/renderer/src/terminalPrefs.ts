/**
 * 终端外观偏好的读写与多标签同步。
 * 字号持久化在 localStorage，改动时通过 CustomEvent 在窗口内广播，
 * 使同一窗口下已挂载的所有终端标签共享同一份字号。
 */

/** 字号持久化键名 */
const FONT_SIZE_KEY = 'ssh-client:font-size'

/** 字号变更广播事件名 */
const FONT_SIZE_EVENT = 'ssh-client:font-size-change'

/** 默认字号 */
export const DEFAULT_FONT_SIZE = 14

/** 最小字号 */
export const MIN_FONT_SIZE = 8

/** 最大字号 */
export const MAX_FONT_SIZE = 32

/**
 * 把字号收拢到合法区间。
 * @param size 待校验的字号
 * @returns 合法字号；不是有限数字时返回默认字号
 */
function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_FONT_SIZE
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)))
}

/**
 * 读取当前字号。
 * @returns 已持久化的字号；缺失或非法时返回默认字号
 */
export function readFontSize(): number {
  const raw = window.localStorage.getItem(FONT_SIZE_KEY)
  return raw === null ? DEFAULT_FONT_SIZE : clampFontSize(Number(raw))
}

/**
 * 写入字号并广播给同窗口内的其它终端标签。
 * @param size 目标字号，超出 8–32 会被收拢
 * @returns 无
 */
export function writeFontSize(size: number): void {
  const next = clampFontSize(size)
  window.localStorage.setItem(FONT_SIZE_KEY, String(next))
  window.dispatchEvent(new CustomEvent<number>(FONT_SIZE_EVENT, { detail: next }))
}

/**
 * 在当前字号基础上按步长调整。
 * @param delta 步长，正数放大、负数缩小
 * @returns 无
 */
export function stepFontSize(delta: number): void {
  writeFontSize(readFontSize() + delta)
}

/**
 * 订阅字号变化。
 * @param listener 变化回调，入参为最新字号
 * @returns 取消订阅函数
 */
export function subscribeFontSize(listener: (size: number) => void): () => void {
  const handler = (event: Event): void => listener((event as CustomEvent<number>).detail)
  window.addEventListener(FONT_SIZE_EVENT, handler)
  return () => window.removeEventListener(FONT_SIZE_EVENT, handler)
}
