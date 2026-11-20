'use strict';

function getDatabaseUrl(env = process.env) {
  const target = env.BOSS_DATABASE_TARGET;

  if (target && target !== 'staging' && target !== 'production') {
    throw new Error('BOSS_DATABASE_TARGET must be staging or production');
  }

  const url = target === 'staging'
    ? env.STAGING_DATABASE_URL
    : env.DATABASE_URL;

  if (!url) {
    throw new Error(
      target === 'staging'
        ? 'STAGING_DATABASE_URL is required for staging. No fallback is allowed.'
        : 'DATABASE_URL is required'
    );
  }

  if (!/^postgres(?:ql)?:\/\//i.test(url)) {
    throw new Error('Database URL must use the PostgreSQL protocol');
  }

  return url;
}

function getDirectDatabaseUrl(env = process.env) {
  const target = env.BOSS_DATABASE_TARGET;

  if (target && target !== 'staging' && target !== 'production') {
    throw new Error('BOSS_DATABASE_TARGET must be staging or production');
  }

  const url = target === 'staging'
    ? getDatabaseUrl(env)
    : (env.DATABASE_DIRECT_URL || getDatabaseUrl(env));

  if (!/^postgres(?:ql)?:\/\//i.test(url)) {
    throw new Error('Direct database URL must use the PostgreSQL protocol');
  }

  return url;
}

module.exports = { getDatabaseUrl, getDirectDatabaseUrl };
