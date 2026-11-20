'use strict';

function isPrivateAdmin(ctx, adminId) {
  return Boolean(
    ctx &&
    ctx.from &&
    ctx.chat &&
    ctx.chat.type === 'private' &&
    adminId !== undefined &&
    adminId !== null &&
    String(ctx.from.id) === String(adminId)
  );
}

module.exports = { isPrivateAdmin };
