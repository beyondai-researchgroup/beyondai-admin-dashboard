import { Injectable, inject, signal } from '@angular/core';
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
    } catch {
      this.usesTlx.set(true);
      this.usesPsychTests.set(true);
      this.rei40Variant.set('v1');
      this.usesConsentForm.set(true);
      this.tracksParticipants.set(true);
      this.usesDemographics.set(false);
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
