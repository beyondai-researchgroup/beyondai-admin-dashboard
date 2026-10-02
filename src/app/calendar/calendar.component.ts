import { Component, inject, signal, computed } from '@angular/core';
import { Router } from '@angular/router';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { DragDropModule, CdkDragDrop } from '@angular/cdk/drag-drop';
import { AdminApiService, ExperimentalSessionSummary } from '../services/admin-api.service';
import { ScopeService } from '../services/scope.service';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';

interface CalendarDay {
  date: Date;
  dateKey: string;
  inMonth: boolean;
  isToday: boolean;
}

const WEEKDAY_KEYS_MON_FIRST = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

/** YYYY-MM-DD using LOCAL date parts (not UTC) — matches how the rest of this app already
 *  displays ExperimentalSession.SessionDate (a Postgres DATE serialized as a UTC-midnight
 *  timestamp, which Angular's DatePipe elsewhere also renders via local-timezone conversion —
 *  using getUTC* here would silently shift everything back a day for this dev setup). */
function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Month-grid calendar of every Experimental Session (across the whole research scope) —
 * complements the tabular list page with an at-a-glance view of what's scheduled when. Sessions
 * are draggable between days (rescheduling — updates SessionDate via the same PUT /:id endpoint
 * the detail page's general-info form already uses); a plain click on a chip opens that session's
 * detail page instead. Clicking empty space in a day cell opens the create modal pre-filled with
 * that date.
 */
@Component({
  selector: 'app-calendar',
  standalone: true,
  imports: [TranslateModule, ReactiveFormsModule, DragDropModule, LoadingSpinnerComponent],
  templateUrl: './calendar.component.html',
  styleUrl: './calendar.component.scss',
})
export class CalendarComponent {
  private api = inject(AdminApiService);
  private scope = inject(ScopeService);
  private router = inject(Router);
  private fb = inject(FormBuilder);
  private translate = inject(TranslateService);

  readonly weekdayKeys = WEEKDAY_KEYS_MON_FIRST;

  readonly viewMonth = signal<Date>(this.firstOfMonth(new Date()));
  readonly sessions = signal<ExperimentalSessionSummary[]>([]);
  readonly loading = signal(false);
  readonly error = signal(false);

  readonly monthLabel = computed(() => {
    this.translate.currentLang; // re-evaluate on language change
    return this.viewMonth().toLocaleDateString(this.translate.currentLang === 'en' ? 'en-US' : 'sr-Latn-RS', {
      month: 'long',
      year: 'numeric',
    });
  });

  private readonly sessionsByDate = computed(() => {
    const map = new Map<string, ExperimentalSessionSummary[]>();
    for (const s of this.sessions()) {
      const key = dateKey(new Date(s.sessionDate));
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    return map;
  });

  readonly weeks = computed<CalendarDay[][]>(() => {
    const month = this.viewMonth();
    const year = month.getFullYear();
    const monthIndex = month.getMonth();
    const firstOfMonth = new Date(year, monthIndex, 1);
    // Monday-first grid: back up to the Monday on/before the 1st.
    const firstWeekday = (firstOfMonth.getDay() + 6) % 7; // 0=Mon..6=Sun
    const gridStart = new Date(year, monthIndex, 1 - firstWeekday);
    const today = dateKey(new Date());

    const days: CalendarDay[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      days.push({ date: d, dateKey: dateKey(d), inMonth: d.getMonth() === monthIndex, isToday: dateKey(d) === today });
    }
    const weeks: CalendarDay[][] = [];
    for (let i = 0; i < 42; i += 7) weeks.push(days.slice(i, i + 7));
    return weeks;
  });

  readonly dropListIds = computed(() => this.weeks().flat().map((d) => 'day-' + d.dateKey));

  readonly showCreateModal = signal(false);
  readonly creating = signal(false);
  readonly createError = signal(false);
  form = this.fb.group({ sessionDate: [''], label: [''], notes: [''] });

  constructor() {
    toObservable(this.scope.selectedResearchId).subscribe((researchId) => {
      this.load(researchId);
    });
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

  entriesFor(day: CalendarDay): ExperimentalSessionSummary[] {
    return this.sessionsByDate().get(day.dateKey) ?? [];
  }

  private firstOfMonth(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  prevMonth(): void {
    const m = this.viewMonth();
    this.viewMonth.set(new Date(m.getFullYear(), m.getMonth() - 1, 1));
  }
  nextMonth(): void {
    const m = this.viewMonth();
    this.viewMonth.set(new Date(m.getFullYear(), m.getMonth() + 1, 1));
  }
  goToday(): void {
    this.viewMonth.set(this.firstOfMonth(new Date()));
  }

  openSession(entry: ExperimentalSessionSummary, event: MouseEvent): void {
    event.stopPropagation();
    this.router.navigate(['/experimental-sessions', entry.id]);
  }

  async onDrop(event: CdkDragDrop<ExperimentalSessionSummary[]>, day: CalendarDay): Promise<void> {
    if (event.previousContainer === event.container) return; // dropped back on the same day, no-op
    const entry = event.item.data as ExperimentalSessionSummary;
    if (dateKey(new Date(entry.sessionDate)) === day.dateKey) return;

    // Optimistic move so the UI doesn't wait on the network before reflecting the drop.
    this.sessions.update((all) => all.map((s) => (s.id === entry.id ? { ...s, sessionDate: day.dateKey } : s)));
    try {
      await this.api.updateExperimentalSession(entry.id, {
        sessionDate: day.dateKey,
        label: entry.label,
        notes: entry.notes,
      });
    } catch {
      // Revert on failure.
      this.sessions.update((all) => all.map((s) => (s.id === entry.id ? { ...s, sessionDate: entry.sessionDate } : s)));
      this.error.set(true);
    }
  }

  openCreateModal(day: CalendarDay): void {
    this.form.setValue({ sessionDate: day.dateKey, label: '', notes: '' });
    this.createError.set(false);
    this.showCreateModal.set(true);
  }

  closeCreateModal(): void {
    if (this.creating()) return;
    this.showCreateModal.set(false);
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
