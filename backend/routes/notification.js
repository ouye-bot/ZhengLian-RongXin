const express = require('express');
const router = express.Router();
const notificationService = require('../services/riskPlugins/notificationService');
const logger = require('../utils/logger');

// 获取未读通知数量
router.get('/unread-count', async (req, res) => {
  try {
    const userId = req.user.id;
    const count = await notificationService.getUnreadCount(userId);
    res.json({ success: true, count });
  } catch (error) {
    logger.error('获取未读通知数量失败', { error: error.message });
    res.status(500).json({ success: false, message: '获取未读通知数量失败' });
  }
});

// 获取通知列表
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 20;
    const notifications = await notificationService.getNotifications(userId, page, pageSize);
    res.json({ success: true, notifications });
  } catch (error) {
    logger.error('获取通知列表失败', { error: error.message });
    res.status(500).json({ success: false, message: '获取通知列表失败' });
  }
});

// 标记单条通知为已读（归属校验：非本人或不存在返回 404，而非静默成功）
router.put('/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await notificationService.markAsRead(parseInt(id), req.user.id);
    if (!updated) {
      return res.status(404).json({ success: false, message: '通知不存在或无权操作' });
    }
    res.json({ success: true });
  } catch (error) {
    logger.error('标记通知已读失败', { error: error.message });
    res.status(500).json({ success: false, message: '标记通知已读失败' });
  }
});

// 标记所有通知为已读
router.put('/read-all', async (req, res) => {
  try {
    const userId = req.user.id;
    await notificationService.markAllAsRead(userId);
    res.json({ success: true });
  } catch (error) {
    logger.error('标记所有通知已读失败', { error: error.message });
    res.status(500).json({ success: false, message: '标记所有通知已读失败' });
  }
});

module.exports = router;
