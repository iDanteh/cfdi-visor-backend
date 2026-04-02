const mongoose = require('mongoose');

// Sub-schema para Emisor/Receptor
const contribuyenteSchema = new mongoose.Schema({
  rfc: { type: String, required: true, uppercase: true, trim: true },
  nombre: { type: String, trim: true },
  regimenFiscal: { type: String },
  domicilioFiscalReceptor: { type: String },
  residenciaFiscal: { type: String },
  numRegIdTrib: { type: String },
  usoCFDI: { type: String },
}, { _id: false });

// Sub-schema para Conceptos
const conceptoSchema = new mongoose.Schema({
  claveProdServ: { type: String },
  noIdentificacion: { type: String },
  cantidad: { type: Number },
  claveUnidad: { type: String },
  unidad: { type: String },
  descripcion: { type: String },
  valorUnitario: { type: Number },
  importe: { type: Number },
  descuento: { type: Number },
  objetoImp: { type: String },
  impuestos: {
    traslados: [{
      base: Number,
      impuesto: String,
      tipoFactor: String,
      tasaOCuota: Number,
      importe: Number,
    }],
    retenciones: [{
      base: Number,
      impuesto: String,
      tipoFactor: String,
      tasaOCuota: Number,
      importe: Number,
    }],
  },
}, { _id: false });

// Sub-schema para Impuestos globales
const impuestosSchema = new mongoose.Schema({
  totalImpuestosTrasladados: { type: Number, default: 0 },
  totalImpuestosRetenidos: { type: Number, default: 0 },
  traslados: [{
    base: Number,
    impuesto: String,
    tipoFactor: String,
    tasaOCuota: Number,
    importe: Number,
  }],
  retenciones: [{
    impuesto: String,
    importe: Number,
  }],
}, { _id: false });

const cfdiSchema = new mongoose.Schema({
  // Identificación
  uuid: {
    type: String,
    required: true,
    uppercase: true,
    trim: true,
  },

  // Origen del CFDI
  source: {
    type: String,
    enum: ['ERP', 'SAT', 'MANUAL', 'RECEPTOR'],
    required: true,
    index: true,
  },

  // Versión CFDI
  version: { type: String, enum: ['3.3', '4.0'], default: '4.0' },

  // Datos principales
  serie: { type: String },
  folio: { type: String },
  fecha: { type: Date, required: true, index: true },
  sello: { type: String },
  formaPago: { type: String },
  noCertificado: { type: String },
  certificado: { type: String },
  condicionesDePago: { type: String },
  subTotal: { type: Number, required: true },
  descuento: { type: Number, default: 0 },
  moneda: { type: String, default: 'MXN' },
  tipoCambio: { type: Number, default: 1 },
  total: { type: Number, required: true, index: true },

  // Monto real de pago — solo se popula en tipoDeComprobante 'P' (complemento de pago).
  // Es la suma de todos los nodos pago:Pago/@Monto del complemento.
  // Sirve para conciliar contra el movimiento bancario real (tipo P tiene total=0).
  montoPago: { type: Number, default: null, index: true },

  tipoDeComprobante: {
    type: String,
    enum: ['I', 'E', 'T', 'N', 'P'],
    required: true,
    index: true,
  },
  exportacion: { type: String },
  metodoPago: { type: String },
  lugarExpedicion: { type: String },

  // Partes
  emisor: { type: contribuyenteSchema, required: true },
  receptor: { type: contribuyenteSchema, required: true },
  conceptos: [conceptoSchema],
  impuestos: impuestosSchema,

  // CfdiRelacionados
  cfdiRelacionados: [{
    tipoRelacion: String,
    uuids: [String],
  }],

  // Complementos (timbre fiscal, pagos, etc.)
  timbreFiscalDigital: {
    uuid: String,
    fechaTimbrado: Date,
    rfcProvCertif: String,
    selloCFD: String,
    noCertificadoSAT: String,
    selloSAT: String,
    version: String,
  },

  // Resultado de la última comparación ejecutada
  lastComparisonStatus: {
    type: String,
    enum: ['match', 'discrepancy', 'not_in_sat', 'not_in_erp', 'cancelled', 'pending', 'error', null],
    default: null,
  },
  lastComparisonAt: { type: Date },

  // Estado en SAT
  satStatus: {
    type: String,
    enum: ['Vigente', 'Cancelado', 'No Encontrado', 'Pendiente', 'Error', 'Expresión Inválida', 'Desconocido', null],
    default: null,
    index: true,
  },
  satLastCheck: { type: Date },
  satCancelacionMotivo: { type: String },

  // XML original
  xmlContent: { type: String, select: false },
  xmlHash: { type: String },

  // ERP metadata
  erpId: { type: String, index: true },
  erpSystem: { type: String },

  // Google Drive (opcional — solo presente si el CFDI fue importado desde Drive)
  driveFileId:   { type: String, default: null },
  driveFileName: { type: String, default: null },

  // Auditoría
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isActive: { type: Boolean, default: true },
}, {
  timestamps: true,
  collection: 'cfdis',
});

// Índice único compuesto: un UUID puede existir como ERP y como SAT
cfdiSchema.index({ uuid: 1, source: 1 }, { unique: true });

// Índices compuestos
cfdiSchema.index({ 'emisor.rfc': 1, fecha: -1 });
cfdiSchema.index({ 'receptor.rfc': 1, fecha: -1 });
cfdiSchema.index({ source: 1, satStatus: 1 });
cfdiSchema.index({ tipoDeComprobante: 1, fecha: -1 });
cfdiSchema.index({ total: 1, 'emisor.rfc': 1 });

// Índice de texto para búsqueda
cfdiSchema.index({
  uuid: 'text',
  'emisor.rfc': 'text',
  'emisor.nombre': 'text',
  'receptor.rfc': 'text',
  'receptor.nombre': 'text',
});

module.exports = mongoose.model('CFDI', cfdiSchema);
