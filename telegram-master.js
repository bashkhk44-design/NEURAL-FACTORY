function createMasterRuntime(options = {}) {
const env = options.env || (typeof process !== 'undefined' ? process.env : {});
const runtimeDependencies = options.dependencies || (() => {
  require('dotenv').config();
  const grammy = require('grammy');
  return {
    ...grammy,
    ...require('./telegram-admin-auth'),
    ...require('./db'),
    ...require('./bot-runtime'),
    ...require('./project-db'),
    ...require('./project-construction-points'),
    ...require('./intake-bot'),
    ...require('./gemini-analyst'),
    ...require('./ai-designer'),
    ...require('./project-pipeline'),
    ...require('./ai-router'),
    ...require('./project-release'),
    ...require('./deployment-readiness-telegram'),
    ...require('./deployment-preflight-queue')
  };
})();

const {
  Bot, Keyboard, InlineKeyboard, isPrivateAdmin,
  pool, verifyDatabaseSchema, insertTelegramBot, acquireTelegramRuntimeLock,
  isTelegramRuntimeLockHeld, releaseTelegramRuntimeLock, setRuntimeLockFailureHandler,
  startBotRuntime, stopBotRuntime, startBotById, stopBotById,
  getRunningBotCount, getBotRuntimeStatus,
  createProjectAiJob, getLatestCompletedProjectAiJob, markProjectAiJobRunning,
  completeProjectAiJob, failProjectAiJob, recoverInterruptedProjectAiJobs,
  getProjectApprovalState, approveProjectMilestone, buildConstructionPoints,
  startIntakeBot, stopIntakeBot, analyzeProject, designProject,
  runProjectPipeline, getGeminiModel, getReleaseCandidate, decideRelease,
  authorizeDeployment, reviewDeploymentReadiness, formatDeploymentReadinessReview,
  enqueueDeploymentPreflight, getLatestDeploymentPreflightJob, formatDeploymentPreflightJob
} = runtimeDependencies;

const botFactory = options.createBot || ((botToken) => new Bot(botToken, { client: { timeoutSeconds: 45 } }));
const CUSTOMER_BOT_WORKER_MODE = env.CUSTOMER_BOT_WORKER_MODE === 'external';

const token = options.token || env.TELEGRAM_BOT_TOKEN;
const adminId = options.adminId || env.TELEGRAM_ADMIN_ID;

if (!token || !adminId) {
  console.error('إعدادات Telegram ناقصة');
  throw new Error('إعدادات Telegram ناقصة');
}

const bot = botFactory(token);
const pendingAdds = new Map();

function isAdmin(ctx) {
  return isPrivateAdmin(ctx, adminId);
}

function designKeyboard(projectId) {
  return new InlineKeyboard().text('🎨 بدء AI DESIGNER', `project:design:${projectId}`);
}

function projectApprovalKeyboard(projectId, designJobId, approvals) {
  const pointsApproved = approvals?.construction_points_approved === true;
  const designApproved = approvals?.design_approved === true;
  const keyboard = new InlineKeyboard()
    .text((pointsApproved ? '✅ ' : '⬜ ') + 'اعتماد نقاط البناء', `project:approve:points:${projectId}:${designJobId}`)
    .row()
    .text((designApproved ? '✅ ' : '⬜ ') + 'اعتماد التصميم', `project:approve:design:${projectId}:${designJobId}`);

  if (pointsApproved && designApproved) {
    keyboard.row().text('🚀 تنفيذ المشروع بالكامل', `project:pipeline:${projectId}`);
  }
  return keyboard;
}

async function sendProjectApprovalPanel(ctx, projectId, designJob) {
  const approvals = await getProjectApprovalState({
    projectId,
    specVersion: designJob.spec_version,
    designJobId: designJob.id
  });

  const specResult = await pool.query(`
    SELECT s.spec
    FROM project_specs s
    JOIN client_projects p ON p.id = s.project_id
    JOIN project_ai_jobs j
      ON j.project_id = p.id
     AND j.spec_version = s.version
     AND j.id = $3
     AND j.job_type = 'design'
     AND j.status = 'completed'
    WHERE p.id = $1
      AND s.version = $2
      AND s.status = 'approved'
      AND p.status = 'spec_approved'
    LIMIT 1
  `, [projectId, designJob.spec_version, designJob.id]);

  const points = buildConstructionPoints(specResult.rows[0]?.spec || {});
  const pointsText = points.sections.length
    ? points.sections.map(section =>
        '• ' + section.label + ': ' + section.value
      ).join('\n').slice(0, 2400)
    : 'لا توجد تفاصيل نصية محفوظة في المواصفات؛ راجع وثيقة التصميم قبل الاعتماد.';

  await ctx.reply(
    '📋 اعتماد المشروع قبل التنفيذ\n\n' +
    '🧩 نقاط البناء المستخرجة من مواصفات العميل:\n' + pointsText + '\n\n' +
    '1. نقاط البناء: ' + (approvals?.construction_points_approved ? '✅ معتمدة' : '⏳ بانتظار اعتمادك') + '\n' +
    '2. وثيقة التصميم: ' + (approvals?.design_approved ? '✅ معتمدة' : '⏳ بانتظار اعتمادك') + '\n\n' +
    'لن يبدأ التنفيذ الكامل إلا بعد اعتماد النقطتين.',
    { reply_markup: projectApprovalKeyboard(projectId, designJob.id, approvals) }
  );
}

async function showProjects(ctx) {
  const result = await pool.query(`
    SELECT
      p.id, p.name, p.business_type, p.status,
      c.first_name, c.telegram_username, c.telegram_user_id
    FROM client_projects p
    JOIN clients c ON c.id = p.client_id
    ORDER BY p.created_at DESC
    LIMIT 50
  `);

  if (!result.rows.length) {
    return ctx.reply('📁 لا توجد مشاريع مسجلة حالياً.');
  }

  const labels = {
    collecting_requirements: 'يجمع المتطلبات',
    spec_approved: 'المواصفات معتمدة',
    completed: 'مكتمل',
    cancelled: 'ملغى'
  };

  await ctx.reply(`📁 مشاريع العملاء (آخر ${result.rows.length} مشروع):`);

  for (const p of result.rows) {
    const client = p.first_name || p.telegram_username || p.telegram_user_id;
    const status = labels[p.status] || p.status;
    const message =
      `📁 مشروع رقم ${p.id}\n` +
      `الاسم: ${p.name}\n` +
      `العميل: ${client}\n` +
      `النشاط: ${p.business_type || 'غير محدد'}\n` +
      `الحالة: ${status}`;

    if (p.status === 'spec_approved') {
      const keyboard = new InlineKeyboard()
        .text('🧠 AI ANALYST', `project:ai:${p.id}`)
        .text('🎨 AI DESIGNER', `project:design:${p.id}`)
        .row()
        .text('🚀 تنفيذ المشروع بالكامل', `project:pipeline:${p.id}`);
      await ctx.reply(message, { reply_markup: keyboard });
    } else {
      await ctx.reply(message);
    }
  }
}


function menu() {
  return new Keyboard()
    .text('🤖 البوتات').text('📁 المشاريع').row()
    .text('➕ إضافة بوت').text('📊 الإحصائيات').row()
    .text('⚙️ الإعدادات').text('🏠 الرئيسية')
    .resized();
}

async function getBots() {
  const result = await pool.query(
    'SELECT id, name, username, active FROM telegram_bots ORDER BY id DESC'
  );
  return result.rows;
}

async function getExternalBotRuntimeStatuses(botIds) {
  if (!CUSTOMER_BOT_WORKER_MODE || !botIds.length) return new Map();
  const result = await pool.query(
    'SELECT bot_id, status, worker_id, last_heartbeat_at FROM bot_runtime_status WHERE bot_id = ANY($1::bigint[])',
    [botIds]
  );
  return new Map(result.rows.map(row => [String(row.bot_id), row]));
}

async function queueCustomerBotAction(botId, action, requestedBy) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Invalid bot action');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(`
      SELECT b.id, s.worker_id
      FROM telegram_bots b
      LEFT JOIN bot_runtime_status s ON s.bot_id = b.id
      WHERE b.id = $1
      FOR UPDATE OF b
    `, [botId]);
    if (!found.rowCount) throw new Error('لم يتم العثور على البوت.');
    const targetWorkerId = found.rows[0].worker_id || null;
    await client.query(
      'UPDATE telegram_bots SET active = $2 WHERE id = $1',
      [botId, action !== 'stop']
    );
    await client.query(`
      INSERT INTO bot_runtime_commands
        (bot_id, action, status, target_worker_id, requested_by)
      VALUES ($1, $2, 'queued', $3, $4)
    `, [botId, action, targetWorkerId, String(requestedBy)]);
    await client.query('COMMIT');
    return { botId: String(botId), action, targetWorkerId };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function showBots(ctx, requestedPage = 0) {
  const bots = await getBots();
  if (!bots.length) return ctx.reply('🤖 لا توجد بوتات مسجلة حالياً.');

  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(bots.length / pageSize));
  const page = Math.min(Math.max(0, Number(requestedPage) || 0), pageCount - 1);
  const visible = bots.slice(page * pageSize, (page + 1) * pageSize);
  const externalStatuses = await getExternalBotRuntimeStatuses(visible.map(b => b.id));
  const statusLabels = {
    running: '🟢 يعمل',
    starting: '🟡 يبدأ',
    retrying: '🟠 يعيد',
    stopped: '🔴 متوقف',
    conflict: '⛔ تعارض',
    unauthorized: '⛔ Token',
    error: '❌ خطأ',
    not_loaded: '⚪ غير محمّل'
  };
  const keyboard = new InlineKeyboard();
  const lines = [
    '🤖 إدارة البوتات',
    'الصفحة: ' + (page + 1) + '/' + pageCount + ' | الإجمالي: ' + bots.length,
    'الحالة التشغيلية من runtime، وليست مجرد حالة التفعيل.',
    ''
  ];

  for (const b of visible) {
    const external = externalStatuses.get(String(b.id));
    const runtimeStatus = CUSTOMER_BOT_WORKER_MODE
      ? (external?.status || 'not_loaded')
      : getBotRuntimeStatus(b.id);
    lines.push(
      '#' + b.id + ' ' + b.name +
      (b.username ? ' (@' + b.username + ')' : '') +
      '\n' + (statusLabels[runtimeStatus] || runtimeStatus) +
      (CUSTOMER_BOT_WORKER_MODE && external?.worker_id ? ' | العامل: ' + external.worker_id.slice(0, 8) : '') +
      ' | ' + (b.active ? 'مفعّل' : 'معطّل')
    );
    if (b.active) {
      keyboard.text('⏹ #' + b.id, 'bot:stop:' + b.id)
        .text('🔄', 'bot:restart:' + b.id).row();
    } else {
      keyboard.text('▶️ #' + b.id, 'bot:start:' + b.id).row();
    }
  }

  if (pageCount > 1) {
    if (page > 0) keyboard.text('⬅️ السابق', 'bots:page:' + (page - 1));
    if (page < pageCount - 1) keyboard.text('التالي ➡️', 'bots:page:' + (page + 1));
  }

  const message = lines.join('\n');
  if (ctx.callbackQuery) {
    return ctx.editMessageText(message, { reply_markup: keyboard });
  }
  return ctx.reply(message, { reply_markup: keyboard });
}

async function showStats(ctx) {
  const bots = await getBots();
  const active = bots.filter(b => b.active).length;
  let running = getRunningBotCount();
  if (CUSTOMER_BOT_WORKER_MODE) {
    const result = await pool.query("SELECT COUNT(*)::int AS count FROM bot_runtime_status WHERE status = 'running' AND last_heartbeat_at >= NOW() - INTERVAL '2 minutes'");
    running = Number(result.rows[0]?.count || 0);
  }
  return ctx.reply(
    '📊 إحصائيات BOSS BOT MASTER\n\n' +
    'إجمالي البوتات: ' + bots.length + '\n' +
    'مفعّلة في قاعدة البيانات: ' + active + '\n' +
    'تعمل فعلياً في هذه العملية: ' + running + '\n' +
    'غير العاملة فعلياً حالياً: ' + Math.max(0, active - running) + '\n' +
    'الحد التشغيلي الحالي: 100 بوت'
  );
}

bot.command('start', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ غير مصرح لك.');

  return ctx.reply(
    '👑 BOSS BOT MASTER\n\nأهلاً بك في مركز إدارة جميع البوتات.',
    { reply_markup: menu() }
  );
});

bot.command('id', async (ctx) => {
  await ctx.reply(`Telegram ID: ${ctx.from.id}`);
});

bot.command('cancel', async (ctx) => {
  if (!isAdmin(ctx)) return;
  pendingAdds.delete(ctx.from.id);
  await ctx.reply('تم إلغاء عملية إضافة البوت.', {
    reply_markup: menu()
  });
});

bot.command('bots', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ غير مصرح لك.');
  await showBots(ctx);
});

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ غير مصرح لك.');
  await showStats(ctx);
});

bot.callbackQuery(/^bots:page:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'غير مصرح لك.' });
  await ctx.answerCallbackQuery();
  return showBots(ctx, Number(ctx.match[1]));
});

bot.callbackQuery(/^bot:(start|stop|restart):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'غير مصرح لك.' });
  const action = ctx.match[1];
  const botId = Number(ctx.match[2]);
  await ctx.answerCallbackQuery({ text: 'جارٍ تنفيذ الأمر...' });
  try {
    if (CUSTOMER_BOT_WORKER_MODE) {
      const queued = await queueCustomerBotAction(botId, action, ctx.from.id);
      return ctx.reply(
        (action === 'stop' ? '⏹' : action === 'restart' ? '🔄' : '▶️') +
        ' تم إرسال أمر ' + action + ' للبوت رقم ' + botId +
        '.\nالعامل الموزع سينفذ الأمر، ويمكنك متابعة الحالة من قائمة البوتات.'
      );
    }
    if (action === 'stop') {
      await pool.query('UPDATE telegram_bots SET active = FALSE WHERE id = $1', [botId]);
      await stopBotById(botId);
      return ctx.reply('⏹ تم إيقاف البوت رقم ' + botId + ' وتعطيل تشغيله التلقائي.');
    }
    if (action === 'start') {
      const saved = await pool.query('UPDATE telegram_bots SET active = TRUE WHERE id = $1 RETURNING id', [botId]);
      if (!saved.rowCount) return ctx.reply('لم يتم العثور على البوت.');
      await startBotById(botId);
      return ctx.reply('▶️ تم تفعيل طلب تشغيل البوت رقم ' + botId + '. راجع حالته من قائمة البوتات.');
    }
    const saved = await pool.query('UPDATE telegram_bots SET active = TRUE WHERE id = $1 RETURNING id', [botId]);
    if (!saved.rowCount) return ctx.reply('لم يتم العثور على البوت.');
    await stopBotById(botId);
    await startBotById(botId);
    return ctx.reply('🔄 أُعيد تشغيل البوت رقم ' + botId + '.');
  } catch (error) {
    console.error('CUSTOMER BOT MANAGEMENT ERROR:', botId, error.message);
    return ctx.reply('❌ تعذر تنفيذ الأمر للبوت رقم ' + botId + ': ' + String(error.message || error).slice(0, 500));
  }
});


async function getApprovedProjectForAnalysis(projectId) {
  const result = await pool.query(`
    SELECT
      p.id AS project_id,
      p.name AS project_name,
      p.business_type,
      p.status,
      c.telegram_user_id,
      c.telegram_username,
      c.first_name,
      s.version AS spec_version,
      s.spec
    FROM client_projects p
    JOIN clients c ON c.id = p.client_id
    JOIN LATERAL (
      SELECT version, spec
      FROM project_specs
      WHERE project_id = p.id AND status = 'approved'
      ORDER BY version DESC
      LIMIT 1
    ) s ON TRUE
    WHERE p.id = $1 AND p.status = 'spec_approved'
  `, [projectId]);

  return result.rows[0] || null;
}

bot.callbackQuery(/^project:ai:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCallbackQuery({ text: 'غير مصرح لك.' });
  }

  const projectId = Number(ctx.match[1]);

  await ctx.answerCallbackQuery({
    text: 'جارٍ تجهيز تحليل المشروع...'
  });

  try {
    const project = await getApprovedProjectForAnalysis(projectId);

    if (!project) {
      return ctx.reply(
        'تعذر العثور على المشروع أو لا توجد مواصفات معتمدة له.'
      );
    }

    const job = await createProjectAiJob({
      projectId,
      adminTelegramId: ctx.from.id
    });

    if (job.status === 'completed') {
      const previousText = job.analysis && job.analysis.text;

      if (previousText) {
        await ctx.reply('هذا الإصدار محلل مسبقاً. التقرير المحفوظ:');
        for (let i = 0; i < previousText.length; i += 3500) {
          await ctx.reply(previousText.slice(i, i + 3500));
        }
        await ctx.reply('التحليل محفوظ. يمكنك الآن إنشاء تصميم المشروع:', {
          reply_markup: designKeyboard(projectId)
        });
      } else {
        await ctx.reply('هذا الإصدار محلل مسبقاً، لكن لا يوجد نص تقرير محفوظ.');
      }
      return;
    }

    if (job.status === 'running') {
      return ctx.reply('⏳ تحليل هذا المشروع قيد التنفيذ بالفعل.');
    }

    const claimed = await markProjectAiJobRunning(job.id);

    if (!claimed) {
      return ctx.reply('⏳ المهمة قيد المعالجة أو تغيرت حالتها. تحقق من قائمة المهام.');
    }

    await ctx.reply(
      `🤖 بدأ AI ANALYST تحليل المشروع رقم ${projectId}.\n` +
      'سأرسل التقرير عند انتهاء التحليل.'
    );

    let analysis;

    try {
      analysis = await analyzeProject({ project });

      const saved = await completeProjectAiJob(job.id, analysis);

      if (!saved) {
        throw new Error('تعذر حفظ نتيجة التحليل في قاعدة البيانات.');
      }
    } catch (error) {
      try {
        await failProjectAiJob(job.id, error.message);
      } catch (dbError) {
        console.error('AI JOB FAILURE SAVE ERROR:', dbError.message);
      }

      console.error('GEMINI ANALYSIS ERROR:', error.message);

      await ctx.reply(
        '❌ تعذر إكمال تحليل Gemini أو حفظ نتيجته.\n' +
        'تم تسجيل فشل المهمة إن أمكن. تحقق من إعدادات Gemini وسجلات Render.'
      );
      return;
    }

    try {
      await ctx.reply(
        `✅ اكتمل تحليل المشروع رقم ${projectId}.\n` +
        `النموذج: ${analysis.model}\n` +
        'التقرير:'
      );

      for (let i = 0; i < analysis.text.length; i += 3500) {
        await ctx.reply(analysis.text.slice(i, i + 3500));
      }
      await ctx.reply('اكتمل التحليل. الخطوة التالية هي تصميم تجربة البوت:', {
        reply_markup: designKeyboard(projectId)
      });
    } catch (deliveryError) {
      console.error('AI REPORT DELIVERY ERROR:', deliveryError.message);

      try {
        await ctx.reply(
          '✅ التحليل اكتمل وحُفظ بنجاح، لكن تعذر إرسال التقرير كاملاً. ' +
          'يمكنك طلب التحليل مرة أخرى لاستعادة التقرير المحفوظ.'
        );
      } catch (noticeError) {
        console.error('AI DELIVERY NOTICE ERROR:', noticeError.message);
      }
    }
  } catch (error) {
    console.error('PROJECT AI HANDLER ERROR:', error.message);
    await ctx.reply(
      '❌ تعذر تجهيز مهمة التحليل. تحقق من قاعدة البيانات وحالة اعتماد المشروع.'
    );
  }
});


bot.callbackQuery(/^project:design:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCallbackQuery({ text: 'غير مصرح لك.' });
  }

  const projectId = Number(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: 'جارٍ تجهيز التصميم...' });

  try {
    const project = await getApprovedProjectForAnalysis(projectId);
    if (!project) {
      return ctx.reply('تعذر العثور على مشروع معتمد.');
    }

    const analysisJob = await getLatestCompletedProjectAiJob({
      projectId,
      jobType: 'analysis'
    });

    if (!analysisJob || !analysisJob.analysis || !analysisJob.analysis.text) {
      return ctx.reply('يجب إكمال AI ANALYST أولاً قبل بدء التصميم.');
    }

    const job = await createProjectAiJob({
      projectId,
      adminTelegramId: ctx.from.id,
      jobType: 'design'
    });

    if (job.status === 'completed' && job.analysis?.text) {
      await ctx.reply('🎨 التصميم محفوظ مسبقاً:');
      for (let i = 0; i < job.analysis.text.length; i += 3500) {
        await ctx.reply(job.analysis.text.slice(i, i + 3500));
      }
      await sendProjectApprovalPanel(ctx, projectId, job);
      return;
    }

    if (job.status === 'running') {
      return ctx.reply('⏳ تصميم هذا المشروع قيد التنفيذ بالفعل.');
    }

    const claimed = await markProjectAiJobRunning(job.id);
    if (!claimed) {
      return ctx.reply('المهمة قيد المعالجة أو تغيرت حالتها. حاول التحقق لاحقاً.');
    }

    await ctx.reply('🎨 بدأ AI DESIGNER إعداد تجربة المشروع. سأرسل وثيقة التصميم عند اكتمالها.');

    let design;
    try {
      design = await designProject({
        project,
        analysis: analysisJob.analysis
      });

      const saved = await completeProjectAiJob(job.id, design);
      if (!saved) {
        throw new Error('تعذر حفظ وثيقة التصميم في قاعدة البيانات.');
      }
    } catch (error) {
      try {
        await failProjectAiJob(job.id, error.message);
      } catch (dbError) {
        console.error('DESIGN JOB FAILURE SAVE ERROR:', dbError.message);
      }

      console.error('AI DESIGNER ERROR:', error.message);
      await ctx.reply('❌ تعذر إكمال التصميم أو حفظه. تحقق من سجلات Render.');
      return;
    }

    await ctx.reply(
      `✅ اكتمل تصميم المشروع رقم ${projectId}.\nالنموذج: ${design.model}\nوثيقة التصميم:`
    );

    for (let i = 0; i < design.text.length; i += 3500) {
      await ctx.reply(design.text.slice(i, i + 3500));
    }
    await sendProjectApprovalPanel(ctx, projectId, job);
  } catch (error) {
    console.error('PROJECT DESIGN HANDLER ERROR:', error.message);
    await ctx.reply('❌ تعذر تجهيز مهمة التصميم. تحقق من قاعدة البيانات وحالة التحليل.');
  }
});




bot.callbackQuery(/^project:approve:(points|design):(\d+):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCallbackQuery({ text: 'غير مصرح لك.' });
  }

  const approvalType = ctx.match[1] === 'points' ? 'construction_points' : 'design';
  const projectId = Number(ctx.match[2]);
  const designJobId = Number(ctx.match[3]);

  await ctx.answerCallbackQuery({ text: 'جارٍ حفظ الاعتماد...' });

  try {
    const approved = await approveProjectMilestone({
      projectId,
      designJobId,
      approvalType,
      adminTelegramId: ctx.from.id
    });

    const pointsApproved = approved.construction_points_approved === true;
    const designApproved = approved.design_approved === true;

    await ctx.reply(
      '✅ تم حفظ الاعتماد في قاعدة البيانات.\n\n' +
      'نقاط البناء: ' + (pointsApproved ? '✅ معتمدة' : '⏳ بانتظار الاعتماد') + '\n' +
      'التصميم: ' + (designApproved ? '✅ معتمد' : '⏳ بانتظار الاعتماد') + '\n\n' +
      (pointsApproved && designApproved
        ? 'اكتمل الاعتمادان. أصبح بإمكانك بدء التنفيذ الكامل.'
        : 'اعتمد النقطة المتبقية لإتاحة التنفيذ الكامل.'),
      { reply_markup: projectApprovalKeyboard(projectId, designJobId, approved) }
    );
  } catch (error) {
    console.error('PROJECT APPROVAL ERROR:', error.message);
    await ctx.reply('❌ لم يتم حفظ الاعتماد: ' + String(error.message || error).slice(0, 1000));
  }
});

bot.callbackQuery(/^project:pipeline:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCallbackQuery({ text: 'غير مصرح لك.' });
  }

  const projectId = Number(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: 'جارٍ التحقق من الاعتمادات...' });

  try {
    const project = await getApprovedProjectForAnalysis(projectId);

    if (!project) {
      return ctx.reply('تعذر العثور على مشروع ذي مواصفات معتمدة.');
    }

    await ctx.reply('🚀 بدأ التنفيذ الكامل للمشروع رقم ' + projectId);

    const result = await runProjectPipeline({
      project,
      adminTelegramId: ctx.from.id,
      onProgress: async (message) => {
        await ctx.reply('⚙️ ' + message);
      }
    });

    if (!result.completed) {
      return ctx.reply(
        '❌ توقف التنفيذ قبل النشر.\n' + result.summary
      );
    }

    const release = result.releaseCandidate;
    await ctx.reply(
      '✅ اكتمل البناء والاختبار للمشروع رقم ' + projectId +
      '\n' + result.summary +
      '\nرقم الإصدار: R' + release.release_version +
      '\nبصمة SHA-256: ' + release.artifact_sha256 +
      '\nحالة الإصدار: بانتظار موافقة العميل ثم المدير.\nلم يتم النشر.'
    );

    try {
      await ctx.api.sendMessage(
        release.customerTelegramId,
        '📦 إصدار جديد جاهز للمراجعة والتسليم' +
        '\nالمشروع: ' + (project.project_name || project.name) +
        '\nالإصدار: R' + release.release_version +
        '\nالمواصفات المعتمدة: v' + release.spec_version +
        '\nملخص المواصفات: ' + JSON.stringify(result.releaseReport.approvals.customerSpec.details).slice(0, 650) +
        '\nملخص التصميم: ' + result.releaseReport.design.summary.slice(0, 650) +
        '\nبصمة الإصدار: ' + release.artifact_sha256 +
        '\n\nملخص الاختبارات: ' + result.releaseReport.tests.summary.passed + '/' + result.releaseReport.tests.summary.tests + ' ناجحة' +
        '\nاختبارات القبول: ' + result.releaseReport.tests.acceptanceTests.length +
        '\nفحوصات ما قبل النشر غير المستوفاة: ' + result.releaseReport.risks.length +
        (result.releaseReport.risks.length
          ? '\n' + result.releaseReport.risks.map(item => '• ' + item.check + ': ' + item.details).join('\n').slice(0, 1200)
          : '') +
        '\n\nبموافقتك تؤكد قبولك لإصدار المواصفات والتصميم ونتيجة الاختبارات الموضحة أعلاه. موافقتك لا تعني النشر؛ إنها اعتماد للتسليم فقط.',
        { reply_markup: new InlineKeyboard()
          .text('✅ أوافق على الإصدار', 'project:release:customer:approved:' + release.id)
          .row()
          .text('❌ أرفض الإصدار', 'project:release:customer:rejected:' + release.id) }
      );
    } catch (deliveryError) {
      console.error('RELEASE CUSTOMER DELIVERY ERROR:', deliveryError.message);
      await ctx.reply('⚠️ تم حفظ الإصدار، لكن تعذر إرسال طلب الموافقة إلى العميل عبر Telegram. لم يتم النشر.');
    }
  } catch (error) {
    console.error('PROJECT PIPELINE ERROR:', error);
    await ctx.reply(
      '❌ تعذر إكمال التنفيذ: ' +
      String(error.message || error).slice(0, 2000)
    );
  }
});


bot.callbackQuery(/^project:release:customer:(approved|rejected):(\d+)$/, async (ctx) => {
  try {
    const decision = await decideRelease({
      releaseId: ctx.match[2],
      role: 'customer',
      telegramUserId: ctx.from.id,
      decision: ctx.match[1]
    });
    await ctx.answerCallbackQuery({
      text: decision.status === 'awaiting_manager' ? 'تم تسجيل موافقتك.' : 'تم تسجيل الرفض.'
    });
    await ctx.reply(
      decision.status === 'awaiting_manager'
        ? '✅ تم تسجيل موافقتك على تقرير الإصدار ونتيجة الاختبارات. ينتظر الآن اعتماد المدير. لم يتم النشر.'
        : 'تم تسجيل رفض الإصدار. سيقوم فريق المشروع بمراجعته.'
    );
    if (decision.status === 'awaiting_manager') {
      try {
        const approvedRelease = await getReleaseCandidate(decision.id);
        await ctx.api.sendMessage(
          adminId,
          '📋 موافقة العميل وصلت للإصدار R' + decision.release_version +
          ' للمشروع #' + decision.project_id +
          '.\nالمواصفات: ' + JSON.stringify(approvedRelease.artifact.report.approvals.customerSpec.details).slice(0, 700) +
          '\nالاختبارات: ' + approvedRelease.artifact.report.tests.summary.passed + '/' +
            approvedRelease.artifact.report.tests.summary.tests +
          '\nالمخاطر: ' + approvedRelease.artifact.report.risks.length +
          '\nبصمة SHA-256: ' + approvedRelease.artifact_sha256 +
          '\nيمكنك مراجعة الإصدار واعتماده أو رفضه.',
          { reply_markup: new InlineKeyboard()
            .text('✅ اعتماد المدير', 'project:release:manager:approved:' + decision.id)
            .row()
            .text('❌ رفض الإصدار', 'project:release:manager:rejected:' + decision.id) }
        );
      } catch (notifyError) {
        console.error('RELEASE MANAGER NOTIFICATION ERROR:', notifyError.message);
      }
    } else {
      await ctx.api.sendMessage(adminId, '❌ رفض العميل الإصدار R' + decision.release_version + ' للمشروع #' + decision.project_id + '.');
    }
  } catch (error) {
    await ctx.answerCallbackQuery({ text: String(error.message || error).slice(0, 180) });
  }
});

bot.callbackQuery(/^project:release:manager:(approved|rejected):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'غير مصرح لك.' });
  try {
    const current = await getReleaseCandidate(ctx.match[2]);
    if (!current) throw new Error('الإصدار غير موجود.');
    const decision = await decideRelease({
      releaseId: ctx.match[2],
      role: 'manager',
      telegramUserId: ctx.from.id,
      decision: ctx.match[1]
    });
    await ctx.answerCallbackQuery({
      text: decision.status === 'approved' ? 'اعتمد الإصدار.' : 'تم رفض الإصدار.'
    });
    await ctx.reply(
      (decision.status === 'approved' ? '✅ اكتمل اعتماد الإصدار ' : '❌ تم رفض الإصدار ') +
      'R' + decision.release_version + ' للمشروع #' + decision.project_id +
      '.\nحالة النشر: لم يتم النشر، ويتطلب النشر تصريحاً منفصلاً.' +
      (decision.status === 'approved' ? '\nيمكنك الآن إصدار تصريح نشر مستقل بعد مراجعة الإصدار.' : ''),
      decision.status === 'approved'
        ? { reply_markup: new InlineKeyboard().text('🔐 إصدار تصريح نشر منفصل', 'project:deploy-auth:authorize:' + decision.id) }
        : {}
    );
    try {
      await ctx.api.sendMessage(
        current.customer_telegram_id,
        (decision.status === 'approved'
          ? '✅ اعتمد المدير إصدارك R' + decision.release_version + '.'
          : '❌ رفض المدير إصدار R' + decision.release_version + '.') +
        '\nلم يتم تنفيذ أي نشر تلقائي.'
      );
    } catch (notifyError) {
      console.error('RELEASE CUSTOMER FINAL NOTIFICATION ERROR:', notifyError.message);
    }
  } catch (error) {
    await ctx.answerCallbackQuery({ text: String(error.message || error).slice(0, 180) });
  }
});


bot.callbackQuery(/^project:deploy-auth:authorize:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'غير مصرح لك.' });
  try {
    const authorization = await authorizeDeployment({
      releaseId: ctx.match[1],
      telegramUserId: ctx.from.id
    });
    await ctx.answerCallbackQuery({ text: 'تم إصدار تصريح النشر المستقل.' });
    await ctx.reply(
      '🔐 تصريح النشر رقم #' + authorization.id + ' أصبح معتمداً.\n' +
      'الإصدار: #' + authorization.release_id + '\n' +
      'بصمة التصريح SHA-256: ' + authorization.authorization_sha256 + '\n\n' +
      'تنبيه: هذا التصريح لا ينفّذ النشر تلقائياً. لم يتم الاتصال بـ Render أو تغيير الإنتاج.',
      {
        reply_markup: new InlineKeyboard().text(
          '📋 مراجعة متطلبات الجاهزية',
          'project:deploy:readiness:' + authorization.release_id
        )
      }
    );
  } catch (error) {
    await ctx.answerCallbackQuery({ text: String(error.message || error).slice(0, 180) });
  }
});

bot.callbackQuery(/^project:deploy:readiness:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'غير مصرح لك.' });
  try {
    const release = await getReleaseCandidate(ctx.match[1]);
    if (!release) throw new Error('الإصدار غير موجود.');

    const authorizationResult = await pool.query(
      `SELECT id, release_id, authorized_by, status, authorization_sha256, created_at
       FROM project_deployment_authorizations
       WHERE release_id = $1`,
      [ctx.match[1]]
    );
    const authorization = authorizationResult.rows[0] || null;
    const review = reviewDeploymentReadiness({ release, authorization });
    const message = formatDeploymentReadinessReview({ release, review });

    const keyboard = new InlineKeyboard();
    if (release.status === 'approved' &&
        review.artifactDigestValid &&
        review.authorizationDigestValid) {
      keyboard.text('🧪 تشغيل فحص Docker المعزول', 'project:deploy:preflight:' + release.id).row();
    }
    keyboard.text('🔄 تحديث المراجعة', 'project:deploy:readiness:' + release.id);

    await ctx.answerCallbackQuery({ text: 'اكتملت مراجعة المتطلبات.' });
    await ctx.reply(message, { reply_markup: keyboard });
  } catch (error) {
    console.error('DEPLOYMENT READINESS TELEGRAM REVIEW ERROR:', error.message);
    await ctx.answerCallbackQuery({ text: String(error.message || error).slice(0, 180) });
  }
});

bot.callbackQuery(/^project:deploy:preflight:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'غير مصرح لك.' });
  try {
    const release = await getReleaseCandidate(ctx.match[1]);
    if (!release) throw new Error('الإصدار غير موجود.');

    const authorizationResult = await pool.query(
      `SELECT id, release_id, authorized_by, status, authorization_sha256, created_at
       FROM project_deployment_authorizations
       WHERE release_id = $1`,
      [release.id]
    );
    const authorization = authorizationResult.rows[0] || null;
    const queued = await enqueueDeploymentPreflight({
      pool,
      release,
      authorization,
      requestedBy: ctx.from.id
    });
    const job = await getLatestDeploymentPreflightJob({
      pool,
      releaseId: release.id,
      projectId: release.project_id
    });

    await ctx.answerCallbackQuery({
      text: queued.created ? 'تمت إضافة الفحص إلى قائمة الانتظار.' : 'يوجد فحص سابق لهذا الإصدار.'
    });
    await ctx.reply(formatDeploymentPreflightJob(job, release), {
      reply_markup: new InlineKeyboard()
        .text('🔄 تحديث حالة الفحص', 'project:deploy:preflight-status:' + release.id)
        .row()
        .text('📋 مراجعة متطلبات الجاهزية', 'project:deploy:readiness:' + release.id)
    });
  } catch (error) {
    console.error('DEPLOYMENT PREFLIGHT QUEUE ERROR:', error.message);
    await ctx.answerCallbackQuery({ text: String(error.message || error).slice(0, 180) });
  }
});

bot.callbackQuery(/^project:deploy:preflight-status:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'غير مصرح لك.' });
  try {
    const release = await getReleaseCandidate(ctx.match[1]);
    if (!release) throw new Error('الإصدار غير موجود.');
    const job = await getLatestDeploymentPreflightJob({
      pool,
      releaseId: release.id,
      projectId: release.project_id
    });
    await ctx.answerCallbackQuery({ text: 'تم تحديث حالة الفحص.' });
    await ctx.reply(formatDeploymentPreflightJob(job, release), {
      reply_markup: new InlineKeyboard()
        .text('🔄 تحديث حالة الفحص', 'project:deploy:preflight-status:' + release.id)
        .row()
        .text('📋 مراجعة متطلبات الجاهزية', 'project:deploy:readiness:' + release.id)
    });
  } catch (error) {
    console.error('DEPLOYMENT PREFLIGHT STATUS ERROR:', error.message);
    await ctx.answerCallbackQuery({ text: String(error.message || error).slice(0, 180) });
  }
});

function settingsKeyboard() {
  return new InlineKeyboard()
    .text('🧠 Gemini', 'settings:gemini')
    .text('🗄️ قاعدة البيانات', 'settings:database')
    .row()
    .text('🔐 الأمان والتشفير', 'settings:security')
    .text('🤖 حالة البوتات', 'settings:services')
    .row()
    .text('🔄 تحديث المركز', 'settings:main');
}

async function showSettingsResult(ctx, message) {
  try {
    await ctx.editMessageText(message, {
      reply_markup: settingsKeyboard()
    });
  } catch (_) {
    await ctx.reply(message, {
      reply_markup: settingsKeyboard()
    });
  }
}

bot.callbackQuery(/^settings:(main|database|security|services|gemini|gemini:test)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCallbackQuery({ text: 'غير مصرح لك.' });
  }

  const section = ctx.match[1];
  await ctx.answerCallbackQuery(
    section === 'gemini:test'
      ? { text: 'بدأ اختبار اتصال Gemini...' }
      : {}
  );

  if (section === 'main') {
    return showSettingsResult(
      ctx,
      '⚙️ مركز إعدادات BOSS BOT MASTER\nاختر القسم الذي تريد فحصه:'
    );
  }

  if (section === 'database') {
    try {
      const result = await pool.query('SELECT NOW() AS server_time');
      return showSettingsResult(
        ctx,
        '🗄️ فحص قاعدة البيانات\n\n' +
        'الحالة: ✅ الاتصال ناجح\n' +
        'الخادم: Neon PostgreSQL\n' +
        'وقت استجابة الخادم: ' +
        new Date(result.rows[0].server_time).toLocaleString('en-GB', { timeZone: 'UTC' }) +
        ' UTC'
      );
    } catch (error) {
      console.error('SETTINGS DATABASE CHECK:', error.message);
      return showSettingsResult(
        ctx,
        '🗄️ فحص قاعدة البيانات\n\n❌ تعذر الاتصال بقاعدة البيانات. راجع إعداد اتصال قاعدة البيانات وإعدادات الخدمة وسجلات التشغيل.'
      );
    }
  }

  if (section === 'security') {
    const encryptionReady = /^[0-9a-fA-F]{64}$/.test(
      env.BOTS_ENCRYPTION_KEY || ''
    );
    const adminReady = /^\d+$/.test(String(adminId || ''));

    return showSettingsResult(
      ctx,
      '🔐 فحص الأمان\n\n' +
      'معرّف المدير: ' + (adminReady ? '✅ مضبوط' : '❌ غير صالح') + '\n' +
      'مفتاح تشفير AES-256: ' + (encryptionReady ? '✅ التنسيق صحيح' : '❌ غير مضبوط أو تنسيقه غير صحيح') + '\n' +
      'حماية الرموز: AES-256-GCM\n' +
      'عرض المفاتيح السرية: ممنوع'
    );
  }

  if (section === 'services') {
    let runningCount = 0;
    try {
      runningCount = getRunningBotCount();
    } catch (_) {}

    return showSettingsResult(
      ctx,
      '🤖 حالة الخدمات\n\n' +
      'بوت المدير: ✅ يعمل (تم استقبال هذا الطلب)\n' +
      'بوتات العملاء العاملة: ' + runningCount + '\n' +
      'رمز بوت الاستقبال: ' +
      (env.INTAKE_BOT_TOKEN ? '✅ مضبوط' : '⚠️ غير مضبوط') + '\n' +
      'المنصة: Telegram فقط'
    );
  }

  if (section === 'gemini') {
    const configured = Boolean(env.GEMINI_API_KEY);
    const model = env.GEMINI_MODEL || env.GEMINI_FREE_MODEL || 'gemini-3.8-flash';

    const keyboard = new InlineKeyboard()
      .text('🧪 اختبار اتصال Gemini', 'settings:gemini:test')
      .row()
      .text('⬅️ العودة للإعدادات', 'settings:main');

    return ctx.editMessageText(
      '🧠 إعدادات Gemini\n\n' +
      'مفتاح API: ' + (configured ? '✅ موجود (مخفي)' : '❌ غير مضبوط') + '\n' +
      'النموذج: ' + model + '\n\n' +
      'يمكنك اختبار الاتصال الفعلي بالضغط على الزر.\n' +
      'لن يتم عرض المفتاح السري.',
      { reply_markup: keyboard }
    );
  }

  if (section === 'gemini:test') {
    if (!env.GEMINI_API_KEY) {
      return showSettingsResult(ctx, '❌ لا يوجد GEMINI_API_KEY مضبوط في إعدادات Render.');
    }

    await showSettingsResult(
      ctx,
      '🧠 اختبار Gemini\n\n⏳ جارٍ الاتصال بخدمة Google Gemini...\nقد يستغرق الاختبار حتى دقيقتين.'
    );

    try {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({
        apiKey: env.GEMINI_API_KEY
      });
      const model = getGeminiModel();

      const response = await ai.interactions.create({
        model,
        input: 'Reply with OK.',
        system_instruction: 'You are a connectivity test. Reply briefly.'
      }, {
        timeout_ms: 120000
      });

      if (!response.output_text || !response.output_text.trim()) {
        throw new Error('Gemini returned an empty response');
      }

      return showSettingsResult(
        ctx,
        '🧠 اختبار Gemini\n\n✅ اتصال API ناجح واستلمنا رداً من النموذج.\nالنموذج: ' + model
      );
    } catch (error) {
      console.error('SETTINGS GEMINI TEST:', error.name, error.message, error.status || '');
      return showSettingsResult(
        ctx,
        '🧠 اختبار Gemini\n\n❌ فشل اختبار الاتصال. تحقق من المفتاح واسم النموذج وحالة الخدمة في إعدادات Render.'
      );
    }
  }
});

bot.on('message:text', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('⛔ غير مصرح لك باستخدام لوحة الإدارة.');
  }

  const text = ctx.message.text;
  const userId = ctx.from.id;

  const menuCommands = [
    '🏠 الرئيسية', '/menu',
    '🤖 البوتات', '📁 المشاريع',
    '➕ إضافة بوت', '📊 الإحصائيات',
    '⚙️ الإعدادات'
  ];

  // أزرار القائمة لها الأولوية دائماً على حالة الإضافة المعلقة.
  if (menuCommands.includes(text)) {
    pendingAdds.delete(userId);
  } else {
    const pending = pendingAdds.get(userId);

    if (pending) {
      if (text === 'إلغاء' || text === 'الغاء') {
        pendingAdds.delete(userId);
        return ctx.reply('تم إلغاء الإضافة.', {
          reply_markup: menu()
        });
      }

      if (pending.step === 'name') {
        const name = text.trim();

        if (name.length < 2 || name.length > 80) {
          return ctx.reply('اكتب اسماً بين حرفين و80 حرفاً.');
        }

        pendingAdds.set(userId, { step: 'token', name });

        return ctx.reply(
          '🔐 أرسل Token البوت الآن برسالة واحدة.\n\n' +
          'سيحاول النظام حذف رسالة الرمز فور استلامها.\n' +
          'لا ترسل أي رمز إلا في المحادثة الخاصة مع بوت المدير.'
        );
      }

      if (pending.step === 'token') {
        const newToken = text.trim();

        try {
          await ctx.deleteMessage();
        } catch (_) {}

        if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(newToken)) {
          pendingAdds.delete(userId);
          return ctx.reply(
            '❌ صيغة Token غير صحيحة. ابدأ الإضافة من جديد.',
            { reply_markup: menu() }
          );
        }

        try {
          const candidate = new Bot(newToken, {
            client: { timeoutSeconds: 45 }
          });
          const me = await candidate.api.getMe();

          const saved = await insertTelegramBot({
            name: pending.name,
            username: me.username || null,
            token: newToken
          });

          let runtimeMessage = '⚠️ تم تسجيله، لكن لم يبدأ التشغيل؛ راجع السعة أو سجل الأخطاء.';
          try {
            const state = await startBotById(saved.id);
            runtimeMessage = '🟢 ' + (state.status === 'running' ? 'يعمل الآن' : 'بدأ التشغيل وحالته: ' + state.status);
          } catch (runtimeError) {
            console.error('NEW CUSTOMER BOT START ERROR:', saved.id, runtimeError.message);
          }

          pendingAdds.delete(userId);

          return ctx.reply(
            `✅ تمت إضافة البوت بنجاح!\n\n` +
            `الاسم: ${saved.name}\n` +
            `الحساب: @${me.username}\n` +
            `رقم التسجيل: ${saved.id}\n` +
            `حالة التشغيل: ${runtimeMessage}\n\n` +
            'تم حفظ الرمز بصورة مشفرة.',
            { reply_markup: menu() }
          );
        } catch (err) {
          pendingAdds.delete(userId);

          if (err.code === '23505') {
            return ctx.reply('⚠️ هذا البوت مسجل مسبقاً.', {
              reply_markup: menu()
            });
          }

          if (err.error_code || err.description) {
            return ctx.reply(
              '❌ تعذر التحقق من Token. تأكد من صحته ومن BotFather، ثم أعد المحاولة.',
              { reply_markup: menu() }
            );
          }

          console.error('Bot registration failed:', err.code || 'unknown');

          return ctx.reply(
            '❌ تعذر حفظ البوت. تحقق من إعدادات التشفير وقاعدة البيانات.',
            { reply_markup: menu() }
          );
        }
      }
    }
  }

  // معالجة أزرار القائمة الرئيسية بعد إنهاء حالة الانتظار.
  if (text === '🏠 الرئيسية' || text === '/menu') {
    return ctx.reply('👑 القائمة الرئيسية', {
      reply_markup: menu()
    });
  }

  if (text === '🤖 البوتات') return showBots(ctx);
  if (text === '📁 المشاريع') return showProjects(ctx);

  if (text === '➕ إضافة بوت') {
    pendingAdds.set(userId, { step: 'name' });
    return ctx.reply(
      '➕ إضافة بوت جديد\n\n' +
      'أرسل اسم البوت الذي تريد تسجيله.\n\n' +
      'للإلغاء أرسل: إلغاء'
    );
  }

  if (text === '📊 الإحصائيات') return showStats(ctx);

  if (text === '⚙️ الإعدادات') {
    return ctx.reply(
      '⚙️ مركز إعدادات BOSS BOT MASTER\nاختر القسم الذي تريد فحصه:',
      { reply_markup: settingsKeyboard() }
    );
  }

  return ctx.reply('اختر أحد أزرار القائمة.', {
    reply_markup: menu()
  });
});

bot.catch((err) => {
  console.error('Telegram error:', err.message);
});


let shuttingDown = false;
let runtimeRecoveryPromise = null;
let runtimeRecoveryRequested = false;
let masterPollingPromise = null;
let stoppingForRecovery = false;

function recoveryDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function stopTelegramServicesForRecovery() {
  stoppingForRecovery = true;

  try {
    try {
      await stopIntakeBot();
    } catch (err) {
      console.error('RECOVERY INTAKE STOP ERROR:', err.message);
    }

    try {
      await bot.stop();
    } catch (err) {
      console.error('RECOVERY MASTER STOP ERROR:', err.message);
    }

    const currentPolling = masterPollingPromise;
    if (currentPolling) {
      try {
        await currentPolling;
      } catch (err) {
        console.error('RECOVERY MASTER POLLING WAIT ERROR:', err.message);
      }
    }

    if (!CUSTOMER_BOT_WORKER_MODE) {
      try {
        await stopBotRuntime();
      } catch (err) {
        console.error('RECOVERY CUSTOMER BOTS STOP ERROR:', err.message);
      }
    }
  } finally {
    stoppingForRecovery = false;
  }
}

let startupInProgress = false;

function startMasterPolling() {
  return new Promise((resolve, reject) => {
    let started = false;

    const polling = bot.start({
      onStart: (info) => {
        started = true;
        console.log('BOSS BOT MASTER يعمل: @' + info.username);
        resolve();
      }
    }).then(() => {
      if (!started) {
        reject(new Error('Master polling stopped before startup completed'));
      } else if (!shuttingDown && !stoppingForRecovery) {
        void recoverTelegramRuntime(new Error('Master polling stopped unexpectedly'));
      }
    }).catch((err) => {
      if (!started) {
        reject(err);
        return;
      }

      if (!shuttingDown && !stoppingForRecovery) {
        console.error('MASTER POLLING ERROR:', err.message);
        void recoverTelegramRuntime(new Error('Master polling failed: ' + err.message));
      }
    }).finally(() => {
      if (masterPollingPromise === polling) {
        masterPollingPromise = null;
      }
    });

    masterPollingPromise = polling;
  });
}

async function runtimeLockIsSafe() {
  if (shuttingDown || runtimeRecoveryRequested) return false;

  const held = await isTelegramRuntimeLockHeld();

  return held && !shuttingDown && !runtimeRecoveryRequested;
}

async function startTelegramServices() {
  if (!(await runtimeLockIsSafe())) {
    throw new Error('Runtime lock lost before Telegram services startup');
  }

  if (!CUSTOMER_BOT_WORKER_MODE) {
    await startBotRuntime();
  } else {
    console.log('Customer bot runtime is external; manager will control bots through PostgreSQL commands.');
  }

  if (!(await runtimeLockIsSafe())) {
    throw new Error('Runtime lock lost after customer bots startup');
  }

  await startIntakeBot(
    async ({ text, extra }) => {
      await bot.api.sendMessage(adminId, text, extra);
    },
    (fatalError) => recoverTelegramRuntime(
      new Error('Intake bot polling failed: ' + fatalError.message)
    )
  );

  if (!(await runtimeLockIsSafe())) {
    throw new Error('Runtime lock lost after intake bot startup');
  }

  await startMasterPolling();

  if (!(await runtimeLockIsSafe())) {
    throw new Error('Runtime lock lost after master bot startup');
  }
}

async function recoverTelegramRuntime(err) {
  if (shuttingDown) return;
  runtimeRecoveryRequested = true;
  if (runtimeRecoveryPromise) return runtimeRecoveryPromise;

  console.error(
    'WARNING: Telegram polling/runtime failed. Stopping Telegram services and attempting safe recovery.',
    err?.message || err || ''
  );

  // During initial startup, the startup loop already owns recovery.
  if (startupInProgress) return;

  runtimeRecoveryPromise = (async () => {
    await stopTelegramServicesForRecovery();

    while (!shuttingDown) {
      try {
        const locked = await acquireTelegramRuntimeLock();

        if (!locked) {
          console.log('Runtime lock is held by another instance; retrying recovery in 5 seconds.');
          await recoveryDelay(5000);
          continue;
        }

        runtimeRecoveryRequested = false;

        if (!(await isTelegramRuntimeLockHeld())) {
          runtimeRecoveryRequested = true;
          await stopTelegramServicesForRecovery();
          await recoveryDelay(5000);
          continue;
        }

        const recoveredJobs = await recoverInterruptedProjectAiJobs();
        console.log('Recovered ' + recoveredJobs + ' interrupted AI job(s) after lock loss');

        await startTelegramServices();

        if (!(await runtimeLockIsSafe()) || runtimeRecoveryRequested) {
          throw new Error('Runtime lock was lost while restarting Telegram services');
        }

        process.emit('boss:runtime-ready');
        console.log('Telegram runtime recovered successfully without exiting the service.');
        return;
      } catch (recoveryError) {
        console.error('RUNTIME LOCK RECOVERY ATTEMPT FAILED:', recoveryError.message);
        runtimeRecoveryRequested = true;
        await stopTelegramServicesForRecovery();

        if (!shuttingDown) {
          await recoveryDelay(5000);
        }
      }
    }
  })().finally(() => {
    runtimeRecoveryPromise = null;
  });

  return runtimeRecoveryPromise;
}

async function start() {
  startupInProgress = true;
  setRuntimeLockFailureHandler(recoverTelegramRuntime);

  try {
    let databaseReady = false;

    while (!databaseReady && !shuttingDown) {
      try {
        await verifyDatabaseSchema();
        databaseReady = true;
      } catch (databaseError) {
        console.error('DATABASE INITIALIZATION FAILED; retrying in 10 seconds:', databaseError.message);
        await recoveryDelay(10000);
      }
    }

    if (shuttingDown) return;

    let locked = false;

    while (!locked && !shuttingDown) {
      runtimeRecoveryRequested = false;

      try {
        locked = await acquireTelegramRuntimeLock();
      } catch (lockError) {
        console.error('INITIAL RUNTIME LOCK ERROR:', lockError.message);
        await recoveryDelay(5000);
        continue;
      }

      if (runtimeRecoveryRequested) {
        await stopTelegramServicesForRecovery();
        continue;
      }

      if (!locked) {
        console.log('نسخة أخرى تشغّل بوتات تلغرام؛ إعادة المحاولة بعد 5 ثوانٍ');
        await recoveryDelay(5000);
        continue;
      }

      try {
        if (!(await runtimeLockIsSafe())) {
          await stopTelegramServicesForRecovery();
          continue;
        }

        const recoveredJobs = await recoverInterruptedProjectAiJobs();
        console.log('Recovered ' + recoveredJobs + ' interrupted AI job(s)');

        await startTelegramServices();

        if (!(await runtimeLockIsSafe())) {
          await stopTelegramServicesForRecovery();
          continue;
        }

        startupInProgress = false;
        process.emit('boss:runtime-ready');
        console.log('اكتمل التشغيل الأولي لخدمات Telegram.');
        return;

      } catch (startupError) {
        await stopTelegramServicesForRecovery();

        const lockStillHeld = await isTelegramRuntimeLockHeld().catch(() => false);
        console.error(
          'TELEGRAM SERVICE STARTUP FAILED; retrying in 5 seconds:',
          startupError.message
        );

        if (runtimeRecoveryRequested || !lockStillHeld) {
          runtimeRecoveryRequested = false;
        }

        await recoveryDelay(5000);
      }
    }

    if (shuttingDown) return;

  } finally {
    startupInProgress = false;

    // Close the narrow race where the lock is lost as startup is completing.
    if (runtimeRecoveryRequested && !shuttingDown && !runtimeRecoveryPromise) {
      void recoverTelegramRuntime(
        new Error('Runtime lock loss detected while startup was completing')
      );
    }
  }
}

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.emit('boss:runtime-stopping', signal);

  console.log('Shutting down Telegram runtime:', signal);

  try {
    await stopIntakeBot();
  } catch (err) {
    console.error('INTAKE BOT STOP ERROR:', err.message);
  }

  try {
    await bot.stop();
  } catch (err) {
    console.error('MASTER BOT STOP ERROR:', err.message);
  }

  if (!CUSTOMER_BOT_WORKER_MODE) {
    try {
      await stopBotRuntime();
    } catch (err) {
      console.error('CUSTOMER BOTS STOP ERROR:', err.message);
    }
  }

  try {
    await releaseTelegramRuntimeLock();
  } catch (err) {
    console.error('RUNTIME LOCK RELEASE ERROR:', err.message);
  }

  try {
    await pool.end();
  } catch (err) {
    console.error('DATABASE SHUTDOWN ERROR:', err.message);
  }

  process.exit(exitCode);
}

async function startRuntime() {
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  return start().catch(async (err) => {
    console.error(
      'فشل تشغيل قاعدة البيانات أو البوت:',
      err.message
    );

    await shutdown('STARTUP_ERROR', 1);
  });
}

async function createWebhookRuntime() {
  let stopped = false;
  await bot.init();
  return {
    handleUpdate(update) {
      if (stopped) throw new Error('Master webhook runtime is stopped');
      if (!update || typeof update !== 'object' || Array.isArray(update) ||
          !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
        throw new TypeError('A valid Telegram update is required');
      }
      if (typeof bot.handleUpdate !== 'function') {
        throw new TypeError('The configured master bot does not support handleUpdate');
      }
      return bot.handleUpdate(update);
    },
    async stop() {
      stopped = true;
    }
  };
}

let webhookResourcesClosePromise = null;
async function closeWebhookResources() {
  if (!webhookResourcesClosePromise) {
    webhookResourcesClosePromise = (async () => {
      try {
        await releaseTelegramRuntimeLock();
      } finally {
        await pool.end();
      }
    })();
  }
  return webhookResourcesClosePromise;
}

return { bot, start: startRuntime, shutdown, createWebhookRuntime, closeWebhookResources };
}

module.exports = { createMasterRuntime };

if (require.main === module) {
  const runtime = createMasterRuntime();
  void runtime.start();
}
