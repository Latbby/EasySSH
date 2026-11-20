/**
 * 验证脚本共用的主机密钥生成辅助。
 *
 * 背景：ssh2 的 `utils.generateKeyPairSync('ed25519')` 偶发产出连它自己的 `utils.parseKey`
 * 都拒绝的私钥（本机实测约 1/60，报错 "Malformed OpenSSH private key"），属上游缺陷。
 * 各脚本若直接使用，会以每把约 1.7% 的概率随机假失败（一次跑多把密钥时概率更高），
 * 排查成本远高于收益，因此统一走这里：生成后立刻自检，不通过就重试。
 */
const { utils } = require('ssh2')

/**
 * 生成一对可被 ssh2 正常解析的 ed25519 主机密钥。
 * @returns {{ private: string, public: string }} OpenSSH 格式的私钥与公钥
 */
function generateHostKeyPair() {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const pair = utils.generateKeyPairSync('ed25519')
    if (!(utils.parseKey(pair.private) instanceof Error)) return pair
  }
  throw new Error('连续生成 25 对主机密钥都无法被 ssh2 解析，疑似上游 generateKeyPairSync 异常')
}

/**
 * 只取私钥的便捷写法。
 * @returns {string} OpenSSH 格式的 ed25519 主机私钥
 */
function generateHostKey() {
  return generateHostKeyPair().private
}

module.exports = { generateHostKey, generateHostKeyPair }
