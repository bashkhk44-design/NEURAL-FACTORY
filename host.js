'use strict';

const { createHealthServer } = require('./health-server');

const PORT = Number(process.env.PORT || 8080);

let runtimeReady = false;
let runtimeStopping = false;

process.on('boss:runtime-ready', () => {
  runtimeReady = true;
  runtimeStopping = false;
  console.log('Health status: READY');
});

process.on('boss:runtime-stopping', (signal) => {
  runtimeReady = false;
  runtimeStopping = true;
  console.log('Health status: STOPPING', signal || '');
});

const server = createHealthServer(() => ({ runtimeReady, runtimeStopping }));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`BOSS BOT MASTER health server running on port ${PORT}`);
});

server.on('error', (err) => {
  console.error('HEALTH SERVER ERROR:', err.message);
  process.exitCode = 1;
});

const { createMasterRuntime } = require('./telegram-master');
const telegramRuntime = createMasterRuntime();
void telegramRuntime.start();
