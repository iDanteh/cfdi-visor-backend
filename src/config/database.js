const mongoose = require('mongoose');
const { logger } = require('../shared/utils/logger');

const connectDB = async () => {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/cfdi_comparator';

  mongoose.connection.on('connected', () => logger.info('MongoDB conectado'));
  mongoose.connection.on('error', (err) => logger.error('MongoDB error:', err));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB desconectado'));

  await mongoose.connect(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });
};

const disconnectDB = async () => {
  await mongoose.connection.close();
  logger.info('MongoDB desconectado correctamente');
};

module.exports = { connectDB, disconnectDB };
