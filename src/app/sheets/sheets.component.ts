import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AdminApiService, SheetsEntryView, SheetsOverview, SheetsParticipantRow } from '../services/admin-api.service';
import { SelectComponent, SelectOption } from '../shared/select/select.component';
import { ScopeService } from '../services/scope.service';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';

type Msg = { text: string; tone: 'ok' | 'error' } | null;

/**
 * "Tabele" (2026-10): the admin side of the Excel-like tables app. The template is designed in the sheets app
 * (separate login); here the researcher sends participants their personal links, sees who has not started /
 * is in progress / has submitted, opens a participant's table read-only and exports everything to Excel.
 */
@Component({
  selector: 'app-sheets',
  standalone: true,
  imports: [TranslateModule, DatePipe, LoadingSpinnerComponent, SelectComponent],
  templateUrl: './sheets.component.html',
  styleUrl: './sheets.component.scss',
})
export class SheetsComponent {
  private api = inject(AdminApiService);
  private scope = inject(ScopeService);
  private translate = inject(TranslateService);

  readonly overview = signal<SheetsOverview | null>(null);
  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly busyId = signal<string | null>(null);
  readonly bulkBusy = signal(false);
  readonly exporting = signal(false);
  readonly message = signal<Msg>(null);
  readonly copiedId = signal<string | null>(null);

  readonly viewing = signal<{ participantId: string; entry: SheetsEntryView } | null>(null);
  readonly viewSheet = signal(0);

  /** Participants a bulk send would reach: not submitted, with an email, a template that fits, and without a still-valid link. */
  readonly bulkTargets = computed(() =>
    (this.overview()?.participants ?? []).filter((p) => !p.noTemplate && p.entry?.status !== 'SUBMITTED' && p.hasEmail && (!p.link || p.link.expired)).length);

  readonly templates = computed(() => this.overview()?.workbooks ?? []);
  readonly anyRules = computed(() => this.templates().some((w) => w.hasRules));
  readonly anyGroup = computed(() => (this.overview()?.participants ?? []).some((p) => !!p.groupName));
  readonly anyTask = computed(() => (this.overview()?.participants ?? []).some((p) => !!p.taskName));
  readonly withoutTemplate = computed(() => (this.overview()?.participants ?? []).filter((p) => p.noTemplate).length);
  /** '' = all participants, 'none' = those without a fitting template, otherwise a template id. */
  readonly templateFilter = signal<string>('');
  readonly filterOptions = computed<SelectOption[]>(() => [
    { value: '', label: this.translate.instant('SHEETS.FILTER_ALL') },
    ...this.templates().map((w) => ({ value: String(w.id), label: w.label || w.title })),
    ...(this.withoutTemplate() ? [{ value: 'none', label: this.translate.instant('SHEETS.FILTER_NONE') }] : []),
  ]);
  readonly visibleParticipants = computed(() => {
    const ps = this.overview()?.participants ?? [];
    const f = this.templateFilter();
    if (!f) return ps;
    if (f === 'none') return ps.filter((p) => p.noTemplate);
    return ps.filter((p) => String(p.workbookId) === f);
  });
  /** Many templates: one export button each next to the export of everything. */
  readonly severalTemplates = computed(() => this.templates().length > 1);

  // ── availability window: the tables open and close at these moments (the participant's local picker -> UTC) ──
  readonly opensInput = signal('');
  readonly closesInput = signal('');
  readonly windowSaving = signal(false);
  readonly windowDirty = computed(() => {
    const w = this.overview()?.window;
    return this.opensInput() !== this.toInput(w?.opensAt) || this.closesInput() !== this.toInput(w?.closesAt);
  });

