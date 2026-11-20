/**
 * 验证「应用更名后的数据目录迁移与凭据主密钥自检」。
 *
 * 背景：应用名从 ssh-client 改成 EasySSH 后 userData 目录随之改变。只复制 connections.json
 * 而不带 Local State（Chromium 的加密主密钥）会让新目录用自己的新密钥去解旧密文，
 * 表现为「编辑连接不回显密码」+「连接报认证失败」——线上真实踩到过。
 *
 * 用例（全部用临时目录，不触碰真实数据）：
 *   1. 全新目录：连接文件与主密钥一起迁移；
 *   2. 已存在自己的主密钥且密文解不开：恢复旧主密钥并写标记（只修一次）；
 *   3. 密文能正常解密：不动任何文件；
 *   4. 没有旧目录：直接跳过；
 *   5. 迁移不覆盖新目录里已有的文件。
 */
const fs = require('fs')
const Module = require('module')
const os = require('os')
const path = require('path')
const ts = require('typescript')

const SOURCE = path.resolve(__dirname, '../src/main/migrate.ts')

let passed = 0

/**
 * 断言并打印。
 * @param {boolean} condition 断言条件
 * @param {string} message 说明
 */
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`)
  passed += 1
  console.log(`[通过] ${message}`)
}

/**
 * 把 TypeScript 源码转成可 require 的 JS。
 * @param {string} file 源文件路径
 * @returns {string} 编译后的代码
 */
function compile(file) {
  const source = fs.readFileSync(file, 'utf8')
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
}

/**
 * 加载被测模块。
 * @param {string} tmpDir 临时目录
 * @returns {object} migrate 模块导出
 */
function loadModule(tmpDir) {
  const compiledPath = path.join(tmpDir, 'migrate.compiled.cjs')
  fs.writeFileSync(compiledPath, compile(SOURCE), 'utf8')
  return require(compiledPath)
}

/**
 * 造一个带加密主密钥的 Local State。
 * @param {string} dir 目录
 * @param {string} key 主密钥内容
 */
function writeLocalState(dir, key) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: key } }))
}

/**
 * 造一份连接文件。
 * @param {string} dir 目录
 * @param {string} secret 密文
 */
function writeConnections(dir, secret) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'connections.json'),
    JSON.stringify([{ id: 'c1', name: '机器一', secret }], null, 2)
  )
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easyssh-migrate-verify-'))
  const migrate = loadModule(root)

  // 1. 全新目录：连接文件与主密钥一起迁移
  {
    const appData = path.join(root, 'case1')
    const legacy = path.join(appData, 'ssh-client')
    const current = path.join(appData, 'EasySSH')
    writeConnections(legacy, 'cipher-1')
    writeLocalState(legacy, 'key-old')
    fs.writeFileSync(path.join(legacy, 'groups.json'), '["组一"]', 'utf8')

    const migrated = migrate.migrateLegacyUserData({ appData, userData: current })
    assert(migrated.includes('connections.json'), `迁移了连接文件（${migrated.join('、')}）`)
    assert(migrated.includes('Local State'), '迁移了保存加密主密钥的 Local State')
    assert(migrated.includes('groups.json'), '迁移了分组文件')
    assert(
      migrate.readOsCryptKey(current) === 'key-old',
      '新目录的主密钥与旧目录一致（密文才解得开）'
    )
    assert(
      migrate.firstStoredSecret(current) === 'cipher-1',
      'firstStoredSecret 能取到待解密的密文'
    )
  }

  // 2. 新目录已有自己的主密钥且密文解不开：恢复旧主密钥，且只修一次
  {
    const appData = path.join(root, 'case2')
    const legacy = path.join(appData, 'ssh-client')
    const current = path.join(appData, 'EasySSH')
    writeConnections(legacy, 'cipher-old')
    writeLocalState(legacy, 'key-old')
    writeConnections(current, 'cipher-old')
    writeLocalState(current, 'key-new')

    const first = migrate.repairLegacyCredentialKey({ appData, userData: current }, () => false)
    assert(first === 'repaired', '密文解不开时恢复旧主密钥并返回 repaired')
    assert(migrate.readOsCryptKey(current) === 'key-old', '主密钥已恢复为旧目录的那把')
    assert(
      fs.existsSync(path.join(current, 'credential-key-repaired')),
      '写入标记文件，避免反复重启'
    )
    const second = migrate.repairLegacyCredentialKey({ appData, userData: current }, () => false)
    assert(second === 'skip', '第二次自检因标记文件而跳过（不会反复重启）')
  }

  // 3. 密文能正常解密：不动任何文件
  {
    const appData = path.join(root, 'case3')
    const legacy = path.join(appData, 'ssh-client')
    const current = path.join(appData, 'EasySSH')
    writeConnections(legacy, 'cipher-old')
    writeLocalState(legacy, 'key-old')
    writeConnections(current, 'cipher-new')
    writeLocalState(current, 'key-new')

    const result = migrate.repairLegacyCredentialKey({ appData, userData: current }, () => true)
    assert(result === 'ok', '密文可解密时自检返回 ok')
    assert(migrate.readOsCryptKey(current) === 'key-new', '可解密时不改动主密钥')
    assert(!fs.existsSync(path.join(current, 'credential-key-repaired')), '可解密时不写标记文件')
  }

  // 4. 没有旧目录：直接跳过
  {
    const appData = path.join(root, 'case4')
    const current = path.join(appData, 'EasySSH')
    writeConnections(current, 'cipher-new')
    assert(
      migrate.migrateLegacyUserData({ appData, userData: current }).length === 0,
      '没有旧目录时迁移为空操作'
    )
    assert(
      migrate.repairLegacyCredentialKey({ appData, userData: current }, () => false) === 'skip',
      '没有旧目录时自检直接跳过'
    )
  }

  // 5. 迁移不覆盖新目录里已有的文件
  {
    const appData = path.join(root, 'case5')
    const legacy = path.join(appData, 'ssh-client')
    const current = path.join(appData, 'EasySSH')
    writeConnections(legacy, 'cipher-legacy')
    writeLocalState(legacy, 'key-old')
    writeConnections(current, 'cipher-current')
    writeLocalState(current, 'key-current')

    const migrated = migrate.migrateLegacyUserData({ appData, userData: current })
    assert(migrated.length === 0, `已有数据时不迁移任何文件（实际 ${migrated.join('、') || '无'}）`)
    assert(
      migrate.firstStoredSecret(current) === 'cipher-current',
      '新目录里已有的连接文件未被旧目录覆盖'
    )
    assert(migrate.readOsCryptKey(current) === 'key-current', '新目录已有的主密钥未被覆盖')
  }

  fs.rmSync(root, { recursive: true, force: true })
  console.log(`\n[结果] 全部通过，共 ${passed} 项`)
}

try {
  main()
} catch (err) {
  console.error(`\n[失败] ${err.message}`)
  process.exitCode = 1
}