'use strict';

const BankMovement      = require('./BankMovement.model');
const BankConfig        = require('./BankConfig.model');
const Counter           = require('../../shared/models/Counter');
const CollectionRequest = require('../collection-requests/CollectionRequest.model');
const { parseBankFile, clasificar } = require('./bank.parser');
const { NotFoundError, BadRequestError, ConflictError } = require('../../shared/errors/AppError');

// ── Constantes ────────────────────────────────────────────────────────────────

const BANCOS_VALIDOS = [
  'BBVA', 'Banamex', 'Santander', 'Azteca',
  'Banorte', 'HSBC', 'Inbursa', 'Scotiabank',
  'BanBajío', 'Afirme', 'Intercam', 'Nu',
  'Spin', 'Hey Banco', 'Albo',
];
const STATUS_VALIDOS = ['no_identificado', 'identificado', 'otros'];

const BANK_PREFIX = {
  bbva:       'BBVA',
  banamex:    'BNAM',
  santander:  'SANT',
  azteca:     'AZTC',
  banorte:    'BNRT',
  hsbc:       'HSBC',
  inbursa:    'INBR',
  scotiabank: 'SCOT',
  banbajío:   'BAJIO',
  afirme:     'AFRM',
  intercam:   'INTC',
  nu:         'NU',
  spin:       'SPIN',
  'hey banco':'HEY',
  albo:       'ALBO',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function generarFolio(banco, fecha, seq) {
  const key    = (banco ?? '').trim().toLowerCase();
  const prefix = BANK_PREFIX[key] ?? 'UNKN';
  const yy     = String(fecha.getFullYear()).slice(-2);
  const mm     = String(fecha.getMonth() + 1).padStart(2, '0');
  const dd     = String(fecha.getDate()).padStart(2, '0');
  const sufijo = seq.toString(16).toUpperCase().padStart(4, '0');
  return `${prefix}-${yy}${mm}${dd}-${sufijo}`;
}

// ── Service ───────────────────────────────────────────────────────────────────

async function getCards() {
  const agg = await BankMovement.aggregate([
    { $match: { isActive: true } },
    { $sort:  { banco: 1, fecha: 1, _id: 1 } },
    {
      $group: {
        _id:            '$banco',
        movimientos:    { $sum: 1 },
        totalDepositos: { $sum: { $ifNull: ['$deposito', 0] } },
        totalRetiros:   { $sum: { $ifNull: ['$retiro',   0] } },
        ultimaFecha:    { $max: '$fecha' },
        ultimaImport:   { $max: '$createdAt' },
        saldoFinal:     { $last: '$saldo' },
        no_identificado: { $sum: { $cond: [{ $in: ['$status', ['no_identificado', null]] }, 1, 0] } },
        identificado:    { $sum: { $cond: [{ $eq:  ['$status', 'identificado'] }, 1, 0] } },
        otros:           { $sum: { $cond: [{ $eq:  ['$status', 'otros'] }, 1, 0] } },
        saldoPendiente:  {
          $sum: {
            $cond: [
              { $in: ['$status', ['no_identificado', null]] },
              { $subtract: [{ $ifNull: ['$deposito', 0] }, { $ifNull: ['$retiro', 0] }] },
              0,
            ],
          },
        },
        saldoIdentificado: {
          $sum: {
            $cond: [
              { $eq: ['$status', 'identificado'] },
              { $subtract: [{ $ifNull: ['$deposito', 0] }, { $ifNull: ['$retiro', 0] }] },
              0,
            ],
          },
        },
        saldoOtros: {
          $sum: {
            $cond: [
              { $eq: ['$status', 'otros'] },
              { $subtract: [{ $ifNull: ['$deposito', 0] }, { $ifNull: ['$retiro', 0] }] },
              0,
            ],
          },
        },
      },
    },
    { $sort: { _id: 1 } },
    {
      $lookup: {
        from: 'bank_configs', localField: '_id', foreignField: 'banco', as: 'config',
      },
    },
    { $unwind: { path: '$config', preserveNullAndEmptyArrays: true } },
  ]);

  return agg.map((b) => ({
    banco:          b._id,
    movimientos:    b.movimientos,
    totalDepositos: b.totalDepositos,
    totalRetiros:   b.totalRetiros,
    saldoFinal:     b.saldoFinal ?? null,
    ultimaFecha:    b.ultimaFecha,
    ultimaImport:   b.ultimaImport,
    cuentaContable: b.config?.cuentaContable ?? null,
    numeroCuenta:   b.config?.numeroCuenta   ?? null,
    saldoPendiente:    b.saldoPendiente    ?? 0,
    saldoIdentificado: b.saldoIdentificado ?? 0,
    saldoOtros:        b.saldoOtros        ?? 0,
    porStatus: {
      no_identificado: b.no_identificado,
      identificado:    b.identificado,
      otros:           b.otros,
    },
  }));
}

async function listMovements(filters) {
  const {
    page = 1, limit = 50,
    banco, fechaInicio, fechaFin,
    tipo, search,
    sortBy = 'fecha', sortDir = 'desc',
    status, categoria,
  } = filters;

  const filter = { isActive: true };
  if (banco)     filter.banco     = banco;
  if (status)    filter.status    = status;
  if (categoria) filter.categoria = categoria;
  if (tipo === 'deposito') filter.deposito = { $gt: 0 };
  if (tipo === 'retiro')   filter.retiro   = { $gt: 0 };

  if (fechaInicio || fechaFin) {
    filter.fecha = {};
    if (fechaInicio) filter.fecha.$gte = new Date(fechaInicio);
    if (fechaFin)    filter.fecha.$lte = new Date(`${fechaFin}T23:59:59.999Z`);
  }

  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re       = new RegExp(escaped, 'i');
    const orClauses = [
      { concepto: re }, { numeroAutorizacion: re },
      { referenciaNumerica: re }, { folio: re }, { uuidXML: re },
    ];

    // Búsqueda por monto
    const cleanNum = search.replace(/[$,\s]/g, '');
    const num = parseFloat(cleanNum);
    if (!isNaN(num) && num > 0) {
      orClauses.push({ deposito: { $gte: num - 0.005, $lte: num + 0.005 } });
      orClauses.push({ retiro:   { $gte: num - 0.005, $lte: num + 0.005 } });
    }

    // Búsqueda por fecha
    const dmyMatch = search.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
    const ymdMatch = search.match(/^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})$/);
    let searchDate = null;
    if (dmyMatch) {
      searchDate = new Date(parseInt(dmyMatch[3]), parseInt(dmyMatch[2]) - 1, parseInt(dmyMatch[1]));
    } else if (ymdMatch) {
      searchDate = new Date(parseInt(ymdMatch[1]), parseInt(ymdMatch[2]) - 1, parseInt(ymdMatch[3]));
    }
    if (searchDate && !isNaN(searchDate.getTime())) {
      const nextDay = new Date(searchDate);
      nextDay.setDate(nextDay.getDate() + 1);
      orClauses.push({ fecha: { $gte: searchDate, $lt: nextDay } });
    }

    filter.$or = orClauses;
  }

  const SORTABLE   = ['fecha', 'banco', 'deposito', 'retiro', 'saldo'];
  const sortField  = SORTABLE.includes(sortBy) ? sortBy : 'fecha';
  const sortOrder  = sortDir === 'asc' ? 1 : -1;
  const skip       = (parseInt(page) - 1) * parseInt(limit);

  const [movements, total] = await Promise.all([
    BankMovement.find(filter)
      .sort({ [sortField]: sortOrder, _id: 1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    BankMovement.countDocuments(filter),
  ]);

  // Enriquecer con solicitudes de cobro confirmadas vinculadas a cada movimiento
  const movIds = movements.map(m => m._id);
  const solicitudes = await CollectionRequest.find(
    { bankMovementId: { $in: movIds }, status: 'confirmado' },
    'bankMovementId monto clienteNombre clienteRFC confirmadoAt',
  ).lean();

  const solicitudesPorMov = {};
  for (const s of solicitudes) {
    const key = s.bankMovementId.toString();
    if (!solicitudesPorMov[key]) solicitudesPorMov[key] = [];
    solicitudesPorMov[key].push({
      _id:           s._id,
      monto:         s.monto,
      clienteNombre: s.clienteNombre,
      clienteRFC:    s.clienteRFC,
      confirmadoAt:  s.confirmadoAt,
    });
  }

  const data = movements.map(m => ({
    ...m,
    solicitudesConfirmadas: solicitudesPorMov[m._id.toString()] ?? [],
  }));

  return {
    data,
    pagination: {
      total,
      page:  parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / parseInt(limit)),
    },
  };
}

