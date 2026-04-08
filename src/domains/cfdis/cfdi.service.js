'use strict';

const CFDI           = require('./CFDI.model');
const { parseCFDI }  = require('./cfdi.parser');
const { NotFoundError } = require('../../shared/errors/AppError');

const SOURCES_VALIDOS = ['ERP', 'SAT', 'MANUAL', 'RECEPTOR'];

async function list(filters) {
  const {
    page = 1, limit = 20,
    source, tipoDeComprobante, rfcEmisor, rfcReceptor,
    satStatus, fechaInicio, fechaFin, search,
    excludeLinked,  // 'true' | 'false' — oculta CFDIs ya vinculados a un movimiento bancario
    estadoPago,
  } = filters;

  const filter = { isActive: true };
  if (source)             filter.source             = source;
  if (tipoDeComprobante)  filter.tipoDeComprobante  = tipoDeComprobante;
  if (rfcEmisor)          filter['emisor.rfc']       = rfcEmisor.toUpperCase();
  if (rfcReceptor)        filter['receptor.rfc']     = rfcReceptor.toUpperCase();
  if (satStatus)          filter.satStatus           = satStatus;
  if (estadoPago)         filter.estadoPago          = estadoPago;
  if (fechaInicio || fechaFin) {
    filter.fecha = {};
    if (fechaInicio) filter.fecha.$gte = new Date(fechaInicio);
    if (fechaFin)    filter.fecha.$lte = new Date(fechaFin);
  }
  if (search) filter.$text = { $search: search };

  // Obtener mapa de UUIDs ya vinculados a movimientos bancarios.
  // Se usa tanto para excluir (excludeLinked=true) como para marcar (_linkedFolio).
  const BankMovement = require('../banks/BankMovement.model');
  const linkedDocs   = await BankMovement.find(
    { uuidXML: { $ne: null }, isActive: true },
    'uuidXML folio',
  ).lean();
  const linkedMap = {};
  for (const m of linkedDocs) {
    if (m.uuidXML) linkedMap[m.uuidXML] = m.folio || m._id.toString();
  }

  if (excludeLinked === 'true' || excludeLinked === true) {
    const usedUuids = Object.keys(linkedMap);
    if (usedUuids.length) filter.uuid = { $nin: usedUuids };
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [cfdis, total] = await Promise.all([
    CFDI.find(filter, { xmlContent: 0 }).sort({ fecha: -1 }).skip(skip).limit(parseInt(limit)).lean(),
    CFDI.countDocuments(filter),
  ]);

  // Enriquecer cada CFDI con el folio del movimiento al que está vinculado (si aplica).
  // _linkedFolio = null → libre; _linkedFolio = "BBVA-260302-1A2B" → ocupado.
  const data = cfdis.map(c => ({
    ...c,
    _linkedFolio: linkedMap[c.uuid] ?? null,
  }));

  return {
    data,
    pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
  };
}

async function getById(id) {
  const cfdi = await CFDI.findById(id, { xmlContent: 0 });
  if (!cfdi) throw new NotFoundError('CFDI');
  return cfdi;
}

async function getXml(id) {
  const cfdi = await CFDI.findById(id).select('+xmlContent');
  if (!cfdi || !cfdi.xmlContent) throw new NotFoundError('XML');
  return { uuid: cfdi.uuid, xmlContent: cfdi.xmlContent };
}

async function uploadXmls(files, source, userId) {
  const sourceValidado = SOURCES_VALIDOS.includes(source) ? source : 'ERP';
  const results = { success: [], failed: [] };

  for (const file of files) {
    const xmlString = file.buffer.toString('utf8');
    try {
      const cfdiData = await parseCFDI(xmlString);

      // Construir la operación de upsert.
      // Para tipo I: inicializar estadoPago/saldoPendiente solo en inserción ($setOnInsert),
      // para no sobreescribir el estado ya actualizado por un tipo P previo.
      const setData = { ...cfdiData, source: sourceValidado, uploadedBy: userId };
      const updateOp = { $set: setData };
      if (cfdiData.tipoDeComprobante === 'I') {
        updateOp.$setOnInsert = {
          estadoPago:     'no_pagado',
          saldoPendiente: cfdiData.total,
        };
      }

      const cfdi = await CFDI.findOneAndUpdate(
        { uuid: cfdiData.uuid, source: sourceValidado },
        updateOp,
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      // Si es un complemento de pago, actualizar el estado de las facturas relacionadas.
      let pagoResult = null;
      if (cfdi.tipoDeComprobante === 'P' && cfdi.pagos?.length) {
        pagoResult = await procesarComplementoDePago(cfdi);
      }

      results.success.push({
        uuid:           cfdi.uuid,
        id:             cfdi._id,
        filename:       file.originalname,
        tipo:           cfdi.tipoDeComprobante,
        ...(pagoResult ? { pagoResult } : {}),
      });
    } catch (err) {
      results.failed.push({ filename: file.originalname, error: err.message });
    }
  }

  return results;
}

async function createFromJson(data, userId) {
  const uuid = data.uuid.toUpperCase();
  const setData = { ...data, uuid, source: 'ERP', uploadedBy: userId };
  const updateOp = { $set: setData };

  if (data.tipoDeComprobante === 'I') {
    updateOp.$setOnInsert = {
      estadoPago:     'no_pagado',
      saldoPendiente: data.total,
    };
  }

  const cfdi = await CFDI.findOneAndUpdate(
    { uuid, source: 'ERP' },
    updateOp,
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  if (cfdi.tipoDeComprobante === 'P' && cfdi.pagos?.length) {
    await procesarComplementoDePago(cfdi);
  }

  return cfdi;
}

/**
 * Para un CFDI tipo P ya guardado, itera sus DoctoRelacionado y actualiza
 * el estadoPago y saldoPendiente de cada factura (tipo I) referenciada.
 *
 * Retorna un resumen de qué UUIDs se actualizaron y cuáles no se encontraron.
 */
async function procesarComplementoDePago(cfdiP) {
  const procesados     = [];
  const noEncontrados  = [];

  for (const pago of (cfdiP.pagos || [])) {
    for (const docto of (pago.doctosRelacionados || [])) {
      const uuid = docto.idDocumento;
      if (!uuid) continue;

      // Buscar la factura sin restringir por source: puede ser ERP o SAT
      const factura = await CFDI.findOne(
        { uuid, tipoDeComprobante: 'I', isActive: true },
        'total saldoPendiente estadoPago',
      ).lean();

      if (!factura) {
        noEncontrados.push(uuid);
        continue;
      }

      const nuevoSaldo  = Math.max(0, docto.impSaldoInsoluto ?? 0);
      const nuevoEstado =
        nuevoSaldo === 0                    ? 'pagado' :
        nuevoSaldo < (factura.total ?? 0)   ? 'parcialmente_pagado' :
                                              'no_pagado';

      await CFDI.updateOne(
        { _id: factura._id },
        { $set: { saldoPendiente: nuevoSaldo, estadoPago: nuevoEstado } },
      );

      procesados.push({ uuid, estadoPago: nuevoEstado, saldoPendiente: nuevoSaldo });
    }
  }

  return { procesados, noEncontrados };
}

async function softDelete(id) {
  const cfdi = await CFDI.findByIdAndUpdate(id, { isActive: false }, { new: true });
  if (!cfdi) throw new NotFoundError('CFDI');
  return { message: 'CFDI desactivado', id: cfdi._id };
}

module.exports = {
  list, getById, getXml,
  uploadXmls, createFromJson, softDelete,
  procesarComplementoDePago,
};
