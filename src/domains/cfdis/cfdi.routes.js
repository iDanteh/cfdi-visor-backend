'use strict';

const express = require('express');
const multer  = require('multer');
const { body, validationResult } = require('express-validator');
const { authenticate, authorize } = require('../../shared/middleware/auth.stub');
const { asyncHandler }            = require('../../shared/middleware/error-handler');
const service                     = require('./cfdi.service');

const router  = express.Router();
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// GET /api/cfdis
router.get('/', authenticate, asyncHandler(async (req, res) => {
  res.json(await service.list(req.query));
}));

// GET /api/cfdis/:id
router.get('/:id', authenticate, asyncHandler(async (req, res) => {
  res.json(await service.getById(req.params.id));
}));

// GET /api/cfdis/:id/xml
router.get('/:id/xml', authenticate, asyncHandler(async (req, res) => {
  const { uuid, xmlContent } = await service.getXml(req.params.id);
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Content-Disposition', `attachment; filename="${uuid}.xml"`);
  res.send(xmlContent);
}));

// POST /api/cfdis/upload
router.post('/upload',
  authenticate,
  authorize('admin', 'contador'),
  upload.array('xmlFiles', 50),
  asyncHandler(async (req, res) => {
    if (!req.files?.length) return res.status(400).json({ error: 'No se enviaron archivos XML' });
    const results = await service.uploadXmls(req.files, req.body.source, req.user._id);
    res.status(207).json({
      message: `${results.success.length} CFDIs procesados, ${results.failed.length} fallidos`,
      ...results,
    });
  }),
);

// POST /api/cfdis — Crear desde JSON (integración ERP)
router.post('/',
  authenticate,
  authorize('admin', 'contador'),
  [
    body('uuid').isUUID().withMessage('UUID inválido'),
    body('emisor.rfc').notEmpty(),
    body('receptor.rfc').notEmpty(),
    body('total').isNumeric(),
    body('fecha').isISO8601(),
    body('tipoDeComprobante').isIn(['I', 'E', 'T', 'N', 'P']),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const cfdi = await service.createFromJson(req.body, req.user._id);
    res.status(201).json(cfdi);
  }),
);

// POST /api/cfdis/:id/reprocesar-pago
// Vuelve a ejecutar procesarComplementoDePago para un CFDI tipo P ya guardado.
// Útil cuando las facturas (tipo I) se importaron DESPUÉS del complemento de pago.
router.post('/:id/reprocesar-pago',
  authenticate,
  authorize('admin', 'contador'),
  asyncHandler(async (req, res) => {
    const cfdi = await service.getById(req.params.id);
    if (cfdi.tipoDeComprobante !== 'P') {
      return res.status(400).json({ error: 'Solo se puede reprocesar un CFDI tipo P' });
    }
    if (!cfdi.pagos?.length) {
      return res.status(400).json({ error: 'Este CFDI tipo P no tiene nodos Pago — ¿fue importado con el parser anterior?' });
    }
    const result = await service.procesarComplementoDePago(cfdi);
    res.json({
      message: `${result.procesados.length} facturas actualizadas, ${result.noEncontrados.length} no encontradas`,
      ...result,
    });
  }),
);

// DELETE /api/cfdis/:id
router.delete('/:id',
  authenticate,
  authorize('admin'),
  asyncHandler(async (req, res) => {
    res.json(await service.softDelete(req.params.id));
  }),
);

module.exports = router;
