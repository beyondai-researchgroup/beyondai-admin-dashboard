import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { AdminApiService, PrConfig } from '../../services/admin-api.service';
import { ScopeService } from '../../services/scope.service';
import { LoadingSpinnerComponent } from '../../shared/loading-spinner/loading-spinner.component';
import { HelpIconComponent } from '../../shared/help-icon/help-icon.component';

/**
 * Lists every PR task added for the current research (Intro task first, then by creation order)
 * — every task is an equally-usable option a researcher can assign via the Excel import, there is
 * no single active/inactive state. Lets the researcher add a new task, rename a task's label,
 * (re)assign which one is the Intro task, or delete an unused one. There is deliberately no
 * "edit owner/repo/PR#/token" affordance — adding is always a fresh row with its own token, so a
 * GitHub PAT can never be silently remembered/pre-filled from a previous configuration.
 *
 * Formerly the standalone routed page `PrConfigComponent` (`/pr-config`) — extracted into a
 * child component (Task Configuration Phase 1, 2026-08-19) rendered by `TaskConfigComponent`
 * when the selected research's TaskType is `'PR_REVIEW'`. Logic/markup unchanged, only the
 * outer `page-header` was dropped (the host page owns that now).
 *
 * The 3 field-level "?" buttons used to share one bespoke modal with a local `helpTopic` switch
 * — replaced (2026-09-07) by 3 independent `<app-help-icon>` instances, the same shared
 * component now used everywhere else in the app, each with its own `steps` array built here via
 * `translate.instant` (mirrors `typeOptions`-style computed signals elsewhere in this app).
 */
@Component({
  selector: 'app-pr-review-task',
  standalone: true,
  imports: [ReactiveFormsModule, TranslateModule, DatePipe, LoadingSpinnerComponent, HelpIconComponent],
  templateUrl: './pr-review-task.component.html',
  styleUrl: './pr-review-task.component.scss',
})
export class PrReviewTaskComponent {
  private fb = inject(FormBuilder);
  private api = inject(AdminApiService);
  private scope = inject(ScopeService);
  private translate = inject(TranslateService);
  private readonly lang = signal(this.translate.currentLang || 'sr');

  readonly loading = signal(false);
  readonly error = signal(false);
  readonly configs = signal<PrConfig[]>([]);

  readonly saving = signal(false);
  readonly saveError = signal(false);
  readonly saved = signal(false);

  readonly settingIntroId = signal<number | null>(null);
  readonly deletingId = signal<number | null>(null);
  readonly deleteError = signal<number | null>(null);

  readonly editingLabelId = signal<number | null>(null);
  readonly labelDraft = signal('');
  readonly labelSaving = signal(false);
  readonly labelError = signal(false);

  form = this.fb.group({
    label: ['', [Validators.required, Validators.maxLength(40)]],
    owner: ['', Validators.required],
    repo: ['', Validators.required],
    prNumber: this.fb.control<number | null>(null, [Validators.required, Validators.min(1)]),
    token: ['', Validators.required],
    isIntro: [false],
  });

  constructor() {
    this.translate.onLangChange.subscribe((e) => this.lang.set(e.lang));
    toObservable(this.scope.selectedResearchId).subscribe((id) => {
      if (id != null) this.load(id);
    });
  }

  readonly linkHelpSteps = computed(() => {
    this.lang();
    return ['PR_CONFIG.HELP_LINK_STEP1', 'PR_CONFIG.HELP_LINK_STEP2', 'PR_CONFIG.HELP_LINK_STEP3'].map((k) =>
      this.translate.instant(k)
    );
  });

  readonly prNumberHelpSteps = computed(() => {
    this.lang();
    return ['PR_CONFIG.HELP_PR_NUMBER_STEP1', 'PR_CONFIG.HELP_PR_NUMBER_STEP2'].map((k) => this.translate.instant(k));
  });

  readonly tokenHelpSteps = computed(() => {
    this.lang();
    return [
      'PR_CONFIG.HELP_TOKEN_STEP1',
      'PR_CONFIG.HELP_TOKEN_STEP2',
      'PR_CONFIG.HELP_TOKEN_STEP3',
      'PR_CONFIG.HELP_TOKEN_STEP4',
    ].map((k) => this.translate.instant(k));
  });

  private async load(researchId: number): Promise<void> {
    this.loading.set(true);
    this.error.set(false);
    try {
      this.configs.set(await this.api.getPrConfigs(researchId));
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  async submit(): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (this.form.invalid || this.saving() || researchId == null) return;

    this.saving.set(true);
    this.saved.set(false);
    this.saveError.set(false);

    const { label, owner, repo, prNumber, token, isIntro } = this.form.value;
    try {
      await this.api.addPrConfig(researchId, {
        label: label!, owner: owner!, repo: repo!, prNumber: prNumber!, token: token!, isIntro: isIntro ?? false,
      });
      this.form.reset({ label: '', owner: '', repo: '', prNumber: null, token: '', isIntro: false });
      this.saved.set(true);
      await this.load(researchId);
    } catch {
      this.saveError.set(true);
    } finally {
      this.saving.set(false);
    }
  }

  async setAsIntro(configId: number): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || this.settingIntroId() != null) return;

    this.settingIntroId.set(configId);
    try {
      await this.api.updatePrConfig(researchId, configId, { isIntro: true });
      await this.load(researchId);
    } finally {
      this.settingIntroId.set(null);
    }
  }

  startEditLabel(config: PrConfig): void {
    this.editingLabelId.set(config.id);
    this.labelDraft.set(config.label);
    this.labelError.set(false);
  }

  cancelEditLabel(): void {
    this.editingLabelId.set(null);
  }

  async saveLabel(configId: number): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    const label = this.labelDraft().trim();
    if (researchId == null || !label || this.labelSaving()) return;

    this.labelSaving.set(true);
    this.labelError.set(false);
    try {
      await this.api.updatePrConfig(researchId, configId, { label });
      this.editingLabelId.set(null);
      await this.load(researchId);
    } catch {
      this.labelError.set(true);
    } finally {
      this.labelSaving.set(false);
    }
  }

  async deleteConfig(configId: number): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || this.deletingId() != null) return;

    this.deletingId.set(configId);
    this.deleteError.set(null);
    try {
      await this.api.deletePrConfig(researchId, configId);
      await this.load(researchId);
    } catch {
      this.deleteError.set(configId);
    } finally {
      this.deletingId.set(null);
    }
  }
}
