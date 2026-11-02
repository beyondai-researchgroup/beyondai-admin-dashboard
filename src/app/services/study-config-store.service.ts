import { Injectable, computed, inject, signal } from '@angular/core';
import { AdminApiService } from './admin-api.service';

/**
 * Shared, injectable holder for the "Results menu" -relevant slice of a research's
 * Study/Task Configuration (2026-08-20 bug fix). Before this existed, `DashboardShellComponent`
 * fetched and cached this itself, refreshed only when `scope.selectedResearchId` changed — so
 * saving Configuration for the *currently selected* research left the sidebar showing stale
 * NASA-TLX/REI-40/Big Five/R analiza tabs until the researcher switched research and back (or
 * reloaded the page). Both `DashboardShellComponent` (reads) and `ConfigurationComponent`
 * (writes, then calls `refresh`) now share this one instance instead of keeping their own
 * copies, so a save is reflected immediately.
 *
 * Defaults fail open (all "shown") on a fetch error — mirrors the NASA-TLX app's own
 * `getTlxConfig` fallback precedent: never block a researcher out of a results page just because
 * a request hiccuped. `showRAnalysisResults` is the one exception, failing closed, since it's an
 * opt-in feature that shouldn't clutter the menu on an error.
 */
@Injectable({ providedIn: 'root' })
export class StudyConfigStoreService {
  private api = inject(AdminApiService);

  readonly usesTlx = signal(true);
  readonly usesPsychTests = signal(true);
  readonly rei40Variant = signal('v1');
  readonly showRAnalysisResults = signal(false);
  /** Drives Overview's Intro/AI/Report chart — that breakdown only makes sense for a PR-review
   *  research. Fails open to 'PR_REVIEW' on a fetch error, matching every other field here. */
  readonly taskType = signal('PR_REVIEW');
  /** Part C of the platform re-architecture (2026-09-07) — drives the Consent Form nav entry's
   *  visibility. Fails open to true (show it) on a fetch error, matching this store's convention
   *  of never hiding a page a researcher might need over a transient fetch hiccup. */
  readonly usesConsentForm = signal(true);
  /** 2026-09-08 follow-up — drives the Participants/Import/Experimental-Sessions nav entries'
   *  visibility. Fails open to true, same convention as every other field here. */
  readonly tracksParticipants = signal(true);
  /** Demographic Questionnaire (2026-10-01) — drives both the Demographic Questions nav entry and
   *  the Results-menu's Demographic item. Fails CLOSED to false on a fetch error, same exception
   *  as showRAnalysisResults — an opt-in feature nobody has necessarily configured yet shouldn't
   *  clutter the menu over a transient fetch hiccup. */
  readonly usesDemographics = signal(false);
  /** Excel-like tables (2026-10) — drives the "Tabele" nav entry. Fails closed on a fetch error (opt-in). */
  readonly usesSheets = signal(false);

  /** 'CLASSIC' = the original BeyondAI flow driven by the switches above (every research that
   *  existed before the protocol feature); 'PROTOCOL' = a researcher-defined step list. Fails open to
   *  'CLASSIC' on a fetch error, so a hiccup can never hide the classic menu. */
  readonly flowMode = signal<'CLASSIC' | 'PROTOCOL'>('CLASSIC');
  /** Step types present in this research's protocol (empty for CLASSIC) — drives which module
   *  nav/results entries a PROTOCOL research shows. */
  readonly protocolStepTypes = signal<string[]>([]);
  /** Task kind of the protocol's EXPERIMENT step (GENERIC_TASK / GOOGLE_FORM / SHEETS / CODE_REVIEW), or null. */
  readonly protocolTaskKind = signal<string | null>(null);
  readonly isProtocol = computed(() => this.flowMode() === 'PROTOCOL');
  /** false while the study wizard that created a PROTOCOL research is unfinished (fails open to true). */
  readonly setupComplete = signal(true);
  /** Participant groups defined for the research (0 = none) — decides whether the Group column / actions show. */
  readonly groupCount = signal(0);

  /** True if the selected research is a PROTOCOL one whose protocol contains this step type. */
  hasStep(type: string): boolean {
    return this.protocolStepTypes().includes(type);
  }

  private loadedResearchId: number | null = null;

  /** Called whenever the selected research changes. */
  async load(researchId: number): Promise<void> {
    this.loadedResearchId = researchId;
    await this.fetchAll(researchId);
  }

  /** Called after a successful Configuration save so the menu updates without a research
   *  switch. No-ops if the saved research isn't the one currently in view (shouldn't happen in
   *  practice — Configuration always operates on the selected research — but guards against a
   *  stale call landing after the user has already switched away). */
  async refresh(researchId: number): Promise<void> {
    if (researchId !== this.loadedResearchId) return;
    await this.fetchAll(researchId);
  }

  private async fetchAll(researchId: number): Promise<void> {
    try {
      const cfg = await this.api.getStudyConfig(researchId);
      this.usesTlx.set(cfg.usesTlx);
      this.usesPsychTests.set(cfg.usesPsychTests);
      this.rei40Variant.set(cfg.rei40Variant);
      this.usesConsentForm.set(cfg.usesConsentForm);
      this.tracksParticipants.set(cfg.tracksParticipants);
      this.usesDemographics.set(cfg.usesDemographics);
      this.usesSheets.set(cfg.usesSheets);
      this.flowMode.set(cfg.flowMode === 'PROTOCOL' ? 'PROTOCOL' : 'CLASSIC');
      this.setupComplete.set(cfg.setupComplete !== false);
      this.groupCount.set(cfg.groupCount ?? 0);
    } catch {
      this.flowMode.set('CLASSIC');
      this.setupComplete.set(true);
      this.groupCount.set(0);
      this.usesTlx.set(true);
      this.usesPsychTests.set(true);
      this.rei40Variant.set('v1');
      this.usesConsentForm.set(true);
      this.tracksParticipants.set(true);
      this.usesDemographics.set(false);
      this.usesSheets.set(false);
    }

    if (this.flowMode() === 'PROTOCOL') {
      try {
        const protocol = await this.api.getProtocol(researchId);
        this.protocolStepTypes.set(protocol.steps.map((s) => s.stepType));
        this.protocolTaskKind.set(protocol.steps.find((s) => s.stepType === 'EXPERIMENT')?.config?.taskKind ?? null);
      } catch {
        this.protocolStepTypes.set([]);
        this.protocolTaskKind.set(null);
      }
    } else {
      this.protocolStepTypes.set([]);
      this.protocolTaskKind.set(null);
    }

    try {
      const taskCfg = await this.api.getTaskConfig(researchId);
      this.taskType.set(taskCfg.taskType);
      if (taskCfg.taskType !== 'GOOGLE_FORMS') {
        this.showRAnalysisResults.set(false);
        return;
      }
      const script = await this.api.getAnalysisScript(researchId);
      this.showRAnalysisResults.set(script.exists);
    } catch {
      this.taskType.set('PR_REVIEW');
      this.showRAnalysisResults.set(false);
    }
  }
}
