/**
 * 应用更名（ssh-client → EasySSH）后的数据目录迁移与凭据主密钥自检。
 *
 * 独立成模块的原因：这段逻辑最容易出错的地方是「少迁移了哪个文件」，
 * 而它只有在真实更名场景下才会被触发；把路径作为入参注入后可以用临时目录直接验证。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/** 更名前使用的数据目录名 */
export const LEGACY_APP_DIR = 'ssh-client'

/** 需要迁移的数据文件；Local State 保存加密主密钥，漏掉它密码密文就解不开了 */
const MIGRATED_FILES = [
  'connections.json',
  'known_hosts.json',
  'groups.json',
  'session.json',
  'Local State'
]

/** 参与迁移的路径 */
export interface MigratePaths {
  /** 应用数据根目录（Windows 上是 %APPDATA%） */
  appData: string
  /** 当前 userData 目录 */
  userData: string
}

/** 自检结果：ok=无需处理，repaired=已恢复旧主密钥，skip=条件不满足 */
export type KeyRepairResult = 'ok' | 'repaired' | 'skip'

/**
 * 读取某个数据目录里 Chromium 的加密主密钥（Local State 的 os_crypt.encrypted_key）。
 * 密码密文是用这个密钥加密的：跨目录迁移配置时若漏掉它，密文就再也解不开了。
 * @param dir 数据目录
 * @returns 加密主密钥；文件不存在、损坏或没有该字段时返回空串
 */
export function readOsCryptKey(dir: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'Local State'), 'utf8')) as {
      os_crypt?: { encrypted_key?: string }
    }
    return parsed.os_crypt?.encrypted_key ?? ''
  } catch {
    return ''
  }
}

/**
 * 取数据目录里第一条待解密的密文，用于自检能否解密。
 * @param userData 当前 userData 目录
 * @returns base64 密文；没有则返回 undefined
 */
export function firstStoredSecret(userData: string): string | undefined {
  try {
    const file = join(userData, 'connections.json')
    if (!existsSync(file)) return undefined
    const rows = JSON.parse(readFileSync(file, 'utf8')) as Array<{
      secret?: string
      secretPassphrase?: string
    }>
    if (!Array.isArray(rows)) return undefined
    for (const row of rows) {
      const secret = row.secret ?? row.secretPassphrase
      if (secret) return secret
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 把旧数据目录里的文件复制到当前数据目录。
 * 只在目标文件不存在时复制，绝不覆盖新目录里已有的数据。
 * @param paths 参与迁移的路径
 * @returns 实际迁移的文件名列表
 */
export function migrateLegacyUserData(paths: MigratePaths): string[] {
  const legacy = join(paths.appData, LEGACY_APP_DIR)
  if (paths.userData === legacy || !existsSync(legacy)) return []
  mkdirSync(paths.userData, { recursive: true })
  const migrated: string[] = []
  for (const name of MIGRATED_FILES) {
    const from = join(legacy, name)
    const to = join(paths.userData, name)
    // 加密主密钥只在目标目录还没有自己的密钥时才接管，避免破坏已经能用的新数据
    if (name === 'Local State' && readOsCryptKey(paths.userData)) continue
    if (existsSync(from) && !existsSync(to)) {
      copyFileSync(from, to)
      migrated.push(name)
    }
  }
  return migrated
}

/**
 * 凭据主密钥自检。
 * 早期版本只迁移了 connections.json，新目录会用自己的主密钥去解旧密文，表现为
 * 「编辑连接不回显密码」+「连接报认证失败」。发现密文解不开且旧目录还留着主密钥时，
 * 恢复旧主密钥并返回 repaired，由调用方重启应用让它生效。
 * 只尝试一次：无论结果如何都写标记文件，避免反复重启。
 * @param paths 参与迁移的路径
 * @param canDecrypt 判断密文能否用当前主密钥解开的回调（由调用方注入 safeStorage）
 * @returns 自检结果
 */
export function repairLegacyCredentialKey(
  paths: MigratePaths,
  canDecrypt: (secret: string) => boolean
): KeyRepairResult {
  const legacy = join(paths.appData, LEGACY_APP_DIR)
  if (paths.userData === legacy || !existsSync(legacy)) return 'skip'
  const marker = join(paths.userData, 'credential-key-repaired')
  if (existsSync(marker)) return 'skip'
  const legacyKey = readOsCryptKey(legacy)
  if (!legacyKey || legacyKey === readOsCryptKey(paths.userData)) return 'skip'
  const sample = firstStoredSecret(paths.userData)
  if (!sample || canDecrypt(sample)) return 'ok'

  writeFileSync(marker, new Date().toISOString(), 'utf8')
  copyFileSync(join(legacy, 'Local State'), join(paths.userData, 'Local State'))
  return 'repaired'
}
