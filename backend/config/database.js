const mysql = require('mysql2/promise');

// 数据库配置
const config = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '123456',
  database: process.env.DB_NAME || 'finzktrust',
  waitForConnections: true,
  // 阶段3：单进程 50 连接 / 500 排队（当前运维模式：单 node 进程监听 3003）。
  // 诚实口径：若改用 PM2 8 实例集群，总需求 = 8 × 50 = 400 连接，而 3307 专用实例
  // max_connections 实测为 200（SHOW VARIABLES，2026-11-01），必须先调到 ≥400 再上集群，
  // 否则各进程建连会撞 'Too many connections'。
  connectionLimit: 50,
  queueLimit: 500,          // 获取连接的最大排队请求数，超出即报错而非无限堆积
  connectTimeout: 5000,    // 获取连接超时 5 秒
  idleTimeout: 30000,      // 空闲连接 30 秒后释放
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
};

// 先创建数据库
const createDatabase = async () => {
  try {
    // 不指定数据库连接
    const tempConfig = { ...config };
    delete tempConfig.database;
    
    const tempPool = mysql.createPool(tempConfig);
    const connection = await tempPool.getConnection();
    
    // 创建数据库
    await connection.execute(`CREATE DATABASE IF NOT EXISTS ${config.database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`数据库 ${config.database} 创建成功`);
    
    connection.release();
    tempPool.end();
  } catch (error) {
    console.error('创建数据库失败:', error);
  }
};

// 执行数据库创建
createDatabase();

// 创建连接池
const pool = mysql.createPool(config);

/**
 * 执行SQL语句
 * @param {string} sql - SQL语句
 * @param {Array} params - 参数数组
 * @returns {Promise<Array>} - 结果数组
 */
exports.execute = async (sql, params = []) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [results] = await connection.execute(sql, params);
    return results;
  } catch (error) {
    console.error('数据库执行错误:', error);
    throw error;
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

/**
 * 执行事务
 * @param {Function} callback - 事务回调函数
 * @returns {Promise<any>} - 事务结果
 */
exports.transaction = async (callback) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('事务执行错误:', error);
    throw error;
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

exports.pool = pool;
