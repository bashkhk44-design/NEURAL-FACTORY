'use strict';

const {
  createProjectAiJob,
  getLatestCompletedProjectAiJob,
  getProjectApprovalState,
  startProjectAiJobAttempt,
  completeProjectAiJobAttempt,
  failProjectAiJobAttempt,
  acquireProjectPipelineLock,
  releaseProjectPipelineLock
} = require('./project-db');

const { getProjectSecretNames } = require('./project-db');
const { analyzeProject } = require('./gemini-analyst');
const { buildProject } = require('./ai-builder');
const { testProjectBundle } = require('./ai-tester');
const { fixProject, canAttemptFix } = require('./ai-fixer');
const { prepareDeployment } = require('./ai-deployer');
const { buildReleaseReport, createReleaseCandidate } = require('./project-release');

async function runStage({
  projectId,
  adminTelegramId,
  jobType,
  execute,
  onProgress,
  forceRetry = false
}) {
  const job = await createProjectAiJob({
    projectId,
    adminTelegramId,
    jobType
  });

  if (job.status === 'completed' && job.analysis && !forceRetry) {
    if (onProgress) {
      await onProgress('استخدام نتيجة المرحلة المحفوظة: ' + jobType);
    }
    return job.analysis;
  }

  if (job.status === 'running') {
    throw new Error('المرحلة قيد التنفيذ بالفعل: ' + jobType);
  }

  const attempt = await startProjectAiJobAttempt(job.id, {
    allowCompleted: forceRetry
  });

  if (!attempt) {
    throw new Error('تعذر بدء محاولة جديدة للمرحلة: ' + jobType);
  }

  try {
    if (onProgress) {
      await onProgress(
        'بدأت المرحلة: ' + jobType +
        ' | المحاولة رقم ' + attempt.attempt_no
      );
    }

    const result = await execute();

    const saved = await completeProjectAiJobAttempt(
      attempt.id,
      job.id,
      result
    );

    if (!saved) {
      throw new Error('تعذر حفظ نتيجة المرحلة: ' + jobType);
    }

    return result;
  } catch (error) {
    try {
      await failProjectAiJobAttempt(
        attempt.id,
        job.id,
        error.message
      );
    } catch (saveError) {
      console.error(
        'PIPELINE FAILURE SAVE ERROR:',
        saveError.message
      );
    }

    throw error;
  }
}

