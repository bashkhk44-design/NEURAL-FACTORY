'use strict';

function createIntakeRuntime({ dependencies = null, createBot = null } = {}) {
  const runtimeDependencies = dependencies || (() => {
    const { Bot, InlineKeyboard } = require('grammy');
    const { pool } = require('./db');
    const projectDb = require('./project-db');
    const aiIntake = require('./ai-intake');
    return { Bot, InlineKeyboard, pool, ...projectDb, ...aiIntake };
  })();

  const {
    Bot,
    InlineKeyboard,
    pool,
    createClientProjectWithSession,
    setProjectBusinessType,
    updateProjectName,
    updateClientProjectStatus,
    addConversationMessage,
    getIntakeSession,
    getProjectConversation,
    saveIntakeSession,
    deleteIntakeSession,
    approveProjectSpec,
    processIntakeTurn,
    advanceFallbackIntake
  } = runtimeDependencies;

  for (const name of [
    'Bot', 'InlineKeyboard', 'pool', 'createClientProjectWithSession',
    'setProjectBusinessType', 'updateProjectName', 'updateClientProjectStatus',
    'addConversationMessage', 'getIntakeSession', 'getProjectConversation',
    'saveIntakeSession', 'deleteIntakeSession', 'approveProjectSpec',
    'processIntakeTurn', 'advanceFallbackIntake'
  ]) {
    if (!runtimeDependencies[name]) {
      throw new TypeError('Missing intake runtime dependency: ' + name);
    }
  }

  const botFactory = createBot || ((token) => new Bot(token, { client: { timeoutSeconds: 45 } }));

  let intakeBot = null;
  let pollingPromise = null;
  let intakeReadyPromise = null;
  let intakeStopping = false;
  let intakeMode = null;


const TYPES = [
  ['restaurant', '🍽️ مطعم'],
  ['store', '🛍️ متجر'],
  ['games', '🎮 ألعاب ومسابقات'],
  ['booking', '📅 حجوزات'],
  ['services', '🛠️ خدمات'],
  ['support', '💬 خدمة عملاء'],
  ['payments', '💳 مدفوعات'],
  ['other', '✨ نشاط آخر']
];

async function saveMessage(userId, projectId, role, content, updateId = null) {
  await addConversationMessage({
    telegramUserId: userId,
    projectId,
    role,
    content,
    metadata: updateId === null || updateId === undefined
      ? {}
      : { telegram_update_id: String(updateId) }
  });
}

async function replySaved(ctx, session, text, extra = {}) {
  await saveMessage(
    ctx.from.id,
    session.project_id,
    'assistant',
    text,
    ctx.update?.update_id
  );

  return ctx.reply(text, extra);
}

function typeKeyboard() {
  const keyboard = new InlineKeyboard();

  TYPES.forEach(([key, label], index) => {
    keyboard.text(label, `type:${key}`);
    if (index % 2 === 1) keyboard.row();
  });

  return keyboard;
}

function reviewKeyboard() {
  return new InlineKeyboard()
    .text('✅ اعتماد المواصفات', 'review:approve')
    .row()
    .text('✏️ تعديل المواصفات', 'review:edit')
    .row()
    .text('❌ إلغاء الطلب', 'review:cancel');
}

function editFieldsKeyboard() {
  return new InlineKeyboard()
    .text('📌 اسم المشروع', 'edit:field:projectName')
    .text('🏢 نوع النشاط', 'edit:field:businessType')
    .row()
    .text('📝 فكرة المشروع', 'edit:field:description')
    .row()
    .text('⚙️ الميزات', 'edit:field:features')
    .text('🔘 الأزرار', 'edit:field:buttons')
    .row()
    .text('💳 الدفع', 'edit:field:payments')
    .row()
    .text('🌐 اللغات والتصميم', 'edit:field:languagesDesign')
    .row()
    .text('➕ الإضافات', 'edit:field:extra')
    .row()
    .text('⬅️ العودة للملخص', 'edit:back');
}

function typeName(key) {
  return TYPES.find(item => item[0] === key)?.[1] || key;
}

function buildSummary(data) {
  return [
    '📋 ملخص مشروعك في BOSS BOT MASTER',
    '',
    `📌 اسم المشروع: ${data.projectName || 'غير محدد'}`,
    `🏢 نوع النشاط: ${typeName(data.businessType)}`,
    '📱 قناة الاستقبال الأساسية: تيليغرام',
    '',
    `📝 فكرة المشروع:\n${data.description || 'غير محدد'}`,
    '',
    `⚙️ الميزات المطلوبة:\n${data.features || 'غير محدد'}`,
    '',
    `🔘 الأزرار والقوائم:\n${data.buttons || 'غير محدد'}`,
    '',
    `💳 الدفع:\n${data.payments || 'غير محدد'}`,
    '',
    `🌐 اللغات والتصميم:\n${data.languagesDesign || 'غير محدد'}`,
    '',
    `➕ إضافات أخرى:\n${data.extra || 'لا يوجد'}`,
    '',
    'راجع التفاصيل جيداً. لن نعتمد المواصفات إلا بعد موافقتك.'
  ].join('\n');
}

async function askNext(ctx, session) {
  const prompts = {
    description:
      '📝 اشرح لنا فكرة مشروعك: ماذا تريد أن يقدم البوت للعملاء؟',

    features:
      '⚙️ ما الميزات والوظائف التي تريدها؟ اذكر كل ما يخطر ببالك.',

    buttons:
      '🔘 ما الأزرار والقوائم التي تريد ظهورها للعميل؟',

    payments:
      '💳 هل تريد نظام دفع أو تحويلات؟ اشرح الطريقة المطلوبة، أو اكتب: لا يوجد.',

    languagesDesign:
      '🎨 ما اللغات والألوان والتصميم الذي تفضله؟ اذكر التفاصيل أو اكتب: لا يوجد.',

    extra:
      '➕ هل هناك شروط أو تفاصيل إضافية؟ اكتبها أو أرسل: لا يوجد.'
  };

  if (session.step === 'business_type') {
    await replySaved(
      ctx,
      session,
      '🏢 ما نوع النشاط الذي تريد إنشاء البوت له؟',
      { reply_markup: typeKeyboard() }
    );
    return;
  }

  if (session.step === 'edit_menu') {
    await replySaved(
      ctx,
      session,
      '✏️ اختر القسم الذي تريد تعديله:',
      { reply_markup: editFieldsKeyboard() }
    );
    return;
  }

  if (session.step === 'correction') {
    await replySaved(
      ctx,
      session,
      '✏️ اكتب التعديل الذي تريد إضافته أو تصحيحه في مواصفات المشروع.'
    );
    return;
  }

  if (session.step === 'review') {
    const summary = buildSummary(session.data);
    await replySaved(ctx, session, summary, {
      reply_markup: reviewKeyboard()
    });
    return;
  }

  const prompt = prompts[session.step];

  if (prompt) {
    await replySaved(ctx, session, prompt);
  }
}

async function runInteractiveIntake(ctx, session, userMessage = '') {
  if (session.data?.aiFallback) {
    const result = advanceFallbackIntake(session.data, userMessage);
    const nextStep = result.readyForReview ? 'review' : 'ai_intake';
    await saveIntakeSession({ telegramUserId: ctx.from.id, projectId: session.project_id, step: nextStep, data: result.data });
    await saveMessage(ctx.from.id, session.project_id, 'assistant', result.assistantMessage);
    if (result.readyForReview) {
      await ctx.reply('اكتمل جمع المتطلبات دون الاعتماد على المحلل الذكي. هذا ملخص طلبك:');
      await askNext(ctx, { ...session, step: 'review', data: result.data });
    } else {
      await ctx.reply(result.assistantMessage);
    }
    return;
  }

  try {
    const history = await getProjectConversation(ctx.from.id, session.project_id);
    const result = await processIntakeTurn({
      project: {
        project_id: session.project_id,
        project_name: session.data.projectName,
        business_type: session.data.businessType
      },
      currentData: session.data || {},
      userMessage,
      history
    });

    const missingItems = result.missingItems || [];
    const readyForReview = result.readyForReview && missingItems.length === 0;
    const data = {
      ...result.data,
      aiIntakeTurns: (Number(session.data?.aiIntakeTurns) || 0) + (userMessage ? 1 : 0),
      aiIntakeMissing: missingItems
    };
    const nextStep = readyForReview ? 'review' : 'ai_intake';

    await saveIntakeSession({
      telegramUserId: ctx.from.id,
      projectId: session.project_id,
      step: nextStep,
      data
    });

    await saveMessage(
      ctx.from.id,
      session.project_id,
      'assistant',
      result.assistantMessage
    );

    if (readyForReview) {
      await ctx.reply('✅ اكتمل جمع المتطلبات بمساعدة AI ANALYST. هذا ملخص طلبك للمراجعة:');
      await askNext(ctx, { ...session, step: 'review', data });
      return;
    }

    await ctx.reply(result.assistantMessage);
  } catch (error) {
    console.error('INTERACTIVE AI INTAKE ERROR:', error.message);
    const fallback = advanceFallbackIntake(
      { ...(session.data || {}), aiFallback: true },
      userMessage
    );
    await saveIntakeSession({ telegramUserId: ctx.from.id, projectId: session.project_id, step: 'ai_intake', data: fallback.data });
    const notice = '⚠️ المحلل الذكي غير متاح مؤقتاً بسبب حد الاستخدام أو مشكلة اتصال. حفظنا إجابتك وسنكمل جمع المواصفات بأسئلة واضحة دون فقدان ما سبق.\n\n';
    await saveMessage(ctx.from.id, session.project_id, 'assistant', notice + fallback.assistantMessage);
    await ctx.reply(notice + fallback.assistantMessage);
  }
}

async function beginProject(ctx) {
  const userId = ctx.from.id;
  const session = await getIntakeSession(userId);

  if (session) {
    await pool.query(
      `UPDATE client_projects p
       SET status = 'cancelled', updated_at = NOW()
       FROM clients c
       WHERE p.client_id = c.id
         AND p.id = $1
         AND c.telegram_user_id = $2
         AND p.status = 'collecting_requirements'`,
      [session.project_id, String(userId)]
    );

    await deleteIntakeSession(userId);
  }

  await ctx.reply(
    '🚀 لنبدأ إنشاء مشروعك الجديد.\n\nما اسم المشروع أو النشاط الذي تريد إنشاء بوت له؟'
  );
}

function createWebhookAdapter(bot) {
  return {
    handleUpdate(update) {
      if (!update || typeof update !== 'object' || Array.isArray(update) ||
          !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
        throw new TypeError('A valid Telegram update is required');
      }
      if (typeof bot.handleUpdate !== 'function') {
        throw new TypeError('The configured intake bot does not support handleUpdate');
      }
      return bot.handleUpdate(update);
    },
    async stop() {
      if (intakeBot === bot && intakeMode === 'webhook') {
        intakeBot = null;
        pollingPromise = null;
        intakeReadyPromise = null;
        intakeMode = null;
        intakeStopping = false;
      }
    }
  };
}

async function startIntakeBot(notifyAdmin = null, onFatal = null, options = {}) {
  const mode = options.mode === 'webhook' ? 'webhook' : 'polling';
  if (options.mode !== undefined && !['polling', 'webhook'].includes(options.mode)) {
    throw new TypeError('Intake runtime mode must be polling or webhook');
  }
  const token = options.token || process.env.INTAKE_BOT_TOKEN;

  if (!token) {
    if (mode === 'webhook') {
      throw new Error('An intake bot token is required for webhook mode');
    }
    console.log('Intake bot disabled: INTAKE_BOT_TOKEN is not configured');
    return null;
  }

  if (intakeBot) {
    if (intakeMode !== mode) {
      throw new Error('Intake bot is already initialized in ' + intakeMode + ' mode');
    }
    if (mode === 'polling' && intakeReadyPromise) await intakeReadyPromise;
    return mode === 'webhook' ? createWebhookAdapter(intakeBot) : intakeBot;
  }

  intakeBot = botFactory(token);
  intakeMode = mode;

  intakeBot.command('start', async (ctx) => {
    let session = await getIntakeSession(ctx.from.id);

    if (session) {
      const data = { ...(session.data || {}), platform: 'telegram' };
      const step = session.step === 'platform' ? 'description' : session.step;

      if (session.step !== step || session.data?.platform !== 'telegram') {
        session = { ...session, step, data };

        await saveIntakeSession({
          telegramUserId: ctx.from.id,
          projectId: session.project_id,
          step,
          data
        });
      }

      await ctx.reply(
        'أهلاً بعودتك إلى BOSS BOT MASTER 👋\nوجدنا طلبك السابق وسنكمل من حيث توقفت.'
      );

      if (session.step === 'ai_intake') {
        await runInteractiveIntake(ctx, session, '');
        return;
      }

      await askNext(ctx, session);
      return;
    }

    const keyboard = new InlineKeyboard()
      .text('🚀 ابدأ مشروعك', 'start:new')
      .row()
      .text('📚 خدماتنا', 'start:services');

    await ctx.reply(
      '👑 أهلاً بك في BOSS BOT MASTER\n\n' +
      'منصتك لتصميم وتطوير وإدارة البوتات المخصصة للأنشطة التجارية والخدمية.\n\n' +
      'نساعدك على تحويل فكرتك إلى مشروع منظم، مع جمع المتطلبات ومراجعتها واعتمادها قبل البدء بالتنفيذ.\n\n' +
      'اختر ما تريد:',
      { reply_markup: keyboard }
    );
  });

  intakeBot.command('new', beginProject);

  intakeBot.command('services', async (ctx) => {
    await ctx.reply(
      '📚 خدمات BOSS BOT MASTER\n\n' +
      '🎮 بوتات الألعاب والمسابقات والنقاط والترتيب.\n' +
      '🍽️ بوتات المطاعم والطلبات والمنيو.\n' +
      '🛍️ بوتات المتاجر والمنتجات والمبيعات.\n' +
      '📅 بوتات الحجوزات والمواعيد.\n' +
      '🛠️ بوتات الخدمات وإدارة العملاء.\n' +
      '💬 بوتات الدعم وخدمة العملاء.\n' +
      '💳 تكاملات الدفع المناسبة عند توفر مزود معتمد.\n' +
      '🌐 دعم تعدد اللغات والعملات حسب متطلبات المشروع.\n\n' +
      'يمر كل مشروع بجمع المتطلبات ومراجعتها واعتمادها، ثم مراحل التصميم والبناء والاختبار والتسليم بحسب الإمكانيات والتكاملات المفعّلة.'
    );
  });

  intakeBot.callbackQuery('start:services', async (ctx) => {
    await ctx.answerCallbackQuery();

    await ctx.reply(
      '📚 خدماتنا تشمل:\n\n' +
      '🎮 الألعاب والمسابقات\n' +
      '🍽️ المطاعم والطلبات\n' +
      '🛍️ المتاجر والمبيعات\n' +
      '📅 الحجوزات\n' +
      '🛠️ الخدمات\n' +
      '💬 خدمة العملاء\n' +
      '💳 تكاملات الدفع\n\n' +
      'يمكنك بدء طلبك من زر ابدأ مشروعك.'
    );
  });

  intakeBot.callbackQuery('start:new', async (ctx) => {
    await ctx.answerCallbackQuery();
    await beginProject(ctx);
  });

  intakeBot.callbackQuery(/^type:(.+)$/, async (ctx) => {
    const session = await getIntakeSession(ctx.from.id);

    if (!session || !['business_type', 'edit_business_type'].includes(session.step)) {
      await ctx.answerCallbackQuery({
        text: 'انتهت هذه الخطوة. أرسل /start للمتابعة.'
      });
      return;
    }

    const businessType = ctx.match[1];
    const data = { ...session.data, businessType, platform: 'telegram' };

    await setProjectBusinessType({
      telegramUserId: ctx.from.id,
      projectId: session.project_id,
      businessType
    });

    const editing = session.step === 'edit_business_type';
    const nextStep = editing ? 'review' : 'ai_intake';

    await saveIntakeSession({
      telegramUserId: ctx.from.id,
      projectId: session.project_id,
      step: nextStep,
      data
    });

    await saveMessage(
      ctx.from.id,
      session.project_id,
      'client',
      `نوع النشاط: ${typeName(businessType)}`
    );

    await ctx.answerCallbackQuery();

    const nextSession = { ...session, step: nextStep, data };
    if (editing) {
      await askNext(ctx, nextSession);
    } else {
      await runInteractiveIntake(ctx, nextSession, '');
    }
  });

  intakeBot.callbackQuery(/^platform:(.+)$/, async (ctx) => {
    const session = await getIntakeSession(ctx.from.id);

    if (!session || session.step !== 'platform') {
      await ctx.answerCallbackQuery({
        text: 'انتهت هذه الخطوة. أرسل /start للمتابعة.'
      });
      return;
    }

    // الأزرار القديمة لا تغيّر المنصة: النظام أصبح Telegram فقط.
    const platform = 'telegram';
    const data = { ...session.data, platform };

    await saveIntakeSession({
      telegramUserId: ctx.from.id,
      projectId: session.project_id,
      step: 'description',
      data
    });

    await saveMessage(
      ctx.from.id,
      session.project_id,
      'client',
      'المنصة: تيليغرام فقط'
    );

    await ctx.answerCallbackQuery();

    const nextSession = {
      ...session,
      step: 'description',
      data
    };

    await askNext(ctx, nextSession);
  });

  intakeBot.callbackQuery('review:approve', async (ctx) => {
    const session = await getIntakeSession(ctx.from.id);

    if (!session || session.step !== 'review') {
      await ctx.answerCallbackQuery({
        text: 'لا يوجد طلب جاهز للاعتماد.'
      });
      return;
    }

    try {
      const result = await approveProjectSpec({
        telegramUserId: ctx.from.id,
        projectId: session.project_id,
        spec: session.data
      });

      let adminNotified = false;

      if (notifyAdmin) {
        try {
          let adminMessage = [
            '📥 طلب مشروع جديد — يحتاج مراجعة الإدارة',
            '',
            `رقم المشروع: ${session.project_id}`,
            `اسم العميل: ${ctx.from.first_name || 'غير محدد'}`,
            `معرّف العميل: ${ctx.from.id}`,
            `حساب العميل: ${ctx.from.username ? '@' + ctx.from.username : 'غير متوفر'}`,
            '',
            buildSummary(session.data),
            '',
            `نسخة المواصفات المعتمدة: ${result.version}`
          ].join('\n');

          if (adminMessage.length > 3500) {
            adminMessage = adminMessage.slice(0, 3500) + '\n... تم اختصار بقية التفاصيل.';
          }

          const adminKeyboard = new InlineKeyboard()
            .text('🤖 إحالة إلى Gemini للتحليل', `project:ai:${session.project_id}`);

          await notifyAdmin({
            text: adminMessage,
            extra: { reply_markup: adminKeyboard }
          });
          adminNotified = true;
        } catch (notifyError) {
          console.error('ADMIN PROJECT NOTIFICATION ERROR:', notifyError.message);
        }
      }

      await ctx.answerCallbackQuery({
        text: 'تم اعتماد المواصفات'
      });

      await ctx.reply(
        `✅ تم اعتماد مواصفات مشروعك بنجاح.\n\nرقم المشروع: ${session.project_id}\nنسخة المواصفات: ${result.version}\n\n` +
        (adminNotified
          ? '📨 تم إرسال طلبك إلى الإدارة للمراجعة.'
          : 'تم حفظ طلبك، وسيتمكن المدير من مراجعته من قاعدة البيانات.')
      );
    } catch (error) {
      console.error('Project approval error:', error.message);
      await ctx.answerCallbackQuery({
        text: 'تعذر اعتماد الطلب، حاول لاحقاً.',
        show_alert: true
      });
    }
  });

  intakeBot.callbackQuery('review:edit', async (ctx) => {
    const session = await getIntakeSession(ctx.from.id);

    if (!session || session.step !== 'review') {
      await ctx.answerCallbackQuery({ text: 'لا يوجد طلب قابل للتعديل.' });
      return;
    }

    await saveIntakeSession({
      telegramUserId: ctx.from.id,
      projectId: session.project_id,
      step: 'edit_menu',
      data: session.data
    });

    await ctx.answerCallbackQuery();
    await askNext(ctx, { ...session, step: 'edit_menu' });
  });

  intakeBot.callbackQuery('edit:back', async (ctx) => {
    const session = await getIntakeSession(ctx.from.id);

    if (!session || session.step !== 'edit_menu') {
      await ctx.answerCallbackQuery({ text: 'انتهت جلسة التعديل.' });
      return;
    }

    await saveIntakeSession({
      telegramUserId: ctx.from.id,
      projectId: session.project_id,
      step: 'review',
      data: session.data
    });

    await ctx.answerCallbackQuery();
    await askNext(ctx, { ...session, step: 'review' });
  });

  intakeBot.callbackQuery(/^edit:field:(.+)$/, async (ctx) => {
    const session = await getIntakeSession(ctx.from.id);

    if (!session || session.step !== 'edit_menu') {
      await ctx.answerCallbackQuery({ text: 'انتهت جلسة التعديل.' });
      return;
    }

    const field = ctx.match[1];
    const allowed = [
      'projectName', 'businessType', 'description',
      'features', 'buttons', 'payments',
      'languagesDesign', 'extra'
    ];

    if (!allowed.includes(field)) {
      await ctx.answerCallbackQuery({ text: 'هذا القسم غير صالح.' });
      return;
    }

    const step = field === 'businessType' ? 'edit_business_type' : 'edit_' + field;

    await saveIntakeSession({
      telegramUserId: ctx.from.id,
      projectId: session.project_id,
      step,
      data: session.data
    });

    await ctx.answerCallbackQuery();

    if (field === 'businessType') {
      await ctx.reply(
        '🏢 اختر نوع النشاط الجديد:',
        { reply_markup: typeKeyboard() }
      );
      return;
    }

    const prompts = {
      projectName: '📌 اكتب اسم المشروع الجديد:',
      description: '📝 اكتب فكرة المشروع الجديدة:',
      features: '⚙️ اكتب الميزات المطلوبة بعد التعديل:',
      buttons: '🔘 اكتب الأزرار والقوائم المطلوبة:',
      payments: '💳 اكتب طريقة الدفع الجديدة، أو اكتب: لا يوجد.',
      languagesDesign: '🌐 اكتب اللغات والتصميم المطلوبين:',
      extra: '➕ اكتب الإضافات الجديدة، أو اكتب: لا يوجد.'
    };

    await ctx.reply(prompts[field]);
  });

  intakeBot.callbackQuery('review:cancel', async (ctx) => {
    const session = await getIntakeSession(ctx.from.id);

    if (session) {
      await updateClientProjectStatus({
        telegramUserId: ctx.from.id,
        projectId: session.project_id,
        status: 'cancelled'
      });
    }

    await deleteIntakeSession(ctx.from.id);
    await ctx.answerCallbackQuery({
      text: 'تم إلغاء جلسة الاستقبال.'
    });

    await ctx.reply(
      'تم إلغاء جلسة الطلب. إذا أردت البدء من جديد أرسل /new.'
    );
  });

  intakeBot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();

    if (!text || text.startsWith('/')) return;

    const userId = ctx.from.id;
    let session = await getIntakeSession(userId);

    if (!session) {
      const result = await createClientProjectWithSession({
        telegramUserId: userId,
        telegramUsername: ctx.from.username || null,
        firstName: ctx.from.first_name || null,
        name: text
      });

      session = result.session;

      if (!result.created) {
        await ctx.reply(
          'وجدنا طلبك السابق، سنكمل من حيث توقفت.'
        );
        await askNext(ctx, session);
        return;
      }

      await replySaved(
        ctx,
        session,
        '🏢 ما نوع النشاط الذي تريد إنشاء البوت له؟',
        { reply_markup: typeKeyboard() }
      );

      return;
    }

    if (session.step === 'business_type' || session.step === 'platform') {
      await ctx.reply('يرجى اختيار أحد الأزرار الظاهرة أمامك.');
      return;
    }

    if (!session.step.startsWith('edit_')) {
      await saveMessage(userId, session.project_id, 'client', text, ctx.update?.update_id);
    }

    if (session.step.startsWith('edit_')) {
      const field = session.step.slice(5);
      const data = { ...session.data };

      if (field === 'projectName') {
        await updateProjectName({
          telegramUserId: userId,
          projectId: session.project_id,
          name: text
        });
        data.projectName = text;
      } else {
        const editableFields = [
          'description', 'features', 'buttons',
          'payments', 'languagesDesign', 'extra'
        ];

        if (!editableFields.includes(field)) {
          await ctx.reply('تعذر تحديد القسم. أرسل /start للمتابعة.');
          return;
        }

        data[field] = text;
      }

      await saveIntakeSession({
        telegramUserId: userId,
        projectId: session.project_id,
        step: 'review',
        data
      });

      await saveMessage(userId, session.project_id, 'client', text);

      await saveMessage(
        userId,
        session.project_id,
        'system',
        'تم تعديل الحقل: ' + field
      );

      await ctx.reply('✅ تم حفظ التعديل في المواصفات.');
      await askNext(ctx, { ...session, step: 'review', data });
      return;
    }

    if (session.step === 'ai_intake') {
      await runInteractiveIntake(ctx, session, text);
      return;
    }

    if (session.step === 'correction') {
      const data = {
        ...session.data,
        extra: [session.data.extra, 'تعديل العميل: ' + text]
          .filter(Boolean)
          .join('\n')
      };

      await saveIntakeSession({
        telegramUserId: userId,
        projectId: session.project_id,
        step: 'review',
        data
      });

      session = { ...session, step: 'review', data };
      await askNext(ctx, session);
      return;
    }

    const nextSteps = {
      description: 'features',
      features: 'buttons',
      buttons: 'payments',
      payments: 'languagesDesign',
      languagesDesign: 'extra',
      extra: 'review'
    };

    const fields = {
      description: 'description',
      features: 'features',
      buttons: 'buttons',
      payments: 'payments',
      languagesDesign: 'languagesDesign',
      extra: 'extra'
    };

    const nextStep = nextSteps[session.step];

    if (!nextStep) {
      await ctx.reply('أرسل /start للعودة إلى طلبك.');
      return;
    }

    const data = {
      ...session.data,
      [fields[session.step]]: text
    };

    await saveIntakeSession({
      telegramUserId: userId,
      projectId: session.project_id,
      step: nextStep,
      data
    });

    session = {
      ...session,
      step: nextStep,
      data
    };

    await askNext(ctx, session);
  });

  intakeBot.catch((err) => {
    console.error('Intake bot error:', err.message);
  });

  const currentBot = intakeBot;
  intakeStopping = false;

  if (mode === 'webhook') {
    try {
      await currentBot.init();
      return createWebhookAdapter(currentBot);
    } catch (error) {
      if (intakeBot === currentBot) {
        intakeBot = null;
        pollingPromise = null;
        intakeReadyPromise = null;
        intakeMode = null;
      }
      throw error;
    }
  }

  let resolveReady;
  let rejectReady;
  let ready = false;

  intakeReadyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const reportFatal = (err) => {
    if (intakeStopping || intakeBot !== currentBot) return;
    if (typeof onFatal !== 'function') return;

    Promise.resolve()
      .then(() => onFatal(err))
      .catch(error => {
        console.error('INTAKE FATAL HANDLER ERROR:', error.message);
      });
  };

  pollingPromise = currentBot.start({
    onStart: (info) => {
      ready = true;
      console.log(`BOSS CLIENT INTAKE BOT يعمل: @${info.username}`);
      resolveReady(currentBot);
    }
  });

  pollingPromise.then(() => {
    if (ready) {
      reportFatal(new Error('Intake bot polling stopped unexpectedly'));
    }
  }).catch((err) => {
    console.error('INTAKE BOT POLLING ERROR:', err.message);

    if (!ready) {
      rejectReady(err);
    } else {
      reportFatal(err);
    }
  });

  try {
    await intakeReadyPromise;
    return currentBot;
  } catch (err) {
    intakeStopping = true;

    try {
      await currentBot.stop();
    } catch (_) {}

    if (intakeBot === currentBot) {
      intakeBot = null;
      pollingPromise = null;
      intakeReadyPromise = null;
      intakeMode = null;
    }

    throw err;
  }
}

