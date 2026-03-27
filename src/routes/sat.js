const express = require('express');
const { body, validationResult } = require('express-validator');
const { verifyCFDIWithSAT } = require('../services/satVerification');
const CFDI = require('../models/CFDI');
const { authenticate, authorize } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

// POST /api/sat/verify — Verificar un UUID directamente con SAT
router.post('/verify',
  authenticate,
  [
    body('uuid').isUUID().withMessage('UUID inválido'),
    body('rfcEmisor').notEmpty().withMessage('RFC Emisor requerido'),
    body('rfcReceptor').notEmpty().withMessage('RFC Receptor requerido'),
    body('total').isNumeric().withMessage('Total debe ser numérico'),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { uuid, rfcEmisor, rfcReceptor, total, sello = '', version = '4.0' } = req.body;
    const result = await verifyCFDIWithSAT(uuid, rfcEmisor, rfcReceptor, parseFloat(total), sello, version);

    // Actualizar estado en BD si existe
    await CFDI.findOneAndUpdate(
      { uuid: uuid.toUpperCase() },
      { satStatus: result.state, satLastCheck: new Date() }
    );

    res.json(result);
  })
);

// POST /api/sat/verify-batch — Verificar múltiples UUIDs
router.post('/verify-batch', authenticate, authorize('admin', 'contador'),
  asyncHandler(async (req, res) => {
    const { uuids } = req.body;
    if (!Array.isArray(uuids) || uuids.length === 0) {
      return res.status(400).json({ error: 'Se requiere un array de UUIDs' });
    }
    if (uuids.length > 100) {
      return res.status(400).json({ error: 'Máximo 100 UUIDs por lote' });
    }

    const cfdis = await CFDI.find({ uuid: { $in: uuids.map(u => u.toUpperCase()) } }).lean();
    const cfdiMap = Object.fromEntries(cfdis.map(c => [c.uuid, c]));

    res.status(202).json({
      message: 'Verificación en lote iniciada',
      total: uuids.length,
      found: cfdis.length,
      notFound: uuids.length - cfdis.length,
    });

    // Procesar en background
    (async () => {
      for (const uuid of uuids) {
        const cfdi = cfdiMap[uuid.toUpperCase()];
        if (!cfdi) continue;
        try {
          const result = await verifyCFDIWithSAT(cfdi.uuid, cfdi.emisor.rfc, cfdi.receptor.rfc, cfdi.total);
          await CFDI.findOneAndUpdate({ uuid: cfdi.uuid }, { satStatus: result.state, satLastCheck: new Date() });
          await new Promise(r => setTimeout(r, 500)); // rate limit SAT
        } catch (err) {
          console.error(`Error verificando ${uuid}:`, err.message);
        }
      }
    })();
  })
);

// GET /api/sat/status/:uuid — Estado de un UUID en SAT (con caché)
router.get('/status/:uuid', authenticate, asyncHandler(async (req, res) => {
  const uuid = req.params.uuid.toUpperCase();
  const cfdi = await CFDI.findOne({ uuid }, 'uuid satStatus satLastCheck emisor receptor total');
  if (!cfdi) return res.status(404).json({ error: 'CFDI no encontrado en base local' });

  // Si la verificación es reciente (menos de 1 hora), devolver caché
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  if (cfdi.satLastCheck && cfdi.satLastCheck > oneHourAgo) {
    return res.json({ uuid, satStatus: cfdi.satStatus, satLastCheck: cfdi.satLastCheck, cached: true });
  }

  // Consultar SAT en tiempo real
  const result = await verifyCFDIWithSAT(cfdi.uuid, cfdi.emisor.rfc, cfdi.receptor.rfc, cfdi.total);
  await CFDI.findOneAndUpdate({ uuid }, { satStatus: result.state, satLastCheck: new Date() });

  res.json({ uuid, satStatus: result.state, satLastCheck: new Date(), cached: false });
}));

module.exports = router;
