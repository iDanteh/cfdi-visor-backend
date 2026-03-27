const xml2js = require('xml2js');
const crypto = require('crypto');

/**
 * Parsea un XML de CFDI 3.3 o 4.0 a un objeto estructurado
 * compatible con el modelo CFDI de MongoDB.
 */
const parseCFDI = async (xmlString) => {
  const parser = new xml2js.Parser({
    explicitArray: false,
    ignoreAttrs: false,
    attrkey: '$',
    charkey: '_',
    mergeAttrs: true,
  });

  const result = await parser.parseStringPromise(xmlString);

  // El nodo raíz puede ser cfdi:Comprobante o tfd:TimbreFiscalDigital
  const comprobante = result['cfdi:Comprobante'] || result['Comprobante'];
  if (!comprobante) {
    throw new Error('XML no es un CFDI válido: nodo cfdi:Comprobante no encontrado');
  }

  const attrs = comprobante;
  const emisorNode = comprobante['cfdi:Emisor'] || comprobante['Emisor'] || {};
  const receptorNode = comprobante['cfdi:Receptor'] || comprobante['Receptor'] || {};
  const conceptosNode = comprobante['cfdi:Conceptos'] || comprobante['Conceptos'] || {};
  const impuestosNode = comprobante['cfdi:Impuestos'] || comprobante['Impuestos'] || {};
  const timbreNode = getTimbre(comprobante);

  const cfdiData = {
    uuid: timbreNode?.UUID || timbreNode?.['$']?.UUID || null,
    version: attrs.Version || attrs.version || '4.0',
    serie: attrs.Serie,
    folio: attrs.Folio,
    fecha: new Date(attrs.Fecha),
    sello: attrs.Sello,
    formaPago: attrs.FormaPago,
    noCertificado: attrs.NoCertificado,
    certificado: attrs.Certificado,
    condicionesDePago: attrs.CondicionesDePago,
    subTotal: parseFloat(attrs.SubTotal) || 0,
    descuento: parseFloat(attrs.Descuento) || 0,
    moneda: attrs.Moneda || 'MXN',
    tipoCambio: parseFloat(attrs.TipoCambio) || 1,
    total: parseFloat(attrs.Total) || 0,
    tipoDeComprobante: attrs.TipoDeComprobante,
    exportacion: attrs.Exportacion,
    metodoPago: attrs.MetodoPago,
    lugarExpedicion: attrs.LugarExpedicion,

    emisor: {
      rfc: emisorNode.Rfc || '',
      nombre: emisorNode.Nombre,
      regimenFiscal: emisorNode.RegimenFiscal,
    },

    receptor: {
      rfc: receptorNode.Rfc || '',
      nombre: receptorNode.Nombre,
      domicilioFiscalReceptor: receptorNode.DomicilioFiscalReceptor,
      regimenFiscal: receptorNode.RegimenFiscalReceptor,
      usoCFDI: receptorNode.UsoCFDI,
      residenciaFiscal: receptorNode.ResidenciaFiscal,
      numRegIdTrib: receptorNode.NumRegIdTrib,
    },

    conceptos: parseConceptos(conceptosNode),
    impuestos: parseImpuestos(impuestosNode),

    timbreFiscalDigital: timbreNode ? {
      uuid: timbreNode.UUID || timbreNode['$']?.UUID,
      fechaTimbrado: timbreNode.FechaTimbrado ? new Date(timbreNode.FechaTimbrado) : null,
      rfcProvCertif: timbreNode.RfcProvCertif,
      selloCFD: timbreNode.SelloCFD,
      noCertificadoSAT: timbreNode.NoCertificadoSAT,
      selloSAT: timbreNode.SelloSAT,
      version: timbreNode.Version,
    } : null,

    xmlContent: xmlString,
    xmlHash: crypto.createHash('sha256').update(xmlString).digest('hex'),
  };

  if (!cfdiData.uuid) {
    throw new Error('CFDI sin UUID (TimbreFiscalDigital no encontrado o UUID vacío)');
  }

  return cfdiData;
};

const getTimbre = (comprobante) => {
  try {
    const complemento = comprobante['cfdi:Complemento'] || comprobante['Complemento'];
    if (!complemento) return null;
    const tfd = complemento['tfd:TimbreFiscalDigital'] || complemento['TimbreFiscalDigital'];
    if (!tfd) return null;
    return tfd['$'] ? { ...tfd['$'] } : tfd;
  } catch {
    return null;
  }
};

const parseConceptos = (conceptosNode) => {
  if (!conceptosNode) return [];
  const concepto = conceptosNode['cfdi:Concepto'] || conceptosNode['Concepto'];
  if (!concepto) return [];
  const list = Array.isArray(concepto) ? concepto : [concepto];

  return list.map((c) => ({
    claveProdServ: c.ClaveProdServ,
    noIdentificacion: c.NoIdentificacion,
    cantidad: parseFloat(c.Cantidad) || 0,
    claveUnidad: c.ClaveUnidad,
    unidad: c.Unidad,
    descripcion: c.Descripcion,
    valorUnitario: parseFloat(c.ValorUnitario) || 0,
    importe: parseFloat(c.Importe) || 0,
    descuento: parseFloat(c.Descuento) || 0,
    objetoImp: c.ObjetoImp,
  }));
};

const parseImpuestos = (impuestosNode) => {
  if (!impuestosNode) return { totalImpuestosTrasladados: 0, totalImpuestosRetenidos: 0 };
  return {
    totalImpuestosTrasladados: parseFloat(impuestosNode.TotalImpuestosTrasladados) || 0,
    totalImpuestosRetenidos: parseFloat(impuestosNode.TotalImpuestosRetenidos) || 0,
  };
};

module.exports = { parseCFDI };
