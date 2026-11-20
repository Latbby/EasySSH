/**
 * 快速连接地址解析验证脚本。
 *
 * 做法：用 TypeScript 编译器把 src/renderer/src/quickConnect.ts 转成 CJS 后直接在 Node 中加载。
 * 该模块是纯函数（只 import type，编译后不产生任何 require），因此可以脱离 DOM/window 单测；
 * 若将来引入 DOM 依赖导致无法加载，本脚本会直接失败并把它作为设计缺陷报告。
 *
 * 覆盖场景：host、user@host、host:2222、user@host:2222、ssh://user@host:2222、
 * 首尾空格、大小写 SSH://、端口非数字/0/65536/小数/空端口、空输入、缺主机、
 * 用户名缺省用 defaultUsername、端口边界 1 与 65535。
 */
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const SOURCE = path.resolve(__dirname, '../src/renderer/src/quickConnect.ts')
/** 编译产物放在项目内，保持与其它验证脚本一致 */
const BUILD_DIR = path.join(__dirname, '..', '.verify-build-quickconnect')
const OUT_FILE = path.join(BUILD_DIR, 'quickConnect.js')

let passed = 0
let failed = 0

/**
 * 断言条件成立。
 * @param {boolean} condition 条件
 * @param {string} message 描述
 */
function assert(condition, message) {
  if (condition) {
    passed += 1
    console.log(`[通过] ${message}`)
  } else {
    failed += 1
    console.error(`[失败] ${message}`)
  }
}

/**
 * 打印一条用例的四要素记录（目的/入参/出参/预期/实际）。
 * @param {string} name 用例名
 * @param {string} input 入参
 * @param {unknown} actual 实际出参
 * @param {unknown} expected 预期结果
 */
function record(name, input, actual, expected) {
  console.log(
    `[用例] ${name} | 入参=${JSON.stringify(input)} | 预期=${JSON.stringify(expected)} | 实际=${JSON.stringify(actual)}`
  )
}

/**
 * 加载编译后的解析模块。
 * @returns {{ parseQuickConnect: (input: string, defaultUsername: string) => any }} 模块导出
 */
function loadModule() {
  const source = fs.readFileSync(SOURCE, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: 'quickConnect.ts'
  })
  fs.rmSync(BUILD_DIR, { recursive: true, force: true })
  fs.mkdirSync(BUILD_DIR, { recursive: true })
  fs.writeFileSync(OUT_FILE, outputText, 'utf8')
  return { outputText, module: require(OUT_FILE) }
}

/**
 * 断言一次解析成功，并逐项核对字段。
 * @param {Function} parse 解析函数
 * @param {string} name 用例名
 * @param {string} input 入参
 * @param {string} defaultUsername 默认用户名
 * @param {{ host: string, port: number, username: string }} expected 预期结果
 */
function expectOk(parse, name, input, defaultUsername, expected) {
  const result = parse(input, defaultUsername)
  record(name, { input, defaultUsername }, result, { ok: true, dto: expected })
  if (!result.ok) {
    assert(false, `${name}：预期解析成功，实际报错「${result.error}」`)
    return
  }
  const dto = result.dto
  assert(
    dto.host === expected.host &&
      dto.port === expected.port &&
      dto.username === expected.username,
    `${name} 解析出 ${dto.username}@${dto.host}:${dto.port}`
  )
  assert(dto.name === `${expected.username}@${expected.host}`, `${name} 展示名称为 用户名@主机`)
  assert(dto.authType === 'password', `${name} 认证类型为 password`)
  assert(
    !('password' in dto) && !('privateKeyPath' in dto) && !('passphrase' in dto),
    `${name} 临时连接不携带任何凭据字段`
  )
}

/**
 * 断言一次解析失败，且错误原因符合预期。
 * @param {Function} parse 解析函数
 * @param {string} name 用例名
 * @param {string} input 入参
 * @param {string} defaultUsername 默认用户名
 * @param {string|null} expectedError 预期错误文案，null 表示只要求失败
 */
