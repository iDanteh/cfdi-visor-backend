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
  } = filters;

  const filter = { isActive: true };
  if (source)             filter.source             = source;
  if (tipoDeComprobante)  filter.tipoDeComprobante  = tipoDeComprobante;
  if (rfcEmisor)          filter['emisor.rfc']       = rfcEmisor.toUpperCase();
  if (rfcReceptor)        filter['receptor.rfc']     = rfcReceptor.toUpperCase();
  if (satStatus)          filter.satStatus           = satStatus;
  if (fechaInicio || fechaFin) {
    filter.fecha = {};
    if (fechaInicio) filter.fecha.$gte = new Date(fechaInicio);
    if (fechaFin)    filter.fecha.$lte = new Date(fechaFin);
  }
  if (search) filter.$text = { $search: search };

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [cfdis, total] = await Promise.all([
    CFDI.find(filter, { xmlContent: 0 }).sort({ fecha: -1 }).skip(skip).limit(parseInt(limit)).lean(),
    CFDI.countDocuments(filter),
  ]);

  return {
    data: cfdis,
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
      const cfdi = await CFDI.findOneAndUpdate(
        { uuid: cfdiData.uuid, source: sourceValidado },
        { ...cfdiData, source: sourceValidado, uploadedBy: userId },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      results.success.push({ uuid: cfdi.uuid, id: cfdi._id, filename: file.originalname });
    } catch (err) {
      results.failed.push({ filename: file.originalname, error: err.message });
    }
  }

  return results;
}

async function createFromJson(data, userId) {
  return CFDI.findOneAndUpdate(
    { uuid: data.uuid.toUpperCase(), source: 'ERP' },
    { ...data, source: 'ERP', uploadedBy: userId },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function softDelete(id) {
  const cfdi = await CFDI.findByIdAndUpdate(id, { isActive: false }, { new: true });
  if (!cfdi) throw new NotFoundError('CFDI');
  return { message: 'CFDI desactivado', id: cfdi._id };
}

module.exports = { list, getById, getXml, uploadXmls, createFromJson, softDelete };
