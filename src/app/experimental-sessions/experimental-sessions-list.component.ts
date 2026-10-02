import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { AdminApiService, ExperimentalSessionSummary } from '../services/admin-api.service';
import { ScopeService } from '../services/scope.service';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';

/**
 * List page for Experimental Sessions — a physical day/timeslot within a research (e.g. "3
 * participants ran their Intro session on Aug 20"). Just a table; creating a new one happens via
 * the top-right button, which opens a small modal (date required, label/notes optional) rather
 * than an inline form. Clicking a row opens the master-detail page
 * (experimental-session-detail.component.ts) where participant-sessions get assigned (with a
 * required scheduled time) and notes are edited at both levels.
 */
@Component({
  selector: 'app-experimental-sessions-list',
  standalone: true,
  imports: [TranslateModule, ReactiveFormsModule, DatePipe, LoadingSpinnerComponent],
  templateUrl: './experimental-sessions-list.component.html',
  styleUrl: './experimental-sessions-list.component.scss',
})
export class ExperimentalSessionsListComponent {
  private api = inject(AdminApiService);
  private scope = inject(ScopeService);
  private router = inject(Router);
  private fb = inject(FormBuilder);

  readonly dateFormat = 'dd.MM.yyyy.';

  readonly sessions = signal<ExperimentalSessionSummary[]>([]);
  readonly loading = signal(false);
  readonly error = signal(false);

  readonly showCreateModal = signal(false);
  readonly creating = signal(false);
  readonly createError = signal(false);

  form = this.fb.group({
    sessionDate: [new Date().toISOString().slice(0, 10)],
    label: [''],
    notes: [''],
  });

  constructor() {
    toObservable(this.scope.selectedResearchId).subscribe((researchId) => {
      this.load(researchId);
    });
  }

  openSession(id: number): void {
    this.router.navigate(['/experimental-sessions', id]);
  }

  openCreateModal(): void {
    this.form.setValue({ sessionDate: new Date().toISOString().slice(0, 10), label: '', notes: '' });
    this.createError.set(false);
    this.showCreateModal.set(true);
  }

  closeCreateModal(): void {
    if (this.creating()) return;
    this.showCreateModal.set(false);
  }

  private async load(researchId: number | null): Promise<void> {
    this.loading.set(true);
    this.error.set(false);
    try {
      this.sessions.set(await this.api.getExperimentalSessions(researchId));
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  async create(): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (this.creating() || researchId == null || !this.form.value.sessionDate) return;

    this.creating.set(true);
    this.createError.set(false);
    try {
      const { id } = await this.api.createExperimentalSession({
        researchId,
        sessionDate: this.form.value.sessionDate!,
        label: this.form.value.label?.trim() || null,
        notes: this.form.value.notes?.trim() || null,
      });
      this.showCreateModal.set(false);
      this.router.navigate(['/experimental-sessions', id]);
    } catch {
      this.createError.set(true);
    } finally {
      this.creating.set(false);
    }
  }
}
