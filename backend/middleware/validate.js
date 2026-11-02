const Joi = require('joi');

/**
 * 参数校验中间件工厂函数
 * @param {Joi.ObjectSchema} schema - Joi 校验规则
 * @param {'body'|'query'|'params'} source - 校验数据来源
 * @returns {Function} Express 中间件
 */
const validate = (schema, source = 'body') => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[source], {
      abortEarly: false,     // 返回所有错误，而非遇到第一个就停止
      stripUnknown: false,   // 不删除未定义的字段（未知字段直接报错，见下）
      // 阶段3 收严：顶层未知字段 → 400 INVALID_PARAMS（防参数注入/字段漂移）。
      // 各 schema 的嵌套 creditProof 已显式 .unknown(true)（前端传完整证明对象，含 proof/publicSignals 等），
      // borrow/redeem 大额二次提交的 challengeId/challengeSignature 已登记为 optional（validators.js）。
      allowUnknown: false
    });

    if (error) {
      const details = error.details.map(d => ({
        field: d.path.join('.'),
        message: d.message
      }));

      return res.status(400).json({
        success: false,
        code: 'INVALID_PARAMS',
        message: '请求参数校验失败',
        details
      });
    }

    // 将校验并转换后的值挂载回 req，确保类型正确
    req[source] = value;
    next();
  };
};

module.exports = validate;