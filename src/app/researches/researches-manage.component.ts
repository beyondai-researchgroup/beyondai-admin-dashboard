import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { AdminApiService, ResearchSummary } from '../services/admin-api.service';
import { ResearchesStoreService } from '../services/researches-store.service';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';

/** Superadmin-only: list researches, edit their basic details, and start the study wizard for a new
 *  one (2026-10). A new research is always protocol-based and is created by the wizard, so there are no
 *  module switches here; an unfinished wizard can be continued from the list. */
@Component({
  selector: 'app-researches-manage',
  standalone: true,
  imports: [ReactiveFormsModule, TranslateModule, LoadingSpinnerComponent],
  templateUrl: './researches-manage.component.html',
})
export class ResearchesManageComponent {
  private fb = inject(FormBuilder);
  private api = inject(AdminApiService);
  private router = inject(Router);
  readonly store = inject(ResearchesStoreService);

  readonly editingId = signal<number | null>(null);
  readonly saving = signal(false);
  readonly error = signal(false);
  readonly saved = signal(false);

  form = this.fb.group({
    name: ['', [Validators.required, Validators.maxLength(150)]],
    description: ['', Validators.maxLength(2000)],
    university: ['', Validators.maxLength(200)],
    city: ['', Validators.maxLength(200)],
    country: ['', Validators.maxLength(200)],
  });

  constructor() {
    this.store.ensureLoaded();
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
    });
  }

  cancelEdit(): void {
    this.editingId.set(null);
    this.form.reset({ name: '', description: '', university: '', city: '', country: '' });
  }

  startWizard(): void {
    void this.router.navigate(['/study-wizard']);
  }

  continueSetup(r: ResearchSummary): void {
    void this.router.navigate(['/study-wizard'], { queryParams: { researchId: r.id, step: 2 } });
  }

  async submit(): Promise<void> {
    const id = this.editingId();
    if (id == null || this.form.invalid || this.saving()) return;

    this.saving.set(true);
    this.error.set(false);
    this.saved.set(false);

    const { name, description, university, city, country } = this.form.value;
    const body = {
      name: name!.trim(),
      description: description?.trim() || null,
      university: university?.trim() || null,
      city: city?.trim() || null,
      country: country?.trim() || null,
    };

    try {
      await this.api.updateResearch(id, body);
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
