'use strict';

function getPostgresSslConfig(env = process.env) {
  if (env.DATABASE_SSL !== undefined && !['require', 'disable'].includes(env.DATABASE_SSL)) {
    throw new Error('DATABASE_SSL must be either require or disable');
  }
  return env.DATABASE_SSL === 'disable' ? false : true;
}

module.exports = { getPostgresSslConfig };
