import { useEffect, useRef, useState } from 'react'
import type { ISearchResultChangeEvent, SearchAddon } from '@xterm/addon-search'

/**
 * 匹配高亮配色，必须使用 #RRGGBB；
 * 只有开启 decorations 才会触发 onDidChangeResults，计数才能拿到。
 */
const SEARCH_DECORATIONS = {
  matchBackground: '#3b4261',
  matchOverviewRuler: '#7aa2f7',
  activeMatchBackground: '#e0af68',
  activeMatchColorOverviewRuler: '#e0af68'
}

interface Props {
  /** 由 TerminalView 创建并加载到终端上的搜索 addon */
  search: SearchAddon
  /** 自增表示需要重新聚焦输入框，用于搜索栏已展开时再次按下 Ctrl+F */
  focusTick: number
  /** 关闭搜索栏，由上层把焦点交还终端 */
  onClose(): void
}

/**
 * 计算右上角计数文案。
 * @param keyword 当前关键词
 * @param result 最近一次搜索结果，未搜索时为 null
 * @returns 展示文案，关键词为空时不展示
 */
function countText(keyword: string, result: ISearchResultChangeEvent | null): string {
  if (!keyword) return ''
  if (!result || result.resultCount === 0) return '无结果'
  // 匹配数超过高亮上限时 resultIndex 为 -1，此时只报总数
  if (result.resultIndex < 0) return `共 ${result.resultCount} 项`
  return `第 ${result.resultIndex + 1}/${result.resultCount} 项`
}

/**
 * 终端内搜索栏：输入即时增量查找，回车下一个、Shift+回车上一个。
 * 组件卸载即关闭，关闭时清掉搜索高亮并把焦点交还终端（由 onClose 负责）。
 * @param props 见 Props
 * @returns 搜索栏元素
 */
function TerminalSearchBar({ search, focusTick, onClose }: Props): React.JSX.Element {
  const [keyword, setKeyword] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [result, setResult] = useState<ISearchResultChangeEvent | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 展开或再次按下 Ctrl+F 时聚焦并全选，便于直接改写关键词
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusTick])

  // 订阅结果变化；卸载即关闭搜索栏，同时清掉高亮装饰
  useEffect(() => {
    const subscription = search.onDidChangeResults(setResult)
    return () => {
      subscription.dispose()
      search.clearDecorations()
    }
  }, [search])

  // 关键词或大小写开关变化时增量查找；关键词为空时只清装饰（计数文案本身会忽略空关键词）
  useEffect(() => {
    if (!keyword) {
      search.clearDecorations()
      return
    }
    search.findNext(keyword, { caseSensitive, incremental: true, decorations: SEARCH_DECORATIONS })
  }, [keyword, caseSensitive, search])

  /**
   * 跳到下一个匹配项。
   * @returns 无
   */
  const findNext = (): void => {
    if (keyword) search.findNext(keyword, { caseSensitive, decorations: SEARCH_DECORATIONS })
  }

  /**
   * 跳到上一个匹配项。
   * @returns 无
   */
  const findPrevious = (): void => {
    if (keyword) search.findPrevious(keyword, { caseSensitive, decorations: SEARCH_DECORATIONS })
  }

  /**
   * 处理输入框按键：回车下一个、Shift+回车上一个、Esc 关闭。
   * @param event 键盘事件
   * @returns 无
   */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) findPrevious()
      else findNext()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  /**
   * 阻止鼠标按下时按钮抢走输入框焦点，保证回车始终用于跳转。
   * @param event 鼠标事件
   * @returns 无
   */
  const keepInputFocus = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
  }

  return (
    <div className="term-search">
      <input
        ref={inputRef}
        className="term-search-input"
        value={keyword}
        placeholder="查找"
        aria-label="在终端中查找"
        spellCheck={false}
        onChange={(event) => setKeyword(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className="term-search-count">{countText(keyword, result)}</span>
      <button
        className="term-search-btn"
        title="上一个（Shift+Enter）"
        onMouseDown={keepInputFocus}
        onClick={findPrevious}
      >
        ↑
      </button>
      <button
        className="term-search-btn"
        title="下一个（Enter）"
        onMouseDown={keepInputFocus}
        onClick={findNext}
      >
        ↓
      </button>
      <button
        className={caseSensitive ? 'term-search-btn active' : 'term-search-btn'}
        title="区分大小写"
        onMouseDown={keepInputFocus}
        onClick={() => setCaseSensitive((prev) => !prev)}
      >
        Aa
      </button>
      <button className="term-search-btn" title="关闭（Esc）" onClick={onClose}>
        ×
      </button>
    </div>
  )
}

export default TerminalSearchBar
