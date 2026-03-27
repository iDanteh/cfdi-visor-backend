require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const { connectDB } = require('./config/database');
const { logger } = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');

// Routes
const authRoutes = require('./routes/auth');
const cfdiRoutes = require('./routes/cfdis');
const comparisonRoutes = require('./routes/comparisons');
const discrepancyRoutes = require('./routes/discrepancies');
const reportRoutes = require('./routes/reports');
const satRoutes = require('./routes/sat');
const entityRoutes = require('./routes/entities');

const app = express();

// Security
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:4200',
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  message: { error: 'Demasiadas solicitudes, intenta más tarde.' },
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());

// Logging
app.use(morgan('combined', {
  stream: { write: (msg) => logger.info(msg.trim()) },
}));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/cfdis', cfdiRoutes);
app.use('/api/comparisons', comparisonRoutes);
app.use('/api/discrepancies', discrepancyRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/sat', satRoutes);
app.use('/api/entities', entityRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// Error handler (must be last)
app.use(errorHandler);

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  await connectDB();

  // Start cron jobs
  require('./jobs/satSyncJob');

  app.listen(PORT, () => {
    logger.info(`Servidor corriendo en puerto ${PORT} [${process.env.NODE_ENV}]`);
  });
};

startServer().catch((err) => {
  logger.error('Error iniciando servidor:', err);
  process.exit(1);
});

module.exports = app;
