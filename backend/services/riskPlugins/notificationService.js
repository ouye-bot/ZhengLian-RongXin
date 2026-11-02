const notificationDao = require('../../dao/notificationDao');
const guaranteeRequestDao = require('../../dao/guaranteeRequestDao');
const logger = require('../../utils/logger');

class NotificationService {
  /**
   * 发送担保请求通知给担保人
   * @param {number} guarantorId - 担保人ID
   * @param {string} borrowerUsername - 借款人用户名
   * @param {number} loanAmount - 贷款金额
   * @param {number} requestId - 担保请求ID
   * @returns {Promise<Object>} - 创建的通知
   */
  async sendGuaranteeRequestNotification(guarantorId, borrowerUsername, loanAmount, requestId) {
    try {
      const title = '新的担保请求';
      const content = `用户 ${borrowerUsername} 请求您为贷款金额 ${loanAmount} 元提供担保。请及时处理。`;
      const notification = await notificationDao.create({
        user_id: guarantorId,
        type: 'GUARANTEE_REQUEST',
        title,
        content,
        related_id: requestId
      });
      logger.info('发送担保请求通知成功', { guarantorId, borrowerUsername, loanAmount, requestId });
      return notification;
    } catch (error) {
      logger.error('发送担保请求通知失败', { error: error.message, guarantorId, borrowerUsername, loanAmount, requestId });
      throw error;
    }
  }

  /**
   * 发送担保接受通知给借款人
   * @param {number} borrowerId - 借款人ID
   * @param {string} guarantorUsername - 担保人用户名
   * @param {number} requestId - 担保请求ID
   * @returns {Promise<Object>} - 创建的通知
   */
  async sendGuaranteeAcceptedNotification(borrowerId, guarantorUsername, requestId) {
    try {
      const title = '担保请求已接受';
      const content = `用户 ${guarantorUsername} 已接受您的担保请求。请继续完成后续流程。`;
      const notification = await notificationDao.create({
        user_id: borrowerId,
        type: 'GUARANTEE_ACCEPTED',
        title,
        content,
        related_id: requestId
      });
      logger.info('发送担保接受通知成功', { borrowerId, guarantorUsername, requestId });
      return notification;
    } catch (error) {
      logger.error('发送担保接受通知失败', { error: error.message, borrowerId, guarantorUsername, requestId });
      throw error;
    }
  }

  /**
   * 发送担保拒绝通知给借款人
   * @param {number} borrowerId - 借款人ID
   * @param {string} guarantorUsername - 担保人用户名
   * @param {number} requestId - 担保请求ID
   * @returns {Promise<Object>} - 创建的通知
   */
  async sendGuaranteeRejectedNotification(borrowerId, guarantorUsername, requestId) {
    try {
      const title = '担保请求已拒绝';
      const content = `用户 ${guarantorUsername} 已拒绝您的担保请求。`;
      const notification = await notificationDao.create({
        user_id: borrowerId,
        type: 'GUARANTEE_REJECTED',
        title,
        content,
        related_id: requestId
      });
      logger.info('发送担保拒绝通知成功', { borrowerId, guarantorUsername, requestId });
      return notification;
    } catch (error) {
      logger.error('发送担保拒绝通知失败', { error: error.message, borrowerId, guarantorUsername, requestId });
      throw error;
    }
  }

  /**
   * 发送逾期提醒通知
   * @param {number} userId - 用户ID
   * @param {number} loanId - 贷款ID
   * @param {number} overdueDays - 逾期天数
   * @returns {Promise<Object>} - 创建的通知
   */
  async sendOverdueNotification(userId, loanId, overdueDays) {
    try {
      const title = '贷款逾期提醒';
      const content = `您的贷款已逾期 ${overdueDays} 天，请尽快处理以避免产生更多费用。`;
      const notification = await notificationDao.create({
        user_id: userId,
        type: 'OVERDUE_REMINDER',
        title,
        content,
        related_id: loanId
      });
      logger.info('发送逾期提醒通知成功', { userId, loanId, overdueDays });
      return notification;
    } catch (error) {
      logger.error('发送逾期提醒通知失败', { error: error.message, userId, loanId, overdueDays });
      throw error;
    }
  }

  /**
   * 获取用户未读通知数量
   * @param {number} userId - 用户ID
   * @returns {Promise<number>} - 未读通知数量
   */
  async getUnreadCount(userId) {
    try {
      const count = await notificationDao.getUnreadCount(userId);
      return count;
    } catch (error) {
      logger.error('获取未读通知数量失败', { error: error.message, userId });
      throw error;
    }
  }

  /**
   * 获取用户通知列表
   * @param {number} userId - 用户ID
   * @param {number} page - 页码
   * @param {number} pageSize - 每页数量
   * @returns {Promise<Object>} - { list, total }
   */
  async getNotifications(userId, page = 1, pageSize = 20) {
    try {
      const result = await notificationDao.findByUserId(userId, { page, pageSize });
      return result;
    } catch (error) {
      logger.error('获取通知列表失败', { error: error.message, userId, page, pageSize });
      throw error;
    }
  }

  /**
   * 标记通知为已读（校验通知归属用户）
   * @param {number} notificationId - 通知ID
   * @param {number} userId - 当前登录用户ID
   * @returns {Promise<boolean>} - 通知存在且属于该用户时为 true
   */
  async markAsRead(notificationId, userId) {
    try {
      const updated = await notificationDao.markAsRead(notificationId, userId);
      if (updated) {
        logger.info('标记通知已读', { notificationId, userId });
      } else {
        logger.warning('标记通知已读失败：通知不存在或无权操作', { notificationId, userId });
      }
      return updated;
    } catch (error) {
      logger.error('标记通知已读失败', { error: error.message, notificationId, userId });
      throw error;
    }
  }

  /**
   * 标记用户所有通知为已读
   * @param {number} userId - 用户ID
   * @returns {Promise<void>}
   */
  async markAllAsRead(userId) {
    try {
      await notificationDao.markAllAsRead(userId);
      logger.info('标记所有通知已读', { userId });
    } catch (error) {
      logger.error('标记所有通知已读失败', { error: error.message, userId });
      throw error;
    }
  }

  /**
   * 清理过期的担保请求
   * @returns {Promise<number>} - 影响的行数
   */
  async cleanExpiredGuaranteeRequests() {
    try {
      const affectedRows = await guaranteeRequestDao.cleanExpired();
      logger.info('清理过期担保请求成功', { affectedRows });
      return affectedRows;
    } catch (error) {
      logger.error('清理过期担保请求失败', { error: error.message });
      throw error;
    }
  }
}

module.exports = new NotificationService();
