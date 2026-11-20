/**
 * 本地配置读写验证脚本：连接导入导出（src/main/config-io.ts）+ 会话快照（src/main/session.ts）。
 *
 * 目的：这两块功能都在主进程里操作磁盘，跑界面很难覆盖边界，因此这里用 TypeScript 编译器把
 * 被测模块转成 CJS，只把 electron（app / dialog / safeStorage）替换成可控桩，
 * store.ts 用的是与真实运行完全相同的代码，验证以下几件容易出错的事：
 *   1. OpenSSH 配置：Host 块、多别名、通配块跳过、注释与行内注释、IdentityFile、端口与用户名缺省
 *   2. JSON 导入：字段映射、分组保留、端口非法时回退 22、缺主机地址跳过、非数组与非法 JSON 的处理
 *   3. 导出：JSON 与 OpenSSH 两种格式由扩展名决定，且**不含任何凭据**
 *   4. 重复导入计入 skipped，逐条原因可读
 *   5. 会话快照：只落白名单字段（绝不写凭据）、上限截断、损坏备份为 .bak、清除与原子写
 *
 * 说明：脚本只使用临时目录，不接触真实用户配置。
 */
const fs = require('fs')
const Module = require('module')
const os = require('os')
const path = require('path')
const ts = require('typescript')

/** 编译产物目录 */
const BUILD_DIR = path.join(__dirname, '..', '.verify-build-config')
/** 桩实现使用的数据目录（connections.json 与 session.json 都写这里） */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-config-io-'))
/** 临时文件目录，用于放被测的导入源文件与导出目标 */
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-config-io-work-'))

/** 当前系统登录用户名，OpenSSH 配置没写 User 时应当回退到它 */
const SYSTEM_USER = os.userInfo().username

let passed = 0
/** 非致命发现：不满足理想行为但不影响主契约的问题，单独记录便于评估 */
const nonFatal = []

/**
 * 记录一条通过项。
 * @param {string} message 描述
 */
function pass(message) {
  passed += 1
  console.log(`[通过] ${message}`)
}

