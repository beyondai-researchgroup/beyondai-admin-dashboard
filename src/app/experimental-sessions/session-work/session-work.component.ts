import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { AdminApiService, ExperimentalSessionWorkRow } from '../../services/admin-api.service';

/**
 * Who worked a task on this experimental session's day (and group): read from the tasks themselves (Sheets: pressed Start;
 * Generic task: opened it), so the researcher does not add anybody by hand. Read-only.
 */
@Component({
  selector: 'app-session-work',
  standalone: true,
  imports: [TranslateModule, DatePipe],
  template: `
    <section class="work">
      <h3 class="work-heading">{{ 'EXPERIMENTAL_SESSIONS.WORK_HEADING' | translate }}</h3>
      <p class="work-hint">{{ 'EXPERIMENTAL_SESSIONS.WORK_HINT' | translate }}</p>
      @if (error()) {
        <div class="empty-state">{{ 'COMMON.LOAD_ERROR' | translate }}</div>
      } @else {
       @if (rows(); as list) {
        @if (!list.length) {
          <div class="empty-state">{{ 'EXPERIMENTAL_SESSIONS.WORK_EMPTY' | translate }}</div>
        } @else {
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>{{ 'EXPERIMENTAL_SESSIONS.WORK_COL_PARTICIPANT' | translate }}</th>
                  <th>{{ 'EXPERIMENTAL_SESSIONS.WORK_COL_GROUP' | translate }}</th>
                  <th>{{ 'EXPERIMENTAL_SESSIONS.WORK_COL_TASK' | translate }}</th>
                  <th>{{ 'EXPERIMENTAL_SESSIONS.WORK_COL_STARTED' | translate }}</th>
                  <th>{{ 'EXPERIMENTAL_SESSIONS.WORK_COL_STATUS' | translate }}</th>
                </tr>
              </thead>
              <tbody>
                @for (r of list; track r.participantId + r.kind) {
                  <tr>
                    <td>{{ r.participantId }}@if (r.code) { <span class="muted"> · {{ r.code }}</span> }</td>
                    <td>{{ r.groupName ?? '-' }}</td>
                    <td>{{ r.taskName ?? '-' }}</td>
                    <td>{{ r.startedAt | date: 'dd.MM.yyyy. HH:mm' }}</td>
                    <td>
                      <span class="pill" [class]="'pill pill--' + r.status">{{ 'EXPERIMENTAL_SESSIONS.WORK_STATUS_' + r.status | translate }}</span>
                      @if (r.submittedAt) { <span class="muted"> {{ r.submittedAt | date: 'HH:mm' }}</span> }
                      @if (r.durationMin != null) { <span class="muted"> · {{ 'EXPERIMENTAL_SESSIONS.WORK_DURATION' | translate: { min: r.durationMin } }}</span> }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
       }
      }
    </section>
  `,
  styles: [`
    .work { margin: 24px 0; }
    .work-heading { font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-secondary); margin: 0 0 6px; }
    .work-hint { font-size: 13px; color: var(--color-muted); margin: 0 0 12px; max-width: 780px; }
    .muted { color: var(--color-muted); }
    .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid var(--color-border); }
    .pill--SUBMITTED { color: var(--color-accent); border-color: var(--color-accent-dim); }
    .pill--WORKING { color: var(--color-text); }
    .pill--TIMED_OUT { color: var(--color-error); border-color: var(--color-error); }
  `],
})
export class SessionWorkComponent {
  private api = inject(AdminApiService);
  readonly sessionId = input.required<number>();
  /** Bumped by the page when the group of the session was saved. */
  readonly refreshKey = input(0);
  readonly rows = signal<ExperimentalSessionWorkRow[] | null>(null);
  readonly error = signal(false);

  constructor() {
    // reading the inputs is tracked; the loading itself writes signals, so it runs untracked
    effect(() => { const id = this.sessionId(); this.refreshKey(); untracked(() => { void this.load(id); }); });
  }

  private async load(id: number): Promise<void> {
    this.error.set(false);
    try {
      this.rows.set(await this.api.getExperimentalSessionWork(id));
    } catch {
      this.error.set(true);
    }
  }
}