async function getSummary(fechaInicio, fechaFin) {
  const match = { isActive: true };
  if (fechaInicio || fechaFin) {
    match.fecha = {};
    if (fechaInicio) match.fecha.$gte = new Date(fechaInicio);
    if (fechaFin)    match.fecha.$lte = new Date(fechaFin);
  }
  return BankMovement.aggregate([
    { $match: match },
    {
      $group: {
        _id:            '$banco',
        totalDepositos: { $sum: { $ifNull: ['$deposito', 0] } },
        totalRetiros:   { $sum: { $ifNull: ['$retiro',   0] } },
        movimientos:    { $sum: 1 },
        saldoFinal:     { $last: '$saldo' },
      },
    },
    { $sort: { _id: 1 } },
  ]);
}

async function importFile(buffer, banco, userId) {
  const bancoValidado = BANCOS_VALIDOS.includes(banco) ? banco : null;
  const { movements, summary, errors } = await parseBankFile(buffer, bancoValidado);

  if (!movements.length && errors.length) {
    const err = new Error('No se pudo procesar ninguna hoja del archivo');
    err.statusCode = 422;
    err.errors = errors;
    throw err;
  }

  if (movements.length > 0) {
    const counter = await Counter.findOneAndUpdate(
      { _id: 'bankMovement' },
      { $inc: { seq: movements.length } },
      { upsert: true, new: true },
    );
    const startSeq = counter.seq - movements.length + 1;
    movements.forEach((m, i) => {
      const fechaMov = m.fecha instanceof Date ? m.fecha : new Date(m.fecha);
      m.folio = generarFolio(m.banco, fechaMov, startSeq + i);
    });
  }

  const BATCH = 500;
  let insertados = 0;
  let duplicados = 0;

  for (let i = 0; i < movements.length; i += BATCH) {
    const batch = movements.slice(i, i + BATCH);
    const ops = batch.map((m) => ({
      updateOne: {
        filter: { hash: m.hash },
        update: { $setOnInsert: { ...m, uploadedBy: userId, isActive: true } },
        upsert: true,
      },
    }));
    try {
      const result = await BankMovement.bulkWrite(ops, { ordered: false });
      insertados += result.upsertedCount;
      duplicados += result.matchedCount;
    } catch (err) {
      insertados += err.result?.nUpserted || 0;
      duplicados += err.result?.nMatched  || 0;
    }
  }

  return {
    message:      `${insertados} movimientos importados, ${duplicados} ya existían`,
    importados:   insertados,
    duplicados,
    resumen:      summary,
    erroresHojas: errors,
  };
}

