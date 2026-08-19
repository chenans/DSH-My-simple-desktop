'use strict';

/**
 * Port helpers — pure Node, unit-testable (no Electron dependency).
 */

const http = require('node:http');
const net = require('node:net');

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Scan from `start` for the first free TCP port (bound to 127.0.0.1).
 * @param {number} start
 * @param {number} [limit=20]
 * @returns {Promise<number|null>}
 */
async function findFreePort(start, limit = 20) {
  for (let i = 0; i < limit; i++) {
    const port = start + i;
    if (await isPortFree(port)) return port;
  }
  return null;
}

/**
 * Poll until an HTTP server answers on 127.0.0.1:port, or timeout.
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<void>} rejects with a descriptive Error on timeout
 */
function waitForServer(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/', timeout: 2000 },
        (res) => {
          res.resume();
          resolve();
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(
            new Error(
              `dsh web 服务在 ${Math.round(timeoutMs / 1000)}s 内未就绪（端口 ${port}）`,
            ),
          );
        } else {
          setTimeout(attempt, 250);
        }
      });
    };
    attempt();
  });
}

module.exports = { isPortFree, findFreePort, waitForServer };
