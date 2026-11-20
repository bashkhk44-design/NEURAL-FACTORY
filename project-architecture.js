'use strict';

const HOSTING_PLACEMENTS = Object.freeze(['undecided', 'factory', 'customer', 'split']);
const ADMIN_SURFACES = Object.freeze(['undecided', 'none', 'telegram_only', 'dashboard', 'both']);
const COMPONENT_PLACEMENTS = Object.freeze(['factory', 'customer']);
const COMPONENT_IDS = Object.freeze([
  'telegram_bot',
  'website',
  'admin_dashboard',
  'api',
  'background_worker',
  'database',
  'file_storage'
]);

function boundedText(value, field, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new Error('Invalid project architecture field: ' + field);
  }
  return value.trim();
}

function normalizeProjectArchitecture(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Project architecture must be an object.');
  }

  const hostingPlacement = HOSTING_PLACEMENTS.includes(raw.hostingPlacement)
    ? raw.hostingPlacement
    : 'undecided';
  const adminSurface = ADMIN_SURFACES.includes(raw.adminSurface)
    ? raw.adminSurface
    : 'undecided';

  const suppliedComponents = raw.componentHosts === undefined ? [] : raw.componentHosts;
  if (!Array.isArray(suppliedComponents) || suppliedComponents.length > COMPONENT_IDS.length) {
    throw new Error('Invalid project component hosting map.');
  }

  const seen = new Set();
  const componentHosts = suppliedComponents.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        !COMPONENT_IDS.includes(item.component) ||
        !COMPONENT_PLACEMENTS.includes(item.placement) ||
        seen.has(item.component)) {
      throw new Error('Invalid or duplicate project component hosting entry.');
    }
    seen.add(item.component);
    return { component: item.component, placement: item.placement };
  }).sort((a, b) => a.component.localeCompare(b.component));

  const textOrUndecided = (value, field, maxLength = 200) =>
    value === 'undecided' || value === undefined || value === null
      ? 'undecided'
      : boundedText(value, field, maxLength);

  return {
    hostingPlacement,
    componentHosts,
    accountOwner: textOrUndecided(raw.accountOwner, 'accountOwner'),
    dataOwner: textOrUndecided(raw.dataOwner, 'dataOwner'),
    secretsOwner: textOrUndecided(raw.secretsOwner, 'secretsOwner'),
    operationsOwner: textOrUndecided(raw.operationsOwner, 'operationsOwner'),
    rollbackOwner: textOrUndecided(raw.rollbackOwner, 'rollbackOwner'),
    adminSurface,
    adminReason: textOrUndecided(raw.adminReason, 'adminReason', 500)
  };
}

function evaluateProjectArchitectureReadiness(raw, { requiredComponents = [] } = {}) {
  const architecture = normalizeProjectArchitecture(raw);
  if (!Array.isArray(requiredComponents) ||
      requiredComponents.some((item) => !COMPONENT_IDS.includes(item))) {
    throw new Error('Invalid required project components.');
  }

  const blockers = [];
  if (architecture.hostingPlacement === 'undecided') {
    blockers.push('hosting_placement_unresolved');
  }
  const mapped = new Set(architecture.componentHosts.map((item) => item.component));
  for (const component of [...new Set(requiredComponents)]) {
    if (!mapped.has(component)) blockers.push('component_host_missing:' + component);
  }
  for (const field of ['accountOwner', 'dataOwner', 'secretsOwner', 'operationsOwner', 'rollbackOwner']) {
    if (architecture[field] === 'undecided') blockers.push(field.toLowerCase() + '_unresolved');
  }
  if (architecture.adminSurface === 'undecided') {
    blockers.push('admin_surface_unresolved');
  }
  if (architecture.adminSurface !== 'undecided' && architecture.adminReason === 'undecided') {
    blockers.push('admin_surface_reason_unresolved');
  }

  const uniqueBlockers = [...new Set(blockers)];
  return {
    ready: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    architecture
  };
}

module.exports = {
  ADMIN_SURFACES,
  COMPONENT_IDS,
  COMPONENT_PLACEMENTS,
  HOSTING_PLACEMENTS,
  evaluateProjectArchitectureReadiness,
  normalizeProjectArchitecture
};
