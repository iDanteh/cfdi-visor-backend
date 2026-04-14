'use strict';

const User = require('./User.model');
const { NotFoundError, BadRequestError } = require('../../shared/errors/AppError');

const ROLES_VALIDOS = ['admin', 'contador', 'viewer'];

/**
 * Busca al usuario por auth0Sub; si no existe lo crea con rol 'viewer'.
 * Actualiza nombre, email y lastLogin en cada llamada.
 */
async function findOrCreate({ auth0Sub, nombre, email }) {
  // 1. Búsqueda normal por sub de Auth0
  let user = await User.findOne({ auth0Sub });

  // 2. Si no existe por sub, busca un registro pre-sembrado que coincida por email
  //    (auth0Sub empieza con 'seed:' cuando fue creado por el seed)
  if (!user && email) {
    user = await User.findOne({ email, auth0Sub: `seed:${email}` });
    if (user) {
      user.auth0Sub = auth0Sub; // reemplaza el placeholder con el sub real
    }
  }

  if (!user) {
    user = await User.create({ auth0Sub, nombre, email, role: 'viewer' });
  } else {
    user.lastLogin = new Date();
    if (nombre) user.nombre = nombre;
    if (email && !user.email) user.email = email;
    await user.save();
  }

  return user;
}

async function listUsers() {
  return User.find().sort({ createdAt: -1 }).lean();
}

async function updateRole(id, role) {
  if (!ROLES_VALIDOS.includes(role)) {
    throw new BadRequestError(`Rol inválido. Opciones: ${ROLES_VALIDOS.join(', ')}`);
  }
  const user = await User.findByIdAndUpdate(id, { role }, { new: true });
  if (!user) throw new NotFoundError('Usuario');
  return user;
}

async function toggleActive(id) {
  const user = await User.findById(id);
  if (!user) throw new NotFoundError('Usuario');
  user.isActive = !user.isActive;
  await user.save();
  return user;
}

module.exports = { findOrCreate, listUsers, updateRole, toggleActive };
