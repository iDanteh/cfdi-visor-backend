'use strict';

const express = require('express');
const { authenticate }  = require('../../shared/middleware/auth.stub');
const { asyncHandler }  = require('../../shared/middleware/error-handler');
const service           = require('./erp.service');

const router = express.Router();

// GET /api/erp/cuentas-pendientes?fechaDesde=2026-04-01T00:00:00Z&fechaHasta=2026-04-07T23:59:59Z
router.get('/cuentas-pendientes', authenticate, asyncHandler(async (req, res) => {
  const { fechaDesde, fechaHasta } = req.query;

  if (!fechaDesde || !fechaHasta) {
    return res.status(400).json({ error: 'Se requieren los parámetros fechaDesde y fechaHasta (ISO 8601)' });
  }

  res.json(await service.getCuentasPendientes(fechaDesde, fechaHasta));
}));

// GET /api/erp/cxc-matches
// Devuelve todos los snapshots de CxC con sus posibles matches en movimientos bancarios.
// ENDPOINT TEMPORAL — fase exploratoria de conciliación.
router.get('/cxc-matches', authenticate, asyncHandler(async (_req, res) => {
  res.json(await service.getCxcMatches());
}));

module.exports = router;
