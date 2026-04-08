'use strict';

const mongoose = require('mongoose');

/**
 * Colección TEMPORAL de prueba — erp_cxc_snapshots
 *
 * Almacena una copia de las CxC devueltas por el ERP para comparar
 * contra movimientos bancarios y validar la viabilidad de la conciliación.
 * Esta colección será eliminada una vez terminada la fase exploratoria.
 */
const erpCxcSnapshotSchema = new mongoose.Schema({
  // ID original en el ERP (campo único para deduplicar upserts)
  erpId: { type: String, required: true, unique: true },

  // Campos provenientes del ERP
  serie:            { type: String, default: '' },
  folio:            { type: String, default: '' },
  tipoPago:         { type: String, default: null },
  subtotal:         { type: Number, default: 0 },
  impuesto:         { type: Number, default: 0 },
  total:            { type: Number, default: 0 },
  saldoActual:      { type: Number, default: 0 },
  fechaVencimiento: { type: Date,   default: null },

  // true cuando el erpId ya aparece en BankMovement.erpIds de algún movimiento
  is_vinculated: { type: Boolean, default: false, index: true },

  // Última vez que fue actualizado desde el ERP
  snapshotAt: { type: Date, default: Date.now, index: true },
}, {
  timestamps: true,
  collection: 'erp_cxc_snapshots',
});

module.exports = mongoose.model('ErpCxcSnapshot', erpCxcSnapshotSchema);
