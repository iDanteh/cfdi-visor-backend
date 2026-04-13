'use strict';

/**
 * auth.real.js — Middleware de autenticación con Auth0 (producción).
 *
 * Valida el Access Token JWT emitido por Auth0 usando la JWKS del tenant.
 * Extrae el rol y los datos de nombre del usuario de los claims personalizados.
 *
 * Variables de entorno requeridas:
 *   AUTH0_DOMAIN   — dominio del tenant, ej: myapp.us.auth0.com
 *   AUTH0_AUDIENCE — API identifier registrado en Auth0, ej: https://cfdi-comparator-api
 *
 * Para activar este middleware en producción:
 *   Reemplazar 'auth.stub' por 'auth.real' en todos los archivos de rutas.
 */

const { auth } = require('express-oauth2-jwt-bearer');

const ROLE_CLAIM      = 'https://cfdi-comparator/role';
const NOMBRE_CLAIM    = 'https://cfdi-comparator/nombre';
const APELLIDO_CLAIM  = 'https://cfdi-comparator/apellidoP';

// Verifica firma, expiración y audience del Access Token.
// Lanza 401/403 automáticamente si el token es inválido.
const jwtCheck = auth({
  issuerBaseURL: `https://${process.env.AUTH0_DOMAIN}/`,
  audience:      process.env.AUTH0_AUDIENCE,
  tokenSigningAlg: 'RS256',
});

/**
 * authenticate — verifica el JWT y puebla req.user con los datos del token.
 */
const authenticate = (req, res, next) => {
  jwtCheck(req, res, (err) => {
    if (err) return next(err);

    // req.auth es inyectado por express-oauth2-jwt-bearer tras validación exitosa
    const payload = req.auth?.payload ?? {};

    req.user = {
      _id:       payload.sub,                         // 'auth0|xxxx'
      nombre:    payload[NOMBRE_CLAIM]    ?? '',
      apellidoP: payload[APELLIDO_CLAIM]  ?? '',
      role:      payload[ROLE_CLAIM] ?? 'viewer',
    };

    next();
  });
};

/**
 * authorize — verifica que req.user.role sea uno de los roles permitidos.
 * Debe usarse siempre después de authenticate.
 */
const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) {
    return res.status(403).json({
      error: 'Acceso denegado: no tienes el rol requerido para esta acción.',
    });
  }
  next();
};

module.exports = { authenticate, authorize };
