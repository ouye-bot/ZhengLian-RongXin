const { execute, transaction } = require('../config/database');

/**
 * 创建担保请求
 * @param {Object} requestData - 担保请求数据
 * @param {Object} [connection] - 数据库连接（事务中使用）
 * @returns {Promise<Object>} - 创建的担保请求
 */
exports.create = async (requestData, connection) => {
  const {
    borrower_id,
    guarantor_id,
    loan_amount,
    proposed_fee_rate,
    borrower_signature
  } = requestData;

  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;

  // 默认过期时间：24小时后
  const defaultExpireTime = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const sql = `
    INSERT INTO guarantee_requests
      (borrower_id, guarantor_id, loan_amount, proposed_fee_rate,
       status, expire_time, borrower_signature)
    VALUES (?, ?, ?, ?, 'PENDING', ?, ?)
  `;
  const result = await exec(sql, [
    borrower_id,
    guarantor_id,
    loan_amount,
    proposed_fee_rate,
    defaultExpireTime,
    borrower_signature || null
  ]);

  const rows = await exports.findById(result.insertId, connection);
  return rows;
};

/**
 * 根据ID查找担保请求
 * @param {number} id - 担保请求ID
 * @param {Object} [connection] - 数据库连接（事务中使用）
 * @returns {Promise<Object|null>} - 担保请求对象
 */
exports.findById = async (id, connection) => {
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;

  const sql = 'SELECT * FROM guarantee_requests WHERE id = ?';
  const results = await exec(sql, [id]);
  return results.length > 0 ? results[0] : null;
};

/**
 * 根据担保人ID查找待处理的担保请求
 * @param {number} guarantorId - 担保人ID
 * @param {Object} [connection] - 数据库连接（事务中使用）
 * @returns {Promise<Array>} - 担保请求列表
 */
exports.findPendingByGuarantorId = async (guarantorId, connection) => {
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;

  const sql = `
    SELECT * FROM guarantee_requests
    WHERE guarantor_id = ? AND status = 'PENDING'
    ORDER BY created_at DESC
  `;
  return await exec(sql, [guarantorId]);
};

/**
 * 根据借款人ID查找担保请求
 * @param {number} borrowerId - 借款人ID
 * @param {Object} [options] - 可选参数
 * @param {string} [options.status] - 按状态过滤
 * @param {Object} [connection] - 数据库连接（事务中使用）
 * @returns {Promise<Array>} - 担保请求列表
 */
exports.findByBorrowerId = async (borrowerId, options = {}, connection) => {
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;

  const conditions = ['borrower_id = ?'];
  const params = [borrowerId];

  if (options.status) {
    conditions.push('status = ?');
    params.push(options.status);
  }

  const sql = `
    SELECT * FROM guarantee_requests
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC
  `;
  return await exec(sql, params);
};

/**
 * 更新担保请求状态
 * @param {number} id - 担保请求ID
 * @param {string} status - 新状态
 * @param {Object} [fields] - 附加更新字段
 * @param {Object} [connection] - 数据库连接（事务中使用）
 * @returns {Promise<void>}
 */
exports.updateStatus = async (id, status, fields = {}, connection) => {
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;

  const setClauses = ['status = ?'];
  const params = [status];

  if (fields.guarantor_signature !== undefined) {
    setClauses.push('guarantor_signature = ?');
    params.push(fields.guarantor_signature);
  }

  params.push(id);
  const sql = `UPDATE guarantee_requests SET ${setClauses.join(', ')} WHERE id = ?`;
  await exec(sql, params);
};

/**
 * 清理过期的担保请求
 * @param {Object} [connection] - 数据库连接（事务中使用）
 * @returns {Promise<number>} - 影响的行数
 */
exports.cleanExpired = async (connection) => {
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;

  const sql = `
    UPDATE guarantee_requests
    SET status = 'EXPIRED'
    WHERE status = 'PENDING' AND expire_time < NOW()
  `;
  const result = await exec(sql, []);
  // mysql2 返回的 result 可能是 ResultSetHeader，通过 affectedRows 获取
  return result.affectedRows !== undefined ? result.affectedRows : 0;
};
