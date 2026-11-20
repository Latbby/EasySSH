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
  /** 分组名，字段缺失表示未分组 */
  group?: string
  createdAt: number
}

/** 连接配置文件路径，位于 Electron 的 userData 目录，三平台通用 */
function storeFile(): string {
  return join(app.getPath('userData'), 'connections.json')
}

/**
 * 分组登记文件路径。
 * 分组是独立于连接的一等实体：没有这条记录，用户就建不出一个暂时还没有连接的分组。
 */
function groupsFile(): string {
  return join(app.getPath('userData'), 'groups.json')
}

/**
 * 读取已登记的分组名，保持磁盘上的顺序。
 * 文件损坏时备份为 .bak 并重建，避免一条坏数据让分组功能不可用。
 * @returns 去重、去空白后的分组名数组
 */
function loadGroups(): string[] {
  const file = groupsFile()
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!Array.isArray(parsed)) throw new Error('分组文件不是数组')
    const names = parsed
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
    return [...new Set(names)]
  } catch {
    try {
      renameSync(file, `${file}.bak`)
    } catch {
      // 备份失败也不阻断：下面按空列表重建
    }
    return []
  }
}

/**
 * 原子写入分组列表。
 * @param list 待写入的分组名
 */
function persistGroups(list: string[]): void {
  const file = groupsFile()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8')
  renameSync(tmp, file)
}

/**
 * 查询全部分组名。
 * 已登记的在前并保持创建顺序，仅由连接携带、尚未登记的分组按名称排序追加在后面，
 * 这样老数据里的分组不会因为没登记而消失。
 * @returns 分组名数组
 */
export function listGroups(): string[] {
  const registered = loadGroups()
  const derived = [
    ...new Set(
      load()
        .map((row) => row.group?.trim())
        .filter((name): name is string => Boolean(name))
    )
  ].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  return [...registered, ...derived.filter((name) => !registered.includes(name))]
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
    createdAt: row.createdAt,
    group: row.group
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
    // 分组名两端空白没有意义，空串统一按未分组处理（不写字段）
    group: dto.group?.trim() || undefined,
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

/**
 * 批量调整连接所属分组。
 * @param ids 目标连接 id 列表，未命中的 id 直接忽略
 * @param group 目标分组名，空串表示移出分组
 * @returns 调整后的全部连接出参，便于调用方直接刷新列表
 */
export function assignGroup(ids: string[], group: string): ConnectionVO[] {
  const target = group.trim()
  const wanted = new Set(ids)
  const list = load()
  list.forEach((item) => {
    if (!wanted.has(item.id)) return
    // 移出分组时删除字段而不是写空串，避免磁盘上留下无意义的分组名
    if (target) item.group = target
    else delete item.group
  })
  persist(list)
  return list.map(toVO)
}

/**
 * 新建分组。
 * @param name 分组名，两端空白会被去掉
 * @returns 最新的分组列表
 * @throws 名称为空或已存在时抛出可读错误
 */
export function createGroup(name: string): string[] {
  const target = name.trim()
  if (!target) throw new Error('分组名不能为空')
  if (listGroups().includes(target)) throw new Error(`分组「${target}」已存在`)
  persistGroups([...loadGroups(), target])
  return listGroups()
}

/**
 * 重命名分组，同时把该分组下的连接一起改到新名字下。
 * @param from 原分组名
 * @param to 新分组名，两端空白会被去掉
 * @returns 最新的分组列表
 * @throws 新名称为空、重名或原分组不存在时抛出可读错误
 */
export function renameGroup(from: string, to: string): string[] {
  const source = from.trim()
  const target = to.trim()
  if (!target) throw new Error('分组名不能为空')
  if (source === target) return listGroups()
  const groups = listGroups()
  if (!groups.includes(source)) throw new Error(`分组「${source}」不存在`)
  if (groups.includes(target)) throw new Error(`分组「${target}」已存在`)

  // 已登记的原名字就地替换，未登记的（老数据）直接补到末尾
  const registered = loadGroups()
  persistGroups(
    registered.includes(source)
      ? registered.map((item) => (item === source ? target : item))
      : [...registered, target]
  )

  const list = load()
  list.forEach((item) => {
    if (item.group?.trim() === source) item.group = target
  })
  persist(list)
  return listGroups()
}

/**
 * 删除分组，组内连接变为未分组（连接本身不会被删除）。
 * @param name 分组名
 * @returns 最新的分组列表
 */
export function removeGroup(name: string): string[] {
  const target = name.trim()
  persistGroups(loadGroups().filter((item) => item !== target))
  const list = load()
  list.forEach((item) => {
    if (item.group?.trim() === target) delete item.group
  })
  persist(list)
  return listGroups()
}
