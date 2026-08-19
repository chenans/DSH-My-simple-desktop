'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { isPortFree, findFreePort, waitForServer } = require('../src/lib/port');

test('isPortFree: free port → true, busy port → false', async () => {
  // grab a port, hold it, verify busy
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const busyPort = server.address().port;
  assert.equal(await isPortFree(busyPort), false);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await isPortFree(busyPort), true);
});

test('findFreePort: returns the first free port starting at `start`', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const busyPort = server.address().port;

  const port = await findFreePort(busyPort, 3);
  // busyPort is skipped, so the result is the port after it
  assert.equal(port, busyPort + 1);

  await new Promise((resolve) => server.close(resolve));
  // now everything is free: first candidate returned
  assert.equal(await findFreePort(busyPort, 1), busyPort);
});

test('findFreePort: returns null when the whole range is busy', async () => {
  // pick a free base port, then explicitly occupy base..base+2
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const base = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const servers = [];
  for (let i = 0; i < 3; i++) {
    const s = net.createServer();
    await new Promise((resolve, reject) => {
      s.once('error', reject);
      s.listen(base + i, '127.0.0.1', resolve);
    });
    servers.push(s);
  }
  assert.equal(await findFreePort(base, 3), null);
  for (const s of servers) await new Promise((resolve) => s.close(resolve));
});

test('waitForServer: resolves once HTTP answers', async () => {
  const http = require('node:http');
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await waitForServer(port, 5000); // must not throw
  await new Promise((resolve) => server.close(resolve));
});

test('waitForServer: rejects on timeout', async () => {
  const free = await findFreePort(40000, 10);
  await assert.rejects(
    () => waitForServer(free, 1200),
    /未就绪/,
  );
});
