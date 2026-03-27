const express = require('express');
const Entity = require('../models/Entity');
const { authenticate, authorize } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

router.get('/', authenticate, asyncHandler(async (req, res) => {
  const entities = await Entity.find({ isActive: true }, { 'fiel': 0 }).lean();
  res.json(entities);
}));

router.post('/', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
  const entity = await Entity.create(req.body);
  res.status(201).json(entity);
}));

router.patch('/:id', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
  const entity = await Entity.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!entity) return res.status(404).json({ error: 'Entidad no encontrada' });
  res.json(entity);
}));

module.exports = router;
