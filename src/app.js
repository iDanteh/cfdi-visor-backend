require('dotenv').config();
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const morgan      = require('morgan');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');

const { connectDB }    = require('./config/database');
const { logger }       = require('./shared/utils/logger');
const errorHandler     = require('./shared/middleware/error-handler');

// Domain routers
const bankRoutes              = require('./domains/banks/bank.routes');
const accountPlanRoutes       = require('./domains/account-plan/account-plan.routes');
const collectionRequestRoutes = require('./domains/collection-requests/collection-request.routes');
const erpRoutes               = require('./domains/erp/erp.routes');

const app = express();

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin:      process.env.CORS_ORIGIN || 'http://localhost:4200',
  credentials: true,
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use('/api/', rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      parseInt(process.env.RATE_LIMIT_MAX)       || 100,
  message:  { error: 'Demasiadas solicitudes, intenta más tarde.' },
}));

// ── Body parsing & compression ────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());

// ── Logging ───────────────────────────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (msg) => logger.info(msg.trim()) },
}));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.0.0' });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/banks',                bankRoutes);
app.use('/api/account-plan',         accountPlanRoutes);
app.use('/api/collection-requests',  collectionRequestRoutes);
app.use('/api/erp',                  erpRoutes);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// ── Error handler (must be last) ──────────────────────────────────────────────
app.use(errorHandler);

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

const startServer = async () => {
  await connectDB();
  app.listen(PORT, () => {
    logger.info(`Servidor corriendo en puerto ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  });
};

startServer().catch((err) => {
  logger.error('Error iniciando servidor:', err);
  process.exit(1);
});

module.exports = app;
