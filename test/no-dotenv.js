'use strict';

// Keep automated tests isolated from real database credentials.
for (const name of [
  'DATABASE_URL',
  'DATABASE_DIRECT_URL',
  'STAGING_DATABASE_URL',
  'STAGING_OWNER_DATABASE_URL',
  'OWNER_DATABASE_URL',
  'DATABASE_ADMIN_URL',
  'NEON_EMPTY_OWNER_DATABASE_URL'
]) {
  delete process.env[name];
}

// Prevent application imports from loading the project's .env file.
const Module = require('node:module');
const originalLoad = Module._load;

Module._load = function(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (request !== 'dotenv') return loaded;

  return Object.assign({}, loaded, {
    config() {
      return { parsed: {} };
    }
  });
};
