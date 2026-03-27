const axios = require('axios');
const { parseStringPromise } = require('xml2js');
const { logger } = require('../utils/logger');

const SAT_ENDPOINT = 'https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc';
const SOAP_ACTION  = 'http://tempuri.org/IConsultaCFDIService/Consulta';

/**
 * Verifica el estado de un CFDI con el SAT.
 *
 * CFDI 3.3 → expresión: ?re=&rr=&tt=&id=
 * CFDI 4.0 → expresión: ?id=&re=&rr=&tt=&fe=   (fe = últimos 8 chars del sello)
 *
 * @param {string}  uuid
 * @param {string}  rfcEmisor
 * @param {string}  rfcReceptor
 * @param {number}  total
 * @param {string}  [sello]    - Sello del CFDI (requerido para 4.0)
 * @param {string}  [version]  - '3.3' | '4.0'  (default '4.0')
 */
const verifyCFDIWithSAT = async (uuid, rfcEmisor, rfcReceptor, total, sello = '', version = '4.0') => {
  const expresion = buildExpresionImpresa(uuid, rfcEmisor, rfcReceptor, total, sello, version);

  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <Consulta xmlns="http://tempuri.org/">
      <expresionImpresa>${expresion}</expresionImpresa>
    </Consulta>
  </s:Body>
</s:Envelope>`;

  let response;
  try {
    response = await axios.post(SAT_ENDPOINT, envelope, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': `"${SOAP_ACTION}"`,
      },
      timeout: 20000,
    });
  } catch (err) {
    const detail = err.response ? `HTTP ${err.response.status}` : err.message;
    logger.error(`[SAT] Error de conexión para ${uuid}: ${detail}`);
    throw new Error(`Sin respuesta del SAT: ${err.message}`);
  }

  return parseSATResponse(response.data, uuid);
};

/**
 * Construye la expresión impresa según la versión del CFDI.
 *
 * CFDI 3.3: ?re=RFC_EMISOR&rr=RFC_RECEPTOR&tt=TOTAL17&id=UUID
 * CFDI 4.0: ?id=UUID&re=RFC_EMISOR&rr=RFC_RECEPTOR&tt=TOTAL17&fe=ULTIMOS8SELLO
 *
 * Nota: los & se escapan como &amp; porque van dentro de un XML.
 */
const buildExpresionImpresa = (uuid, rfcEmisor, rfcReceptor, total, sello = '', version = '4.0') => {
  const tt = parseFloat(total).toFixed(6).replace('.', '').padStart(17, '0');
  const sep = '&amp;';

  if (version === '4.0') {
    const fe = sello ? encodeURIComponent(sello.slice(-8)) : '';
    return `?id=${uuid}${sep}re=${rfcEmisor}${sep}rr=${rfcReceptor}${sep}tt=${tt}${sep}fe=${fe}`;
  }

  // CFDI 3.3
  return `?re=${rfcEmisor}${sep}rr=${rfcReceptor}${sep}tt=${tt}${sep}id=${uuid}`;
};

const parseSATResponse = async (xmlString, uuid) => {
  let parsed;
  try {
    parsed = await parseStringPromise(xmlString, {
      explicitArray: false,
      tagNameProcessors: [(name) => name.replace(/^.+:/, '')],
    });
  } catch {
    throw new Error('Respuesta SAT no es XML válido');
  }

  const result = parsed?.Envelope?.Body?.ConsultaResponse?.ConsultaResult;

  if (!result) {
    logger.warn(`[SAT] Estructura inesperada para ${uuid}:`, JSON.stringify(parsed).substring(0, 300));
    throw new Error('Respuesta SAT con estructura no reconocida');
  }

  const codigoEstatus = result.CodigoEstatus || '';
  const estado        = result.Estado        || '';
  const esCancelable  = result.EsCancelable  || '';
  const estatusCancel = result.EstatusCancelacion || '';

  const state = resolveState(codigoEstatus, estado);
  logger.info(`[SAT] ${uuid} → ${state} (${codigoEstatus})`);

  return {
    state,
    isCancelled:       state === 'Cancelado',
    isCancellable:     esCancelable.includes('Cancelable'),
    estadoCancelacion: estatusCancel,
    codigoEstatus,
    rawResponse: result,
  };
};

const resolveState = (codigo, estado) => {
  const c = (codigo + ' ' + estado).toLowerCase();
  if (c.includes('601'))                                return 'Expresión Inválida';
  if (c.includes('200') || c.includes('vigente'))       return 'Vigente';
  if (c.includes('201') || c.includes('cancelado'))     return 'Cancelado';
  if (c.includes('202') || c.includes('no encontrado')) return 'No Encontrado';
  if (c.includes('400'))                                return 'Error';
  if (!codigo && !estado)                               return 'Error';
  return estado || codigo || 'Desconocido';
};

module.exports = { verifyCFDIWithSAT, buildExpresionImpresa };
