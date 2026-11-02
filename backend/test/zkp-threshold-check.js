/**
 * 阶段3 执行员验证：阈值强核 / 库读分数 / 24h 口令 / 新 Verifier 链上断言 / 冒烟回归
 * ─────────────────────────────────────────────────────────
 * 组1 本地强核：verifyProof 第三参（requiredThreshold=600）拒低阈值证明、过合规证明、两参旧口径兼容
 * 组2 API 分支：/credit/generate-proof 拒 threshold=0 证明、过 threshold=600 证明（并断言 code_expires_at 24h 落库）；
 *              /zk/generate-proof 缺 userId → 400；请求体伪报低分 300 被忽略——库读 700≥600 → isValid=1
 *              （creditScore 是私有输入不出现在 publicSignals，只能通过 isValid 位反证分数来源）
 * 组3 链上断言：新 Verifier 地址 call 验证通过=true；同 calldata 打旧 1 信号地址（0xaf54ab…）应 status≠0；
 *              篡改 publicSignals[0]='0' 应 false。链不可达 → [SKIP]
 * 组4 冒烟回归：登录→(缓存命中)→登出→旧 token 立即 401；GET /pool 200；
 *              池缓存进程内证据（4c：二次读不打 DB、poolDao 写后失效）；
 *              4d：真实业务写路径——HTTP /invest（事务内直写 fund_pool）提交后，服务端 /pool 缓存立即反映
 * 运行：node backend/test/zkp-threshold-check.js（后端须在线）
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const axios = require('axios');
const mysql = require('mysql2/promise');
const sm2 = require('sm-crypto').sm2;
const { ethers } = require('ethers');

const { canonicalStringify, signWithSM2, generateSM3Hash, buildSignatureData } = require('../utils/cryptoUtils');
const { encryptFields } = require('../utils/sm4Crypto');
const zkService = require('../services/zkService');
const poolService = require('../services/poolService');
const poolDao = require('../dao/poolDao');
const { poolCache } = require('../utils/ttlCache');

const BASE = 'http://127.0.0.1:3003';
const API = `${BASE}/api/v1`;
const REQUIRED_THRESHOLD = 600; // 借款准入阈值（credit.js PROOF_REQUIRED_THRESHOLD 同口径）
const OLD_VERIFIER_ADDR = '0xaf54ab2299cfd70f0387a2589af546b22708bc01'; // 重部署前旧 1 信号地址（out/stage3-backup 备份，负向断言用）

function fail(msg) { throw new Error(`断言失败：${msg}`); }
function assert(cond, msg) { if (!cond) fail(msg); }

function financialHeaders(user, body) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = signWithSM2(timestamp + nonce + canonicalStringify(body), user.privKey);
  return {
    'x-user-id': String(user.id),
    'x-request-timestamp': timestamp,
    'x-request-nonce': nonce,
    'x-sm2-signature': signature
  };
}
async function post(user, urlPath, body) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${user.jwt}`, ...financialHeaders(user, body) };
  return axios.post(`${API}${urlPath}`, body, { headers, validateStatus: () => true, timeout: 60000 });
}
async function get(user, urlPath) {
  const headers = user ? { Authorization: `Bearer ${user.jwt}`, ...financialHeaders(user, {}) } : {};
  return axios.get(`${API}${urlPath}`, { headers, validateStatus: () => true, timeout: 30000 });
}

// FISCO JSON-RPC（与 backend/scripts/deploy-fisco.js 相同通道）
function rpcCall(method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() });
    const url = new URL(process.env.FISCO_BCOS_RPC_URL || 'http://127.0.0.1:8545');
    const req = http.request({
      hostname: url.hostname, port: url.port || 80, path: url.pathname || '/', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 15000
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          else resolve(parsed.result);
        } catch (e) { reject(new Error(`RPC parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('RPC timeout')); });
    req.write(body); req.end();
  });
}

let db;

async function register(kp, tag) {
  const ts = Date.now();
  const username = `thk_${tag}_${ts}`;
  const resp = await axios.post(`${API}/auth/register`, { username, password: 'E2ePassw0rd', sm2PublicKey: kp.publicKey }, { validateStatus: () => true, timeout: 15000 });
  if (resp.status !== 200 || !resp.data.success) throw new Error(`注册失败：${JSON.stringify(resp.data).slice(0, 200)}`);
  const id = resp.data.user.id;
  const login = await axios.post(`${API}/auth/login`, { username, password: 'E2ePassw0rd' }, { validateStatus: () => true, timeout: 15000 });
  const user = { id, jwt: login.data.token, privKey: kp.privateKey };
  // 夹具：balance 5000 / credit_score 700（信封加密直写库，与 phase2-adhoc 同模式）
  const data = { balance: 5000, credit_score: 700 };
  await encryptFields('users', data, id, db);
  await db.execute('UPDATE users SET balance=?, credit_score=? WHERE id=?', [data.balance, data.credit_score, id]);
  return user;
}

function proofCallArgs(zk, userAddress) {
  const sm3Hash = generateSM3Hash(JSON.stringify({ proof: zk.proof, publicSignals: zk.publicSignals }));
  // pB 必须按 EVM 配对预编译口径做 G2 (im,re) 交换（与 blockchainServiceFisco.verifyZKPOnChain L457 同口径；
  // snarkjs 证明 JSON 为 [x_re,x_im]，预编译要求 [x_im,x_re]）
  const pB = [[zk.proof.pi_b[0][1], zk.proof.pi_b[0][0]], [zk.proof.pi_b[1][1], zk.proof.pi_b[1][0]]];
  return [userAddress, zk.proof.pi_a.slice(0, 2), pB, zk.proof.pi_c.slice(0, 2), zk.publicSignals, '0x' + sm3Hash];
}

(async () => {
  const failures = [];
  const run = async (name, fn) => {
    console.log(`\n== ${name}`);
    try { await fn(); console.log(`  ✅ ${name} —— 通过`); }
    catch (e) { failures.push(`${name} :: ${(e && e.message) || e}`); console.error(`  ❌ [FAIL] ${name}\n     ${(e && e.message) || e}`); }
  };

  // 预检
  const health = await axios.get(`${BASE}/health`, { timeout: 5000 });
  assert(health.data && health.data.status === 'ok', '后端不在线');
  db = await mysql.createConnection({ host: '127.0.0.1', port: 3307, user: process.env.DB_USER || 'finzktrust', password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'finzktrust' });
  console.log('预检：后端在线、数据库可达');

  const userA = await register(sm2.generateKeyPairHex(), 'a');
  const userB = await register(sm2.generateKeyPairHex(), 'b');
  console.log(`夹具用户 A#${userA.id}（700/借款链路） B#${userB.id}（登出冒烟）`);

  // ─────────────────────────────────────────────────────
  // 组1 本地强核
  // ─────────────────────────────────────────────────────
  let zkOk; // threshold=600 的合规证明，供组2/组3 复用
  await run('组1a 阈值0证明 + 强核600 → false', async () => {
    const zk = await zkService.generateProof(750, 0, 1);
    assert(zk.publicSignals.length === 2, `publicSignals 应为2个，实得 ${zk.publicSignals.length}`);
    const ok = await zkService.verifyProof(zk.proof, zk.publicSignals, REQUIRED_THRESHOLD);
    assert(ok === false, `阈值0证明在强核600下应为 false，实得 ${ok}`);
  });

  await run('组1b 阈值600证明 + 强核600 → true', async () => {
    zkOk = await zkService.generateProof(750, REQUIRED_THRESHOLD, 1);
    const ok = await zkService.verifyProof(zkOk.proof, zkOk.publicSignals, REQUIRED_THRESHOLD);
    assert(ok === true, `阈值600证明在强核600下应为 true，实得 ${ok}`);
  });

  await run('组1c 两参旧口径（不带阈值）仍通过', async () => {
    const ok = await zkService.verifyProof(zkOk.proof, zkOk.publicSignals);
    assert(ok === true, `不带第三参的旧口径应为 true，实得 ${ok}`);
  });

  // ─────────────────────────────────────────────────────
  // 组2 API 分支
  // ─────────────────────────────────────────────────────
  await run('组2a /credit/generate-proof 拒 threshold=0 证明 → 400', async () => {
    const zk = await zkService.generateProof(700, 0, 1);
    const signature = signWithSM2(JSON.stringify({ userId: String(userA.id), creditScore: 700 }), userA.privKey);
    const resp = await post(userA, '/credit/generate-proof', { userId: userA.id, proof: zk.proof, publicSignals: zk.publicSignals, signature });
    assert(resp.status === 400, `期望 400 实得 ${resp.status}：${JSON.stringify(resp.data).slice(0, 200)}`);
    assert(resp.data.success === false, 'success 应为 false');
  });

  let savedProofId;
  let savedVerificationCode;
  await run('组2b /credit/generate-proof 过 threshold=600 证明 + code_expires_at 24h 落库', async () => {
    const zk = await zkService.generateProof(700, REQUIRED_THRESHOLD, 1);
    const signature = signWithSM2(JSON.stringify({ userId: String(userA.id), creditScore: 700 }), userA.privKey);
    const resp = await post(userA, '/credit/generate-proof', { userId: userA.id, proof: zk.proof, publicSignals: zk.publicSignals, signature });
    assert(resp.status === 200 && resp.data.success === true, `期望 success，实得 ${resp.status}：${JSON.stringify(resp.data).slice(0, 200)}`);
    savedProofId = resp.data.data.proof.proofId;
    savedVerificationCode = resp.data.data.proof.verificationCode;

    const [rows] = await db.execute('SELECT code_expires_at, expires_at FROM credit_proofs WHERE proof_id = ?', [savedProofId]);
    assert(rows.length === 1, '证明未落库');
    const { code_expires_at, expires_at } = rows[0];
    assert(code_expires_at !== null, 'code_expires_at 应已写入（非 NULL）');
    const hours = (new Date(code_expires_at) - Date.now()) / 3600000;
    assert(hours > 23.5 && hours < 24.5, `口令有效期应 ≈24h，实得 ${hours.toFixed(2)}h`);
    const days = (new Date(expires_at) - Date.now()) / 86400000;
    assert(days > 21 && days < 31, `证明本体 expires_at 应在库（存量 UTC 串口径 ≈22d~30d），实得 ${days.toFixed(2)}d`);
  });

  async function runZkTask(user, body) {
    const resp = await post(user, '/zk/generate-proof', body);
    assert(resp.status === 202 && resp.data.success === true, `期望 202，实得 ${resp.status}：${JSON.stringify(resp.data).slice(0, 200)}`);
    const taskId = resp.data.taskId;
    let status = null, deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const s = await get(user, `/zk/task/${taskId}`);
      if (s.status === 200 && s.data.success && (s.data.status === 'completed' || s.data.status === 'failed')) { status = s.data; break; }
    }
    assert(status && status.status === 'completed', `任务未完成：${JSON.stringify(status || 'timeout').slice(0, 300)}`);
    return status.result.publicSignals;
  }

  await run('组2c /zk/generate-proof：缺 userId → 400；伪报低分被库读分覆盖', async () => {
    // userId 必填
    const noUser = await post(userA, '/zk/generate-proof', { creditScore: 700, threshold: REQUIRED_THRESHOLD });
    assert(noUser.status === 400, `缺 userId 期望 400，实得 ${noUser.status}`);
    assert(noUser.data.success === false, 'success 应为 false');

    // 伪报 creditScore=300（< 阈值 600）：若走 body 分数，isValid=0；走库读 700 则 isValid=1
    const signals = await runZkTask(userA, { creditScore: 300, threshold: REQUIRED_THRESHOLD, userId: userA.id });
    assert(Array.isArray(signals) && signals.length === 2, `publicSignals 应为2个：${JSON.stringify(signals)}`);
    assert(String(signals[0]) === '1', `库读分 700≥600 应 isValid=1（若为 0 说明误用了 body 伪报的 300），实得 ${signals[0]}`);
    assert(String(signals[1]) === '600', `公开阈值应透传 body 的 600，实得 ${signals[1]}`);

    // 交叉验证：阈值 800 > 库读 700 → isValid=0（证明 isValid 位与阈值透传真实生效）
    const signals2 = await runZkTask(userA, { creditScore: 300, threshold: 800, userId: userA.id });
    assert(String(signals2[0]) === '0' && String(signals2[1]) === '800', `700<800 应 isValid=0 且阈值 800，实得 ${signals2}`);
  });

  // ─────────────────────────────────────────────────────
  // 组3 链上断言（链不可达 → SKIP）
  // ─────────────────────────────────────────────────────
  let chainSkipped = false;
  await run('组3 链上：新地址 true / 旧地址 status≠0 / 篡改信号 false', async () => {
    try {
      await rpcCall('getClientVersion');
    } catch (e) {
      chainSkipped = true;
      console.log('  [SKIP] 链上分支：节点不可用（' + e.message + '）');
      return;
    }

    const addresses = require('../contract-addresses.json');
    const newAddr = addresses['fisco-bcos'].contracts.Verifier;
    const deployer = addresses['fisco-bcos'].deployer;
    assert(newAddr && newAddr.toLowerCase() !== OLD_VERIFIER_ADDR, `新地址无效：${newAddr}`);
    const artifact = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../contracts/artifacts/contracts/Verifier.sol/Verifier.json'), 'utf8'));
    const iface = new ethers.utils.Interface(artifact.abi);
    console.log(`  新地址=${newAddr}（旧=${OLD_VERIFIER_ADDR}）`);

    // 3a 新合约：合规证明（publicSignals=[1,600]）→ call 解码 true
    const dataOk = iface.encodeFunctionData('verifyProof', proofCallArgs(zkOk, deployer));
    const r1 = await rpcCall('call', [1, { from: deployer, to: newAddr, data: dataOk }]);
    assert(r1 && r1.status === '0x0', `新地址 call status=${r1 && r1.status}`);
    const [okNew] = iface.decodeFunctionResult('verifyProof', r1.output);
    assert(okNew === true, `新地址验证应 true，实得 ${okNew}`);

    // 3b 同 calldata 打旧 1 信号地址 → 函数选择子不匹配，status≠0（revert）
    let oldRejected = false, oldDetail = '';
    try {
      const r2 = await rpcCall('call', [1, { from: deployer, to: OLD_VERIFIER_ADDR, data: dataOk }]);
      oldDetail = `status=${r2 && r2.status}, output=${r2 && r2.output}`;
      oldRejected = !(r2 && r2.status === '0x0');
    } catch (e) { oldRejected = true; oldDetail = `rpc error: ${e.message}`; }
    assert(oldRejected, `旧地址应拒绝 6 参 calldata（选择子不匹配），却成功返回 ${oldDetail}`);

    // 3c 新合约：篡改 publicSignals[0]='0' → call 成功但解码 false
    const tampered = JSON.parse(JSON.stringify(zkOk));
    tampered.publicSignals = ['0', tampered.publicSignals[1]];
    const dataBad = iface.encodeFunctionData('verifyProof', proofCallArgs(tampered, deployer));
    const r3 = await rpcCall('call', [1, { from: deployer, to: newAddr, data: dataBad }]);
    assert(r3 && r3.status === '0x0', `篡改信号的 call 应可执行（密码学层裁决），status=${r3 && r3.status}`);
    const [okBad] = iface.decodeFunctionResult('verifyProof', r3.output);
    assert(okBad === false, `篡改 publicSignals 后应 false，实得 ${okBad}`);
  });

  // ─────────────────────────────────────────────────────
  // 组4 冒烟回归
  // ─────────────────────────────────────────────────────
  await run('组4a 登录→访问(缓存命中)→登出→旧 token 立即 401', async () => {
    // 先带 token 访问受保护端点，令 validTokens 缓存生效（再登出必须即时清除）
    const p1 = await get(userB, '/pool');
    assert(p1.status === 200 && p1.data.success !== false, `登出前 /pool 应 200，实得 ${p1.status}`);
    const lo = await post(userB, '/auth/logout', {});
    assert(lo.status === 200 || lo.status === 201 || (lo.data && lo.data.success === true), `登出应成功：${lo.status} ${JSON.stringify(lo.data).slice(0, 200)}`);
    const p2 = await get(userB, '/pool');
    assert(p2.status === 401, `登出后旧 token 应立即 401，实得 ${p2.status}`);
  });

  await run('组4b GET /api/v1/pool 200（连续两次）', async () => {
    const p1 = await get(userA, '/pool');
    assert(p1.status === 200, `第一次 /pool 实得 ${p1.status}`);
    const p2 = await get(userA, '/pool');
    assert(p2.status === 200, `第二次 /pool 实得 ${p2.status}`);
  });

  await run('组4c 池缓存进程内证据：二次读不打 DB；poolDao 写后失效', async () => {
    poolCache.erase('poolInfo'); // 从干净状态开始
    let calls = 0;
    const orig = poolDao.getPool.bind(poolDao);
    poolDao.getPool = async (...a) => { calls++; return orig(...a); };
    try {
      await poolService.getPoolInfo();
      assert(calls === 1, `首次读应打 DB 1 次，实得 ${calls}`);
      await poolService.getPoolInfo();
      assert(calls === 1, `5s 内二次读应命中缓存，DB 调用数应仍为 1，实得 ${calls}`);

      // 写失效：把当前值原样写回（幂等，不改池数据）→ 缓存应被 erase → 下次读重新打 DB
      const pool = await orig();
      await poolDao.updatePoolV2({
        platform_capital: pool.platform_capital,
        user_capital: pool.user_capital,
        loaned_amount: pool.loaned_amount,
        total_interest_earned: pool.total_interest_earned,
        user_interest_earned: pool.user_interest_earned
      });
      await poolService.getPoolInfo();
      assert(calls === 2, `写失效后再次读应重新打 DB（共2次），实得 ${calls}`);
    } finally {
      poolDao.getPool = orig;
    }
  });

  await run('组4d 真实业务写路径：HTTP /invest（事务内直写 fund_pool）提交后，服务端 /pool 缓存立即反映', async () => {
    // 背景：fund_pool 的业务写（invest/redeem/borrow/repay/riskPlugins/autoRedeem）不经 poolDao，而是在各自事务内
    // 直接 UPDATE；每条写路径须在提交后调用 invalidatePoolReadCaches。本组用真实 HTTP 出资在**服务端进程**验证：
    // 先 GET /pool 令服务端 'poolInfo'/'poolHealth' 入缓存 → POST /invest 100 → 5s TTL 内立刻再 GET /pool，
    // 若写后未失效，第二次会返回写前旧值（userCapital 不变）。
    assert(savedVerificationCode, '需先完成组2b 取得验证口令');
    const p1 = await get(userA, '/pool');
    assert(p1.status === 200 && p1.data.pool, `写前 GET /pool 应 200，实得 ${p1.status}`);
    const ucBefore = Number(p1.data.pool.userCapital);

    const INVEST = 100;
    const body = {
      userId: userA.id, amount: INVEST, term: 30,
      creditProof: { id: savedProofId },
      verificationCode: savedVerificationCode,
      signature: signWithSM2(
        buildSignatureData({ userId: String(userA.id), amount: INVEST, term: 30, creditProofId: savedProofId }, ['amount', 'creditProofId', 'term', 'userId']),
        userA.privKey
      )
    };
    const inv = await post(userA, '/invest', body);
    assert(inv.status === 200 && inv.data.success === true, `出资应成功，实得 ${inv.status}：${JSON.stringify(inv.data).slice(0, 200)}`);

    const p2 = await get(userA, '/pool'); // 紧随写后（远小于 5s TTL）
    assert(p2.status === 200 && p2.data.pool, `写后 GET /pool 应 200，实得 ${p2.status}`);
    const ucAfter = Number(p2.data.pool.userCapital);
    assert(Math.abs(ucAfter - ucBefore - INVEST) < 0.011,
      `invest 提交后 /pool.userCapital 应立即 +${INVEST}（写前 ${ucBefore} → 写后 ${ucAfter}）；若相等即服务端缓存未失效（5s 旧值窗口回归）`);
  });

  console.log('\n──────────────────────────────');
  if (chainSkipped) console.log('（链上组已 SKIP：FISCO 节点不可达）');
  if (failures.length > 0) {
    console.error(`❌ ${failures.length} 项失败：`);
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('✅ 全部断言通过');
  await db.end();
  process.exit(0);
})().catch(async e => {
  console.error('[FATAL]', e.message);
  if (db) await db.end().catch(() => {});
  process.exit(1);
});
