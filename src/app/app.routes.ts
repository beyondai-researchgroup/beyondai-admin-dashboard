import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';
import { superAdminGuard } from './guards/superadmin.guard';

export const routes: Routes = [
  { path: '', redirectTo: 'login', pathMatch: 'full' },
  {
    path: 'login',
    loadComponent: () => import('./login/login.component').then((m) => m.LoginComponent),
  },
  {
    path: 'accept-invite/:token',
    loadComponent: () =>
      import('./accept-invite/accept-invite.component').then((m) => m.AcceptInviteComponent),
  },
  {
    path: 'accept-team-invite/:token',
    loadComponent: () =>
      import('./accept-team-invite/accept-team-invite.component').then((m) => m.AcceptTeamInviteComponent),
  },
  {
    path: '',
    loadComponent: () =>
      import('./shell/dashboard-shell.component').then((m) => m.DashboardShellComponent),
    canActivate: [authGuard],
    children: [
      {
        path: 'overview',
        loadComponent: () => import('./overview/overview.component').then((m) => m.OverviewComponent),
      },
      {
        path: 'participants',
        loadComponent: () =>
          import('./participants/participants-list.component').then((m) => m.ParticipantsListComponent),
      },
      {
        path: 'participants/:id',
        loadComponent: () =>
          import('./participants/participant-detail.component').then((m) => m.ParticipantDetailComponent),
      },
      {
        path: 'import',
        loadComponent: () =>
          import('./participants/participant-import.component').then((m) => m.ParticipantImportComponent),
      },
      {
        path: 'task-config',
        loadComponent: () => import('./task-config/task-config.component').then((m) => m.TaskConfigComponent),
      },
      {
        path: 'configuration',
        loadComponent: () =>
          import('./configuration/configuration.component').then((m) => m.ConfigurationComponent),
      },
      {
        path: 'profile',
        loadComponent: () => import('./profile/profile.component').then((m) => m.ProfileComponent),
      },
      {
        path: 'consent-form',
        loadComponent: () =>
          import('./consent-form/consent-form.component').then((m) => m.ConsentFormComponent),
      },
      {
        path: 'demographic-questions',
        loadComponent: () =>
          import('./demographic-questions/demographic-questions.component').then(
            (m) => m.DemographicQuestionsComponent
          ),
      },
      {
        path: 'experimental-sessions',
        loadComponent: () =>
          import('./experimental-sessions/experimental-sessions-list.component').then(
            (m) => m.ExperimentalSessionsListComponent
          ),
      },
      {
        path: 'experimental-sessions/:id',
        loadComponent: () =>
          import('./experimental-sessions/experimental-session-detail.component').then(
            (m) => m.ExperimentalSessionDetailComponent
          ),
      },
      {
        path: 'calendar',
        loadComponent: () => import('./calendar/calendar.component').then((m) => m.CalendarComponent),
      },
      {
        path: 'protocol',
        loadComponent: () => import('./protocol/protocol.component').then((m) => m.ProtocolComponent),
      },
      {
        path: 'design',
        loadComponent: () =>
          import('./research-design/research-design-page.component').then((m) => m.ResearchDesignPageComponent),
      },
      {
        path: 'study-wizard',
        loadComponent: () => import('./study-wizard/study-wizard.component').then((m) => m.StudyWizardComponent),
        canActivate: [superAdminGuard],
      },
      {
        path: 'protocol-participants',
        loadComponent: () =>
          import('./protocol-participants/protocol-participants.component').then((m) => m.ProtocolParticipantsComponent),
      },
      {
        path: 'protocol-participants/:id',
        loadComponent: () =>
          import('./protocol-participants/protocol-participant-detail.component').then((m) => m.ProtocolParticipantDetailComponent),
      },
      {
        path: 'questionnaires',
        loadComponent: () => import('./questionnaires/questionnaires.component').then((m) => m.QuestionnairesComponent),
      },
      {
        path: 'researches',
        loadComponent: () =>
          import('./researches/researches-manage.component').then((m) => m.ResearchesManageComponent),
        canActivate: [superAdminGuard],
      },
      {
        path: 'researchers',
        loadComponent: () =>
          import('./researchers/researchers-manage.component').then((m) => m.ResearchersManageComponent),
        canActivate: [superAdminGuard],
      },
      {
        path: 'results/tlx',
        loadComponent: () => import('./results/results-tlx.component').then((m) => m.ResultsTlxComponent),
      },
      {
        path: 'results/rei40',
        loadComponent: () => import('./results/results-rei40.component').then((m) => m.ResultsRei40Component),
      },
      {
        path: 'results/bigfive',
        loadComponent: () =>
          import('./results/results-bigfive.component').then((m) => m.ResultsBigFiveComponent),
      },
      {
        path: 'results/r-analysis',
        loadComponent: () =>
          import('./results/results-r-analysis/results-r-analysis.component').then(
            (m) => m.ResultsRAnalysisComponent
          ),
      },
      {
        path: 'results/generic-task',
        loadComponent: () =>
          import('./results/results-generic-task/results-generic-task.component').then(
            (m) => m.ResultsGenericTaskComponent
          ),
      },
      {
        path: 'sheets',
        loadComponent: () => import('./sheets/sheets.component').then((m) => m.SheetsComponent),
      },
      {
        path: 'results/questionnaires',
        loadComponent: () =>
          import('./results/results-questionnaires/results-questionnaires.component').then((m) => m.ResultsQuestionnairesComponent),
      },
      {
        path: 'results/demographic',
        loadComponent: () =>
          import('./results/results-demographic/results-demographic.component').then(
            (m) => m.ResultsDemographicComponent
          ),
      },
      { path: '', redirectTo: 'overview', pathMatch: 'full' },
    ],
  },
  { path: '**', redirectTo: 'login' },
];
