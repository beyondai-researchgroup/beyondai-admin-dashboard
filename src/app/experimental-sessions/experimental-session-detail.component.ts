import { Component, HostListener, inject, signal, computed } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';
import {
  AdminApiService,
  ExperimentalSessionDetail,
  ExperimentalSessionParticipantRow,
  ParticipantRow,
} from '../services/admin-api.service';
import { SelectComponent, SelectOption } from '../shared/select/select.component';
import { MAX_TAGS, PREDEFINED_TAGS, PredefinedTag, predefinedTagLabel, predefinedTagTone } from './session-tags';

/**
 * Master-detail page for a single Experimental Session: general Label/SessionDate/Notes at the
 * top (the whole physical event), and below, the table of ParticipantSession rows assigned to
 * it — each with its own editable Notes/tags and an Unassign action — plus a control to assign
 * more participant-sessions from this research.
 */
@Component({
  selector: 'app-experimental-session-detail',
  standalone: true,
  imports: [TranslateModule, ReactiveFormsModule, RouterLink, DatePipe, SelectComponent, LoadingSpinnerComponent],
  templateUrl: './experimental-session-detail.component.html',
  styleUrl: './experimental-session-detail.component.scss',
})
export class ExperimentalSessionDetailComponent {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(AdminApiService);
  private fb = inject(FormBuilder);
  private translate = inject(TranslateService);

  readonly id = Number(this.route.snapshot.paramMap.get('id'));
  readonly dateFormat = 'dd.MM.yyyy.';

  readonly loading = signal(true);
  readonly notFound = signal(false);
  readonly session = signal<ExperimentalSessionDetail | null>(null);

  readonly saving = signal(false);
  readonly saveError = signal(false);
  readonly saved = signal(false);

  readonly deleting = signal(false);
  readonly deleteError = signal(false);

  form = this.fb.group({
    sessionDate: [''],
    label: [''],
    notes: [''],
  });

  // Per-row note-editing state, keyed "participantId:sessionId" — avoids a save button per row
  // firing on every keystroke; edits are local until "Save note" is clicked for that row.
  readonly noteDrafts = signal<Record<string, string>>({});
  readonly noteSaving = signal<string | null>(null);

  // Assign control
  readonly participants = signal<ParticipantRow[]>([]);
  readonly assignParticipantId = signal<string | null>(null);
  readonly assignSessionId = signal<number | null>(null);
  readonly assignTime = signal<string>('');
  readonly assigning = signal(false);
  readonly assignErrorCode = signal<'ALREADY_ASSIGNED' | 'SERVER_ERROR' | null>(null);

  // A dropdown of 15-minute slots (07:00–20:45) instead of a native <input type="time">: the
  // native control's own value binding fights Angular's [value]/(input) pattern (every keystroke
  // re-sets [value], which can reset the control's internal cursor/segment mid-type), and its
  // little clock-icon affordance is easy to miss — it ends up feeling like a fussy text field
  // rather than a picker. Every real scheduled time in this app so far already lands on a
  // 15-minute mark, so this loses no precision that was actually being used.
  readonly timeOptions: SelectOption[] = Array.from({ length: 14 }, (_, h) => h + 7).flatMap((h) =>
    [0, 15, 30, 45].map((m) => {
      const label = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      return { value: label, label };
    })
  );

  readonly participantOptions = computed<SelectOption[]>(() =>
    this.participants().map((p) => ({ value: p.participantId, label: p.participantId }))
  );
  // Only sessions that are unassigned, or already assigned to THIS experimental session, are
  // offered — an already-assigned-elsewhere session must be unassigned first (server also
  // enforces this with a 409, this just keeps the picker from ever offering the conflict).
  readonly sessionOptions = computed<SelectOption[]>(() => {
    const p = this.participants().find((x) => x.participantId === this.assignParticipantId());
    if (!p) return [];
    return p.sessions
      .filter((s) => s.experimentalSessionId == null || s.experimentalSessionId === this.id)
      .map((s) => ({ value: s.sessionId, label: s.sessionName }));
  });

  // Tag editing
  readonly predefinedTags = PREDEFINED_TAGS;
  readonly maxTags = MAX_TAGS;
  readonly tagPickerOpenFor = signal<string | null>(null);
  readonly customTagDraft = signal('');

  tagLabel(id: string): string {
    return predefinedTagLabel(id, this.translate.currentLang);
  }
  tagTone(id: string): 'positive' | 'negative' | 'neutral' {
    return predefinedTagTone(id) ?? 'neutral';
  }
  availablePredefinedTags(row: ExperimentalSessionParticipantRow): PredefinedTag[] {
    return this.predefinedTags.filter((t) => !row.tags.includes(t.id));
  }

