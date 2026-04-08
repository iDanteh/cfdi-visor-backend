'use strict';

const axios          = require('axios');
const ErpCxcSnapshot = require('./ErpCxcSnapshot.model');
const BankMovement   = require('../banks/BankMovement.model');

// ── Constantes de matching individual ─────────────────────────────────────────
const SCORE_MIN         = 0.50;   // Descarta matches individuales por debajo de este umbral
const TOL_EXACT_MXN     = 1;      // Diferencia ≤ $1  → match exacto
const TOL_PCT           = 0.02;   // Tolerancia de monto: 2 % del saldoActual
const TOL_MIN_MXN       = 5;      // Tolerancia mínima absoluta en pesos
const CAPACIDAD_MIN_MXN = 5;      // Capacidad restante mínima para incluir el depósito
const FOLIO_MIN_LEN     = 5;      // Longitud mínima de folio para buscarlo en texto (< 5 chars → riesgo alto de falso positivo)
const CAT_BONUS         = ['Transferencia', 'Depósitos'];
const CAT_PENALTY       = ['Nómina', 'Cargo bancario', 'Retiro ATM', 'Cheque'];

/**
 * Ventanas de fecha por tipoPago (días relativos al vencimiento).
 *   before: días máximos ANTES del vencimiento que aún se acepta el depósito
 *   after:  días máximos DESPUÉS del vencimiento
 *   ideal:  ventana de bonificación (pago a tiempo / ligeramente tardío)
 */
const DATE_WINDOWS = {
  'Contado': { before: 7,  after: 30,  ideal: 7  },
  'PUE':     { before: 7,  after: 30,  ideal: 7  },
  'Crédito': { before: 90, after: 180, ideal: 45 },
  'PPD':     { before: 90, after: 180, ideal: 45 },
  'Cheque':  { before: 3,  after: 14,  ideal: 5  },
  default:   { before: 90, after: 180, ideal: 45 },
};

// ── Constantes de matching combinacional ─────────────────────────────────────
const TOL_COMB_PCT   = 0.015;   // 1.5 % tolerancia para sumas de grupos
const SCORE_COMB_MIN = 0.65;    // Score mínimo para incluir un grupo combinacional
const MAX_COMB_SIZE  = 4;       // Máximo de CxCs por combinación
const MAX_CANDIDATES = 50;      // Candidatas pre-filtradas por depósito
const MAX_OPCIONES   = 20;      // Máximo de opciones a retornar por depósito

// Match types que resuelven el conflicto (texto identificatorio)
const TEXT_MATCH_TYPES = new Set([
  'referencia_numerica',
  'numero_autorizacion',
  'folio_en_concepto',
]);

// ─────────────────────────────────────────────────────────────────────────────
// API ERP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Llama al endpoint /cuentas-pendientes del ERP, persiste los resultados
 * en la colección temporal erp_cxc_snapshots y devuelve los datos al cliente.
 */
async function getCuentasPendientes(fechaDesde, fechaHasta) {
  const baseUrl = process.env.ERP_BASE_URL;
  const token   = process.env.ERP_TOKEN;

  if (!baseUrl) throw new Error('ERP_BASE_URL no configurada en .env');
  if (!token)   throw new Error('ERP_TOKEN no configurado en .env');

  const { data } = await axios.get(`${baseUrl}/cuentas-pendientes`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    params:  { fechaDesde, fechaHasta },
    timeout: 12_000,
  });

  const items = Array.isArray(data)
    ? data
    : (data.Data?.cuentas ?? data.data?.cuentas ?? data.data ?? data.items ?? []);

  const mapped = items.map((item) => ({
    id:               item.id,
    serie:            item.serie            ?? '',
    folio:            item.folio            ?? '',
    tipoPago:         item.tipoPago         ?? null,
    subtotal:         item.subtotal         ?? 0,
    impuesto:         item.impuesto         ?? 0,
    total:            item.total            ?? 0,
    saldoActual:      item.saldoActual      ?? 0,
    fechaVencimiento: item.fechaVencimiento ?? null,
  }));

  await _upsertSnapshots(mapped);
  return mapped;
}

/**
 * Persiste/actualiza los registros en erp_cxc_snapshots.
 * Recalcula is_vinculated consultando BankMovement.erpIds.
 */
