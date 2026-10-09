// Admin Dashboard API server. Standalone Node/Express backend (same @neondatabase/serverless
// pattern as rei40-andrejkatin/bigfive-andrejkatin's server.mjs), reading/writing the same
// shared Neon database. Unlike those two, this one has real auth (JWT) and role-based scoping —
// see server/scope.mjs for the one rule every participants/results route must follow.
import express from 'express';
import cors from 'cors';
import authRoutes from './auth/routes.mjs';
import researchesRoutes from './researches/routes.mjs';
import researchersRoutes from './researchers/routes.mjs';
import researchersDirectoryRoutes from './researchers/directory.mjs';
import participantsRoutes from './participants/routes.mjs';
import resultsRoutes from './results/routes.mjs';
import resultsExportRoutes from './results-export/routes.mjs';
import eegRoutes from './eeg/routes.mjs';
import activityLogRoutes from './activity-log/routes.mjs';
import studyConfigRoutes from './study-config/routes.mjs';
import consentSectionsRoutes from './consent-sections/routes.mjs';
import demographicQuestionsRoutes from './demographic-questions/routes.mjs';
import demographicResultsRoutes from './demographic-results/routes.mjs';
import consentFormMailingListRoutes from './consent-form/mailing-list.mjs';
import taskConfigRoutes from './task-config/routes.mjs';
import taskFormQuestionsRoutes from './task-config/form-questions.mjs';
import taskFilesRoutes from './task-files/routes.mjs';
import genericTasksRoutes from './generic-tasks/routes.mjs';
import genericTaskResultsRoutes from './generic-task-results/routes.mjs';
import analysisRoutes from './analysis/routes.mjs';
import experimentalSessionsRoutes from './experimental-sessions/routes.mjs';
import calendarRoutes from './calendar/routes.mjs';
import googleFormsRoutes from './google-forms/routes.mjs';
import researcherInviteRoutes from './researcher-invite/routes.mjs';
import teamInviteRoutes from './team-invite/routes.mjs';
import researcherProfileRoutes from './researcher-profile/routes.mjs';
import notificationsRoutes from './notifications/routes.mjs';
import { startSessionReminderJob, runSessionReminderCheck } from './notifications/reminderJob.mjs';

const PORT = process.env.PORT || 4312;

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json());

app.use('/api/admin/auth', authRoutes);
app.use('/api/admin/researches', researchesRoutes);
// Mounted before researchersRoutes so its literal /directory path is matched first — same
// registration-order discipline this codebase has hit bugs over before (see e.g.
// experimental-sessions/routes.mjs's participant-session-notes/tags comments). Not that there's an
// actual collision here today (researchersRoutes has no GET /:id at all), but this keeps the two
// routers' relative order intentional rather than accidental.
app.use('/api/admin/researchers', researchersDirectoryRoutes);
app.use('/api/admin/researchers', researchersRoutes);
app.use('/api/admin/participants', participantsRoutes);
app.use('/api/admin/results', resultsRoutes);
app.use('/api/admin/results-export', resultsExportRoutes);
app.use('/api/admin/eeg', eegRoutes);
app.use('/api/admin/activity-log', activityLogRoutes);
app.use('/api/admin/study-config', studyConfigRoutes);
app.use('/api/admin/consent-sections', consentSectionsRoutes);
app.use('/api/admin/demographic-questions', demographicQuestionsRoutes);
app.use('/api/admin/demographic-results', demographicResultsRoutes);
app.use('/api/admin/consent-form', consentFormMailingListRoutes);
app.use('/api/admin/task-config', taskConfigRoutes);
app.use('/api/admin/task-config', taskFormQuestionsRoutes);
app.use('/api/admin/task-files', taskFilesRoutes);
app.use('/api/admin/generic-tasks', genericTasksRoutes);
app.use('/api/admin/generic-task-results', genericTaskResultsRoutes);
app.use('/api/admin/analysis', analysisRoutes);
app.use('/api/admin/experimental-sessions', experimentalSessionsRoutes);
app.use('/api/admin/calendar', calendarRoutes);
app.use('/api/admin/google-forms', googleFormsRoutes);
app.use('/api/admin/researcher-profile', researcherProfileRoutes);
app.use('/api/admin/notifications', notificationsRoutes);
// Public — not under /api/admin (no requireAuth possible, the researcher isn't logged in yet).
app.use('/api/researcher-invite', researcherInviteRoutes);
app.use('/api/team-invite', teamInviteRoutes);

// On Vercel the hourly in-process reminder timer can't run (functions don't stay alive), so Vercel
// Cron (vercel.json "crons") calls this once a day instead. Vercel sends
// "Authorization: Bearer <CRON_SECRET>"; anything else is refused. The check itself is idempotent
// (at most one SESSION_REMINDER per research per day), same as with the timer.
app.get('/api/cron/session-reminders', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.get('authorization') !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }
  await runSessionReminderCheck();
  res.json({ ok: true });
});

// On Vercel this app runs as a serverless function (api/index.mjs imports it) — only bind a port
// and start the in-process reminder timer when started directly for local dev.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Admin Dashboard API server listening on http://localhost:${PORT}`);
  });
  startSessionReminderJob();
}

export default app;