  constructor() {
    this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.notFound.set(false);
    try {
      const detail = await this.api.getExperimentalSession(this.id);
      this.session.set(detail);
      this.form.setValue({
        sessionDate: detail.sessionDate,
        label: detail.label ?? '',
        notes: detail.notes ?? '',
      });
      this.participants.set(await this.api.getParticipants(detail.researchId));
    } catch {
      this.notFound.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  async saveGeneral(): Promise<void> {
    if (this.saving() || !this.form.value.sessionDate) return;
    this.saving.set(true);
    this.saveError.set(false);
    this.saved.set(false);
    try {
      await this.api.updateExperimentalSession(this.id, {
        sessionDate: this.form.value.sessionDate!,
        label: this.form.value.label?.trim() || null,
        notes: this.form.value.notes?.trim() || null,
      });
      this.saved.set(true);
    } catch {
      this.saveError.set(true);
    } finally {
      this.saving.set(false);
    }
  }

  async deleteSession(): Promise<void> {
    if (this.deleting()) return;
    if (!confirm(this.translate.instant('EXPERIMENTAL_SESSIONS.DELETE_CONFIRM'))) return;

    this.deleting.set(true);
    this.deleteError.set(false);
    try {
      await this.api.deleteExperimentalSession(this.id);
      this.router.navigate(['/experimental-sessions']);
    } catch {
      this.deleteError.set(true);
      this.deleting.set(false);
    }
  }

  rowKey(row: ExperimentalSessionParticipantRow): string {
    return `${row.participantId}:${row.sessionId}`;
  }

  noteDraft(row: ExperimentalSessionParticipantRow): string {
    const key = this.rowKey(row);
    return this.noteDrafts()[key] ?? row.notes ?? '';
  }

  onNoteInput(row: ExperimentalSessionParticipantRow, value: string): void {
    this.noteDrafts.update((d) => ({ ...d, [this.rowKey(row)]: value }));
  }

  async saveNote(row: ExperimentalSessionParticipantRow): Promise<void> {
    const key = this.rowKey(row);
    if (this.noteSaving()) return;
    this.noteSaving.set(key);
    try {
      const value = this.noteDraft(row).trim() || null;
      await this.api.updateParticipantSessionNotes(row.participantId, row.sessionId, value);
      // Reflect the saved value back into the loaded session's row so a page reload isn't needed.
      this.session.update((s) =>
        s
          ? {
              ...s,
              participantSessions: s.participantSessions.map((r) =>
                r.participantId === row.participantId && r.sessionId === row.sessionId ? { ...r, notes: value } : r
              ),
            }
          : s
      );
    } finally {
      this.noteSaving.set(null);
    }
  }

  async unassign(row: ExperimentalSessionParticipantRow): Promise<void> {
    await this.api.unassignParticipantSession(this.id, row.participantId, row.sessionId);
    this.session.update((s) =>
      s ? { ...s, participantSessions: s.participantSessions.filter((r) => r !== row) } : s
    );
    // The participant's session picker filter (sessionOptions) relies on experimentalSessionId
    // being current — refresh so an unassigned session immediately becomes assignable again.
    this.participants.set(await this.api.getParticipants(this.session()?.researchId ?? null));
  }

  async assign(): Promise<void> {
    const participantId = this.assignParticipantId();
    const sessionId = this.assignSessionId();
    const time = this.assignTime();
    if (this.assigning() || !participantId || sessionId == null || !time) return;

    this.assigning.set(true);
    this.assignErrorCode.set(null);
    const result = await this.api.assignParticipantSession(this.id, participantId, sessionId, time);
    if (result.ok) {
      await this.load();
      this.assignParticipantId.set(null);
      this.assignSessionId.set(null);
      this.assignTime.set('');
    } else {
      this.assignErrorCode.set(result.error);
    }
    this.assigning.set(false);
  }

  private async saveTags(row: ExperimentalSessionParticipantRow, tags: string[]): Promise<void> {
    await this.api.updateParticipantSessionTags(row.participantId, row.sessionId, tags);
    this.session.update((s) =>
      s
        ? {
            ...s,
            participantSessions: s.participantSessions.map((r) =>
              r.participantId === row.participantId && r.sessionId === row.sessionId ? { ...r, tags } : r
            ),
          }
        : s
    );
  }

  addPredefinedTag(row: ExperimentalSessionParticipantRow, tagId: string): void {
    if (row.tags.includes(tagId) || row.tags.length >= this.maxTags) return;
    this.saveTags(row, [...row.tags, tagId]);
  }

  addCustomTag(row: ExperimentalSessionParticipantRow): void {
    const value = this.customTagDraft().trim();
    if (!value || row.tags.includes(value) || row.tags.length >= this.maxTags) return;
    this.saveTags(row, [...row.tags, value]);
    this.customTagDraft.set('');
  }

  removeTag(row: ExperimentalSessionParticipantRow, tagId: string): void {
    this.saveTags(row, row.tags.filter((t) => t !== tagId));
  }

  toggleTagPicker(row: ExperimentalSessionParticipantRow): void {
    const key = this.rowKey(row);
    this.customTagDraft.set('');
    this.tagPickerOpenFor.set(this.tagPickerOpenFor() === key ? null : key);
  }

  closeTagPicker(): void {
    this.tagPickerOpenFor.set(null);
  }

  // Clicks inside the tags cell (the toggle button, the picker itself, tag removal, …) call
  // stopPropagation in the template so they never reach here — this only fires for clicks
  // anywhere else on the page, closing whichever picker is open. Escape closes it too.
  @HostListener('document:click')
  onDocumentClick(): void {
    if (this.tagPickerOpenFor() !== null) this.closeTagPicker();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeTagPicker();
  }
}
