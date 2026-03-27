const CFDI = require('../models/CFDI');
const Comparison = require('../models/Comparison');
const Discrepancy = require('../models/Discrepancy');
const { verifyCFDIWithSAT } = require('./satVerification');
const { logger } = require('../utils/logger');

const TOLERANCE_AMOUNT = 0.01;

/**
 * Compara un CFDI del ERP contra:
 *  a) El estado en vivo del SAT (SOAP)
 *  b) La copia local SAT si fue descargada manualmente
 *
 * El chequeo en vivo del SAT es "best-effort": si falla o el UUID no
 * está registrado, el engine igual hace la comparación campo a campo
 * si existe una copia local con source='SAT'.
 */
const compareCFDI = async (erpCfdiId, options = {}) => {
  const erpCfdi = await CFDI.findById(erpCfdiId);
  if (!erpCfdi) throw new Error(`CFDI ERP no encontrado: ${erpCfdiId}`);

  const triggeredBy = options.triggeredBy;

  // ── 1. Buscar copia local SAT (siempre, independiente del live check) ──
  const satCfdi = await CFDI.findOne({ uuid: erpCfdi.uuid, source: 'SAT' });

  // ── 2. Live check SAT (best-effort, no bloquea la comparación local) ──
  let satResponse = null;
  try {
    satResponse = await verifyCFDIWithSAT(
      erpCfdi.uuid,
      erpCfdi.emisor.rfc,
      erpCfdi.receptor.rfc,
      erpCfdi.total,
      erpCfdi.sello || '',
      erpCfdi.version || '4.0'
    );
    await updateSATStatus(erpCfdi, satResponse.state);
  } catch (err) {
    logger.warn(`[Engine] Live SAT check falló para ${erpCfdi.uuid}: ${err.message}. Continuando con copia local.`);
    await updateSATStatus(erpCfdi, satCfdi ? 'Verificado Local' : 'Error');
  }

  const differences = [];

  // ── 3. Discrepancias de estado SAT ──
  if (satResponse) {
    if (satResponse.state === 'No Encontrado') {
      differences.push({
        field: 'sat.uuid',
        erpValue: 'Registrado en ERP',
        satValue: 'No encontrado en SAT',
        severity: 'critical',
        type: 'UUID_NOT_FOUND_SAT',
      });
    } else if (satResponse.isCancelled) {
      differences.push({
        field: 'sat.estado',
        erpValue: 'Vigente',
        satValue: 'Cancelado',
        severity: 'critical',
        type: 'CANCELLED_IN_SAT',
      });
    }
  }

  // ── 4. Comparación campo a campo (solo si existe copia local SAT) ──
  if (satCfdi) {
    differences.push(...compareAmounts(erpCfdi, satCfdi));
    differences.push(...compareParties(erpCfdi, satCfdi));
    differences.push(...compareDates(erpCfdi, satCfdi));
    differences.push(...compareTaxes(erpCfdi, satCfdi));
  }

  const criticalCount = differences.filter(d => d.severity === 'critical').length;
  const warningCount  = differences.filter(d => d.severity === 'warning').length;

  const SAT_VALID_STATES = ['Vigente', 'Cancelado', 'No Encontrado'];
  const satIsUnreachable = satResponse && !SAT_VALID_STATES.includes(satResponse.state);

  let status;
  if (!satCfdi && !satResponse) {
    status = 'error';
  } else if (satIsUnreachable && !satCfdi) {
    // SAT devolvió Expresión Inválida, Error, etc. y no hay copia local — no se puede verificar
    status = 'error';
  } else if (satResponse?.state === 'No Encontrado' && !satCfdi) {
    status = 'not_in_sat';
  } else if (satResponse?.isCancelled) {
    status = 'cancelled';
  } else if (differences.length === 0) {
    status = 'match';
  } else {
    status = 'discrepancy';
  }

  // Persistir resultado en el propio documento CFDI para sobrevivir recargas
  await CFDI.findByIdAndUpdate(erpCfdiId, {
    lastComparisonStatus: status,
    lastComparisonAt: new Date(),
  });

  const comp = await saveComparison({
    uuid: erpCfdi.uuid,
    erpCfdiId,
    satCfdiId: satCfdi?._id,
    status,
    differences,
    criticalCount,
    warningCount,
    satRawResponse: satResponse?.rawResponse ?? null,
    triggeredBy,
    hasLocalSATCopy: !!satCfdi,
  });

  // Eliminar discrepancias previas de esta comparación para evitar duplicados
  await Discrepancy.deleteMany({ comparisonId: comp._id });

  if (differences.length > 0) {
    await Promise.all(differences.map(diff =>
      saveDiscrepancy({
        comparisonId: comp._id,
        uuid: erpCfdi.uuid,
        type: diff.type || mapDiffToType(diff.field),
        severity: diff.severity,
        description: `Campo '${diff.field}': ERP="${diff.erpValue}", SAT="${diff.satValue}"`,
        erpValue: String(diff.erpValue ?? ''),
        satValue: String(diff.satValue ?? ''),
        rfcEmisor: erpCfdi.emisor.rfc,
        rfcReceptor: erpCfdi.receptor.rfc,
        fiscalImpact: diff.fiscalImpact,
      })
    ));
  }

  return comp;
};