function expectFail(parse, name, input, defaultUsername, expectedError) {
  const result = parse(input, defaultUsername)
  record(name, { input, defaultUsername }, result, { ok: false, error: expectedError ?? '任意中文原因' })
  if (result.ok) {
    assert(false, `${name}：预期解析失败，实际返回 ${JSON.stringify(result.dto)}`)
    return
  }
  if (expectedError === null) {
    assert(true, `${name} 解析失败并给出原因「${result.error}」`)
    return
  }
  assert(result.error === expectedError, `${name} 错误文案为「${result.error}」`)
}

function main() {
  const { outputText, module: quickConnect } = loadModule()

  // 先确认编译产物没有任何运行时依赖：只 import type 时 TS 会把 import 完全擦除
  assert(
    typeof quickConnect.parseQuickConnect === 'function',
    'quickConnect.ts 能在纯 Node 环境加载（模块未依赖 DOM/window）'
  )
  assert(
    !/\brequire\(/.test(outputText),
    '编译产物中不含 require 调用，证明未把 DOM/window 依赖带进纯函数模块'
  )

  const parse = quickConnect.parseQuickConnect
  const DEV = 'dev'

  // ---- 正常场景 ---------------------------------------------------------
  expectOk(parse, 'a1 纯主机名', 'example.com', DEV, {
    host: 'example.com',
    port: 22,
    username: DEV
  })
  expectOk(parse, 'a2 user@host', 'alice@example.com', DEV, {
    host: 'example.com',
    port: 22,
    username: 'alice'
  })
  expectOk(parse, 'a3 host:2222', 'example.com:2222', DEV, {
    host: 'example.com',
    port: 2222,
    username: DEV
  })
  expectOk(parse, 'a4 user@host:2222', 'alice@example.com:2222', DEV, {
    host: 'example.com',
    port: 2222,
    username: 'alice'
  })
  expectOk(parse, 'a5 ssh://user@host:2222', 'ssh://alice@example.com:2222', DEV, {
    host: 'example.com',
    port: 2222,
    username: 'alice'
  })
  expectOk(parse, 'a6 首尾空格', '   alice@example.com:2222   ', DEV, {
    host: 'example.com',
    port: 2222,
    username: 'alice'
  })
  expectOk(parse, 'a7 大写 SSH://', 'SSH://alice@example.com:2222', DEV, {
    host: 'example.com',
    port: 2222,
    username: 'alice'
  })
  expectOk(parse, 'a8 大小写混合 Ssh://', 'Ssh://alice@example.com', DEV, {
    host: 'example.com',
    port: 22,
    username: 'alice'
  })
  expectOk(parse, 'a9 端口边界 1', 'example.com:1', DEV, {
    host: 'example.com',
    port: 1,
    username: DEV
  })
  expectOk(parse, 'a10 端口边界 65535', 'example.com:65535', DEV, {
    host: 'example.com',
    port: 65535,
    username: DEV
  })
  expectOk(parse, 'a11 用户名覆盖默认值', 'bob@example.com:22', DEV, {
    host: 'example.com',
    port: 22,
    username: 'bob'
  })
  expectOk(parse, 'a12 用户名两侧空白被 trim', '  alice @ example.com ', DEV, {
    host: 'example.com',
    port: 22,
    username: 'alice'
  })
  expectOk(parse, 'a13 主机两侧空格', 'alice@ example.com :2222 ', DEV, {
    host: 'example.com',
    port: 2222,
    username: 'alice'
  })
  expectOk(parse, 'a14 IPv4', 'root@127.0.0.1:2222', DEV, {
    host: '127.0.0.1',
    port: 2222,
    username: 'root'
  })
  expectOk(parse, 'a15 前导零端口', 'example.com:0022', DEV, {
    host: 'example.com',
    port: 22,
    username: DEV
  })

  // ---- 端口非法 ---------------------------------------------------------
  const PORT_ERROR = '端口必须是 1-65535 之间的整数'
  expectFail(parse, 'b1 端口 abc', 'example.com:abc', DEV, PORT_ERROR)
  expectFail(parse, 'b2 端口 0', 'example.com:0', DEV, PORT_ERROR)
  expectFail(parse, 'b3 端口 65536', 'example.com:65536', DEV, PORT_ERROR)
  expectFail(parse, 'b4 端口小数', 'example.com:22.5', DEV, PORT_ERROR)
  expectFail(parse, 'b5 端口为空', 'example.com:', DEV, PORT_ERROR)
  expectFail(parse, 'b6 端口为负', 'example.com:-1', DEV, PORT_ERROR)
  expectFail(parse, 'b7 端口含字母后缀', 'example.com:22x', DEV, PORT_ERROR)
  expectFail(parse, 'b8 端口超长数字', 'example.com:99999999999999999999', DEV, PORT_ERROR)
  expectFail(parse, 'b9 ssh:// 前缀 + 非法端口', 'ssh://alice@example.com:70000', DEV, PORT_ERROR)

  // ---- 输入非法 ---------------------------------------------------------
  const EMPTY_ERROR = '请输入连接地址，例如 user@host:22'
  const HOST_ERROR = '缺少主机地址，例如 user@host:22'
  expectFail(parse, 'c1 空输入', '', DEV, EMPTY_ERROR)
  expectFail(parse, 'c2 纯空格', '    ', DEV, EMPTY_ERROR)
  expectFail(parse, 'c3 仅 ssh:// 前缀', 'ssh://', DEV, EMPTY_ERROR)
  expectFail(parse, 'c4 缺主机', 'alice@', DEV, HOST_ERROR)
  expectFail(parse, 'c5 缺主机但带端口', 'alice@:2222', DEV, HOST_ERROR)
  expectFail(parse, 'c6 IPv6 明确拒绝', '::1', DEV, '暂不支持 IPv6 地址，请输入主机名或 IPv4')
  expectFail(
    parse,
    'c7 未加方括号的 IPv6 加端口',
    'fe80::1:2222',
    DEV,
    '暂不支持 IPv6 地址，请输入主机名或 IPv4'
  )

  // ---- 用户名解析（task-8 修复项：最终用户名为空时必须明确报错） ----------
  const USER_ERROR = '请输入用户名，例如 root@host'
  expectFail(parse, 'd1 默认用户名为空串且未写用户名', 'example.com', '', USER_ERROR)
  expectFail(parse, 'd2 默认用户名纯空白且未写用户名', 'example.com', '   ', USER_ERROR)
  expectFail(parse, 'd3 @host 且默认用户名为空', '@example.com', '', USER_ERROR)
  expectFail(parse, 'd4 @host:2222 且默认用户名纯空白', '@example.com:2222', '  ', USER_ERROR)
  expectOk(parse, 'd5 输入自带用户名时不受空默认值影响', 'bob@example.com', '', {
    host: 'example.com',
    port: 22,
    username: 'bob'
  })
  expectOk(parse, 'd6 默认用户名首尾空白会被 trim 后使用', 'example.com', '  dev  ', {
    host: 'example.com',
    port: 22,
    username: 'dev'
  })

  // ---- 额外：多次调用互不影响（纯函数无内部状态） ------------------------
  const first = parse('alice@example.com:2222', DEV)
  const second = parse('example.com', DEV)
  const third = parse('alice@example.com:2222', DEV)
  assert(
    JSON.stringify(first) === JSON.stringify(third) && second.ok,
    '重复解析同一输入结果稳定，模块无可变状态'
  )

  console.log(`\n[结果] 通过 ${passed} 项，失败 ${failed} 项`)
  if (failed > 0) process.exitCode = 1
}

try {
  main()
} catch (err) {
  console.error(`\n[失败] ${err.message}`)
  process.exitCode = 1
} finally {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true })
}
