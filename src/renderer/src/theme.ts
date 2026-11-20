/**
 * 主题（浅色 / 深色 / 跟随系统）的读写、应用与多组件同步。
 * 主题模式持久化在 localStorage，生效结果统一写到 <html> 的 data-theme 属性与 color-scheme，
 * 样式侧只需按属性选择器切换令牌；组件侧通过 subscribeTheme 订阅变化，
 * 因此主题不需要在组件树里逐层传递 props。
 */

/** 主题模式：显式浅色、显式深色，或跟随操作系统 */
export type ThemeMode = 'system' | 'light' | 'dark'

/** 解析后的实际主题：跟随系统展开后只剩这两种 */
export type ResolvedTheme = 'light' | 'dark'

/** 主题模式持久化键名 */
const THEME_KEY = 'ssh-client:theme'

/** 主题变更广播事件名，同一窗口内的组件靠它同步 */
const THEME_EVENT = 'ssh-client:theme'

/** 系统深色偏好的媒体查询 */
const DARK_QUERY = '(prefers-color-scheme: dark)'

/** 合法的持久化取值，用于校验 localStorage 里读到的字符串 */
const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark']

/** 系统深色偏好查询，首次使用时创建后复用，保证 change 监听落在同一个对象上 */
let darkQuery: MediaQueryList | null = null

/**
 * 取系统深色偏好查询对象（惰性单例）。
 * @returns 匹配 (prefers-color-scheme: dark) 的 MediaQueryList
 */
function getDarkQuery(): MediaQueryList {
  if (!darkQuery) darkQuery = window.matchMedia(DARK_QUERY)
  return darkQuery
}

/**
 * 读取用户选择的主题模式。
 * @returns 已持久化的主题模式；缺失或非法时返回 'system'
 */
export function readThemeMode(): ThemeMode {
  const raw = window.localStorage.getItem(THEME_KEY)
  return THEME_MODES.includes(raw as ThemeMode) ? (raw as ThemeMode) : 'system'
}

/**
 * 把主题模式解析为实际生效的主题。
 * @param mode 主题模式，'system' 时读取系统深色偏好
 * @returns 实际生效的主题
 */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode
  return getDarkQuery().matches ? 'dark' : 'light'
}

/**
 * 把主题应用到文档根节点。
 * data-theme 供样式表切换设计令牌，color-scheme 让滚动条、表单控件等原生 UI 跟随主题。
 * 本函数幂等，重复调用不会产生副作用。
 * @param mode 主题模式，内部会先解析为实际主题
 * @returns 无
 */
export function applyTheme(mode: ThemeMode): void {
  const theme = resolveTheme(mode)
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}

/**
 * 持久化主题模式并立即生效，同时广播给同窗口内的其它订阅者。
 * @param mode 目标主题模式
 * @returns 无
 */
export function writeThemeMode(mode: ThemeMode): void {
  window.localStorage.setItem(THEME_KEY, mode)
  applyTheme(mode)
  window.dispatchEvent(new CustomEvent<ResolvedTheme>(THEME_EVENT, { detail: resolveTheme(mode) }))
}

/**
 * 订阅实际生效主题的变化，覆盖两种来源：
 * 1. writeThemeMode 触发的主题切换；
 * 2. 跟随系统时操作系统深色偏好的变化（显式 light/dark 下忽略，不擅自改动用户选择）。
 * @param listener 变化回调，入参为最新的实际主题
 * @returns 取消订阅函数
 */
export function subscribeTheme(listener: (theme: ResolvedTheme) => void): () => void {
  const handleThemeEvent = (event: Event): void => {
    listener((event as CustomEvent<ResolvedTheme>).detail)
  }
  window.addEventListener(THEME_EVENT, handleThemeEvent)

  const query = getDarkQuery()
  const handleSystemChange = (): void => {
    if (readThemeMode() !== 'system') return
    // 系统偏好变了，先把新的实际主题落到文档上，再通知组件（如终端重绘配色）
    applyTheme('system')
    listener(query.matches ? 'dark' : 'light')
  }
  query.addEventListener('change', handleSystemChange)

  return () => {
    window.removeEventListener(THEME_EVENT, handleThemeEvent)
    query.removeEventListener('change', handleSystemChange)
  }
}

// 模块加载时立即应用一次，避免首帧闪一下默认主题；applyTheme 幂等，重复引入也安全
applyTheme(readThemeMode())
