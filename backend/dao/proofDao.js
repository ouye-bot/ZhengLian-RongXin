const { execute } = require('../config/database');

/**
 * 创建信用证明
 * @param {Object} proofData - 证明数据
 * @returns {Promise<Object>} - 创建的证明
 */
exports.create = async (proofData) => {
  const { user_id, proof_id, verification_code, sm3_hash, proof_data, expires_at, code_expires_at, zk_proof, public_signals } = proofData;
  // code_expires_at：验证口令 24h 有效期（credit.js 生成时写入）；未提供时为 NULL（存量/旧调用方退回 expires_at 口径）
  const sql = `
    INSERT INTO credit_proofs (user_id, proof_id, verification_code, sm3_hash, proof_data, expires_at, code_expires_at, zk_proof, public_signals)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const result = await execute(sql, [
    user_id,
    proof_id,
    verification_code,
    sm3_hash,
    proof_data,
    expires_at,
    code_expires_at ?? null,
    zk_proof ?? null,
    public_signals ?? null
  ]);
  return await exports.findById(result.insertId);
};

/**
 * 根据ID查找证明
 * @param {number} id - 证明ID
 * @returns {Promise<Object|null>} - 证明对象
 */
exports.findById = async (id) => {
  const sql = 'SELECT * FROM credit_proofs WHERE id = ?';
  const results = await execute(sql, [id]);
  return results.length > 0 ? results[0] : null;
};

/**
 * 根据proof_id查找证明
 * @param {string} proofId - 证明ID
 * @returns {Promise<Object|null>} - 证明对象
 */
exports.findByProofId = async (proofId) => {
  const sql = 'SELECT * FROM credit_proofs WHERE proof_id = ?';
  const results = await execute(sql, [proofId]);
  return results.length > 0 ? results[0] : null;
};

/**
 * 根据用户ID查找证明
 * @param {number} userId - 用户ID
 * @returns {Promise<Array>} - 证明列表
 */
exports.findByUserId = async (userId) => {
  const sql = 'SELECT * FROM credit_proofs WHERE user_id = ? ORDER BY created_at DESC';
  return await execute(sql, [userId]);
};

/**
 * 删除过期的证明
 * @returns {Promise<number>} - 删除的行数
 */
exports.deleteExpired = async () => {
  const sql = 'DELETE FROM credit_proofs WHERE expires_at < NOW()';
  const result = await execute(sql);
  return result.affectedRows;
};
