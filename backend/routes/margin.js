const express = require('express');
const router = express.Router();
const Joi = require('joi');
const validate = require('../middleware/validate');
const marginEngine = require('../services/riskPlugins/marginEngine');
const marginOrderDao = require('../dao/marginOrderDao');
const logger = require('../utils/logger');

// 计算保证金参数
const calculateSchema = Joi.object({
  creditScore: Joi.number().integer().min(300).max(850).required(),
  term: Joi.number().integer().valid(7, 14, 30, 60, 90).required(),
  loanAmount: Joi.number().integer().min(100).max(50000).required()
});

router.post('/calculate', validate(calculateSchema), async (req, res) => {
  try {
    const { creditScore, term, loanAmount } = req.body;
    const { marginRate, marginAmount } = marginEngine.calculateMargin(loanAmount, creditScore, term);

    res.json({
      success: true,
      marginRate,
      marginAmount
    });
  } catch (error) {
    logger.error('计算保证金失败', { error: error.message });
    res.status(500).json({ success: false, message: '计算保证金失败' });
  }
});

// 获取用户保证金订单列表
router.get('/orders/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (parseInt(userId) !== req.user.id) {
      return res.status(403).json({ success: false, message: '无权查看其他用户的保证金订单' });
    }

    const orders = await marginOrderDao.findByUserId(userId);
    res.json({ success: true, orders });
  } catch (error) {
    logger.error('获取保证金订单失败', { error: error.message });
    res.status(500).json({ success: false, message: '获取保证金订单失败' });
  }
});

// 获取单个保证金订单详情
router.get('/orders/detail/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await marginOrderDao.findById(parseInt(orderId));
    if (!order) {
      return res.status(404).json({ success: false, message: '保证金订单不存在' });
    }
    if (order.user_id !== req.user.id) {
      return res.status(403).json({ success: false, message: '无权查看此保证金订单' });
    }
    res.json({ success: true, order });
  } catch (error) {
    logger.error('获取保证金订单详情失败', { error: error.message });
    res.status(500).json({ success: false, message: '获取保证金订单详情失败' });
  }
});

module.exports = router;
