'use strict';

const express = require('express');
const multer  = require('multer');
const { authenticate, authorize }  = require('../../shared/middleware/auth.stub');
const { asyncHandler }             = require('../../shared/middleware/error-handler');
const service                      = require('./bank.service');
const {
  parseAuxiliaryFile,
  applyAuxiliaryMatching,
  resumenAuxiliarClientes,
  listMovimientosAuxiliar,
} = require('./bank-auxiliary.parser');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('Solo se aceptan archivos Excel (.xlsx, .xls)'), ok);
  },
});

// GET /api/banks/cards
router.get('/cards', authenticate, asyncHandler(async (req, res) => {
  res.json(await service.getCards());
}));

// GET /api/banks/movements
router.get('/movements', authenticate, asyncHandler(async (req, res) => {
  res.json(await service.listMovements(req.query));
}));

// GET /api/banks/summary
router.get('/summary', authenticate, asyncHandler(async (req, res) => {
  const { fechaInicio, fechaFin } = req.query;
  res.json(await service.getSummary(fechaInicio, fechaFin));
}));

// POST /api/banks/upload
router.post('/upload',
  authenticate,
  authorize('admin', 'contador'),
  upload.single('excelFile'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se envió ningún archivo Excel' });
    const result = await service.importFile(req.file.buffer, req.body.banco, req.user._id);
    res.status(207).json(result);
  }),
);

// PATCH /api/banks/movements/:id/status
router.patch('/movements/:id/status',
  authenticate,
  authorize('admin', 'contador'),
  asyncHandler(async (req, res) => {
    res.json(await service.updateStatus(req.params.id, req.body.status));
  }),
);

// PATCH /api/banks/movements/:id/uuid
router.patch('/movements/:id/uuid',
  authenticate,
  authorize('admin', 'contador'),
  asyncHandler(async (req, res) => {
    res.json(await service.linkUuid(req.params.id, req.body.uuidXML));
  }),
);

// DELETE /api/banks/movements/:id/uuid
router.delete('/movements/:id/uuid',
  authenticate,
  authorize('admin', 'contador'),
  asyncHandler(async (req, res) => {
    res.json(await service.unlinkUuid(req.params.id));
  }),
);

// PATCH /api/banks/movements/:id/erp-ids  (add / remove individual)
router.patch('/movements/:id/erp-ids',
  authenticate,
  authorize('admin', 'contador'),
  asyncHandler(async (req, res) => {
    res.json(await service.updateErpIds(req.params.id, req.body.action, req.body.erpId));
  }),
);

// PUT /api/banks/movements/:id/erp-ids  (replace full array)
router.put('/movements/:id/erp-ids',
  authenticate,
  authorize('admin', 'contador'),
  asyncHandler(async (req, res) => {
    res.json(await service.setErpIds(req.params.id, req.body.erpIds));
  }),
);

// POST /api/banks/recategorizar
router.post('/recategorizar',
  authenticate,
  authorize('admin', 'contador'),
  asyncHandler(async (_req, res) => {
    const result = await service.recategorizarMovimientos();
    res.json({ mensaje: `${result.actualizados} movimientos actualizados`, ...result });
  }),
);

// POST /api/banks/auxiliar/import
router.post('/auxiliar/import',
  authenticate,
  authorize('admin', 'contador'),
  upload.single('excelFile'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se envió ningún archivo Excel' });
    const result = await parseAuxiliaryFile(req.file.buffer);
    res.status(207).json(result);
  }),
);

// POST /api/banks/auxiliar/aplicar  — cruza catálogo con movimientos
router.post('/auxiliar/aplicar',
  authenticate,
  authorize('admin', 'contador'),
  asyncHandler(async (_req, res) => {
    const result = await applyAuxiliaryMatching();
    res.json(result);
  }),
);

// GET /api/banks/auxiliar/clientes  — resumen agrupado por cliente
router.get('/auxiliar/clientes',
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await resumenAuxiliarClientes(req.query);
    res.json(result);
  }),
);

// GET /api/banks/auxiliar/movimientos  — lista paginada de movimientos identificados
router.get('/auxiliar/movimientos',
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await listMovimientosAuxiliar(req.query);
    res.json(result);
  }),
);

// GET /api/banks/config/:banco
router.get('/config/:banco', authenticate, asyncHandler(async (req, res) => {
  res.json(await service.getConfig(req.params.banco));
}));

// PATCH /api/banks/config/:banco
router.patch('/config/:banco',
  authenticate,
  authorize('admin', 'contador'),
  asyncHandler(async (req, res) => {
    res.json(await service.saveConfig(req.params.banco, req.body));
  }),
);

module.exports = router;
