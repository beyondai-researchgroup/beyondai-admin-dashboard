import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AdminApiService, ResearchSummary, TaskType } from '../services/admin-api.service';
import { ResearchesStoreService } from '../services/researches-store.service';
import { ScopeService } from '../services/scope.service';
import { SelectComponent, SelectOption } from '../shared/select/select.component';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';

/** Superadmin-only: create new researches (new university sites) and edit existing ones —
 *  the last piece needed to manage the whole study fully from the Admin Dashboard, with no
 *  manual SQL required for onboarding a new site. */
@Component({
  selector: 'app-researches-manage',
  standalone: true,
  imports: [ReactiveFormsModule, TranslateModule, SelectComponent, LoadingSpinnerComponent],
  templateUrl: './researches-manage.component.html',
})
export class ResearchesManageComponent {
  private fb = inject(FormBuilder);
  private api = inject(AdminApiService);
  private scope = inject(ScopeService);
  private translate = inject(TranslateService);
  private readonly lang = signal(this.translate.currentLang || 'sr');
  readonly store = inject(ResearchesStoreService);

  readonly editingId = signal<number | null>(null);
  readonly saving = signal(false);
  readonly error = signal(false);
  readonly saved = signal(false);

  // Instrument fields only matter (and are only shown/sent) when creating a NEW research — see
  // the ResearchInput doc comment. Kept out of the reactive form's own validation since they're
  // conditionally rendered/sent, same pattern as Configuration's eegDevicePreset sub-fields.
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
  });

  constructor() {
    this.store.ensureLoaded();
    this.translate.onLangChange.subscribe((e) => this.lang.set(e.lang));
  }

  startEdit(r: ResearchSummary): void {
    this.editingId.set(r.id);
    this.saved.set(false);
    this.error.set(false);
    this.form.setValue({
      name: r.name,
      description: r.description ?? '',
      university: r.university ?? '',
      city: r.city ?? '',
      country: r.country ?? '',
      // Instrument fields aren't rendered while editing (see the template) — this form group
      // just needs *some* valid value in those controls; they're never read/sent by submit()'s
      // edit branch below.
      usesTlx: true,
      usesPsychTests: true,
      taskType: 'PR_REVIEW',
    });
  }

  cancelEdit(): void {
    this.editingId.set(null);
    this.form.reset({
      name: '', description: '', university: '', city: '', country: '',
      usesTlx: true, usesPsychTests: true, taskType: 'PR_REVIEW',
    });
  }

  onTaskTypeChange(value: string | number): void {
    this.form.controls.taskType.setValue(String(value) as TaskType);
  }

  async submit(): Promise<void> {
    if (this.form.invalid || this.saving()) return;

    this.saving.set(true);
    this.error.set(false);
    this.saved.set(false);

    const { name, description, university, city, country, usesTlx, usesPsychTests, taskType } = this.form.value;
    const isCreating = this.editingId() == null;
    const body = {
      name: name!.trim(),
      description: description?.trim() || null,
      university: university?.trim() || null,
      city: city?.trim() || null,
      country: country?.trim() || null,
      // Only sent when creating — the edit form never shows/changes these, they stay owned by
      // Configuration's own PUTs afterward (see ResearchInput's doc comment).
      ...(isCreating
        ? { usesTlx: usesTlx ?? true, usesPsychTests: usesPsychTests ?? true, taskType: taskType ?? 'PR_REVIEW' }
        : {}),
    };

    try {
      const id = this.editingId();
      if (id != null) {
        await this.api.updateResearch(id, body);
      } else {
        // Auto-select the newly created research (2026-08-20) — previously the researcher had
        // to go find it in the sidebar picker themselves right after creating it.
        const created = await this.api.createResearch(body);
        this.scope.select(created.id);
      }
      await this.store.reload();
      this.saved.set(true);
      this.cancelEdit();
    } catch {
      this.error.set(true);
    } finally {
      this.saving.set(false);
    }
  }
}
