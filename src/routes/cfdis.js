const express = require('express');
const multer = require('multer');
const { body, query, param, validationResult } = require('express-validator');
const CFDI = require('../models/CFDI');
const { parseCFDI } = require('../services/cfdiParser');
const { compareCFDI } = require('../services/comparisonEngine');
const { authenticate, authorize } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// GET /api/cfdis — Listar CFDIs con filtros y paginación
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const {
    page = 1, limit = 20, source, tipoDeComprobante, rfcEmisor,
    rfcReceptor, satStatus, fechaInicio, fechaFin, search,
  } = req.query;

  const filter = { isActive: true };
  if (source) filter.source = source;
  if (tipoDeComprobante) filter.tipoDeComprobante = tipoDeComprobante;
  if (rfcEmisor) filter['emisor.rfc'] = rfcEmisor.toUpperCase();
  if (rfcReceptor) filter['receptor.rfc'] = rfcReceptor.toUpperCase();
  if (satStatus) filter.satStatus = satStatus;
  if (fechaInicio || fechaFin) {
    filter.fecha = {};
    if (fechaInicio) filter.fecha.$gte = new Date(fechaInicio);
    if (fechaFin) filter.fecha.$lte = new Date(fechaFin);
  }
  if (search) filter.$text = { $search: search };

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [cfdis, total] = await Promise.all([
    CFDI.find(filter, { xmlContent: 0 })
      .sort({ fecha: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    CFDI.countDocuments(filter),
  ]);

  res.json({
    data: cfdis,
    pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / limit) },
  });
}));

// GET /api/cfdis/:id — Detalle de un CFDI
router.get('/:id', authenticate, asyncHandler(async (req, res) => {
  const cfdi = await CFDI.findById(req.params.id, { xmlContent: 0 });
  if (!cfdi) return res.status(404).json({ error: 'CFDI no encontrado' });
  res.json(cfdi);
}));

// GET /api/cfdis/:id/xml — Descargar XML original
router.get('/:id/xml', authenticate, asyncHandler(async (req, res) => {
  const cfdi = await CFDI.findById(req.params.id).select('+xmlContent');
  if (!cfdi || !cfdi.xmlContent) return res.status(404).json({ error: 'XML no disponible' });
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Content-Disposition', `attachment; filename="${cfdi.uuid}.xml"`);
  res.send(cfdi.xmlContent);
}));

// POST /api/cfdis/upload — Subir uno o varios XMLs
router.post('/upload', authenticate, authorize('admin', 'contador'), upload.array('xmlFiles', 50),
  asyncHandler(async (req, res) => {
    if (!req.files?.length) return res.status(400).json({ error: 'No se enviaron archivos XML' });

    const source = ['ERP', 'SAT', 'MANUAL', 'RECEPTOR'].includes(req.body.source)
      ? req.body.source
      : 'ERP';

    const results = { success: [], failed: [] };

    for (const file of req.files) {
      const xmlString = file.buffer.toString('utf8');
      try {
        const cfdiData = await parseCFDI(xmlString);
        const cfdi = await CFDI.findOneAndUpdate(
          { uuid: cfdiData.uuid, source },
          { ...cfdiData, source, uploadedBy: req.user._id },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        results.success.push({ uuid: cfdi.uuid, id: cfdi._id, filename: file.originalname });
      } catch (err) {
        results.failed.push({ filename: file.originalname, error: err.message });
      }
    }

    res.status(207).json({
      message: `${results.success.length} CFDIs procesados, ${results.failed.length} fallidos`,
      ...results,
    });
  })
);

// POST /api/cfdis — Crear CFDI desde JSON (integración ERP)
router.post('/', authenticate, authorize('admin', 'contador'),
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

    const cfdi = await CFDI.findOneAndUpdate(
      { uuid: req.body.uuid.toUpperCase(), source: 'ERP' },
      { ...req.body, source: 'ERP', uploadedBy: req.user._id },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(201).json(cfdi);
  })
);

// POST /api/cfdis/:id/compare — Comparar un CFDI específico con SAT
router.post('/:id/compare', authenticate, authorize('admin', 'contador', 'auditor'),
  asyncHandler(async (req, res) => {
    const comparison = await compareCFDI(req.params.id, { triggeredBy: req.user._id });
    res.json(comparison);
  })
);

// DELETE /api/cfdis/:id — Soft delete
router.delete('/:id', authenticate, authorize('admin'),
  asyncHandler(async (req, res) => {
    const cfdi = await CFDI.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!cfdi) return res.status(404).json({ error: 'CFDI no encontrado' });
    res.json({ message: 'CFDI desactivado', id: cfdi._id });
  })
);

module.exports = router;