async function _upsertSnapshots(items) {
  if (!items.length) return;

  const allErpIds  = items.map(i => i.id);
  const vinculados = await BankMovement.distinct('erpIds', {
    erpIds:   { $in: allErpIds },
    isActive: true,
  });
  const vinculadosSet = new Set(vinculados);

  const now = new Date();
  const ops = items.map((item) => ({
    updateOne: {
      filter: { erpId: item.id },
      update: {
        $set: {
          serie:            item.serie,
          folio:            item.folio,
          tipoPago:         item.tipoPago,
          subtotal:         item.subtotal,
          impuesto:         item.impuesto,
          total:            item.total,
          saldoActual:      item.saldoActual,
          fechaVencimiento: item.fechaVencimiento ? new Date(item.fechaVencimiento) : null,
          is_vinculated:    vinculadosSet.has(item.id),
          snapshotAt:       now,
        },
      },
      upsert: true,
    },
  }));

  await ErpCxcSnapshot.bulkWrite(ops, { ordered: false });
}

// ─────────────────────────────────────────────────────────────────────────────
// MOTOR DE MATCHING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calcula cuánta capacidad le queda a un depósito para absorber CxCs nuevas.
 *
 * La capacidad comprometida se estima a partir de los snapshots actuales de las
 * CxCs ya vinculadas en dep.erpIds:
 *   - Si la CxC aún tiene saldo (saldoActual > 0): se usa saldoActual (pendiente real).
 *   - Si ya fue cobrada (saldoActual = 0): se usa total como mejor estimación del
 *     monto que fue aplicado desde este depósito.
 */
function _calcCapacidad(dep, erpIdToSnap) {
  if (!dep.erpIds || !dep.erpIds.length) {
    return { comprometido: 0, capacidadRestante: dep.deposito };
  }
  const comprometido = dep.erpIds.reduce((sum, id) => {
    const snap = erpIdToSnap.get(id);
    if (!snap) return sum;
    return sum + (snap.saldoActual > 0 ? snap.saldoActual : snap.total);
  }, 0);
  return {
    comprometido,
    capacidadRestante: Math.max(dep.deposito - comprometido, 0),
  };
}

/**
 * Verifica que `needle` aparece como token independiente dentro de `haystack`.
 * Usa word-boundary (\b) para evitar que folio "123" matchee en "1234" o "COMP123X".
 * Los folios puramente numéricos usan lookbehind/lookahead de dígito para mayor precisión.
 */
