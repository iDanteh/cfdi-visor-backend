const express = require('express');
const { body, validationResult } = require('express-validator');
const Comparison = require('../models/Comparison');
const CFDI = require('../models/CFDI');
const { batchCompareCFDIs } = require('../services/comparisonEngine');
const { authenticate, authorize } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

// GET /api/comparisons — Listar comparaciones
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, status, resolved, dateFrom, dateTo } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (resolved !== undefined) filter.resolved = resolved === 'true';
  if (dateFrom || dateTo) {
    filter.comparedAt = {};
    if (dateFrom) filter.comparedAt.$gte = new Date(dateFrom);
    if (dateTo) filter.comparedAt.$lte = new Date(dateTo);
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [comparisons, total] = await Promise.all([
    Comparison.find(filter, { satRawResponse: 0 })
      .populate('erpCfdiId', 'uuid emisor receptor total fecha')
      .sort({ comparedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    Comparison.countDocuments(filter),
  ]);

  res.json({ data: comparisons, pagination: { total, page: parseInt(page), limit: parseInt(limit) } });
}));

// GET /api/comparisons/stats — Estadísticas generales
router.get('/stats', authenticate, asyncHandler(async (req, res) => {
  const stats = await Comparison.aggregate([
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalDifferences: { $sum: '$totalDifferences' },
      },
    },
    { $sort: { count: -1 } },
  ]);

  const total = stats.reduce((acc, s) => acc + s.count, 0);
  res.json({ total, byStatus: stats });
}));

// GET /api/comparisons/:id
router.get('/:id', authenticate, asyncHandler(async (req, res) => {
  const comparison = await Comparison.findById(req.params.id)
    .populate('erpCfdiId')
    .populate('satCfdiId')
    .populate('triggeredBy', 'name email');
  if (!comparison) return res.status(404).json({ error: 'Comparación no encontrada' });
  res.json(comparison);
}));

// POST /api/comparisons/batch — Comparar CFDIs en lote
router.post('/batch', authenticate, authorize('admin', 'contador'),
  [body('filters').optional().isObject()],
  asyncHandler(async (req, res) => {
    const { filters = {}, concurrency = 5 } = req.body;

    // Construir query de CFDIs a comparar
    const cfdiFilter = { source: 'ERP', isActive: true, ...filters };
    const cfdis = await CFDI.find(cfdiFilter, '_id').lean();

    if (cfdis.length === 0) {
      return res.status(200).json({ message: 'No hay CFDIs para comparar', processed: 0 });
    }

    // Iniciar proceso en background (no bloquear la respuesta)
    const ids = cfdis.map(c => c._id.toString());
    res.status(202).json({
      message: 'Comparación en lote iniciada',
      total: ids.length,
      jobId: `batch_${Date.now()}`,
    });

    // Procesar en segundo plano
    batchCompareCFDIs(ids, { concurrency, triggeredBy: req.user._id })
      .then(results => console.log('Batch completado:', results))
      .catch(err => console.error('Error en batch:', err));
  })
);

// PATCH /api/comparisons/:id/resolve — Marcar como resuelta
router.patch('/:id/resolve', authenticate, authorize('admin', 'contador', 'auditor'),
  [body('resolutionNotes').optional().isString()],
  asyncHandler(async (req, res) => {
    const comparison = await Comparison.findByIdAndUpdate(
      req.params.id,
      {
        resolved: true,
        resolvedAt: new Date(),
        resolvedBy: req.user._id,
        resolutionNotes: req.body.resolutionNotes,
      },
      { new: true }
    );
    if (!comparison) return res.status(404).json({ error: 'Comparación no encontrada' });
    res.json(comparison);
  })
);

module.exports = router;
