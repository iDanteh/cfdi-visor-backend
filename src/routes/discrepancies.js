const express = require('express');
const Discrepancy = require('../models/Discrepancy');
const { authenticate, authorize } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

// GET /api/discrepancies
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, type, severity, status, rfcEmisor } = req.query;
  const filter = {};
  if (type) filter.type = type;
  if (severity) filter.severity = severity;
  if (status) filter.status = status;
  if (rfcEmisor) filter.rfcEmisor = rfcEmisor.toUpperCase();

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [discrepancies, total] = await Promise.all([
    Discrepancy.find(filter)
      .populate('comparisonId', 'uuid status comparedAt')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    Discrepancy.countDocuments(filter),
  ]);

  res.json({ data: discrepancies, pagination: { total, page: parseInt(page), limit: parseInt(limit) } });
}));

// GET /api/discrepancies/summary — Resumen por tipo y severidad
router.get('/summary', authenticate, asyncHandler(async (req, res) => {
  const [byType, bySeverity, byStatus] = await Promise.all([
    Discrepancy.aggregate([{ $group: { _id: '$type', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    Discrepancy.aggregate([{ $group: { _id: '$severity', count: { $sum: 1 } } }]),
    Discrepancy.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  res.json({ byType, bySeverity, byStatus });
}));

// GET /api/discrepancies/:id
router.get('/:id', authenticate, asyncHandler(async (req, res) => {
  const d = await Discrepancy.findById(req.params.id).populate('comparisonId');
  if (!d) return res.status(404).json({ error: 'Discrepancia no encontrada' });
  res.json(d);
}));

// PATCH /api/discrepancies/:id/status — Actualizar estado
router.patch('/:id/status', authenticate, authorize('admin', 'contador', 'auditor'),
  asyncHandler(async (req, res) => {
    const { status, resolutionType, note } = req.body;
    const update = { status };
    if (resolutionType) update.resolutionType = resolutionType;
    if (status === 'resolved') {
      update.resolvedAt = new Date();
      update.resolvedBy = req.user._id;
    }
    if (note) update.$push = { notes: note };

    const d = await Discrepancy.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!d) return res.status(404).json({ error: 'Discrepancia no encontrada' });
    res.json(d);
  })
);

module.exports = router;
