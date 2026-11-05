import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AdminApiService, SessionChecklist, SessionChecklistSlot } from '../../services/admin-api.service';

/**
 * The checklist of an experimental session: a template (what is done in every termin) and, for each termin of the session
 * (a time slot for a participant, a group or everyone), its own copy the researcher ticks off and can change (add / remove
 * items for that termin only). Changing the template spreads to the copies; see server/session-checklists/routes.mjs.
 */
@Component({
  selector: 'app-session-checklist',
  standalone: true,
  imports: [TranslateModule, FormsModule, DatePipe],
  templateUrl: './session-checklist.component.html',
  styleUrl: './session-checklist.component.scss',
})
export class SessionChecklistComponent {
  private api = inject(AdminApiService);
  private translate = inject(TranslateService);

  readonly sessionId = input.required<number>();
  /** Bumped by the page when the termini of the session may have changed. */
  readonly refreshKey = input(0);

  readonly data = signal<SessionChecklist | null>(null);
  readonly error = signal(false);
  readonly busy = signal(false);
  readonly message = signal<string | null>(null);

  /** The template as edited on screen (ids of saved items are kept so the server knows what was renamed / removed). */
  readonly templateDraft = signal<{ id?: number; text: string }[]>([]);
  readonly newTemplateItem = signal('');
  readonly newItem = signal<Record<number, string | undefined>>({});
  readonly expanded = signal<Set<number>>(new Set());

  constructor() {
    // reading the inputs is tracked; the loading itself writes signals, so it runs untracked
    effect(() => { const id = this.sessionId(); this.refreshKey(); untracked(() => { void this.load(id); }); });
  }

  private async load(id: number): Promise<void> {
    this.error.set(false);
    try {
      const d = await this.api.getSessionChecklist(id);
      this.data.set(d);
      this.templateDraft.set(d.template.map((t) => ({ id: t.id, text: t.text })));
    } catch {
      this.error.set(true);
    }
  }

  private async reloadKeepingDraft(): Promise<void> {
    try {
      this.data.set(await this.api.getSessionChecklist(this.sessionId()));
    } catch {
      this.error.set(true);
    }
  }

  // ── template ──

  setTemplateText(index: number, text: string): void {
    this.templateDraft.update((l) => l.map((x, i) => (i === index ? { ...x, text } : x)));
  }

  async addTemplateItem(): Promise<void> {
    const text = this.newTemplateItem().trim();
    if (!text) return;
    this.templateDraft.update((l) => [...l, { text }]);
    this.newTemplateItem.set('');
    await this.saveTemplate();
  }

  async removeTemplateItem(index: number): Promise<void> {
    const item = this.templateDraft()[index];
    if (item.id != null && !confirm(this.translate.instant('EXPERIMENTAL_SESSIONS.CHECKLIST_REMOVE_TEMPLATE_CONFIRM'))) return;
    this.templateDraft.update((l) => l.filter((_, i) => i !== index));
    await this.saveTemplate();
  }

  /** Saves the template when an edited item loses focus (only if something actually changed). */
  async commitTemplateText(index: number): Promise<void> {
    const item = this.templateDraft()[index];
    const saved = this.data()?.template.find((t) => t.id === item.id);
    if (item.id != null && saved && saved.text === item.text.trim()) return;
    if (!item.text.trim()) { await this.load(this.sessionId()); return; }
    await this.saveTemplate();
  }

  private async saveTemplate(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    try {
      const res = await this.api.saveSessionChecklistTemplate(this.sessionId(), this.templateDraft().map((x) => ({ id: x.id, text: x.text.trim() })).filter((x) => x.text));
      this.templateDraft.set(res.template.map((t) => ({ id: t.id, text: t.text })));
      await this.reloadKeepingDraft();
      this.message.set('EXPERIMENTAL_SESSIONS.CHECKLIST_SAVED');
    } catch {
      this.message.set('EXPERIMENTAL_SESSIONS.CHECKLIST_ERROR');
      await this.load(this.sessionId());
    } finally {
      this.busy.set(false);
    }
  }

  // ── termin copies ──

  isOpen(s: SessionChecklistSlot): boolean {
    return this.expanded().has(s.slotId);
  }

  toggle(s: SessionChecklistSlot): void {
    this.expanded.update((set) => {
      const n = new Set(set);
      if (n.has(s.slotId)) n.delete(s.slotId); else n.add(s.slotId);
      return n;
    });
  }

  expandAll(open: boolean): void {
    this.expanded.set(open ? new Set((this.data()?.slots ?? []).map((s) => s.slotId)) : new Set());
  }

  get totals(): { done: number; total: number } {
    const ss = this.data()?.slots ?? [];
    return { done: ss.reduce((a, s) => a + s.doneCount, 0), total: ss.reduce((a, s) => a + s.items.length, 0) };
  }

  percent(s: SessionChecklistSlot): number {
    return s.items.length ? Math.round((s.doneCount / s.items.length) * 100) : 0;
  }

  /** Who the termin is for, in words: a group, everyone, or the participants named. */
  audience(s: SessionChecklistSlot): string {
    if (s.audienceType === 'GROUP') return this.translate.instant('EXPERIMENTAL_SESSIONS.CHECKLIST_AUDIENCE_GROUP', { name: s.groupName ?? '' });
    if (s.audienceType === 'ALL') return this.translate.instant('EXPERIMENTAL_SESSIONS.CHECKLIST_AUDIENCE_ALL');
    return s.attendees.length ? s.attendees.join(', ') : this.translate.instant('EXPERIMENTAL_SESSIONS.CHECKLIST_AUDIENCE_NONE');
  }

  async tick(s: SessionChecklistSlot, itemId: number, done: boolean): Promise<void> {
    // show it at once, then let the server confirm
    this.data.update((d) => d && {
      ...d,
      slots: d.slots.map((x) => x.slotId !== s.slotId ? x : {
        ...x,
        items: x.items.map((i) => i.id === itemId ? { ...i, done, doneAt: done ? new Date().toISOString() : null, doneBy: done ? i.doneBy : null } : i),
        doneCount: x.doneCount + (done ? 1 : -1),
      }),
    });
    try {
      await this.api.updateSessionChecklistItem(itemId, { done });
      await this.reloadKeepingDraft();
    } catch {
      this.message.set('EXPERIMENTAL_SESSIONS.CHECKLIST_ERROR');
      await this.reloadKeepingDraft();
    }
  }

  async addItem(s: SessionChecklistSlot): Promise<void> {
    const text = (this.newItem()[s.slotId] ?? '').trim();
    if (!text) return;
    try {
      await this.api.addSessionChecklistItem(this.sessionId(), s.slotId, text);
      this.newItem.update((m) => ({ ...m, [s.slotId]: '' }));
      await this.reloadKeepingDraft();
    } catch {
      this.message.set('EXPERIMENTAL_SESSIONS.CHECKLIST_ERROR');
    }
  }

  async removeItem(itemId: number): Promise<void> {
    try {
      await this.api.deleteSessionChecklistItem(itemId);
      await this.reloadKeepingDraft();
    } catch {
      this.message.set('EXPERIMENTAL_SESSIONS.CHECKLIST_ERROR');
    }
  }

  setNewItem(slotId: number, text: string): void {
    this.newItem.update((m) => ({ ...m, [slotId]: text }));
  }
}