async function runProjectPipeline({
  project,
  adminTelegramId,
  onProgress
}) {
  if (!project || !project.project_id || !project.spec) {
    throw new Error('المشروع غير مكتمل أو لا يملك مواصفات معتمدة.');
  }

  const projectId = Number(project.project_id);

  const designJob = await getLatestCompletedProjectAiJob({
    projectId,
    jobType: 'design'
  });

  if (!designJob || Number(designJob.spec_version) !== Number(project.spec_version)) {
    throw new Error('يجب إكمال تصميم المشروع الحالي أولاً قبل التنفيذ.');
  }

  const approvals = await getProjectApprovalState({
    projectId,
    specVersion: project.spec_version,
    designJobId: designJob.id
  });

  if (!approvals?.construction_points_approved || !approvals?.design_approved) {
    throw new Error('التنفيذ محظور حتى اعتماد نقاط البناء ووثيقة التصميم من أزرار الاعتماد في بوت المدير.');
  }

  const lock = await acquireProjectPipelineLock(projectId);

  if (!lock) {
    throw new Error(
      'هناك عملية تنفيذ أخرى تعمل على هذا المشروع. انتظر حتى تنتهي.'
    );
  }

  try {
    const stage = (jobType, execute, options = {}) =>
      runStage({
        projectId,
        adminTelegramId,
        jobType,
        execute,
        onProgress,
        ...options
      });

    const analysis = await stage('analysis', () =>
      analyzeProject({ project })
    );

    const design = designJob.analysis;
    if (!design?.artifact ||
        Number(design.artifact.specVersion) !== Number(project.spec_version) ||
        !design.artifact.sourceFingerprint) {
      throw new Error('التصميم المعتمد لا يحتوي وثيقة منظمة مطابقة لإصدار المواصفات الحالي. أعد التصميم واعتماده قبل البناء.');
    }

    const build = await stage('build', () =>
      buildProject({ project, analysis, design }),
      { forceRetry: true }
    );

    const test = await stage('test', () =>
      testProjectBundle({ bundle: build, designArtifact: design.artifact }),
      { forceRetry: true }
    );

    let finalBundle = build;
    let finalTest = test;
    let fixResult = null;

    if (!test.passed && canAttemptFix(test)) {
      const previousFix = await getLatestCompletedProjectAiJob({
        projectId,
        jobType: 'fix'
      });

      const previousPostFixTest =
        await getLatestCompletedProjectAiJob({
          projectId,
          jobType: 'test_after_fix'
        });

      const previousFixResult = previousFix?.analysis || null;
      const previousPostFixResult =
        previousPostFixTest?.analysis || null;

      if (
        previousPostFixResult?.passed === true &&
        previousPostFixResult?.designFingerprint === design.artifact.sourceFingerprint &&
        previousFixResult?.bundle
      ) {
        if (onProgress) {
          await onProgress(
            'استخدام نتيجة الإصلاح والاختبار الناجحة المحفوظة.'
          );
        }

        fixResult = previousFixResult;
        finalBundle = fixResult.bundle;
        finalTest = previousPostFixResult;
      } else {
        const retryFix =
          previousFixResult?.passed === false ||
          previousPostFixResult?.passed === false;

        fixResult = await stage(
          'fix',
          () => fixProject({
            project,
            analysis,
            design,
            designArtifact: design.artifact,
            bundle: build,
            maxAttempts: 2
          }),
          { forceRetry: Boolean(retryFix) }
        );

        finalBundle = fixResult.bundle;

        if (!fixResult.passed && !canAttemptFix(fixResult.testResult)) {
          return {
            completed: false,
            projectId,
            stage: 'testing_environment',
            analysis,
            design,
            build,
            test,
            fixResult,
            finalTest: fixResult.testResult,
            summary: 'توقف الإصلاح لأن بيئة الاختبار لم تؤكد تنفيذ مجموعة الاختبارات بعد التعديل.'
          };
        }

        finalTest = await stage(
          'test_after_fix',
          async () => fixResult.testResult,
          { forceRetry: true }
        );
      }
    }

    if (!finalTest.passed) {
      return {
        completed: false,
        projectId,
        stage: 'testing',
        analysis,
        design,
        build,
        test,
        fixResult,
        finalTest,
        summary:
          'توقف التنفيذ لأن الاختبارات لم تنجح. لن يتم تجهيز النشر.'
      };
    }

    const deployment = await stage(
      'deploy_precheck',
      async () => {
        if (!project.telegram_user_id) {
          throw new Error('لا يوجد معرّف العميل الموثوق لهذا المشروع.');
        }

        const configuredEnvNames = await getProjectSecretNames({
          telegramUserId: project.telegram_user_id,
          projectId
        });

        return prepareDeployment({
          bundle: finalBundle,
          testResult: finalTest,
          approved: false,
          configuredEnvNames
        });
      },
      { forceRetry: true }
    );

    const releaseReport = buildReleaseReport({
      project,
      spec: project.spec,
      design,
      testResult: finalTest,
      deployment
    });
    const releaseCandidate = await createReleaseCandidate({
      project,
      designJobId: designJob.id,
      adminTelegramId,
      report: releaseReport,
      bundle: finalBundle
    });

    return {
      completed: true,
      projectId,
      analysis,
      design,
      build: finalBundle,
      test: finalTest,
      fixResult,
      deployment,
      releaseCandidate,
      releaseReport,
      deployed: false,
      summary:
        'اكتمل البناء والاختبار، وتم إنشاء إصدار ثابت بانتظار موافقة العميل ثم المدير. لم يتم النشر.'
    };
  } finally {
    await releaseProjectPipelineLock(lock, projectId);
  }
}

module.exports = { runProjectPipeline };
