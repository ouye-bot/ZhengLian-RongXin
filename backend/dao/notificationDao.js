const { execute } = require('../config/database');

/**
 * 创建通知
 * @param {Object} notificationData - 通知数据
 * @param {Object} [connection] - 数据库连接（事务中使用）
 * @returns {Promise<Object>} - 创建的通知
 */
exports.create = async (notificationData, connection) => {
  const { user_id, type, title, content, related_id } = notificationData;
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;
  const sql = `
    INSERT INTO user_notifications (user_id, type, title, content, related_id)
    VALUES (?, ?, ?, ?, ?)
  `;
  const result = await exec(sql, [user_id, type, title, content || null, related_id || null]);
  return { id: result.insertId, user_id, type, title, content, related_id, is_read: 0 };
};

/**
 * 根据ID查找通知
 * @param {number} id - 通知ID
 * @param {Object} [connection] - 数据库连接（事务中使用）
 * @returns {Promise<Object|null>} - 通知对象
 */
exports.findById = async (id, connection) => {
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;
  const sql = 'SELECT * FROM user_notifications WHERE id = ?';
  const results = await exec(sql, [id]);
  return results.length > 0 ? results[0] : null;
};

/**
 * 获取用户未读通知数量
 * @param {number} userId - 用户ID
 * @param {Object} [connection] - 数据库连接（事务中使用）
 * @returns {Promise<number>} - 未读通知数量
 */
exports.getUnreadCount = async (userId, connection) => {
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;
  const sql = 'SELECT COUNT(*) AS count FROM user_notifications WHERE user_id = ? AND is_read = 0';
  const results = await exec(sql, [userId]);
  return results[0].count;
};

/**
 * 根据用户ID查找通知列表
 * @param {number} userId - 用户ID
 * @param {Object} options - 查询选项
 * @param {boolean} [options.unreadOnly=false] - 是否只查询未读通知
 * @param {number} [options.page=1] - 页码
 * @param {number} [options.pageSize=20] - 每页数量
 * @param {Object} [connection] - 数据库连接（事务中使用）
 * @returns {Promise<Object>} - { list: Array, total: number }
 */
exports.findByUserId = async (userId, options = {}, connection) => {
  const { unreadOnly = false, page = 1, pageSize = 20 } = options;
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;

  let whereClause = 'WHERE user_id = ?';
  const params = [userId];
  if (unreadOnly) {
    whereClause += ' AND is_read = 0';
  }

  // 查询总数
  const countSql = `SELECT COUNT(*) AS total FROM user_notifications ${whereClause}`;
  const countResults = await exec(countSql, [...params]);
  const total = countResults[0].total;

  // 查询列表
  const offset = (page - 1) * pageSize;
  const listSql = `SELECT * FROM user_notifications ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  const list = await exec(listSql, [...params, pageSize, offset]);

  return { list, total };
};

/**
 * 标记单条通知为已读（带归属校验，防止越权改写他人通知）
 * @param {number} id - 通知ID
 * @param {number} userId - 当前登录用户ID（SQL 层限定只更新本人通知）
 * @param {Object} [connection] - 数据库连接（事务中使用）
 * @returns {Promise<boolean>} - 是否确实更新了该用户的通知（不存在或非本人通知时为 false）
 */
exports.markAsRead = async (id, userId, connection) => {
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;
  const sql = 'UPDATE user_notifications SET is_read = 1 WHERE id = ? AND user_id = ?';
  const result = await exec(sql, [id, userId]);
  return result.affectedRows > 0;
};

/**
 * 标记用户所有未读通知为已读
 * @param {number} userId - 用户ID
 * @param {Object} [connection] - 数据库连接（事务中使用）
 * @returns {Promise<void>}
 */
exports.markAllAsRead = async (userId, connection) => {
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;
  const sql = 'UPDATE user_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0';
  await exec(sql, [userId]);
};

/**
 * 清理过期通知
 * @param {number} expireDays - 过期天数
 * @param {Object} [connection] - 数据库连接（事务中使用）
 * @returns {Promise<number>} - 删除的通知数量
 */
exports.cleanExpired = async (expireDays, connection) => {
  const exec = connection
    ? (sql, params) => connection.execute(sql, params).then(([rows]) => rows)
    : execute;
  const sql = 'DELETE FROM user_notifications WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)';
  const result = await exec(sql, [expireDays]);
  return result.affectedRows;
};