async function updateStatus(id, status) {
  if (!STATUS_VALIDOS.includes(status)) {
    throw new BadRequestError(`Status inválido. Debe ser: ${STATUS_VALIDOS.join(', ')}`);
  }
  const mov = await BankMovement.findById(id);
  if (!mov) throw new NotFoundError('Movimiento');
  if (mov.uuidXML) {
    throw new ConflictError('Movimiento bloqueado: tiene un UUID CFDI vinculado y no puede cambiar de estado');
  }
  mov.status = status;
  await mov.save();
  return { _id: mov._id, status: mov.status };
}

async function linkUuid(id, uuidXML) {
  if (!uuidXML || typeof uuidXML !== 'string' || !uuidXML.trim()) {
    throw new BadRequestError('UUID inválido o vacío');
  }
  const uuid = uuidXML.trim().toUpperCase();

  const mov = await BankMovement.findById(id);
  if (!mov) throw new NotFoundError('Movimiento');
  if (mov.uuidXML) throw new ConflictError('Este movimiento ya tiene un UUID vinculado');

  // Si ese UUID ya está vinculado a otro movimiento, lo desvincula primero.
  const previo = await BankMovement.findOne({ uuidXML: uuid, _id: { $ne: id }, isActive: true });
  if (previo) {
    previo.uuidXML = null;
    previo.status  = 'no_identificado';
    await previo.save();
  }

  mov.uuidXML = uuid;
  mov.status  = 'identificado';
  await mov.save();
  return { _id: mov._id, uuidXML: mov.uuidXML, status: mov.status, previoDesvinculado: previo?._id ?? null };
}

