'use strict';

const express = require('express');
const axios   = require('axios');
const { authenticate } = require('../../shared/middleware/auth.real');
const { asyncHandler } = require('../../shared/middleware/error-handler');

const router = express.Router();

const ERP_BASE_URL = (process.env.ERP_BASE_URL || '').replace(/\/$/, '');
const ERP_TOKEN    = process.env.ERP_TOKEN || '';

// GET /api/erp/cuentas-pendientes
// Parámetros: fechaDesde, fechaHasta, estadoCobro (opcional; 'pendiente' para solo pendientes)
router.get('/cuentas-pendientes', authenticate, asyncHandler(async (req, res) => {
  if (!ERP_BASE_URL) {
    return res.status(503).json({ error: 'ERP no configurado (ERP_BASE_URL ausente)' });
  }

  const { fechaDesde, fechaHasta, estadoCobro } = req.query;

  const params = { fechaDesde, fechaHasta };
  if (estadoCobro) params.estadoCobro = estadoCobro;

  const response = await axios.get(`${ERP_BASE_URL}/cuentas-pendientes`, {
    params,
    headers: { Authorization: `Bearer ${ERP_TOKEN}` },
    timeout: 15000,
  });

  const cuentas = (response.data?.Data?.cuentas || []).map(c => ({
    id:               c.id,
    serie:            c.serie,
    folio:            c.folio,
    tipoPago:         c.tipoPago   ?? null,
    subtotal:         c.subtotal,
    impuesto:         c.impuesto,
    total:            c.total,
    saldoActual:      c.saldoActual,
    fechaVencimiento: c.fechaVencimiento ?? null,
    folioFiscal:      c.folioFiscal ?? null,
  }));

  res.json(cuentas);
}));

module.exports = router;
