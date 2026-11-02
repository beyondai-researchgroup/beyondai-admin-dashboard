import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { AuthService } from '../services/auth.service';
import { ScopeService } from '../services/scope.service';
import { ResearchesStoreService } from '../services/researches-store.service';
import { StudyConfigStoreService } from '../services/study-config-store.service';
import { SelectComponent, SelectOption } from '../shared/select/select.component';

@Component({
  selector: 'app-dashboard-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, TranslateModule, SelectComponent],
  templateUrl: './dashboard-shell.component.html',
  styleUrl: './dashboard-shell.component.scss',
})
export class DashboardShellComponent implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);
  private translate = inject(TranslateService);
  readonly store = inject(ResearchesStoreService);
  readonly scope = inject(ScopeService);

  // Results menu is configurable per research (2026-08-19) — which instrument items appear, and
  // the REI item's label, depend on that research's Study/Task Configuration. The actual data now
  // lives in the shared StudyConfigStoreService (2026-08-20 bug fix) instead of a private copy
  // here, so a Configuration-page save is reflected immediately without needing a research switch.
  private readonly lang = signal(this.translate.currentLang || 'sr');
  readonly studyConfigStore = inject(StudyConfigStoreService);
  // A PROTOCOL research (researcher-defined step list) shows a module's pages only when its protocol
  // contains that step; a CLASSIC research keeps the original per-switch behavior unchanged.
  readonly isProtocol = this.studyConfigStore.isProtocol;
  readonly showTlxResults = computed(() =>
    this.isProtocol() ? this.studyConfigStore.hasStep('NASA_TLX') : this.studyConfigStore.usesTlx());
  readonly showReiResults = computed(() =>
    this.isProtocol() ? this.studyConfigStore.hasStep('REI40') : this.studyConfigStore.usesPsychTests());
  readonly showBigFiveResults = computed(() =>
    this.isProtocol() ? this.studyConfigStore.hasStep('BIGFIVE') : this.studyConfigStore.usesPsychTests());
  readonly showConsentNav = computed(() =>
    this.isProtocol() ? this.studyConfigStore.hasStep('CONSENT') : this.studyConfigStore.usesConsentForm());
  // A PROTOCOL research gets the Task Configuration page when its experiment step wraps a Generic Task, a Google Form or
  // Code Review (the PR tasks); a table is configured in the sheets app.
  readonly showTaskConfigNav = computed(() =>
    !this.isProtocol() || ['GENERIC_TASK', 'GOOGLE_FORM', 'CODE_REVIEW'].includes(this.studyConfigStore.protocolTaskKind() ?? ''));
  readonly showRAnalysisResults = this.studyConfigStore.showRAnalysisResults;
  // Task-app submissions (2026-09-14) — download-only Results page, shown for a GENERIC-type
  // research the same way R analiza is shown for a GOOGLE_FORMS one (both derive off taskType).
  readonly showGenericTaskResults = computed(() => this.isProtocol()
    ? this.studyConfigStore.protocolTaskKind() === 'GENERIC_TASK'
    : this.studyConfigStore.taskType() === 'GENERIC');
  // Demographic Questionnaire (2026-10-01) — drives both the config-nav entry and the
  // Results-menu item; same underlying signal, usesDemographics fails closed on a fetch error.
  readonly showDemographicQuestionsNav = computed(() =>
    this.isProtocol() ? this.studyConfigStore.hasStep('DEMOGRAPHIC') : this.studyConfigStore.usesDemographics());
  readonly showDemographicResults = this.showDemographicQuestionsNav;
  /** Researcher-authored questionnaires exist only in a PROTOCOL research that has such a step. */
  readonly showQuestionnaireResults = computed(() => this.isProtocol() && this.studyConfigStore.hasStep('QUESTIONNAIRE'));
  readonly showResultsGroup = computed(() =>
    this.showTlxResults() || this.showReiResults() || this.showBigFiveResults() || this.showRAnalysisResults()
    || this.showGenericTaskResults() || this.showDemographicResults() || this.showQuestionnaireResults());

  readonly rei40NavLabel = computed(() => {
    this.lang();
    return this.studyConfigStore.rei40Variant() === 'short'
      ? this.translate.instant('NAV.RESULTS_REI40_SHORT')
      : this.translate.instant('NAV.RESULTS_REI40');
  });

  readonly researcher = this.auth.researcher;
  readonly isSuperAdmin = computed(() => this.researcher()?.isSuperAdmin ?? false);
  readonly researches = this.store.researches;

  // Superadmin picks from every research; a scoped researcher assigned to more than one picks
  // from just their own set (Phase B, 2026-08-18 — was always a single locked research before).
  readonly researchOptions = computed<SelectOption[]>(() => {
    if (this.isSuperAdmin()) {
      return this.researches().map((r) => ({ value: r.id, label: r.name }));
    }
    return (this.researcher()?.researches ?? []).map((r) => ({ value: r.id, label: r.name }));
  });

  readonly showPicker = computed(() => this.isSuperAdmin() || (this.researcher()?.researches.length ?? 0) > 1);

  constructor() {
    this.translate.onLangChange.subscribe((e) => this.lang.set(e.lang));
    toObservable(this.scope.selectedResearchId).subscribe((id) => {
      if (id != null) this.studyConfigStore.load(id);
    });
  }

  async ngOnInit(): Promise<void> {
    const r = this.researcher();
    if (!r) return;

    if (r.isSuperAdmin) {
      await this.store.ensureLoaded();
      const list = this.store.researches();
      if (this.scope.selectedResearchId() == null && list.length) {
        this.scope.select(list[0].id);
      }
    } else if (r.researches.length === 1) {
      // Exactly one assignment — same auto-select convenience as before Phase B, no picker
      // needed.
      this.scope.select(r.researches[0].id);
    } else if (r.researches.length > 1) {
      // Several assignments — default to the first, but let the picker below switch it.
      const current = this.scope.selectedResearchId();
      const stillValid = current != null && r.researches.some((res) => res.id === current);
      if (!stillValid) this.scope.select(r.researches[0].id);
    } else {
      this.scope.select(null);
    }
  }

  onResearchChange(value: string | number): void {
    this.scope.select(Number(value));
  }

  logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
