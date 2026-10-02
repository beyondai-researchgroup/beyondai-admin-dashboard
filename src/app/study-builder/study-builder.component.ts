import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AdminApiService, TaskType } from '../services/admin-api.service';
import { ScopeService } from '../services/scope.service';
import { ResearchesStoreService } from '../services/researches-store.service';
import { SelectComponent, SelectOption } from '../shared/select/select.component';
import { ConsentFormComponent } from '../consent-form/consent-form.component';

type WizardStep = 1 | 2 | 3;

/**
 * Study Builder wizard — a guided flow for standing up a brand-new research end to end: basics +
 * module toggles → Consent Form → done. Deliberately reuses the already-working Consent Form page
 * verbatim as a wizard step (ConsentFormComponent) — it already reactively loads off
 * `ScopeService.selectedResearchId`, so once step 1 creates the research and calls
 * `scope.select(newId)`, step 2 "just works" with zero duplicated logic. Only step 1 (a subset of
 * ResearchesManageComponent's own create form) and step 3 (a plain confirmation) are new markup.
 * Still superadmin-only (see app.routes.ts's superAdminGuard on this route).
 */
@Component({
  selector: 'app-study-builder',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, TranslateModule, SelectComponent, ConsentFormComponent],
  templateUrl: './study-builder.component.html',
  styleUrl: './study-builder.component.scss',
})
export class StudyBuilderComponent {
  private fb = inject(FormBuilder);
  private api = inject(AdminApiService);
  private scope = inject(ScopeService);
  private store = inject(ResearchesStoreService);
  private translate = inject(TranslateService);
  private readonly lang = signal(this.translate.currentLang || 'sr');

  readonly step = signal<WizardStep>(1);
  readonly createdResearchName = signal<string | null>(null);

  readonly creating = signal(false);
  readonly createError = signal(false);

  readonly taskTypes: TaskType[] = ['PR_REVIEW', 'GOOGLE_FORMS', 'GENERIC'];
  readonly taskTypeOptions = computed<SelectOption[]>(() => {
    this.lang();
    return this.taskTypes.map((t) => ({ value: t, label: this.translate.instant(`TASK_CONFIG.TASK_TYPE_OPTION_${t}`) }));
  });

  form = this.fb.group({
    name: ['', [Validators.required, Validators.maxLength(150)]],
    description: ['', Validators.maxLength(2000)],
    university: ['', Validators.maxLength(200)],
    city: ['', Validators.maxLength(200)],
    country: ['', Validators.maxLength(200)],
    usesTlx: [true],
    usesPsychTests: [true],
    taskType: ['PR_REVIEW' as TaskType],
    usesConsentForm: [true],
    tracksParticipants: [true],
    // 2026-09-08 follow-up: defaults to only the researcher's OWN current UI language, not both —
    // "podrazumevano neka je čekiran onaj jezik koji je u aplikaciji". Still sent explicitly on
    // create (not left to the column's own both-true default) so this choice actually takes.
    consentLanguageSr: [(this.translate.currentLang || 'sr') === 'sr'],
    consentLanguageEn: [(this.translate.currentLang || 'sr') === 'en'],
  });

  constructor() {
    this.translate.onLangChange.subscribe((e) => this.lang.set(e.lang));
  }

  onTaskTypeChange(value: string | number): void {
    this.form.controls.taskType.setValue(String(value) as TaskType);
  }

  // Refuses to leave both languages unchecked — same guard as ConfigurationComponent's own.
  onConsentLanguageChange(lang: 'sr' | 'en', checked: boolean): void {
    const control = lang === 'sr' ? this.form.controls.consentLanguageSr : this.form.controls.consentLanguageEn;
    const other = lang === 'sr' ? this.form.controls.consentLanguageEn : this.form.controls.consentLanguageSr;
    if (!checked && !other.value) {
      control.setValue(true);
      return;
    }
    control.setValue(checked);
  }

  async createResearch(): Promise<void> {
    if (this.form.invalid || this.creating()) return;
    this.creating.set(true);
    this.createError.set(false);

    const {
      name, description, university, city, country, usesTlx, usesPsychTests, taskType, usesConsentForm,
      tracksParticipants, consentLanguageSr, consentLanguageEn,
    } = this.form.value;
    try {
      const created = await this.api.createResearch({
        name: name!.trim(),
        description: description?.trim() || null,
        university: university?.trim() || null,
        city: city?.trim() || null,
        country: country?.trim() || null,
        usesTlx: usesTlx ?? true,
        usesPsychTests: usesPsychTests ?? true,
        taskType: taskType ?? 'PR_REVIEW',
        usesConsentForm: usesConsentForm ?? true,
        tracksParticipants: taskType === 'PR_REVIEW' ? true : (tracksParticipants ?? true),
        consentLanguageSr: consentLanguageSr ?? true,
        consentLanguageEn: consentLanguageEn ?? true,
      });
      this.createdResearchName.set(created.name);
      this.scope.select(created.id);
      await this.store.reload();
      // The Consent Form step only makes sense when this research actually uses one — skip
      // straight to the done screen otherwise.
      this.step.set(usesConsentForm ? 2 : 3);
    } catch {
      this.createError.set(true);
    } finally {
      this.creating.set(false);
    }
  }

  goTo(step: WizardStep): void {
    // Step 1 is only reachable before a research has been created — going "back" to it would
    // suggest editing the basics form re-creates the research, which it doesn't.
    if (step === 1 && this.createdResearchName() !== null) return;
    // Step 2 (Consent Form) only exists when the created research actually uses one.
    if (step === 2 && !this.form.controls.usesConsentForm.value) return;
    this.step.set(step);
  }

  next(): void {
    const current = this.step();
    if (current < 3) this.step.set((current + 1) as WizardStep);
  }
}
