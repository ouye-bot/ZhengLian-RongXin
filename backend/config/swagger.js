const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: '证链融信（FinZkTrust）API',
      version: '1.0.0',
      description: '基于国密算法与零知识证明的隐私金融信贷系统'
    },
    servers: [
      { url: 'https://localhost:8443/api/v1', description: '开发环境（HTTPS）' }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      }
    },
    security: [{ bearerAuth: [] }]
  },
  apis: ['./routes/*.js']
};

module.exports = swaggerJsdoc(options);