async function unlinkUuid(id) {
  const mov = await BankMovement.findById(id);
  if (!mov) throw new NotFoundError('Movimiento');
  if (!mov.uuidXML) throw new BadRequestError('Este movimiento no tiene UUID vinculado');
  mov.uuidXML = null;
  mov.status  = 'no_identificado';
  await mov.save();
  return { _id: mov._id, uuidXML: null, status: mov.status };
}

async function updateErpIds(id, action, erpId) {
  if (!erpId || typeof erpId !== 'string' || !erpId.trim()) {
    throw new BadRequestError('erpId inválido o vacío');
  }
  if (!['add', 'remove'].includes(action)) {
    throw new BadRequestError('action debe ser "add" o "remove"');
  }
  const cleanId = erpId.trim();
  const update  = action === 'remove'
    ? { $pull:     { erpIds: cleanId } }
    : { $addToSet: { erpIds: cleanId } };

  const mov = await BankMovement.findByIdAndUpdate(id, update, { new: true });
  if (!mov) throw new NotFoundError('Movimiento');
  return { _id: mov._id, erpIds: mov.erpIds };
}

async function setErpIds(id, erpIds) {
  if (!Array.isArray(erpIds)) throw new BadRequestError('erpIds debe ser un arreglo');
  const cleaned = [...new Set(erpIds.map(x => String(x).trim()).filter(Boolean))];
  const mov = await BankMovement.findByIdAndUpdate(id, { erpIds: cleaned }, { new: true });
  if (!mov) throw new NotFoundError('Movimiento');
  return { _id: mov._id, erpIds: mov.erpIds };
}

async function getConfig(banco) {
  const cfg = await BankConfig.findOne({ banco }).lean();
  return cfg ?? { banco, cuentaContable: null, numeroCuenta: null };
}

async function saveConfig(banco, data) {
  if (!BANCOS_VALIDOS.includes(banco)) throw new BadRequestError('Banco inválido');
  const update = {};
  if (data.cuentaContable !== undefined) update.cuentaContable = data.cuentaContable || null;
  if (data.numeroCuenta   !== undefined) update.numeroCuenta   = data.numeroCuenta   || null;
  return BankConfig.findOneAndUpdate({ banco }, { $set: update }, { upsert: true, new: true });
}

async function recategorizarMovimientos() {
  // Obtiene todos los movimientos sin categoría en lotes y los reclasifica
  const BATCH = 500;
  let actualizados = 0;
  let cursor = 0;

  while (true) {
    const docs = await BankMovement.find(
      { isActive: true, $or: [{ categoria: null }, { categoria: { $exists: false } }] },
      { _id: 1, concepto: 1 },
    ).skip(cursor).limit(BATCH).lean();

    if (docs.length === 0) break;

    const ops = docs
      .map((d) => ({ id: d._id, cat: clasificar(d.concepto) }))
      .filter((x) => x.cat !== null)
      .map(({ id, cat }) => ({
        updateOne: { filter: { _id: id }, update: { $set: { categoria: cat } } },
      }));

    if (ops.length) {
      await BankMovement.bulkWrite(ops, { ordered: false });
      actualizados += ops.length;
    }

    cursor += docs.length;
    if (docs.length < BATCH) break;
  }

  return { actualizados };
}

module.exports = {
  getCards, listMovements, getSummary,
  importFile, updateStatus, linkUuid, unlinkUuid, updateErpIds, setErpIds,
  getConfig, saveConfig, recategorizarMovimientos,
};