// ── Comparadores ──────────────────────────────────────────────────────────────

const compareAmounts = (erp, sat) => {
  const diffs = [];
  for (const [field, severity] of [['total', 'critical'], ['subTotal', 'warning'], ['descuento', 'warning']]) {
    const erpVal = erp[field] || 0;
    const satVal = sat[field] || 0;
    if (Math.abs(erpVal - satVal) > TOLERANCE_AMOUNT) {
      diffs.push({
        field,
        erpValue: erpVal,
        satValue: satVal,
        severity,
        fiscalImpact: { amount: Math.abs(erpVal - satVal), currency: erp.moneda },
      });
    }
  }
  return diffs;
};

const compareParties = (erp, sat) => {
  const diffs = [];
  if (erp.emisor.rfc !== sat.emisor.rfc)
    diffs.push({ field: 'emisor.rfc', erpValue: erp.emisor.rfc, satValue: sat.emisor.rfc, severity: 'critical' });
  if (erp.receptor.rfc !== sat.receptor.rfc)
    diffs.push({ field: 'receptor.rfc', erpValue: erp.receptor.rfc, satValue: sat.receptor.rfc, severity: 'critical' });
  if (erp.emisor.regimenFiscal !== sat.emisor.regimenFiscal)
    diffs.push({ field: 'emisor.regimenFiscal', erpValue: erp.emisor.regimenFiscal, satValue: sat.emisor.regimenFiscal, severity: 'warning' });
  return diffs;
};

const compareDates = (erp, sat) => {
  const erpDate = new Date(erp.fecha).toISOString().split('T')[0];
  const satDate = new Date(sat.fecha).toISOString().split('T')[0];
  if (erpDate !== satDate)
    return [{ field: 'fecha', erpValue: erpDate, satValue: satDate, severity: 'warning' }];
  return [];
};

const compareTaxes = (erp, sat) => {
  const erpImp = erp.impuestos?.totalImpuestosTrasladados || 0;
  const satImp = sat.impuestos?.totalImpuestosTrasladados || 0;
  if (Math.abs(erpImp - satImp) > TOLERANCE_AMOUNT) {
    return [{
      field: 'impuestos.totalImpuestosTrasladados',
      erpValue: erpImp,
      satValue: satImp,
      severity: 'critical',
      fiscalImpact: { amount: Math.abs(erpImp - satImp), currency: erp.moneda, taxType: 'IVA' },
    }];
  }
  return [];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const updateSATStatus = async (cfdi, state) => {
  cfdi.satStatus = ['Vigente', 'Cancelado', 'No Encontrado', 'Pendiente', 'Error', 'Expresión Inválida', 'Desconocido'].includes(state)
    ? state : 'Error';
  cfdi.satLastCheck = new Date();
  await cfdi.save();
};

const saveComparison = async (data) => {
  return Comparison.findOneAndUpdate(
    { uuid: data.uuid },
    { ...data, totalDifferences: data.differences?.length || 0, comparedAt: new Date() },
    { upsert: true, new: true }
  );
};

const saveDiscrepancy = async (data) => Discrepancy.create(data);

const mapDiffToType = (field) => {
  if (field.includes('rfc'))        return 'RFC_MISMATCH';
  if (field === 'total' || field === 'subTotal') return 'AMOUNT_MISMATCH';
  if (field.includes('impuesto'))   return 'TAX_CALCULATION_ERROR';
  if (field === 'fecha')            return 'DATE_MISMATCH';
  return 'OTHER';
};

const batchCompareCFDIs = async (erpCfdiIds, options = {}) => {
  const results = { success: 0, failed: 0, discrepancies: 0, errors: [] };
  const concurrency = options.concurrency || 5;

  for (let i = 0; i < erpCfdiIds.length; i += concurrency) {
    const chunk = erpCfdiIds.slice(i, i + concurrency);
    await Promise.all(chunk.map(id =>
      compareCFDI(id, options)
        .then(comp => {
          results.success++;
          if (['discrepancy', 'not_in_sat', 'cancelled'].includes(comp.status)) results.discrepancies++;
        })
        .catch(err => {
          results.failed++;
          results.errors.push({ id, error: err.message });
          logger.error(`Error en comparación de CFDI ${id}:`, err.message);
        })
    ));
    if (i + concurrency < erpCfdiIds.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return results;
};

module.exports = { compareCFDI, batchCompareCFDIs };