  /** ISO (UTC) -> the value of a datetime-local input in the researcher's own time zone. */
  private toInput(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async saveWindow(): Promise<void> {
    if (this.researchId == null || this.windowSaving()) return;
    this.windowSaving.set(true);
    this.message.set(null);
    const iso = (v: string) => (v ? new Date(v).toISOString() : null);
    const res = await this.api.saveSheetsWindow(this.researchId, { opensAt: iso(this.opensInput()), closesAt: iso(this.closesInput()) });
    this.windowSaving.set(false);
    if (res.ok) this.say('SHEETS.WINDOW_SAVED', 'ok');
    else this.say(res.error === 'WINDOW_ORDER' ? 'SHEETS.ERR_WINDOW_ORDER' : 'SHEETS.ERR_GENERIC', 'error');
    await this.load(this.researchId);
  }

  clearWindow(): void {
    this.opensInput.set('');
    this.closesInput.set('');
  }

  private researchId: number | null = null;

  constructor() {
    toObservable(this.scope.selectedResearchId).subscribe((id) => {
      this.researchId = id;
      this.message.set(null);
      if (id != null) this.load(id);
    });
  }

  async load(researchId: number): Promise<void> {
    this.loading.set(true);
    this.loadError.set(false);
    try {
      const o = await this.api.getSheetsOverview(researchId);
      this.overview.set(o);
      this.opensInput.set(this.toInput(o.window?.opensAt));
      this.closesInput.set(this.toInput(o.window?.closesAt));
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  editorUrl(): string {
    return `${this.overview()?.appUrl ?? ''}/login`;
  }

  /** The template list in the sheets app (opens after the researcher's login there). */
  templatesUrl(): string {
    return `${this.overview()?.appUrl ?? ''}/research/${this.researchId ?? ''}`;
  }

  templateName(w: { label: string | null; title: string }): string {
    return w.label || w.title || this.translate.instant('SHEETS.NO_TITLE');
  }

  private say(key: string, tone: 'ok' | 'error', params?: Record<string, unknown>): void {
    this.message.set({ text: this.translate.instant(key, params), tone });
  }

  async sendLink(p: SheetsParticipantRow): Promise<void> {
    if (this.researchId == null || this.busyId()) return;
    this.busyId.set(p.participantId);
    this.message.set(null);
    const r = await this.api.sheetsLink(this.researchId, p.participantId, true);
    this.busyId.set(null);
    if (r.ok) this.say('SHEETS.MSG_SENT', 'ok');
    else if (r.error === 'NO_EMAIL') this.say('SHEETS.ERR_NO_EMAIL', 'error');
    else if (r.error === 'EMAIL_FAILED') this.say('SHEETS.ERR_EMAIL_FAILED', 'error');
    else if (r.error === 'ALREADY_SUBMITTED') this.say('SHEETS.ERR_SUBMITTED', 'error');
    else if (r.error === 'NO_TEMPLATE') this.say('SHEETS.ERR_NO_TEMPLATE', 'error');
    else this.say('SHEETS.ERR_GENERIC', 'error');
    await this.load(this.researchId);
  }

  async copyLink(p: SheetsParticipantRow): Promise<void> {
    if (this.researchId == null) return;
    let url = p.link && !p.link.expired ? p.link.url : null;
    if (!url) {
      // No usable link yet: make one without emailing it, then copy it.
      const r = await this.api.sheetsLink(this.researchId, p.participantId, false);
      url = r.ok ? r.url ?? null : null;
      await this.load(this.researchId);
    }
    if (!url) { this.say('SHEETS.ERR_GENERIC', 'error'); return; }
    try {
      await navigator.clipboard.writeText(url);
      this.copiedId.set(p.participantId);
      setTimeout(() => this.copiedId.set(null), 2000);
    } catch { /* clipboard unavailable */ }
  }

  async sendAll(): Promise<void> {
    if (this.researchId == null || this.bulkBusy()) return;
    this.bulkBusy.set(true);
    this.message.set(null);
    try {
      const r = await this.api.sheetsSendAll(this.researchId);
      this.say('SHEETS.MSG_BULK', r.failed.length ? 'error' : 'ok', { sent: r.sent, noEmail: r.skippedNoEmail, submitted: r.skippedSubmitted, noTemplate: r.skippedNoTemplate ?? 0, failed: r.failed.length });
    } catch {
      this.say('SHEETS.ERR_GENERIC', 'error');
    } finally {
      this.bulkBusy.set(false);
      await this.load(this.researchId);
    }
  }

  async exportExcel(workbookId?: number): Promise<void> {
    if (this.researchId == null || this.exporting()) return;
    this.exporting.set(true);
    this.message.set(null);
    try {
      await this.api.exportSheets(this.researchId, workbookId);
    } catch {
      this.say('SHEETS.EXPORT_ERROR', 'error');
    } finally {
      this.exporting.set(false);
    }
  }

  async view(p: SheetsParticipantRow): Promise<void> {
    if (this.researchId == null) return;
    try {
      const entry = await this.api.getSheetsEntry(this.researchId, p.participantId);
      this.viewSheet.set(0);
      this.viewing.set({ participantId: p.participantId, entry });
    } catch {
      this.say('SHEETS.ERR_GENERIC', 'error');
    }
  }

  closeView(): void {
    this.viewing.set(null);
  }
}
