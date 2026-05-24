const fs = require('fs');
const path = require('path');
const { createLogger, format, transports } = require('winston');
const config = require('./config');

const logsDir = path.join(__dirname, '..', 'logs');
fs.mkdirSync(logsDir, { recursive: true });

const logger = createLogger({
  level: config.logLevel,
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, stack }) =>
      `[${timestamp}] [${level.toUpperCase()}] ${stack || message}`
    )
  ),
  transports: [
    new transports.Console(),
    new transports.File({
      filename: path.join(logsDir, 'whatsapp.log'),
      maxsize: 20 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
  ],
});

module.exports = logger;
