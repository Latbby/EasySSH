import type { JSX } from 'react'

/** 图标名：统一用一份 16x16 视口的线性图标，避免各组件各自找字符符号 */
export type IconName =
  | 'plus'
  | 'close'
  | 'trash'
  | 'edit'
  | 'copy'
  | 'sftp'
  | 'refresh'
  | 'arrow-up'
  | 'chevron-down'
  | 'chevron-right'
  | 'folder'
  | 'file'
  | 'link'
  | 'search'
  | 'download'
  | 'upload'
  | 'import'
  | 'export'
  | 'external'
  | 'sun'
  | 'moon'
  | 'terminal'
  | 'plug'
  | 'alert'
  | 'check'

/**
 * 图标路径表。
 * 全部使用 16x16 视口、1.5 描边、圆角端点，靠 currentColor 继承文字颜色，
 * 因此主题切换与禁用态都不需要额外的图标样式。
 */
const PATHS: Record<IconName, JSX.Element> = {
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  close: <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />,
  trash: (
    <>
      <path d="M3.5 5h9" />
      <path d="M6.5 5V3.6h3V5" />
      <path d="M5.2 5l.5 7.4h4.6L10.8 5" />
      <path d="M7 7.4v3M9 7.4v3" />
    </>
  ),
  edit: (
    <>
      <path d="M11.2 2.9l1.9 1.9-7.3 7.3-2.4.6.6-2.4 7.2-7.4z" />
      <path d="M9.6 4.6l1.9 1.9" />
    </>
  ),
  copy: (
    <>
      <rect x="6" y="6" width="7" height="7" rx="1.2" />
      <path d="M9.6 6V4.4a1.2 1.2 0 0 0-1.2-1.2H4.2A1.2 1.2 0 0 0 3 4.4v4.2a1.2 1.2 0 0 0 1.2 1.2H6" />
    </>
  ),
  sftp: (
    <>
      <path d="M3.5 5.6h8.2" />
      <path d="M9.5 3.6l2 2-2 2" />
      <path d="M12.5 10.4H4.3" />
      <path d="M6.5 8.4l-2 2 2 2" />
    </>
  ),
  refresh: (
    <>
      <path d="M12.8 8a4.8 4.8 0 1 1-1.5-3.5" />
      <path d="M12.8 3.4v2.7h-2.7" />
    </>
  ),
  'arrow-up': <path d="M8 12.8V4M4.6 7.4L8 4l3.4 3.4" />,
  'chevron-down': <path d="M4.6 6.4L8 9.8l3.4-3.4" />,
  'chevron-right': <path d="M6.4 4.6L9.8 8l-3.4 3.4" />,
  folder: (
    <path d="M3 5.3a1.3 1.3 0 0 1 1.3-1.3h1.9l1.2 1.6h5.3A1.3 1.3 0 0 1 13 6.9v4.5a1.3 1.3 0 0 1-1.3 1.3H4.3A1.3 1.3 0 0 1 3 11.4V5.3z" />
  ),
  file: (
    <>
      <path d="M4 3.6h4.6L11.4 6.4v6H4z" />
      <path d="M8.4 3.6v3h3" />
    </>
  ),
  link: (
    <>
      <path d="M7 9.6a2.6 2.6 0 0 1 0-3.7l1.4-1.4a2.6 2.6 0 0 1 3.7 3.7l-1 1" />
      <path d="M9 6.4a2.6 2.6 0 0 1 0 3.7l-1.4 1.4a2.6 2.6 0 0 1-3.7-3.7l1-1" />
    </>
  ),
  search: (
    <>
      <circle cx="7.2" cy="7.2" r="3.7" />
      <path d="M10 10l3 3" />
    </>
  ),
  download: (
    <>
      <path d="M8 3.4v6.8" />
      <path d="M5.2 7.4L8 10.2l2.8-2.8" />
      <path d="M3.6 12.8h8.8" />
    </>
  ),
  upload: (
    <>
      <path d="M8 12.6V5.8" />
      <path d="M5.2 8.6L8 5.8l2.8 2.8" />
      <path d="M3.6 3.4h8.8" />
    </>
  ),
  import: (
    <>
      <path d="M8 3.4v6.4" />
      <path d="M5.4 7.2L8 9.8l2.6-2.6" />
      <path d="M3.6 12.6h8.8" />
    </>
  ),
  export: (
    <>
      <path d="M3.6 3.4h8.8" />
      <path d="M8 12.6V6.2" />
      <path d="M5.4 8.8L8 6.2l2.6 2.6" />
    </>
  ),
  external: (
    <>
      <path d="M6.4 3.6H4.6a1.2 1.2 0 0 0-1.2 1.2v6.6a1.2 1.2 0 0 0 1.2 1.2h6.6a1.2 1.2 0 0 0 1.2-1.2V9.6" />
      <path d="M9.6 3.4h3v3" />
      <path d="M12.6 3.4L7.6 8.4" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" />
    </>
  ),
  moon: <path d="M13 9.8A5.4 5.4 0 1 1 6.2 3a4.4 4.4 0 0 0 6.8 6.8z" />,
  terminal: (
    <>
      <path d="M3.4 4.8l3.2 3.2-3.2 3.2" />
      <path d="M8.6 11.4h4" />
    </>
  ),
  plug: (
    <>
      <path d="M6.2 2.8v3M9.8 2.8v3" />
      <path d="M4.4 5.8h7.2v1.6a3.6 3.6 0 0 1-3.6 3.6 3.6 3.6 0 0 1-3.6-3.6V5.8z" />
      <path d="M8 11v2.4" />
    </>
  ),
  alert: (
    <>
      <path d="M8 3l5.4 9.4H2.6L8 3z" />
      <path d="M8 6.6v2.6" />
      <path d="M8 11.1v.05" />
    </>
  ),
  check: <path d="M3.8 8.4l2.8 2.8 5.6-5.8" />
}

interface Props {
  /** 图标名 */
  name: IconName
  /** 边长（px），默认 16；列表行里常用 14 */
  size?: number
  /** 附加类名 */
  className?: string
  /** 无障碍标题，提供时图标会作为图片被读出，否则对读屏软件隐藏 */
  title?: string
}

/**
 * 统一图标组件。
 * 用 currentColor 描边，尺寸与颜色都由所处位置的文字样式决定，避免每个使用点各写一套样式。
 * @param props 见 Props
 * @returns SVG 图标元素
 */
function Icon({ name, size = 16, className, title }: Props): JSX.Element {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  )
}

export default Icon
