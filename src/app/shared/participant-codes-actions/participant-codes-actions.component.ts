import { Component, inject, input, output, signal } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { AdminApiService } from '../../services/admin-api.service';
import { ScopeService } from '../../services/scope.service';

/**
 * Participant codes (a random four-digit number per participant, for analysis and papers): "Assign codes" gives one to everyone who has none,
 * "Download key" saves the file that maps participant id to code (and group / task). Shown on both participant lists and on the import result.
 */
@Component({
  selector: 'app-participant-codes-actions',
  standalone: true,
  imports: [TranslateModule],
  template: `
    @if (total() > 0) {
      <div class="codes-row">
        <span class="muted">{{ 'CODES.HINT' | translate }}</span>
        <span class="codes-buttons">
          @if (withCode() < total()) {
            <button type="button" class="btn-ghost btn-ghost--small" [disabled]="busy()" (click)="assign()">
              {{ 'CODES.ASSIGN' | translate: { count: total() - withCode() } }}
            </button>
          }
          @if (withCode() > 0) {
            <button type="button" class="btn-ghost btn-ghost--small" [disabled]="busy()" (click)="downloadKey()">{{ 'CODES.DOWNLOAD_KEY' | translate }}</button>
          }
        </span>
        @if (message(); as m) {
          <span [class.field-error]="m.tone === 'error'" [class.muted]="m.tone === 'ok'">{{ m.text | translate: m.params }}</span>
        }
      </div>
    }
  `,
  styles: [`
    .codes-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; margin: 0 0 16px; font-size: 13px; }
    .codes-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
    .muted { color: var(--color-muted); }
  `],
})
export class ParticipantCodesActionsComponent {
  private api = inject(AdminApiService);
  private scope = inject(ScopeService);

  /** Participants in the list, and how many of them already have a code. */
  readonly total = input(0);
  readonly withCode = input(0);
  /** Codes were assigned: the list should reload. */
  readonly changed = output<void>();

  readonly busy = signal(false);
  readonly message = signal<{ text: string; tone: 'ok' | 'error'; params?: Record<string, unknown> } | null>(null);

  async assign(): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    try {
      const res = await this.api.assignParticipantCodes(researchId);
      this.message.set({ text: 'CODES.ASSIGNED', tone: 'ok', params: { count: res.assigned } });
      this.changed.emit();
    } catch (err: any) {
      this.message.set({ text: err?.error?.error === 'CODES_EXHAUSTED' ? 'CODES.EXHAUSTED' : 'CODES.ERROR', tone: 'error' });
    } finally {
      this.busy.set(false);
    }
  }

  async downloadKey(): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    try {
      await this.api.downloadCodeKey(researchId);
    } catch {
      this.message.set({ text: 'CODES.ERROR', tone: 'error' });
    } finally {
      this.busy.set(false);
    }
  }
}
