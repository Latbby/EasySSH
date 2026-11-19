/**
 * 连接存储模块的单元验证。
 *
 * 背景：本执行环境无法启动 Electron 的 GUI 进程（electron.exe 在图形初始化阶段直接崩溃），
 * 因此这里用 TypeScript 编译器把 src/main/store.ts 转成 CJS，再把 electron 模块替换为
 * 可观测的桩实现，从而在不启动 Electron 的前提下验证安全相关的核心承诺：
 *   1. 密码只以密文落盘，明文既不在磁盘上也不出现在出参里
 *   2. 解密可正确往返
 *   3. 「传 undefined 保留原凭据、传空串清除凭据」的更新语义正确
 *   4. 原子写不残留临时文件
 *   5. 配置文件损坏时降级为空列表而不是崩溃
 */
const fs = require('fs')
const Module = require('module')
const os = require('os')
const path = require('path')
const ts = require('typescript')

const SOURCE = path.resolve(__dirname, '../src/main/store.ts')

let passed = 0

/**
 * 断言条件成立。
 * @param {boolean} condition 条件
 * @param {string} message 描述
 */
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`)
  passed += 1
  console.log(`[通过] ${message}`)
}

/**
 * 把 store.ts 转成 CJS 并加载，同时把 electron 依赖替换为桩模块。
 * @param {string} tmpDir 桩实现使用的数据目录
 * @returns {typeof import('../src/main/store')} 可调用的 store 模块
 */
function loadStoreWithStub(tmpDir) {
  const source = fs.readFileSync(SOURCE, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: SOURCE
  })

  const compiledPath = path.join(tmpDir, 'store.compiled.cjs')
  fs.writeFileSync(compiledPath, outputText, 'utf8')

  // safeStorage 桩：可逆的假加密，足以验证「落盘密文」与「解密往返」两件事
  const electronStub = {
    app: { getPath: () => tmpDir },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
      decryptString: (buffer) => buffer.toString('utf8').replace(/^enc:/, '')
    }
  }

  const originalLoad = Module._load
  Module._load = function (request, ...rest) {
    if (request === 'electron') return electronStub
    return originalLoad.call(this, request, ...rest)
  }
  try {
    return require(compiledPath)
  } finally {
    Module._load = originalLoad
  }
}

function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-store-verify-'))
  const storeFile = path.join(tmpDir, 'connections.json')
  const store = loadStoreWithStub(tmpDir)

  // 1. 新增带密码的连接
  const created = store.saveConnection({
    name: '测试机',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    password: 'p@ssw0rd'
  })
  assert(!('password' in created) && !('secret' in created), '保存出参不含任何凭据字段')
  assert(created.hasCredential === true, '出参正确标记已保存凭据')

  const raw = fs.readFileSync(storeFile, 'utf8')
  assert(!raw.includes('p@ssw0rd'), '磁盘文件中不存在明文密码')
  assert(raw.includes('secret'), '磁盘文件中存在加密后的凭据字段')
  assert(JSON.parse(raw) !== null, '落盘内容是合法 JSON')

  // 2. 凭据解密往返
  assert(store.resolveCredential(created.id).password === 'p@ssw0rd', '凭据解密往返正确')

  // 3. 列表出参不泄漏凭据
  const listed = store.listConnections()
  assert(JSON.stringify(listed).indexOf('p@ssw0rd') === -1, '列表出参不含明文密码')
  assert(JSON.stringify(listed).indexOf('secret') === -1, '列表出参不含密文字段')

  // 4. 更新时不传 password 应保留原凭据
  store.saveConnection({
    id: created.id,
    name: '测试机改名',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password'
  })
  assert(store.resolveCredential(created.id).password === 'p@ssw0rd', '未提交凭据时保留原有密码')

  // 5. 传空串应清除凭据
  store.saveConnection({
    id: created.id,
    name: '测试机改名',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    password: ''
  })
  assert(store.resolveCredential(created.id).password === undefined, '提交空串时清除密码')
  assert(store.listConnections()[0].hasCredential === false, '清除后 hasCredential 同步为 false')

  // 6. 原子写不残留临时文件
  assert(!fs.existsSync(`${storeFile}.tmp`), '原子写未残留临时文件')

  // 7. 删除连接
  store.removeConnection(created.id)
  assert(store.listConnections().length === 0, '删除连接生效')

  // 8. 配置文件损坏时降级为空列表
  fs.writeFileSync(storeFile, '{ 这不是合法 JSON', 'utf8')
  assert(store.listConnections().length === 0, '配置文件损坏时降级为空列表而非崩溃')

  fs.rmSync(tmpDir, { recursive: true, force: true })
  console.log(`\n[结果] 全部通过，共 ${passed} 项`)
}

try {
  main()
} catch (err) {
  console.error(`\n[失败] ${err.message}`)
  process.exitCode = 1
}