function _isTokenMatch(haystack, needle) {
  if (!haystack || !needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Para tokens numéricos: asegurar que no haya dígito adyacente
  // Para tokens alfanuméricos: \b es suficiente
  const pattern = /^\d+$/.test(needle)
    ? `(?<!\\d)${escaped}(?!\\d)`
    : `\\b${escaped}\\b`;
  return new RegExp(pattern).test(haystack);
}

/**
 * Calcula el score de un match individual (1 depósito ↔ 1 CxC).
 * Retorna { score, matchType, diferencia, daysFromVenc } o null si no supera filtros.
 *
 * Filtros duros (retorna null):
 *   1. |capacidadRestante - saldoActual| > tolerancia de monto
 *   2. Fecha del depósito fuera de la ventana asimétrica tipoPago-aware
 *
 * Scoring (mayor = mejor):
 *   - Base por monto: exacto(1.0) → cercano(0.95/0.85) → interpolado(≥0.55)
 *   - Bonus texto identificatorio: referenciaNumerica, numeroAutorizacion, folio en concepto → 1.0
 *   - Bonus pago completo (deposito ≈ total, no saldo parcial):     +0.05
 *   - Penalización depósito ya comprometido con otras CxC:          -0.10
 *   - Bonus/penalización fecha: +0.10 ventana ideal / +0.03 anticipado / -0.05/30d tardío
 *   - Bonus categoría Transferencia/Depósitos:                      +0.05
 *   - Penalización categoría Nómina/Cargo/Retiro/Cheque:            -0.20
 */
function _scoreIndividual(dep, cxc, capacidadRestante, dateWin) {
  const saldo  = cxc.saldoActual;
  const tol    = Math.max(saldo * TOL_PCT, TOL_MIN_MXN);
  const vencMs = cxc.fechaVencimiento ? new Date(cxc.fechaVencimiento).getTime() : null;

  // ── Filtro 1: monto ────────────────────────────────────────────────────────
  const diff = Math.abs(capacidadRestante - saldo);
  if (diff > tol) return null;

  // ── Filtro 2: ventana de fecha (tipoPago-aware) ────────────────────────────
  let daysFromVenc = null;
  if (vencMs !== null) {
    daysFromVenc = (new Date(dep.fecha).getTime() - vencMs) / 86_400_000;
    if (daysFromVenc < -dateWin.before || daysFromVenc > dateWin.after) return null;
  }

  // ── Score base por monto (no-lineal) ─────────────────────────────────────
  let score, matchType;
  if (diff <= TOL_EXACT_MXN) {
    score = 1.0; matchType = 'exacto';
  } else if (diff <= saldo * 0.005) {      // ≤ 0.5 %
    score = 0.95; matchType = 'cercano';
  } else if (diff <= saldo * 0.01) {       // ≤ 1 %
    score = 0.85; matchType = 'cercano';
  } else {                                  // 1 % – TOL_PCT (2 %), caída rápida
    const rangePct = tol - saldo * 0.01;
    const overPct  = diff - saldo * 0.01;
    score = 0.75 * Math.max(1 - overPct / rangePct, 0);
    matchType = 'cercano';
  }

  const folioLower = (cxc.folio  || '').toLowerCase().trim();
  const serieLower = (cxc.serie  || '').toLowerCase().trim();
  const erpIdLower = (cxc.erpId  || '').toLowerCase().trim();
  const sfToken    = serieLower && folioLower ? `${serieLower}-${folioLower}` : '';

  // ── Bonus: referenciaNumerica contiene folio / erpId ──────────────────────
  // Match exacto O token independiente (word-boundary) para evitar falsos positivos
  const refNum = (dep.referenciaNumerica || '').toLowerCase().trim();
  if (refNum && folioLower.length >= FOLIO_MIN_LEN) {
    if (refNum === folioLower || refNum === erpIdLower ||
        _isTokenMatch(refNum, folioLower) || _isTokenMatch(refNum, erpIdLower)) {
      score = 1.0; matchType = 'referencia_numerica';
    }
  }

  // ── Bonus: numeroAutorizacion contiene folio / erpId ─────────────────────
  if (matchType !== 'referencia_numerica') {
    const authNum = (dep.numeroAutorizacion || '').toLowerCase().trim();
    if (authNum && folioLower.length >= FOLIO_MIN_LEN) {
      if (_isTokenMatch(authNum, folioLower) || _isTokenMatch(authNum, erpIdLower)) {
        score = 1.0; matchType = 'numero_autorizacion';
      }
    }
  }

  // ── Bonus: folio / serie-folio / erpId aparece en el concepto ────────────
  // Usa word-boundary: folio "123" no matchea en "COMP1234" ni en "0001230"
  if (!TEXT_MATCH_TYPES.has(matchType)) {
    const concepto = (dep.concepto || '').toLowerCase();
    if (
      (folioLower.length >= FOLIO_MIN_LEN && _isTokenMatch(concepto, folioLower)) ||
      (sfToken.length    >= FOLIO_MIN_LEN && _isTokenMatch(concepto, sfToken))    ||
      (erpIdLower.length >= FOLIO_MIN_LEN && _isTokenMatch(concepto, erpIdLower))
    ) {
      score = 1.0; matchType = 'folio_en_concepto';
    }
  }

  // ── Bonus: el depósito cubre el total (no solo el saldo parcial) ──────────
  if (cxc.total > 0 && Math.abs(cxc.total - cxc.saldoActual) > 0.01) {
    const diffTotal = Math.abs(capacidadRestante - cxc.total);
    if (diffTotal <= TOL_EXACT_MXN) score = Math.min(score + 0.05, 1.0);
  }

  // ── Penalización: depósito ya comprometido con otra(s) CxC ───────────────
  if (dep.comprometido > 0) score = Math.max(score - 0.10, 0);

  // ── Bonus/penalización por fecha ──────────────────────────────────────────
  if (daysFromVenc !== null) {
    if (daysFromVenc >= 0 && daysFromVenc <= dateWin.ideal) {
      score = Math.min(score + 0.10, 1.0);
    } else if (daysFromVenc < 0 && daysFromVenc >= -30) {
      score = Math.min(score + 0.03, 1.0);
    } else if (daysFromVenc > dateWin.ideal) {
      const extraPeriods = Math.floor((daysFromVenc - dateWin.ideal) / 30);
      score = Math.max(score - extraPeriods * 0.05, 0);
    }
  }

  // ── Bonus/penalización por categoría ─────────────────────────────────────
  if (CAT_BONUS.includes(dep.categoria))   score = Math.min(score + 0.05, 1.0);
  if (CAT_PENALTY.includes(dep.categoria)) score = Math.max(score - 0.20, 0);

  score = Math.round(score * 100) / 100;
  if (score < SCORE_MIN) return null;

  return {
    score,
    matchType,
    diferencia:  Math.round(diff * 100) / 100,
    daysFromVenc: daysFromVenc !== null ? Math.round(daysFromVenc) : null,
  };
}

/**
 * Matching combinacional: encuentra subconjuntos de 2..MAX_COMB_SIZE CxCs cuya
 * suma de saldoActual ≈ capacidadRestante del depósito.
 *
 * Algoritmo: backtracking + poda doble con suffix sums sobre candidatas ordenadas ASC.
 *   Poda 1 (insuficiente): currentSum + suffixSum[i] < target − tol → break
 *   Poda 2 (exceso):       currentSum + candidates[i] > target + tol → break
 *                          (ASC: todos los siguientes también excederán)
 *
 * Complejidad efectiva: O(K^MAX) con K ≤ MAX_CANDIDATES y poda agresiva (~ms).
 */
function _findCombinational(deposits, cxcsElegibles) {
  const results = [];

  for (const dep of deposits) {
    const target    = dep.capacidadRestante;
    const tolAbs    = Math.max(target * TOL_COMB_PCT, TOL_MIN_MXN);
    const depDateMs = dep.fecha ? new Date(dep.fecha).getTime() : null;

    // Pre-filtrar: saldo dentro del target Y ventana de fecha tipoPago-aware
    const candidates = cxcsElegibles
      .filter(c => {
        if (c.saldoActual < TOL_MIN_MXN || c.saldoActual > target + tolAbs) return false;
        // Verificar que la fecha del depósito cae dentro de la ventana de la CxC
        if (depDateMs !== null && c.fechaVencimiento) {
          const dateWin = DATE_WINDOWS[c.tipoPago] || DATE_WINDOWS.default;
          const vencMs  = new Date(c.fechaVencimiento).getTime();
          const days    = (depDateMs - vencMs) / 86_400_000;
          if (days < -dateWin.before || days > dateWin.after) return false;
        }
        return true;
      })
      .sort((a, b) => a.saldoActual - b.saldoActual)   // ASC — necesario para las podas
      .slice(0, MAX_CANDIDATES);

    if (candidates.length < 2) continue;

    // Suffix sums para poda 1
    const suffixSum = new Array(candidates.length + 1).fill(0);
    for (let i = candidates.length - 1; i >= 0; i--) {
      suffixSum[i] = suffixSum[i + 1] + candidates[i].saldoActual;
    }

    const opciones = [];

    (function backtrack(startIdx, current, currentSum) {
      // Registrar si la combinación actual (≥ 2 CxCs) está dentro de tolerancia
      if (current.length >= 2) {
        const diff = Math.abs(currentSum - target);
        if (diff <= tolAbs) {
          const amountScore = diff <= 1
            ? 1.0
            : Math.max(1.0 - (diff / tolAbs) * 0.35, SCORE_COMB_MIN);
          const sizePenalty = (current.length - 2) * 0.05;
          const score = Math.round(Math.max(amountScore - sizePenalty, SCORE_COMB_MIN) * 100) / 100;
          opciones.push({
            cxcs: current.map(c => ({
              _id:              c._id,
              erpId:            c.erpId,
              serie:            c.serie,
              folio:            c.folio,
              saldoActual:      c.saldoActual,
              fechaVencimiento: c.fechaVencimiento,
            })),
            sumaSaldos:  Math.round(currentSum * 100) / 100,
            diferencia:  Math.round(diff * 100) / 100,
            score,
          });
        }
      }

      if (current.length >= MAX_COMB_SIZE || opciones.length >= MAX_OPCIONES) return;

      for (let i = startIdx; i < candidates.length; i++) {
        if (opciones.length >= MAX_OPCIONES) break;

        // Poda 1: incluso tomando TODOS los candidatos desde i no llegamos al mínimo
        if (currentSum + suffixSum[i] < target - tolAbs) break;

        const newSum = currentSum + candidates[i].saldoActual;

        // Poda 2: el candidato más pequeño restante ya supera el máximo
        if (newSum > target + tolAbs) break;

        backtrack(i + 1, [...current, candidates[i]], newSum);
      }
    })(0, [], 0);

    if (opciones.length > 0) {
      opciones.sort((a, b) => b.score - a.score);
      results.push({
        deposito: {
          _id:               dep._id,
          banco:             dep.banco,
          fecha:             dep.fecha,
          concepto:          dep.concepto,
          deposito:          dep.deposito,
          capacidadRestante: dep.capacidadRestante,
          comprometido:      dep.comprometido,
          referenciaNumerica: dep.referenciaNumerica,
          categoria:         dep.categoria,
          folio:             dep.folio,
        },
        opciones: opciones.slice(0, MAX_OPCIONES),
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────

function _formatCxc(cxc) {
  return {
    _id:              cxc._id,
    erpId:            cxc.erpId,
    serie:            cxc.serie,
    folio:            cxc.folio,
    tipoPago:         cxc.tipoPago,
    subtotal:         cxc.subtotal,
    impuesto:         cxc.impuesto,
    total:            cxc.total,
    saldoActual:      cxc.saldoActual,
    fechaVencimiento: cxc.fechaVencimiento,
    is_vinculated:    cxc.is_vinculated,
    snapshotAt:       cxc.snapshotAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Punto de entrada principal.
 *
 * Devuelve:
 * {
 *   individual:     CxcMatchResult[]       — 1 depósito ↔ 1 CxC
 *   combinacionales: CombinacionalResult[] — 1 depósito ↔ N CxCs
 * }
 *
 * Cambios respecto a versión anterior:
 *
 * 1. Sin filtro duro "erpIds vacío":
 *    Se incluyen depósitos que ya tienen CxCs vinculadas, pero solo si su
 *    capacidadRestante = deposito − montoComprometido ≥ CAPACIDAD_MIN_MXN.
 *    El scoring penaliza (−0.10) depósitos ya comprometidos.
 *
 * 2. Matching contra capacidadRestante (no contra deposito total):
 *    Un depósito de $3,000 que ya aplicó $1,000 a CxC-A compite con
 *    saldo de $2,000 para las siguientes CxC.
 *
 * 3. Ventanas de fecha tipoPago-aware:
 *    Contado/PUE: ±7/30d | Crédito/PPD: ±90/180d | Cheque: ±3/14d
 *
 * 4. Nuevo bonus: numeroAutorizacion contiene folio/erpId → score 1.0
 *
 * 5. Nuevo bonus: deposito ≈ total (pago completo, no solo saldo) → +0.05
 *
 * 6. Conflictos más precisos:
 *    Solo se marca esConflicto cuando el mismo depósito compite por ≥2 CxC
 *    EXCLUSIVAMENTE por monto. Si una coincidencia tiene texto identificatorio
 *    (referencia, autorización, folio en concepto), no hay conflicto real.
 *
 * 7. Matching combinacional N:M:
 *    Para depósitos sin match de texto fuerte, se buscan grupos de 2-4 CxC
 *    cuya suma de saldoActual ≈ capacidadRestante.
 */
async function getCxcMatches() {
  const snapshots = await ErpCxcSnapshot.find({}).lean();
  if (!snapshots.length) return { individual: [], combinacionales: [] };

  // Mapa erpId → snapshot para cálculo de capacidad y matching combinacional
  const erpIdToSnap = new Map(snapshots.map(s => [s.erpId, s]));

  // ── Fetch TODOS los depósitos activos sin UUID (sin filtrar por erpIds) ────
  const allDeposits = await BankMovement.find(
    {
      deposito: { $gt: 0 },
      isActive: true,
      status:   'no_identificado',
      uuidXML:  null,
    },
    {
      _id: 1, banco: 1, fecha: 1, concepto: 1, deposito: 1, status: 1,
      folio: 1, uuidXML: 1, erpIds: 1,
      referenciaNumerica: 1, numeroAutorizacion: 1, categoria: 1,
    },
  ).lean();

  // Enriquecer cada depósito con su capacidad restante
  const deposits = allDeposits
    .map(dep => {
      const { comprometido, capacidadRestante } = _calcCapacidad(dep, erpIdToSnap);
      return { ...dep, comprometido, capacidadRestante };
    })
    .filter(dep => dep.capacidadRestante >= CAPACIDAD_MIN_MXN);

  // ── Primera pasada: matching individual ────────────────────────────────────
  // depositMatchCount: depositId → número de CxC distintas que lo seleccionaron
  const depositMatchCount = new Map();

  const rawIndividual = snapshots.map((cxc) => {
    // CxC totalmente saldada → no hay nada que cobrar
    if (cxc.saldoActual <= 0) return { cxc: _formatCxc(cxc), matches: [] };

    const dateWin = DATE_WINDOWS[cxc.tipoPago] || DATE_WINDOWS.default;
    const matches = [];

    for (const dep of deposits) {
      const result = _scoreIndividual(dep, cxc, dep.capacidadRestante, dateWin);
      if (!result) continue;

      matches.push({
        _id:               dep._id,
        banco:             dep.banco,
        fecha:             dep.fecha,
        concepto:          dep.concepto,
        deposito:          dep.deposito,
        capacidadRestante: dep.capacidadRestante,
        comprometido:      dep.comprometido,
        status:            dep.status,
        folio:             dep.folio,
        uuidXML:           dep.uuidXML,
        erpIds:            dep.erpIds,
        referenciaNumerica: dep.referenciaNumerica,
        categoria:         dep.categoria,
        ...result,
      });

      const key = dep._id.toString();
      depositMatchCount.set(key, (depositMatchCount.get(key) || 0) + 1);
    }

    matches.sort((a, b) => b.score - a.score);
    return { cxc: _formatCxc(cxc), matches };
  });

  // ── Segunda pasada: marcar conflictos ──────────────────────────────────────
  // Conflicto REAL: un depósito compite por ≥2 CxC ÚNICAMENTE por monto.
  // Si alguna coincidencia tiene texto identificatorio, el texto gana y no hay conflicto.
  const individual = rawIndividual.map(({ cxc, matches }) => ({
    cxc,
    matches: matches.map((m) => ({
      ...m,
      esConflicto: (depositMatchCount.get(m._id.toString()) || 0) > 1
                   && !TEXT_MATCH_TYPES.has(m.matchType),
    })),
  }));

  // ── Matching combinacional ─────────────────────────────────────────────────
  // Solo para depósitos que NO tienen un match de texto fuerte en los individuales.
  // Un match de texto ya identifica unívocamente el depósito → no necesita combinación.
  const depositsConTexto = new Set();
  for (const { matches } of individual) {
    for (const m of matches) {
      if (TEXT_MATCH_TYPES.has(m.matchType)) {
        depositsConTexto.add(m._id.toString());
      }
    }
  }

  const depositsParaComb = deposits.filter(d => !depositsConTexto.has(d._id.toString()));

  // CxCs con match individual sólido (texto identificatorio O score ≥ 0.90 sin conflicto)
  // no deben participar en combinaciones: ya tienen destino conocido y solo generarían ruido.
  const cxcIdsConMatchSolido = new Set();
  for (const { cxc, matches } of individual) {
    if (matches.some(m => !m.esConflicto && (TEXT_MATCH_TYPES.has(m.matchType) || m.score >= 0.90))) {
      cxcIdsConMatchSolido.add(cxc.erpId);
    }
  }

  const cxcsElegibles   = snapshots.filter(s =>
    s.saldoActual > 0 && !cxcIdsConMatchSolido.has(s.erpId)
  );
  const combinacionales = _findCombinational(depositsParaComb, cxcsElegibles);

  return { individual, combinacionales };
}

module.exports = { getCuentasPendientes, getCxcMatches };
