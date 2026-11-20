import type { SaveConnectionDTO } from '@shared/types'

/** 快速连接的默认端口 */
const DEFAULT_PORT = 22

/**
 * 快速连接地址的解析结果。
 * ok 为 true 时给出可直接用于临时连接的配置，为 false 时给出面向用户的中文原因。
 */
export type QuickConnectResult = { ok: true; dto: SaveConnectionDTO } | { ok: false; error: string }

/**
 * 解析快速连接输入，支持 host、user@host、host:2222、user@host:2222、ssh://user@host:2222。
 * 纯函数模块，不依赖 DOM 与 window，便于脚本单测。
 * @param input 用户输入的地址，首尾空白会被忽略
 * @param defaultUsername 输入中未写用户名时使用的默认用户名
 * @returns 成功时返回临时连接配置，失败时返回错误原因
 */
export function parseQuickConnect(
  input: string,
  defaultUsername: string
): { ok: true; dto: SaveConnectionDTO } | { ok: false; error: string } {
  // 兼容从别处粘贴带来的首尾空白，以及可选的 ssh:// 前缀
  const text = input.trim().replace(/^ssh:\/\//i, '')
  if (!text) return { ok: false, error: '请输入连接地址，例如 user@host:22' }

  // 用户名与主机以最后一个 @ 分隔，没有 @ 时整体视为主机
  const at = text.lastIndexOf('@')
  const userPart = at >= 0 ? text.slice(0, at).trim() : ''
  const hostPart = (at >= 0 ? text.slice(at + 1) : text).trim()

  // 主机与端口以最后一个冒号分隔，没有冒号时用默认端口
  const colon = hostPart.lastIndexOf(':')
  const host = (colon >= 0 ? hostPart.slice(0, colon) : hostPart).trim()
  const portText = colon >= 0 ? hostPart.slice(colon + 1).trim() : ''
  if (!host) return { ok: false, error: '缺少主机地址，例如 user@host:22' }
  // 未加方括号的 IPv6 与上述分隔规则冲突，这里明确报错而不是猜出一个错误主机
  if (host.includes(':')) return { ok: false, error: '暂不支持 IPv6 地址，请输入主机名或 IPv4' }

  // 写了冒号就必须给出合法端口，没写冒号才用默认端口；空串经 Number 得到 0，同样落入报错分支
  const port = colon >= 0 ? Number(portText) : DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: '端口必须是 1-65535 之间的整数' }
  }

  const username = (userPart || defaultUsername).trim()
  // 用户名最终为空时明确报错，否则会以空用户名发起连接，用户只看到看不懂的认证失败
  if (!username) return { ok: false, error: '请输入用户名，例如 root@host' }

  return {
    ok: true,
    dto: {
      name: `${username}@${host}`,
      host,
      port,
      username,
      authType: 'password'
      // 临时连接不落盘，因此不提交密码，连接时若无法免密登录会提示认证失败
    }
  }
}
