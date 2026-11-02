const { execute } = require('../config/database');

/**
 * 创建保证金订单
 * @param {Object} orderData - 订单数据
 * @param {Object} [connection] - 可选事务连接
 * @returns {Promise<Object>} - 创建的订单
 */
exports.create = async (orderData, connection) => {
  const { loan_id, user_id, margin_amount, margin_rate, frozen_interest, status } = orderData;

  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;

  const sql = `
    INSERT INTO risk_margin_orders (loan_id, user_id, margin_amount, margin_rate, frozen_interest, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  const result = await exec(sql, [
    loan_id,
    user_id,
    Number(margin_amount),
    Number(margin_rate),
    Number(frozen_interest || 0),
    status || 'FROZEN'
  ]);

  return await exports.findById(result.insertId, connection);
};

/**
 * 根据ID查找保证金订单
 * @param {number} id - 订单ID
 * @param {Object} [connection] - 可选事务连接
 * @returns {Promise<Object|null>} - 订单对象
 */
exports.findById = async (id, connection) => {
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;

  const sql = 'SELECT * FROM risk_margin_orders WHERE id = ?';
  const results = await exec(sql, [id]);

  if (results.length > 0) {
    const order = { ...results[0] };
    order.id = Number(order.id);
    order.loan_id = order.loan_id != null ? Number(order.loan_id) : null;
    order.user_id = Number(order.user_id);
    order.margin_amount = Number(order.margin_amount);
    order.margin_rate = Number(order.margin_rate);
    order.frozen_interest = Number(order.frozen_interest);
    return order;
  }
  return null;
};

/**
 * 根据贷款ID查找保证金订单
 * @param {number} loanId - 贷款ID
 * @param {Object} [connection] - 可选事务连接
 * @returns {Promise<Object|null>} - 订单对象
 */
exports.findByLoanId = async (loanId, connection) => {
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;

  const sql = 'SELECT * FROM risk_margin_orders WHERE loan_id = ?';
  const results = await exec(sql, [loanId]);

  if (results.length > 0) {
    const order = { ...results[0] };
    order.id = Number(order.id);
    order.loan_id = Number(order.loan_id);
    order.user_id = Number(order.user_id);
    order.margin_amount = Number(order.margin_amount);
    order.margin_rate = Number(order.margin_rate);
    order.frozen_interest = Number(order.frozen_interest);
    return order;
  }
  return null;
};

/**
 * 根据用户ID查找保证金订单
 * @param {number} userId - 用户ID
 * @param {Object} options - 选项
 * @param {string} [options.status] - 状态筛选
 * @param {number} [options.limit] - 分页限制
 * @param {number} [options.offset] - 分页偏移
 * @param {Object} [connection] - 可选事务连接
 * @returns {Promise<Array>} - 订单列表
 */
exports.findByUserId = async (userId, options = {}, connection) => {
  const { limit, offset, status } = options;

  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;

  let sql = 'SELECT * FROM risk_margin_orders WHERE user_id = ?';
  const params = [userId];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }

  sql += ' ORDER BY created_at DESC';

  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  if (offset) {
    sql += ' OFFSET ?';
    params.push(offset);
  }

  const results = await exec(sql, params);
  const mapped = [];
  for (const row of results) {
    const order = { ...row };
    order.id = Number(order.id);
    order.loan_id = order.loan_id != null ? Number(order.loan_id) : null;
    order.user_id = Number(order.user_id);
    order.margin_amount = Number(order.margin_amount);
    order.margin_rate = Number(order.margin_rate);
    order.frozen_interest = Number(order.frozen_interest);
    mapped.push(order);
  }
  return mapped;
};

/**
 * 更新保证金订单状态
 * @param {number} id - 订单ID
 * @param {string} status - 新状态
 * @param {Object} [fields] - 可选的额外字段更新
 * @param {Object} [connection] - 可选事务连接
 * @returns {Promise<Object>} - 更新后的订单
 */
exports.updateStatus = async (id, status, fields = {}, connection) => {
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;

  const setClauses = ['status = ?'];
  const params = [status];

  for (const [key, value] of Object.entries(fields)) {
    if (key === 'margin_amount' || key === 'margin_rate' || key === 'frozen_interest') {
      setClauses.push(`${key} = ?`);
      params.push(Number(value));
    }
  }

  params.push(id);
  const sql = `UPDATE risk_margin_orders SET ${setClauses.join(', ')} WHERE id = ?`;
  await exec(sql, params);

  return await exports.findById(id, connection);
};
