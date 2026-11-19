import { app, safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AuthType, ConnectionVO, SaveConnectionDTO } from '@shared/types'

/**
 * 磁盘上的连接记录。
 * secret / secretPassphrase 为 safeStorage 加密后的 base64，明文绝不落盘。
 */
interface StoredConnection {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  privateKeyPath?: string
  /** 加密后的登录密码 */
  secret?: string
  /** 加密后的私钥口令 */
  secretPassphrase?: string
  createdAt: number
}

/** 连接配置文件路径，位于 Electron 的 userData 目录，三平台通用 */
function storeFile(): string {
  return join(app.getPath('userData'), 'connections.json')
}

/**
 * 读取磁盘上的连接记录。
 * @returns 连接记录数组；文件缺失或损坏时返回空数组，避免一条坏数据导致应用无法启动
 */
function load(): StoredConnection[] {
  const file = storeFile()
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as StoredConnection[]) : []
  } catch {
    return []
  }
}

/**
 * 原子写入连接记录：先写同目录临时文件再改名。
 * 直接覆盖原文件时若进程中途退出会留下半个 JSON，导致全部连接丢失。
 * @param list 待写入的连接记录
 */
function persist(list: StoredConnection[]): void {
  const file = storeFile()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8')
  renameSync(tmp, file)
}

/**
 * 查询当前系统是否支持安全存储凭据。
 * @returns Linux 缺少 keyring 时返回 false，此时必须拒绝保存密码
 */
export function isSecureStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/**
 * 加密凭据。
 * @param plain 明文凭据
 * @returns base64 密文；明文为空或安全存储不可用时返回 undefined
 */
function encrypt(plain: string | undefined): string | undefined {
  if (!plain) return undefined
  if (!safeStorage.isEncryptionAvailable()) return undefined
  return safeStorage.encryptString(plain).toString('base64')
}

/**
 * 解密凭据。
 * @param cipher base64 密文
 * @returns 明文；密文缺失或损坏时返回 undefined，不阻断连接流程
 */
function decrypt(cipher: string | undefined): string | undefined {
  if (!cipher) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
  } catch {
    return undefined
  }
}

/**
 * 磁盘记录转换为出参，剥离一切凭据信息。
 * @param row 磁盘记录
 * @returns 仅含非敏感字段的连接出参
 */
function toVO(row: StoredConnection): ConnectionVO {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authType: row.authType,
    privateKeyPath: row.privateKeyPath,
    hasCredential: Boolean(row.secret || row.secretPassphrase),
    createdAt: row.createdAt
  }
}

/**
 * 查询全部连接。
 * @returns 供列表展示的连接出参数组
 */
export function listConnections(): ConnectionVO[] {
  return load().map(toVO)
}

/**
 * 按 id 查询单个连接。
 * @param id 连接 id
 * @returns 连接出参，不存在时返回 undefined
 */
export function getConnection(id: string): ConnectionVO | undefined {
  const row = load().find((item) => item.id === id)
  return row ? toVO(row) : undefined
}

/**
 * 取出连接的认证凭据，仅供主进程建立 SSH 连接时调用。
 * @param id 连接 id
 * @returns 解密后的密码、私钥口令与私钥路径
 */
export function resolveCredential(id: string): {
  password?: string
  passphrase?: string
  privateKeyPath?: string
} {
  const row = load().find((item) => item.id === id)
  if (!row) return {}
  return {
    password: decrypt(row.secret),
    passphrase: decrypt(row.secretPassphrase),
    privateKeyPath: row.privateKeyPath
  }
}

/**
 * 新增或更新连接。
 * @param dto 保存入参；password / passphrase 传 undefined 表示保持原值，传空串表示清除
 * @returns 保存后的连接出参
 * @throws 当需要保存凭据但系统无法加密时抛出，避免退化为明文存储
 */
export function saveConnection(dto: SaveConnectionDTO): ConnectionVO {
  const list = load()
  const index = dto.id ? list.findIndex((item) => item.id === dto.id) : -1
  const exists = index >= 0 ? list[index] : undefined

  const needSecret = Boolean(dto.password || dto.passphrase)
  if (needSecret && !safeStorage.isEncryptionAvailable()) {
    throw new Error(
      '当前系统未提供安全存储（Linux 需安装 keyring），已拒绝保存密码，请改用私钥认证'
    )
  }

  const row: StoredConnection = {
    id: exists?.id ?? randomUUID(),
    name: dto.name,
    host: dto.host,
    port: dto.port,
    username: dto.username,
    authType: dto.authType,
    privateKeyPath: dto.privateKeyPath,
    createdAt: exists?.createdAt ?? Date.now(),
    // undefined 表示本次未修改凭据，沿用旧值；空串则表示清除
    secret: dto.password === undefined ? exists?.secret : encrypt(dto.password),
    secretPassphrase:
      dto.passphrase === undefined ? exists?.secretPassphrase : encrypt(dto.passphrase)
  }

  if (index >= 0) list[index] = row
  else list.push(row)
  persist(list)
  return toVO(row)
}

/**
 * 删除连接。
 * @param id 连接 id
 */
export function removeConnection(id: string): void {
  persist(load().filter((item) => item.id !== id))
}
