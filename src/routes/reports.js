const express = require('express');
const ExcelJS = require('exceljs');
const CFDI = require('../models/CFDI');
const Comparison = require('../models/Comparison');
const Discrepancy = require('../models/Discrepancy');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

// GET /api/reports/dashboard — KPIs para el dashboard principal
router.get('/dashboard', authenticate, asyncHandler(async (req, res) => {
  const { rfcEmisor, fechaInicio, fechaFin } = req.query;
  const dateFilter = {};
  if (fechaInicio) dateFilter.$gte = new Date(fechaInicio);
  if (fechaFin) dateFilter.$lte = new Date(fechaFin);

  const cfdiFilter = { isActive: true, source: 'ERP' };
  if (rfcEmisor) cfdiFilter['emisor.rfc'] = rfcEmisor.toUpperCase();
  if (Object.keys(dateFilter).length) cfdiFilter.fecha = dateFilter;

  const [
    totalCFDIs,
    cfdisBySatStatus,
    comparisonStats,
    discrepancyStats,
    topDiscrepancyTypes,
    recentDiscrepancies,
  ] = await Promise.all([
    CFDI.countDocuments(cfdiFilter),
    CFDI.aggregate([
      { $match: cfdiFilter },
      { $group: { _id: '$satStatus', count: { $sum: 1 }, totalAmount: { $sum: '$total' } } },
    ]),
    Comparison.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Discrepancy.aggregate([
      { $group: { _id: '$severity', count: { $sum: 1 }, fiscalImpact: { $sum: '$fiscalImpact.amount' } } },
    ]),
    Discrepancy.aggregate([
      { $match: { status: 'open' } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]),
    Discrepancy.find({ status: 'open' })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean(),
  ]);

  res.json({
    kpis: {
      totalCFDIs,
      cfdisBySatStatus,
      comparisonStats,
      discrepancyStats,
    },
    topDiscrepancyTypes,
    recentDiscrepancies,
  });
}));

// GET /api/reports/export/excel — Exportar reporte a Excel
router.get('/export/excel', authenticate, asyncHandler(async (req, res) => {
  const { dateFrom, dateTo, status } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (dateFrom || dateTo) {
    filter.comparedAt = {};
    if (dateFrom) filter.comparedAt.$gte = new Date(dateFrom);
    if (dateTo) filter.comparedAt.$lte = new Date(dateTo);
  }

  const comparisons = await Comparison.find(filter, { satRawResponse: 0 })
    .populate('erpCfdiId', 'uuid emisor receptor total fecha tipoDeComprobante')
    .lean();

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Comparaciones CFDI');

  sheet.columns = [
    { header: 'UUID', key: 'uuid', width: 40 },
    { header: 'Estado', key: 'status', width: 15 },
    { header: 'RFC Emisor', key: 'rfcEmisor', width: 15 },
    { header: 'RFC Receptor', key: 'rfcReceptor', width: 15 },
    { header: 'Total', key: 'total', width: 12 },
    { header: 'Fecha', key: 'fecha', width: 15 },
    { header: 'Diferencias', key: 'totalDifferences', width: 12 },
    { header: 'Críticas', key: 'criticalCount', width: 10 },
    { header: 'Fecha Comparación', key: 'comparedAt', width: 20 },
    { header: 'Resuelta', key: 'resolved', width: 10 },
  ];

  // Style header
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  for (const comp of comparisons) {
    const cfdi = comp.erpCfdiId;
    const row = sheet.addRow({
      uuid: comp.uuid,
      status: comp.status,
      rfcEmisor: cfdi?.emisor?.rfc || '',
      rfcReceptor: cfdi?.receptor?.rfc || '',
      total: cfdi?.total || '',
      fecha: cfdi?.fecha ? new Date(cfdi.fecha).toLocaleDateString('es-MX') : '',
      totalDifferences: comp.totalDifferences,
      criticalCount: comp.criticalCount,
      comparedAt: new Date(comp.comparedAt).toLocaleDateString('es-MX'),
      resolved: comp.resolved ? 'Sí' : 'No',
    });

    if (comp.status === 'discrepancy') row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };
    if (comp.status === 'not_in_sat' || comp.status === 'cancelled') row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8D7DA' } };
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="reporte_cfdis_${Date.now()}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
}));

module.exports = router;
