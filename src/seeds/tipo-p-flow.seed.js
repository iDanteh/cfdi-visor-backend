'use strict';

/**
 * Seed: flujo completo CFDI tipo I → tipo P → movimiento bancario
 *
 * Cubre dos escenarios:
 *   A) Pago total:   una factura de $116,000 liquidada con un solo tipo P
 *   B) Pago parcial: una factura de $200,000 pagada en dos complementos ($80k + $120k)
 *
 * Uso:
 *   node src/seeds/tipo-p-flow.seed.js
 *   node src/seeds/tipo-p-flow.seed.js --clean   (solo limpia, sin insertar)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const mongoose     = require('mongoose');
const crypto       = require('crypto');
const { connectDB, disconnectDB } = require('../config/database');
const cfdiService  = require('../domains/cfdis/cfdi.service');
const bankService  = require('../domains/banks/bank.service');
const CFDI         = require('../domains/cfdis/CFDI.model');
const BankMovement = require('../domains/banks/BankMovement.model');

// ── UUIDs fijos (UUID v4 válido, prefijo 00000 para identificarlos fácilmente) ─

const UUID = {
  // Escenario A — pago total
  FACTURA_A:   '00000000-0000-4000-8000-000000000001',
  TIPO_P_A:    '00000000-0000-4000-8000-000000000002',

  // Escenario B — pago parcial
  FACTURA_B:   '00000000-0000-4000-8000-000000000003',
  TIPO_P_B1:   '00000000-0000-4000-8000-000000000004',  // primer pago: $80,000
  TIPO_P_B2:   '00000000-0000-4000-8000-000000000005',  // segundo pago: $120,000
};

const FAKE_USER = new mongoose.Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa');

// ── Helpers ──────────────────────────────────────────────────────────────────

const log  = (msg)       => console.log(`\n  ${msg}`);
const ok   = (msg)       => console.log(`  ✓ ${msg}`);
const info = (label, obj) => console.log(`  · ${label}:`, JSON.stringify(obj, null, 4)
  .split('\n').join('\n    '));
const hr   = (title)     => console.log(`\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}`);

function makeHash(seed) {
  return crypto.createHash('sha256').update(`SEED:${seed}`).digest('hex');
}

// ── Limpieza de datos de prueba ───────────────────────────────────────────────

async function clean() {
  hr('LIMPIEZA');
  const allUuids = Object.values(UUID);

  const cfdisRemoved = await CFDI.deleteMany({ uuid: { $in: allUuids } });
  ok(`CFDIs eliminados: ${cfdisRemoved.deletedCount}`);

  const movsRemoved = await BankMovement.deleteMany({
    folio: { $in: ['BBVA-SEED-0001', 'BBVA-SEED-0002', 'BBVA-SEED-0003'] },
  });
  ok(`Movimientos bancarios eliminados: ${movsRemoved.deletedCount}`);
}

// ── Escenario A: pago total ───────────────────────────────────────────────────

async function scenarioA() {
  hr('ESCENARIO A — Pago total ($116,000)');

  // ── 1. Factura tipo I ──────────────────────────────────────────────────────
  log('Paso 1: Crear factura tipo I ($116,000 PPD)');

  const facturaA = await cfdiService.createFromJson({
    uuid:               UUID.FACTURA_A,
    tipoDeComprobante:  'I',
    fecha:              '2026-03-01T10:00:00',
    serie:              'A',
    folio:              'SEED-001',
    subTotal:           100000,
    total:              116000,
    moneda:             'MXN',
    tipoCambio:         1,
    metodoPago:         'PPD',   // pago en parcialidades o diferido
    formaPago:          '99',    // por definir (se usará en tipo P)
    emisor:   { rfc: 'EMP010101AAA', nombre: 'Empresa Emisora SA de CV', regimenFiscal: '601' },
    receptor: { rfc: 'CLI020202BBB', nombre: 'Cliente Receptor SA de CV',
                domicilioFiscalReceptor: '64000', regimenFiscal: '601', usoCFDI: 'G01' },
    impuestos: { totalImpuestosTrasladados: 16000, totalImpuestosRetenidos: 0 },
  }, FAKE_USER);

  ok(`Factura creada: ${facturaA.uuid}`);
  info('estadoPago inicial', {
    estadoPago:     facturaA.estadoPago,
    saldoPendiente: facturaA.saldoPendiente,
    total:          facturaA.total,
  });

  // ── 2. Movimiento bancario ─────────────────────────────────────────────────
  log('Paso 2: Crear movimiento bancario (depósito $116,000 BBVA)');

  const movA = await BankMovement.create({
    banco:              'BBVA',
    fecha:              new Date('2026-03-15'),
    concepto:           'TRANSFERENCIA RECIBIDA CLIENTE RECEPTOR SA DE CV REF 1234567890',
    deposito:           116000,
    retiro:             null,
    saldo:              316000,
    numeroAutorizacion: '1234567890',
    referenciaNumerica: '98765432',
    status:             'no_identificado',
    folio:              'BBVA-SEED-0001',
    hash:               makeHash('MOV-A-116000'),
    isActive:           true,
    uploadedBy:         FAKE_USER,
  });

  ok(`Movimiento creado: ${movA._id} | folio: ${movA.folio} | status: ${movA.status}`);

  // ── 3. Complemento de pago tipo P ─────────────────────────────────────────
  log('Paso 3: Crear CFDI tipo P (complemento de pago que liquida la factura)');

  const pagoA = await cfdiService.createFromJson({
    uuid:               UUID.TIPO_P_A,
    tipoDeComprobante:  'P',
    fecha:              '2026-03-15T14:00:00',
    subTotal:           0,
    total:              0,
    moneda:             'XXX',
    tipoCambio:         1,
    emisor:   { rfc: 'EMP010101AAA', nombre: 'Empresa Emisora SA de CV', regimenFiscal: '601' },
    receptor: { rfc: 'CLI020202BBB', nombre: 'Cliente Receptor SA de CV',
                domicilioFiscalReceptor: '64000', regimenFiscal: '601', usoCFDI: 'CP01' },
    // Nodos pago20:Pago (parseados del XML)
    pagos: [{
      fechaPago:       new Date('2026-03-15T12:00:00'),
      formaDePagoP:    '03',   // transferencia electrónica
      monedaP:         'MXN',
      tipoCambioP:     1,
      monto:           116000,
      numOperacion:    '1234567890',
      ctaOrdenante:    '0123456789012345',
      ctaBeneficiario: '9876543210987654',
      rfcEmisorCtaBen: 'BBA830831LJ2',    // BBVA México
      doctosRelacionados: [{
        idDocumento:      UUID.FACTURA_A,
        serie:            'A',
        folio:            'SEED-001',
        monedaDR:         'MXN',
        equivalenciaDR:   1,
        numParcialidad:   1,
        impSaldoAnt:      116000,
        impPagado:        116000,
        impSaldoInsoluto: 0,        // ← factura queda liquidada
        objetoImpDR:      '02',
      }],
    }],
  }, FAKE_USER);

  ok(`CFDI tipo P creado: ${pagoA.uuid} | montoPago: $${pagoA.montoPago?.toLocaleString()}`);

  // ── 4. Verificar que la factura quedó pagada ───────────────────────────────
  log('Paso 4: Verificar estado de la factura tipo I');

  const facturaVerif = await CFDI.findOne({ uuid: UUID.FACTURA_A }).lean();
  info('Estado actualizado de la factura', {
    uuid:           facturaVerif.uuid,
    estadoPago:     facturaVerif.estadoPago,      // debe ser "pagado"
    saldoPendiente: facturaVerif.saldoPendiente,  // debe ser 0
  });

  const estadoOk = facturaVerif.estadoPago === 'pagado' && facturaVerif.saldoPendiente === 0;
  if (!estadoOk) {
    console.error('\n  ✗ ERROR: la factura no quedó en estado "pagado"');
    process.exitCode = 1;
    return;
  }
  ok('Factura correctamente marcada como "pagado" con saldoPendiente = 0');

  // ── 5. Vincular tipo P al movimiento bancario ──────────────────────────────
  log('Paso 5: Vincular UUID del tipo P al movimiento bancario');

  const linkResult = await bankService.linkUuid(movA._id.toString(), UUID.TIPO_P_A);
  ok(`Movimiento vinculado: status=${linkResult.status} | uuidXML=${linkResult.uuidXML}`);

  // ── Resumen escenario A ────────────────────────────────────────────────────
  log('RESUMEN ESCENARIO A:');
  console.log(`
    Movimiento bancario
      _id   : ${movA._id}
      folio : ${movA.folio}
      monto : $116,000
      status: identificado ✓
      uuidXML → ${UUID.TIPO_P_A}
           ↓
    CFDI tipo P
      uuid      : ${UUID.TIPO_P_A}
      montoPago : $116,000
      pagos[0].doctosRelacionados[0]
        idDocumento      → ${UUID.FACTURA_A}
        impPagado        : $116,000
        impSaldoInsoluto : $0
           ↓
    CFDI tipo I (factura)
      uuid           : ${UUID.FACTURA_A}
      total          : $116,000
      estadoPago     : pagado ✓
      saldoPendiente : $0 ✓
  `);
}

// ── Escenario B: pago parcial ─────────────────────────────────────────────────

async function scenarioB() {
  hr('ESCENARIO B — Pago parcial ($200,000 en dos complementos)');

  // ── 1. Factura tipo I por $200,000 ─────────────────────────────────────────
  log('Paso 1: Crear factura tipo I ($200,000 PPD)');

  const facturaB = await cfdiService.createFromJson({
    uuid:               UUID.FACTURA_B,
    tipoDeComprobante:  'I',
    fecha:              '2026-02-01T09:00:00',
    serie:              'A',
    folio:              'SEED-002',
    subTotal:           172413.79,
    total:              200000,
    moneda:             'MXN',
    tipoCambio:         1,
    metodoPago:         'PPD',
    formaPago:          '99',
    emisor:   { rfc: 'EMP010101AAA', nombre: 'Empresa Emisora SA de CV', regimenFiscal: '601' },
    receptor: { rfc: 'GRU030303CCC', nombre: 'Grupo Industrial del Sur SA de CV',
                domicilioFiscalReceptor: '06600', regimenFiscal: '601', usoCFDI: 'G01' },
  }, FAKE_USER);

  ok(`Factura creada | estadoPago: ${facturaB.estadoPago} | saldoPendiente: $${facturaB.saldoPendiente?.toLocaleString()}`);

  // ── 2. Primer movimiento bancario ($80,000) ────────────────────────────────
  log('Paso 2a: Crear primer movimiento bancario (depósito $80,000)');

  const movB1 = await BankMovement.create({
    banco:              'BBVA',
    fecha:              new Date('2026-02-20'),
    concepto:           'SPEI RECIBIDO GRUPO INDUSTRIAL DEL SUR 080000',
    deposito:           80000,
    saldo:              380000,
    status:             'no_identificado',
    folio:              'BBVA-SEED-0002',
    hash:               makeHash('MOV-B1-80000'),
    isActive:           true,
    uploadedBy:         FAKE_USER,
  });
  ok(`Movimiento 1 creado: ${movB1._id} | $80,000`);

  // ── 3. Primer complemento de pago ($80,000) ───────────────────────────────
  log('Paso 3a: Crear primer CFDI tipo P ($80,000 — parcialidad 1 de 2)');

  const pagoB1 = await cfdiService.createFromJson({
    uuid:               UUID.TIPO_P_B1,
    tipoDeComprobante:  'P',
    fecha:              '2026-02-20T16:00:00',
    subTotal:           0,
    total:              0,
    moneda:             'XXX',
    tipoCambio:         1,
    emisor:   { rfc: 'EMP010101AAA', nombre: 'Empresa Emisora SA de CV', regimenFiscal: '601' },
    receptor: { rfc: 'GRU030303CCC', nombre: 'Grupo Industrial del Sur SA de CV',
                domicilioFiscalReceptor: '06600', regimenFiscal: '601', usoCFDI: 'CP01' },
    pagos: [{
      fechaPago:    new Date('2026-02-20T14:30:00'),
      formaDePagoP: '03',
      monedaP:      'MXN',
      monto:        80000,
      numOperacion: '9876543210',
      doctosRelacionados: [{
        idDocumento:      UUID.FACTURA_B,
        monedaDR:         'MXN',
        equivalenciaDR:   1,
        numParcialidad:   1,
        impSaldoAnt:      200000,
        impPagado:        80000,
        impSaldoInsoluto: 120000,  // ← queda saldo de $120k
        objetoImpDR:      '02',
      }],
    }],
  }, FAKE_USER);

  ok(`Primer tipo P creado: ${pagoB1.uuid}`);

  // Verificar estado intermedio
  const facturaInter = await CFDI.findOne({ uuid: UUID.FACTURA_B }).lean();
  info('Estado intermedio de la factura (parcialmente pagada)', {
    estadoPago:     facturaInter.estadoPago,      // parcialmente_pagado
    saldoPendiente: facturaInter.saldoPendiente,  // 120000
  });

  // Vincular primer tipo P a movimiento
  await bankService.linkUuid(movB1._id.toString(), UUID.TIPO_P_B1);
  ok(`Movimiento 1 vinculado al tipo P B1`);

  // ── 4. Segundo movimiento bancario ($120,000) ──────────────────────────────
  log('Paso 2b: Crear segundo movimiento bancario (depósito $120,000)');

  const movB2 = await BankMovement.create({
    banco:              'BBVA',
    fecha:              new Date('2026-03-10'),
    concepto:           'SPEI RECIBIDO GRUPO INDUSTRIAL DEL SUR SALDO 120000',
    deposito:           120000,
    saldo:              500000,
    status:             'no_identificado',
    folio:              'BBVA-SEED-0003',
    hash:               makeHash('MOV-B2-120000'),
    isActive:           true,
    uploadedBy:         FAKE_USER,
  });
  ok(`Movimiento 2 creado: ${movB2._id} | $120,000`);

  // ── 5. Segundo complemento de pago ($120,000) ─────────────────────────────
  log('Paso 3b: Crear segundo CFDI tipo P ($120,000 — parcialidad 2 de 2)');

  const pagoB2 = await cfdiService.createFromJson({
    uuid:               UUID.TIPO_P_B2,
    tipoDeComprobante:  'P',
    fecha:              '2026-03-10T15:00:00',
    subTotal:           0,
    total:              0,
    moneda:             'XXX',
    tipoCambio:         1,
    emisor:   { rfc: 'EMP010101AAA', nombre: 'Empresa Emisora SA de CV', regimenFiscal: '601' },
    receptor: { rfc: 'GRU030303CCC', nombre: 'Grupo Industrial del Sur SA de CV',
                domicilioFiscalReceptor: '06600', regimenFiscal: '601', usoCFDI: 'CP01' },
    pagos: [{
      fechaPago:    new Date('2026-03-10T14:00:00'),
      formaDePagoP: '03',
      monedaP:      'MXN',
      monto:        120000,
      numOperacion: '5555555555',
      doctosRelacionados: [{
        idDocumento:      UUID.FACTURA_B,
        monedaDR:         'MXN',
        equivalenciaDR:   1,
        numParcialidad:   2,
        impSaldoAnt:      120000,
        impPagado:        120000,
        impSaldoInsoluto: 0,        // ← factura queda liquidada
        objetoImpDR:      '02',
      }],
    }],
  }, FAKE_USER);

  ok(`Segundo tipo P creado: ${pagoB2.uuid}`);

  // Verificar estado final
  const facturaFinal = await CFDI.findOne({ uuid: UUID.FACTURA_B }).lean();
  info('Estado final de la factura (liquidada)', {
    estadoPago:     facturaFinal.estadoPago,      // pagado
    saldoPendiente: facturaFinal.saldoPendiente,  // 0
  });

  const estadoOk = facturaFinal.estadoPago === 'pagado' && facturaFinal.saldoPendiente === 0;
  if (!estadoOk) {
    console.error('\n  ✗ ERROR: la factura no quedó en estado "pagado" tras el segundo complemento');
    process.exitCode = 1;
    return;
  }
  ok('Factura correctamente liquidada tras dos complementos de pago');

  // Vincular segundo tipo P a movimiento
  await bankService.linkUuid(movB2._id.toString(), UUID.TIPO_P_B2);
  ok('Movimiento 2 vinculado al tipo P B2');

  // ── Resumen escenario B ────────────────────────────────────────────────────
  log('RESUMEN ESCENARIO B:');
  console.log(`
    Factura tipo I
      uuid    : ${UUID.FACTURA_B}
      total   : $200,000
      metodoPago: PPD

    Pago 1 — SPEI $80,000 (20-Feb-2026)
      Movimiento  : ${movB1._id} | folio BBVA-SEED-0002
      CFDI tipo P : ${UUID.TIPO_P_B1}
      Parcialidad 1 — impSaldoAnt: $200,000 | impPagado: $80,000 | insoluto: $120,000
      → estadoPago: parcialmente_pagado ✓

    Pago 2 — SPEI $120,000 (10-Mar-2026)
      Movimiento  : ${movB2._id} | folio BBVA-SEED-0003
      CFDI tipo P : ${UUID.TIPO_P_B2}
      Parcialidad 2 — impSaldoAnt: $120,000 | impPagado: $120,000 | insoluto: $0
      → estadoPago: pagado ✓  |  saldoPendiente: $0 ✓
  `);
}

// ── Escenario C: tipo P importado ANTES que la factura (reprocesar) ───────────

async function scenarioC() {
  hr('ESCENARIO C — Tipo P importado antes que la factura (reprocesar-pago)');

  const UUID_FAC_C  = '00000000-0000-4000-8000-000000000006';
  const UUID_PAG_C  = '00000000-0000-4000-8000-000000000007';

  // Limpiar por si acaso
  await CFDI.deleteMany({ uuid: { $in: [UUID_FAC_C, UUID_PAG_C] } });

  // ── 1. Primero crear el tipo P (sin que exista la factura aún) ─────────────
  log('Paso 1: Importar tipo P (la factura aún NO existe)');

  const pagoC = await cfdiService.createFromJson({
    uuid:               UUID_PAG_C,
    tipoDeComprobante:  'P',
    fecha:              '2026-04-01T10:00:00',
    subTotal:           0, total: 0, moneda: 'XXX', tipoCambio: 1,
    emisor:   { rfc: 'EMP010101AAA', nombre: 'Empresa Emisora SA de CV', regimenFiscal: '601' },
    receptor: { rfc: 'CLI040404DDD', nombre: 'Cliente Tardío SA',
                domicilioFiscalReceptor: '01010', regimenFiscal: '601', usoCFDI: 'CP01' },
    pagos: [{
      fechaPago: new Date('2026-04-01'), formaDePagoP: '03', monedaP: 'MXN', monto: 58000,
      doctosRelacionados: [{
        idDocumento:      UUID_FAC_C,
        monedaDR: 'MXN', equivalenciaDR: 1,
        numParcialidad:   1,
        impSaldoAnt:      58000,
        impPagado:        58000,
        impSaldoInsoluto: 0,
        objetoImpDR: '02',
      }],
    }],
  }, FAKE_USER);

  ok(`Tipo P creado: ${pagoC.uuid} | montoPago: $${pagoC.montoPago?.toLocaleString()}`);
  log('Verificando noEncontrados en pagoResult del log anterior...');
  // procesarComplementoDePago devuelve { procesados:[], noEncontrados:['UUID_FAC_C'] }
  // aquí lo verificamos manualmente re-ejecutando:
  const checkResult = await cfdiService.procesarComplementoDePago(pagoC);
  info('resultado de procesarComplementoDePago (factura ausente)', checkResult);

  // ── 2. Ahora importar la factura tipo I ────────────────────────────────────
  log('Paso 2: Importar la factura tipo I (llega después del complemento)');

  await cfdiService.createFromJson({
    uuid:               UUID_FAC_C,
    tipoDeComprobante:  'I',
    fecha:              '2026-03-25T09:00:00',
    serie: 'B', folio: 'SEED-003',
    subTotal: 50000, total: 58000, moneda: 'MXN', tipoCambio: 1,
    metodoPago: 'PPD', formaPago: '99',
    emisor:   { rfc: 'EMP010101AAA', nombre: 'Empresa Emisora SA de CV', regimenFiscal: '601' },
    receptor: { rfc: 'CLI040404DDD', nombre: 'Cliente Tardío SA',
                domicilioFiscalReceptor: '01010', regimenFiscal: '601', usoCFDI: 'G01' },
  }, FAKE_USER);

  // La factura recién creada tendrá estadoPago: 'no_pagado' (no sabe del tipo P aún)
  const facturaNueva = await CFDI.findOne({ uuid: UUID_FAC_C }).lean();
  info('Estado de la factura recién importada (antes de reprocesar)', {
    estadoPago:     facturaNueva.estadoPago,      // no_pagado — aún no sabe del tipo P
    saldoPendiente: facturaNueva.saldoPendiente,  // 58000
  });

  // ── 3. Reprocesar el tipo P via endpoint ───────────────────────────────────
  log('Paso 3: Reprocesar el tipo P (POST /api/cfdis/:id/reprocesar-pago)');

  const reprocResult = await cfdiService.procesarComplementoDePago(pagoC);
  info('Resultado del reprocesamiento', reprocResult);

  const facturaFinal = await CFDI.findOne({ uuid: UUID_FAC_C }).lean();
  info('Estado de la factura DESPUÉS del reprocesamiento', {
    estadoPago:     facturaFinal.estadoPago,      // pagado
    saldoPendiente: facturaFinal.saldoPendiente,  // 0
  });

  const ok2 = facturaFinal.estadoPago === 'pagado';
  if (!ok2) {
    console.error('\n  ✗ ERROR: el reprocesamiento no actualizó la factura');
    process.exitCode = 1;
    return;
  }
  ok('Reprocesamiento exitoso — factura marcada como "pagado" ✓');

  // Limpiar datos del escenario C
  await CFDI.deleteMany({ uuid: { $in: [UUID_FAC_C, UUID_PAG_C] } });
  ok('Datos del escenario C limpiados');
}

// ── Consultas de verificación útiles ─────────────────────────────────────────

async function printVerificationQueries() {
  hr('CONSULTAS DE VERIFICACIÓN');
  console.log(`
  1. Ver todas las facturas con su estado de cobro:
     GET /api/cfdis?tipoDeComprobante=I

  2. Ver solo facturas pendientes (cartera CxC):
     db.cfdis.find({ tipoDeComprobante: 'I', estadoPago: { $ne: 'pagado' } })

  3. Ver el tipo P con sus DoctoRelacionado:
     GET /api/cfdis/<id_tipo_p>    → campo "pagos[0].doctosRelacionados"

  4. Ver movimiento con UUID vinculado:
     GET /api/banks/movements?banco=BBVA

  5. Reprocesar un tipo P si la factura llegó después:
     POST /api/cfdis/<id_tipo_p>/reprocesar-pago
  `);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const onlyClean = process.argv.includes('--clean');

  await connectDB();
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  SEED: Flujo CFDI tipo P → DoctoRelacionado');
  console.log('══════════════════════════════════════════════════════════');

  try {
    await clean();

    if (!onlyClean) {
      await scenarioA();
      await scenarioB();
      await scenarioC();
      await printVerificationQueries();

      hr('SEED COMPLETADO ✓');
      console.log('  Puedes verificar los datos con las consultas de arriba.');
      console.log('  Para limpiar: node src/seeds/tipo-p-flow.seed.js --clean\n');
    } else {
      hr('LIMPIEZA COMPLETADA ✓');
    }
  } catch (err) {
    console.error('\n  ✗ ERROR INESPERADO:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await disconnectDB();
  }
}

main();
