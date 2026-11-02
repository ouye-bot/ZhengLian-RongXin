const { execute } = require('../config/database');

/**
 * 创建担保合约
 * @param {Object} contractData - 担保合约数据
 * @param {Object} [connection] - 可选数据库连接（用于事务）
 * @returns {Promise<Object>} - 创建的合约
 */
exports.create = async (contractData, connection) => {
  const {
    loan_id,
    borrower_id,
    guarantor_id,
    guarantee_amount,
    fee_rate,
    fee_amount,
    guarantor_signature,
    signature_data,
    status,
    expire_time
  } = contractData;

  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;

  const sql = `
    INSERT INTO risk_guarantee_contracts
      (loan_id, borrower_id, guarantor_id, guarantee_amount, fee_rate,
       fee_amount, guarantor_signature, signature_data, status, expire_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const result = await exec(sql, [
    loan_id != null ? Number(loan_id) : null,
    Number(borrower_id),
    Number(guarantor_id),
    Number(guarantee_amount),
    Number(fee_rate),
    Number(fee_amount),
    guarantor_signature || null,
    signature_data || null,
    status || 'PENDING',
    expire_time || null
  ]);

  return await exports.findById(result.insertId, connection);
};

/**
 * 根据ID查找担保合约
 * @param {number} id - 合约ID
 * @param {Object} [connection] - 可选数据库连接
 * @returns {Promise<Object|null>} - 合约对象
 */
exports.findById = async (id, connection) => {
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;

  const sql = 'SELECT * FROM risk_guarantee_contracts WHERE id = ?';
  const results = await exec(sql, [Number(id)]);
  return results.length > 0 ? results[0] : null;
};

/**
 * 根据贷款ID查找担保合约
 * @param {number} loanId - 贷款ID
 * @param {Object} [connection] - 可选数据库连接
 * @returns {Promise<Object|null>} - 合约对象
 */
exports.findByLoanId = async (loanId, connection) => {
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;

  const sql = 'SELECT * FROM risk_guarantee_contracts WHERE loan_id = ?';
  const results = await exec(sql, [Number(loanId)]);
  return results.length > 0 ? results[0] : null;
};

/**
 * 根据担保人ID查找有效担保合约（PENDING 或 ACTIVE）
 * @param {number} guarantorId - 担保人ID
 * @param {Object} [connection] - 可选数据库连接
 * @returns {Promise<Array<Object>>} - 合约列表
 */
exports.findActiveByGuarantorId = async (guarantorId, connection) => {
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;

  const sql = `
    SELECT * FROM risk_guarantee_contracts
    WHERE guarantor_id = ? AND status IN ('PENDING', 'ACTIVE')
  `;
  return await exec(sql, [Number(guarantorId)]);
};

/**
 * 统计担保人担保次数
 * @param {number} guarantorId - 担保人ID
 * @param {string} [status] - 可选状态筛选（如 'ACTIVE', 'COMPLETED'）
 * @param {Object} [connection] - 可选数据库连接
 * @returns {Promise<number>} - 担保次数
 */
exports.countByGuarantorId = async (guarantorId, status, connection) => {
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;

  let sql = 'SELECT COUNT(*) as count FROM risk_guarantee_contracts WHERE guarantor_id = ?';
  const params = [Number(guarantorId)];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }

  const results = await exec(sql, params);
  return results[0]?.count || 0;
};

/**
 * 更新担保合约状态及可选字段
 * @param {number} id - 合约ID
 * @param {string} status - 新状态
 * @param {Object} [fields={}] - 额外要更新的字段 { field: value }
 * @param {Object} [connection] - 可选数据库连接
 * @returns {Promise<Object|null>} - 更新后的合约
 */
exports.updateStatus = async (id, status, fields = {}, connection) => {
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;

  // 阶段2：担保费代收标记与增量释放额度随状态一并回写（白名单）
  const allowedFields = ['loan_id', 'fee_collected', 'released_amount'];
  const setClauses = ['status = ?'];
  const params = [status];

  for (const [key, value] of Object.entries(fields)) {
    if (!allowedFields.includes(key)) {
      throw new Error(`不允许更新的字段: ${key}`);
    }
    setClauses.push(`${key} = ?`);
    params.push(key === 'loan_id' ? Number(value) : value);
  }

  params.push(Number(id));
  const sql = `UPDATE risk_guarantee_contracts SET ${setClauses.join(', ')} WHERE id = ?`;
  await exec(sql, params);

  return await exports.findById(id, connection);
};