async function stopIntakeBot() {
  const currentBot = intakeBot;
  if (!currentBot) return;

  if (intakeMode === 'webhook') {
    intakeBot = null;
    pollingPromise = null;
    intakeReadyPromise = null;
    intakeMode = null;
    intakeStopping = false;
    return;
  }

  intakeStopping = true;

  try {
    await currentBot.stop();
  } catch (error) {
    console.error('INTAKE BOT STOP ERROR:', error.message);
  }

  const currentPolling = pollingPromise;
  if (currentPolling) {
    try {
      await currentPolling;
    } catch (_) {}
  }

  if (intakeBot === currentBot) {
    intakeBot = null;
    pollingPromise = null;
    intakeReadyPromise = null;
    intakeMode = null;
  }
}

async function createWebhookRuntime({ token, notifyAdmin = null } = {}) {
  return startIntakeBot(notifyAdmin, null, { mode: 'webhook', token });
}

  return { startIntakeBot, stopIntakeBot, createWebhookRuntime };
}

let defaultRuntime = null;

function getDefaultRuntime() {
  if (!defaultRuntime) defaultRuntime = createIntakeRuntime();
  return defaultRuntime;
}

async function startIntakeBot(...args) {
  return getDefaultRuntime().startIntakeBot(...args);
}

async function createIntakeWebhookRuntime(options = {}) {
  return getDefaultRuntime().createWebhookRuntime(options);
}

async function stopIntakeBot(...args) {
  if (!defaultRuntime) return;
  return defaultRuntime.stopIntakeBot(...args);
}

module.exports = {
  createIntakeRuntime,
  startIntakeBot,
  stopIntakeBot,
  createIntakeWebhookRuntime
};