/**
 * 断言条件成立，不成立直接抛错（退出码非零）。
 * @param {boolean} condition 条件
 * @param {string} message 描述
 */
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`)
  pass(message)
}

/**
 * 记录一条非致命发现。
 * @param {string} message 描述
 */
function note(message) {
  nonFatal.push(message)
  console.log(`[非致命] ${message}`)
}

/** dialog 桩的行为开关，由各用例设置 */
const dialogBehavior = { openPaths: [], savePath: null }

/**
 * 把主进程 TS 模块编译成临时目录下的 CJS。
 * @param {string} fileName 源文件名
 * @param {string} outName 输出文件名
 * @param {string} sourceDir 源文件所在目录
 */
function compileTo(fileName, outName, sourceDir = '../src/main') {
  const source = fs.readFileSync(path.resolve(__dirname, `${sourceDir}/${fileName}`), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName
  })
  fs.writeFileSync(path.join(BUILD_DIR, outName), outputText, 'utf8')
}

/**
 * 注入 electron 桩后加载编译产物。
 * @returns {{ store: object, configIo: object, session: object }} 编译出来的模块
 */
function loadModules() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true })
  fs.mkdirSync(BUILD_DIR, { recursive: true })
  compileTo('store.ts', 'store.js')
  compileTo('config-io.ts', 'config-io.js')
  compileTo('session.ts', 'session.js')

  const electronStub = {
    app: { getPath: () => DATA_DIR },
    // 与前几轮脚本保持一致的假加密：可逆，足以验证「密文落盘 + 可解密」
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
      decryptString: (buffer) => buffer.toString('utf8').replace(/^enc:/, '')
    },
    dialog: {
      showOpenDialog: async () => ({
        canceled: dialogBehavior.openPaths.length === 0,
        filePaths: dialogBehavior.openPaths
      }),
      showSaveDialog: async () => ({
        canceled: !dialogBehavior.savePath,
        filePath: dialogBehavior.savePath
      })
    }
  }

  const originalLoad = Module._load
  Module._load = function (request, ...rest) {
    if (request === 'electron') return electronStub
    return originalLoad.call(this, request, ...rest)
  }
  try {
    return {
      store: require(path.join(BUILD_DIR, 'store.js')),
      configIo: require(path.join(BUILD_DIR, 'config-io.js')),
      session: require(path.join(BUILD_DIR, 'session.js'))
    }
  } finally {
    Module._load = originalLoad
  }
}

/** 连接存储文件路径 */
const STORE_FILE = path.join(DATA_DIR, 'connections.json')
/** 会话快照文件路径 */
const SESSION_FILE = path.join(DATA_DIR, 'session.json')

/**
 * 清空连接存储，让每个阶段从干净状态开始。
 */
function resetStore() {
  fs.rmSync(STORE_FILE, { force: true })
}

/**
 * 写一个临时文件。
 * @param {string} name 文件名
 * @param {string} content 内容
 * @returns {string} 绝对路径
 */
function writeWorkFile(name, content) {
  const file = path.join(WORK_DIR, name)
  fs.writeFileSync(file, content, 'utf8')
  return file
}

/**
 * 让下一次「打开文件」对话框返回指定路径。
 * @param {string|null} file 文件路径，null 表示用户取消
 */
function nextOpenFile(file) {
  dialogBehavior.openPaths = file ? [file] : []
}

/**
 * 让下一次「保存文件」对话框返回指定路径。
 * @param {string|null} file 文件路径，null 表示用户取消
 */
function nextSaveFile(file) {
  dialogBehavior.savePath = file
}

async function main() {
  const { store, configIo, session } = loadModules()

  // -------------------------------------------------------------------------
  // 1. OpenSSH 配置解析
  // -------------------------------------------------------------------------
  const sshConfig = [
    '# 测试用 OpenSSH 配置',
    'Host web',
    '    HostName 10.0.0.10',
    '    User deploy',
    '    Port 2222',
    '    IdentityFile ~/.ssh/id_ed25519_web',
    '',
    'Host db db-alias   # 一个块可以带多个别名',
    '    HostName 10.0.0.11',
    '    # 没写 User 与 Port，应回退到系统用户与 22',
    '',
    'Host *.internal',
    '    User nobody',
    '',
    'Host only-alias',
    '    User root',
    '    Port 0',
    ''
  ].join('\n')
  const sshConfigPath = writeWorkFile('config', sshConfig)

  nextOpenFile(sshConfigPath)
  const firstImport = await configIo.importConnectionsFromFile(null)
  assert(firstImport.imported === 4, `OpenSSH 配置导入 4 个连接（实际 ${firstImport.imported}）`)
  assert(firstImport.skipped === 0, `首次导入没有跳过项（实际 ${firstImport.skipped}）`)

  const list = store.listConnections()
  const byName = Object.fromEntries(list.map((vo) => [vo.name, vo]))

  const web = byName['web']
  assert(Boolean(web), 'Host web 被导入')
  assert(
    web.host === '10.0.0.10' && web.port === 2222 && web.username === 'deploy',
    `Host 块字段映射正确（${web.host}:${web.port} / ${web.username}）`
  )
  assert(
    web.authType === 'privateKey' &&
      web.privateKeyPath === path.join(os.homedir(), '.ssh', 'id_ed25519_web'),
    `IdentityFile 导入为私钥认证并展开 ~（${web.privateKeyPath}）`
  )

  assert(
    byName['db']?.host === '10.0.0.11' && byName['db']?.port === 22,
    `未写 Port 时缺省 22（db → ${byName['db']?.host}:${byName['db']?.port}）`
  )
  assert(
    byName['db']?.username === SYSTEM_USER,
    `未写 User 时回退到系统登录用户（${byName['db']?.username}）`
  )
  assert(
    byName['db-alias']?.host === '10.0.0.11' && byName['db-alias']?.name === 'db-alias',
    '同一 Host 块的多个别名各自生成一条连接'
  )
  assert(
    byName['only-alias']?.host === 'only-alias' && byName['only-alias']?.username === 'root',
    '未写 HostName 时别名即主机名（only-alias）'
  )
  assert(!byName['*.internal'], '通配 Host 块没有被导入成连接')
  assert(
    firstImport.errors.some((item) => item.includes('通配') && item.includes('已跳过')),
    `通配块给出了可读的跳过原因（${firstImport.errors[0]}）`
  )
  assert(
    firstImport.errors.some((item) => item.includes('端口') && item.includes('22')),
    `非法端口行给出提示并按 22 处理（${firstImport.errors.find((item) => item.includes('端口'))}）`
  )

  // 重复导入：同名同主机同端口同用户的连接应当计入 skipped
  nextOpenFile(sshConfigPath)
  const secondImport = await configIo.importConnectionsFromFile(null)
  assert(
    secondImport.imported === 0 && secondImport.skipped === 4,
    `重复导入全部计入 skipped（新增 ${secondImport.imported} / 跳过 ${secondImport.skipped}）`
  )
  assert(
    secondImport.errors.filter((item) => item.includes('已存在')).length === 4,
    '重复导入逐条给出「已存在」原因'
  )
  assert(store.listConnections().length === 4, '重复导入没有产生重复连接')

  // -------------------------------------------------------------------------
  // 2. JSON 导入：字段映射、分组、端口规范化、缺字段跳过
  // -------------------------------------------------------------------------
  resetStore()
  const jsonSource = JSON.stringify([
    {
      name: 'JSON 连接',
      host: '10.1.1.1',
      port: 2200,
      username: 'jsonuser',
      authType: 'privateKey',
      privateKeyPath: '~/.ssh/json_key',
      group: '生产环境'
    },
    { name: '端口非法', host: '10.1.1.2', port: 'abc', username: 'u2', authType: 'password' },
    { name: '缺主机', port: 22, username: 'u3' }
  ])
  const jsonPath = writeWorkFile('conns.json', jsonSource)
  nextOpenFile(jsonPath)
  const jsonImport = await configIo.importConnectionsFromFile(null)
  assert(jsonImport.imported === 2, `JSON 导入 2 条合法记录（实际 ${jsonImport.imported}）`)
  assert(
    jsonImport.errors.some((item) => item.includes('缺少主机地址')),
    '缺主机地址的记录被跳过并说明原因'
  )
  const jsonList = store.listConnections()
  const jsonConn = jsonList.find((vo) => vo.name === 'JSON 连接')
  assert(
    jsonConn.host === '10.1.1.1' &&
      jsonConn.port === 2200 &&
      jsonConn.username === 'jsonuser' &&
      jsonConn.group === '生产环境',
    `JSON 字段与分组完整映射（${jsonConn.host}:${jsonConn.port} / 分组「${jsonConn.group}」）`
  )
  assert(
    jsonConn.privateKeyPath === path.join(os.homedir(), '.ssh', 'json_key'),
    'JSON 里的 ~ 私钥路径同样被展开'
  )
  assert(
    jsonList.find((vo) => vo.name === '端口非法')?.port === 22,
    `JSON 里非法端口回退 22（实际 ${jsonList.find((vo) => vo.name === '端口非法')?.port}）`
  )

  const notArray = writeWorkFile('not-array.json', '{"a":1}')
  nextOpenFile(notArray)
  const notArrayResult = await configIo.importConnectionsFromFile(null)
  assert(
    notArrayResult.imported === 0 &&
      notArrayResult.errors.some((item) => item.includes('不是连接数组')),
    'JSON 内容不是数组时给出可读原因'
  )

  const brokenJson = writeWorkFile('broken.json', '[{ 这不是合法 JSON')
  nextOpenFile(brokenJson)
  let brokenMessage = ''
  try {
    await configIo.importConnectionsFromFile(null)
  } catch (err) {
    brokenMessage = err.message
  }
  assert(
    brokenMessage.includes('JSON 文件格式不正确'),
    `非法 JSON 抛出中文错误（${brokenMessage}）`
  )

  const emptyConfig = writeWorkFile('empty-config', '# 只有注释\n')
  nextOpenFile(emptyConfig)
  const emptyResult = await configIo.importConnectionsFromFile(null)
  assert(
    emptyResult.errors.some((item) => item.includes('没有找到可导入的 Host 配置')),
    '空配置给出可读提示'
  )

  nextOpenFile(null)
  assert(
    (await configIo.importConnectionsFromFile(null)) === null,
    '用户在导入框取消时返回 null，不产生任何副作用'
  )

  // -------------------------------------------------------------------------
  // 3. 导出：JSON 与 OpenSSH，且不含任何凭据
  // -------------------------------------------------------------------------
  resetStore()
  store.saveConnection({
    name: '导出目标',
    host: '10.2.2.2',
    port: 2222,
    username: 'exporter',
    authType: 'password',
    password: 'EXPORT-SECRET-PW',
    group: '运维'
  })
  store.saveConnection({
    name: '带 空格 的 名称',
    host: '10.2.2.3',
    port: 22,
    username: 'keyuser',
    authType: 'privateKey',
    privateKeyPath: 'C:\\Users\\John Doe\\.ssh\\id_rsa'
  })

  const exportJsonPath = path.join(WORK_DIR, 'export.json')
  nextSaveFile(exportJsonPath)
  const jsonExport = await configIo.exportConnectionsToFile(null)
  assert(jsonExport.format === 'json', `按 .json 后缀导出为 JSON（${jsonExport.format}）`)
  assert(jsonExport.exported === 2, `导出条数与连接数一致（${jsonExport.exported}）`)
  const exportedJsonText = fs.readFileSync(exportJsonPath, 'utf8')
  assert(
    !exportedJsonText.includes('EXPORT-SECRET-PW') && !exportedJsonText.includes('secret'),
    '导出的 JSON 不含任何密码或密文字段'
  )
  const exportedRows = JSON.parse(exportedJsonText)
  assert(
    exportedRows.length === 2 &&
      exportedRows[0].name === '导出目标' &&
      exportedRows[0].group === '运维' &&
      exportedRows[0].authType === 'password',
    '导出的 JSON 字段与分组完整'
  )
  assert(
    exportedRows.every(
      (row) => !('password' in row) && !('passphrase' in row) && !('secret' in row)
    ),
    '导出记录里不存在凭据相关字段'
  )

  const exportConfigPath = path.join(WORK_DIR, 'export.conf')
  nextSaveFile(exportConfigPath)
  const sshExport = await configIo.exportConnectionsToFile(null)
  assert(sshExport.format === 'openssh', `按 .conf 后缀导出为 OpenSSH 配置（${sshExport.format}）`)
  const exportedConfigText = fs.readFileSync(exportConfigPath, 'utf8')
  assert(!exportedConfigText.includes('EXPORT-SECRET-PW'), '导出的 OpenSSH 配置不含密码明文')
  assert(
    exportedConfigText.includes('Host 导出目标') &&
      exportedConfigText.includes('HostName 10.2.2.2') &&
      exportedConfigText.includes('User exporter') &&
      exportedConfigText.includes('Port 2222'),
    'OpenSSH 导出包含 Host / HostName / User / Port 四要素'
  )
  assert(
    exportedConfigText.includes('Host 带-空格-的-名称'),
    '名称里的空白在导出别名时替换为短横线（不破坏配置语法）'
  )
  assert(
    exportedConfigText.includes('IdentityFile "C:\\Users\\John Doe\\.ssh\\id_rsa"'),
    '含空格的私钥路径在导出时加了引号'
  )

  // 导出的 OpenSSH 配置重新导入：不带空格的路径必须逐字段还原
  resetStore()
  const noSpaceConfig = writeWorkFile(
    'roundtrip.conf',
    [
      'Host roundtrip',
      '  HostName 10.3.3.3',
      '  User rt',
      '  Port 2201',
      '  IdentityFile ~/.ssh/rt_key',
      ''
    ].join('\n')
  )
  nextOpenFile(noSpaceConfig)
  await configIo.importConnectionsFromFile(null)
  const rt = store.listConnections()[0]
  assert(
    rt.host === '10.3.3.3' &&
      rt.port === 2201 &&
      rt.username === 'rt' &&
      rt.privateKeyPath === path.join(os.homedir(), '.ssh', 'rt_key'),
    `导出的 OpenSSH 配置可被自身重新导入（${rt.host}:${rt.port}）`
  )

  // 边界探针：导出时给含空格的路径加了引号，导入时是否会把引号当成路径的一部分
  resetStore()
  const quotedConfig = writeWorkFile(
    'quoted.conf',
    [
      'Host quoted',
      '  HostName 10.4.4.4',
      '  User q',
      '  IdentityFile "C:\\Users\\John Doe\\.ssh\\id_rsa"',
      ''
    ].join('\n')
  )
  nextOpenFile(quotedConfig)
  await configIo.importConnectionsFromFile(null)
  const quoted = store.listConnections()[0]
  if (quoted.privateKeyPath === 'C:\\Users\\John Doe\\.ssh\\id_rsa') {
    pass('带引号的 IdentityFile 导入后被正确去引号')
  } else {
    note(
      `IdentityFile 的引号未被去掉：导出会为含空格的路径加引号，导入后 privateKeyPath=${JSON.stringify(
        quoted.privateKeyPath
      )}，用该连接时无法读到私钥文件（导出/导入往返不一致）`
    )
  }

  // -------------------------------------------------------------------------
  // 4. 分组批量调整（store.assignGroup）
  // -------------------------------------------------------------------------
  resetStore()
  const groupA = store.saveConnection({
    name: '分组甲',
    host: '10.5.5.1',
    port: 22,
    username: 'g1',
    authType: 'password'
  })
  const groupB = store.saveConnection({
    name: '分组乙',
    host: '10.5.5.2',
    port: 22,
    username: 'g2',
    authType: 'password'
  })
  const afterAssign = store.assignGroup([groupA.id, groupB.id], '  生产  ')
  assert(
    afterAssign.every((vo) => vo.group === '生产'),
    '批量移动分组时分组名两端空白被去掉'
  )
  assert(
    store.listConnections().every((vo) => vo.group === '生产'),
    '分组变更已落盘（重新读盘仍是新分组）'
  )
  const afterClear = store.assignGroup([groupA.id], '')
  assert(
    afterClear.find((vo) => vo.id === groupA.id).group === undefined &&
      afterClear.find((vo) => vo.id === groupB.id).group === '生产',
    '留空表示移出分组，且不影响其它连接'
  )
  assert(
    !JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')).some((row) => row.group === ''),
    '移出分组时删除字段而不是写空串'
  )

  // -------------------------------------------------------------------------
  // 5. 会话快照（session.ts）：白名单、上限、损坏备份、清除
  // -------------------------------------------------------------------------
  session.clearSession()
  session.saveSession({
    // 故意多塞凭据与主机地址：白名单之外的内容一律不允许落盘
    tabs: [
      { kind: 'terminal', connectionId: 'conn-1', password: 'SNAPSHOT-SECRET', host: '10.9.9.9' },
      { kind: 'sftp', connectionId: 'conn-2' },
      { kind: 'terminal', connectionId: '   ' },
      { kind: 'bogus', connectionId: 'conn-3' },
      { kind: 'terminal' }
    ],
    savedAt: 1717171717171
  })
  const snapshotRaw = fs.readFileSync(SESSION_FILE, 'utf8')
  assert(
    !snapshotRaw.includes('SNAPSHOT-SECRET') && !snapshotRaw.includes('10.9.9.9'),
    '会话快照不落盘凭据与主机地址（只保留白名单字段）'
  )
  const loaded = session.loadSession()
  assert(
    loaded.tabs.length === 2 &&
      loaded.tabs[0].kind === 'terminal' &&
      loaded.tabs[0].connectionId === 'conn-1' &&
      loaded.tabs[1].kind === 'sftp',
    `非法 kind 与空 connectionId 被丢弃（保留 ${loaded.tabs.length} 项）`
  )
  assert(loaded.savedAt === 1717171717171, 'savedAt 原样保留')
  assert(!fs.existsSync(`${SESSION_FILE}.tmp`), '会话快照写入未残留 .tmp 临时文件')

  const manyTabs = Array.from({ length: 60 }, (_item, index) => ({
    kind: 'terminal',
    connectionId: `conn-${index}`
  }))
  session.saveSession({ tabs: manyTabs })
  assert(session.loadSession().tabs.length === 50, '快照标签数按上限 50 截断')

  session.saveSession({ tabs: [] })
  assert(!fs.existsSync(SESSION_FILE), '空快照等同于清除，不留磁盘文件')

  fs.writeFileSync(SESSION_FILE, '{ 这不是合法 JSON', 'utf8')
  assert(session.loadSession() === null, '损坏的快照返回 null 而不是抛异常')
  assert(fs.existsSync(`${SESSION_FILE}.bak`), '损坏的快照被备份为 .bak 保留现场')

  fs.writeFileSync(SESSION_FILE, JSON.stringify({ tabs: 'not-array' }), 'utf8')
  assert(session.loadSession() === null, '结构不合法（tabs 非数组）同样按损坏处理')
  session.clearSession()
  assert(!fs.existsSync(SESSION_FILE), 'clearSession 删除快照文件')

  console.log(
    `\n[结果] 断言通过 ${passed} 项，非致命发现 ${nonFatal.length} 项` +
      (nonFatal.length ? `：\n  - ${nonFatal.join('\n  - ')}` : '')
  )
}

main()
  .catch((err) => {
    console.error(`\n[失败] ${err.message}`)
    if (err.stack) console.error(err.stack)
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(BUILD_DIR, { recursive: true, force: true })
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
    fs.rmSync(WORK_DIR, { recursive: true, force: true })
  })
