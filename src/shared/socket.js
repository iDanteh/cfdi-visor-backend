'use strict';

const { Server } = require('socket.io');

let _io = null;

/**
 * init — adjunta Socket.IO al servidor HTTP y registra el evento 'identify'.
 * Cada cliente se une a una sala nombrada user:{auth0Sub} para recibir
 * notificaciones de cambio de rol en tiempo real.
 */
function init(httpServer) {
  _io = new Server(httpServer, {
    cors: {
      origin:  process.env.CORS_ORIGIN || 'http://localhost:4200',
      methods: ['GET', 'POST'],
    },
  });

  _io.on('connection', (socket) => {
    socket.on('identify', (auth0Sub) => {
      if (typeof auth0Sub === 'string' && auth0Sub.trim()) {
        socket.join(`user:${auth0Sub.trim()}`);
      }
    });
  });

  return _io;
}

/** Devuelve la instancia de Socket.IO; null si aún no se ha inicializado. */
function getIo() {
  return _io;
}

module.exports = { init, getIo };
