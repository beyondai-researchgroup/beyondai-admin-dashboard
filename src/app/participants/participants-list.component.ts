import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { AdminApiService, ParticipantRow } from '../services/admin-api.service';
import { ScopeService } from '../services/scope.service';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';

@Component({
  selector: 'app-participants-list',
  standalone: true,
  imports: [TranslateModule, LoadingSpinnerComponent],
  templateUrl: './participants-list.component.html',
})
export class ParticipantsListComponent {
  private api = inject(AdminApiService);
  private scope = inject(ScopeService);
  private router = inject(Router);

  readonly participants = signal<ParticipantRow[]>([]);
  readonly loading = signal(false);
  readonly error = signal(false);

  // Survey-response completion badge (2026-09-08 follow-up) — null means "not applicable" (not
  // a GOOGLE_FORMS research, no research selected, or no ID column configured yet), in which
  // case the column renders nothing at all rather than a row of blanks.
  readonly notRespondedIds = signal<Set<string> | null>(null);

  constructor() {
    toObservable(this.scope.selectedResearchId).subscribe((researchId) => {
      this.load(researchId);
    });
  }

  openParticipant(participantId: string): void {
    this.router.navigate(['/participants', participantId]);
  }

  /** Looks up a row's session by SessionId directly (1=Intro, 2=AI, 3=Report) instead of relying
   *  on array position — a participant with a missing session (not imported yet) or an extra one
   *  (Hybrid, SessionId 4) used to silently shift every later column under the wrong header. */
  sessionByType(p: ParticipantRow, sessionId: number) {
    return p.sessions.find((s) => s.sessionId === sessionId) ?? null;
  }

  /** The first not-yet-finished session in study order, or null once every session is done —
   *  shown as the participant's current phase without a separate round-trip (the full 6-step
   *  timeline with Consent/questionnaires/scheduling lives on the detail page). */
  currentPhase(p: ParticipantRow): string | null {
    const next = [...p.sessions].sort((a, b) => (a.sequenceOrder ?? a.sessionId) - (b.sequenceOrder ?? b.sessionId))
      .find((s) => !s.isFinished);
    return next?.sessionName ?? null;
  }

  private async load(researchId: number | null): Promise<void> {
    this.loading.set(true);
    this.error.set(false);
    this.notRespondedIds.set(null);
    try {
      this.participants.set(await this.api.getParticipants(researchId));
      if (researchId != null) await this.loadSurveyMatch(researchId);
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadSurveyMatch(researchId: number): Promise<void> {
    try {
      const taskCfg = await this.api.getTaskConfig(researchId);
      if (taskCfg.taskType !== 'GOOGLE_FORMS') return;
      const stats = await this.api.getDescriptiveStats(researchId);
      if (stats.ok && stats.stats.participantMatch) {
        this.notRespondedIds.set(new Set(stats.stats.participantMatch.notResponded.map((p) => p.participantId)));
      }
    } catch {
      // Best-effort — the badge is a soft convenience, never worth failing the whole list over.
    }
  }
}
