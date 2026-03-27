const cron = require('node-cron');
const CFDI = require('../models/CFDI');
const { compareCFDI } = require('../services/comparisonEngine');
const { logger } = require('../utils/logger');

/**
 * Job: Verifica CFDIs del ERP que no tienen estado SAT o cuyo estado
 * no se ha verificado en las últimas 24 horas.
 * Corre a las 2:00 AM diariamente.
 */
cron.schedule('0 2 * * *', async () => {
  logger.info('[SatSyncJob] Iniciando sincronización nocturna con SAT...');

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const cfdis = await CFDI.find({
    source: 'ERP',
    isActive: true,
    $or: [
      { satStatus: null },
      { satLastCheck: { $lt: yesterday } },
      { satStatus: 'Pendiente' },
    ],
  }, '_id').limit(500).lean();

  logger.info(`[SatSyncJob] ${cfdis.length} CFDIs por verificar`);

  let success = 0, failed = 0;
  for (const cfdi of cfdis) {
    try {
      await compareCFDI(cfdi._id.toString(), { triggeredBy: null });
      success++;
      await new Promise(r => setTimeout(r, 600)); // ~100 req/min max SAT
    } catch (err) {
      failed++;
      logger.error(`[SatSyncJob] Error CFDI ${cfdi._id}:`, err.message);
    }
  }

  logger.info(`[SatSyncJob] Completado: ${success} exitosos, ${failed} fallidos`);
}, {
  timezone: 'America/Mexico_City',
});

logger.info('[SatSyncJob] Job registrado: verificación SAT diaria a las 2:00 AM CST');
