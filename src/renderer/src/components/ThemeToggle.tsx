import { useEffect, useState } from 'react'
import Icon from './Icon'
import {
  readThemeMode,
  resolveTheme,
  subscribeTheme,
  writeThemeMode,
  type ResolvedTheme,
  type ThemeMode
} from '../theme'

/** 主题模式的中文名，用于提示文案 */
const MODE_LABELS: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色'
}

/** 实际生效主题的中文名，用于提示文案 */
const THEME_LABELS: Record<ResolvedTheme, string> = {
  light: '浅色',
  dark: '深色'
}

/**
 * 生成按钮提示文案：写清点击后的目标主题、当前模式，以及回到跟随系统的操作方式。
 * @param mode 当前主题模式
 * @param theme 当前实际生效主题
 * @returns 中文提示文案
 */
function buildHint(mode: ThemeMode, theme: ResolvedTheme): string {
  const next = theme === 'light' ? '深色' : '浅色'
  const current = mode === 'system' ? `跟随系统·${THEME_LABELS[theme]}` : MODE_LABELS[mode]
  return `切换到${next}主题，当前：${current}；右键或 Shift+点击恢复跟随系统`
}

/**
 * 主题切换按钮。
 * 无 props：内部直接读写 theme.ts 的主题状态，避免主题经组件树层层透传。
 * 点击在浅色与深色之间切换并持久化，右键或 Shift+点击回到跟随系统。
 * @returns 主题切换按钮元素
 */
function ThemeToggle(): React.JSX.Element {
  const [mode, setMode] = useState<ThemeMode>(readThemeMode)
  const [theme, setTheme] = useState<ResolvedTheme>(() => resolveTheme(readThemeMode()))

  // 订阅主题变化：按钮自身切换、系统偏好变化都会走到这里，顺带按持久化值校准模式
  useEffect(
    () =>
      subscribeTheme((next) => {
        setTheme(next)
        // 模式也可能被其它入口改写，统一以 localStorage 为准回填
        setMode(readThemeMode())
      }),
    []
  )

  /**
   * 点击：按当前生效主题取反，在浅色与深色之间切换并持久化。
   * @param event 鼠标事件，按住 Shift 表示回到跟随系统
   * @returns 无
   */
  const handleClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (event.shiftKey) {
      writeThemeMode('system')
      return
    }
    writeThemeMode(theme === 'light' ? 'dark' : 'light')
  }

  /**
   * 右键：回到跟随系统，并拦掉浏览器默认菜单。
   * @param event 鼠标事件
   * @returns 无
   */
  const handleContextMenu = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    writeThemeMode('system')
  }

  const hint = buildHint(mode, theme)

  return (
    <button
      type="button"
      className="theme-toggle"
      title={hint}
      aria-label={hint}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      <Icon name={theme === 'light' ? 'sun' : 'moon'} />
    </button>
  )
}

export default ThemeToggle
