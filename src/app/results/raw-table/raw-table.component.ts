import { DatePipe } from '@angular/common';
import { Component, computed, input, output, signal } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

export interface TableColumn {
  key: string;
  label: string;
  /** 'date' renders the raw ISO timestamp through DatePipe instead of as plain text. */
  type?: 'date';
}

type SortDirection = 'asc' | 'desc' | null;

/**
 * Generic read-only data table shared by all three Results views: client-side substring
 * filtering across every column plus click-to-sort column headers (asc → desc → none).
 * Rows/columns are supplied by the parent; sort/filter state lives entirely in here.
 */
@Component({
  selector: 'app-raw-table',
  standalone: true,
  imports: [TranslateModule, DatePipe],
  templateUrl: './raw-table.component.html',
})
export class RawTableComponent {
  /** dd.MM.yyyy. HH:mm — the conventional Serbian date format, used regardless of UI language
   *  since it's unambiguous and this is DB data, not translated chrome text. */
  readonly dateFormat = 'dd.MM.yyyy. HH:mm';

  readonly columns = input.required<TableColumn[]>();
  readonly rows = input.required<Record<string, unknown>[]>();
  /** Optional trailing action column (e.g. "View answers" on the REI-40/Big Five raw tables).
   *  Omitted entirely (no extra column) when not provided — TLX's table is unaffected. */
  readonly rowActionLabel = input<string | null>(null);
  readonly rowAction = output<Record<string, unknown>>();

  readonly filterText = signal('');
  readonly sortKey = signal<string | null>(null);
  readonly sortDir = signal<SortDirection>(null);

  readonly filteredRows = computed(() => {
    const query = this.filterText().trim().toLowerCase();
    if (!query) return this.rows();
    return this.rows().filter((row) =>
      Object.values(row).some((v) => v !== null && v !== undefined && String(v).toLowerCase().includes(query))
    );
  });

  readonly sortedRows = computed(() => {
    const key = this.sortKey();
    const dir = this.sortDir();
    const rows = this.filteredRows();
    if (!key || !dir) return rows;

    const factor = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;

      const an = Number(av);
      const bn = Number(bv);
      if (!Number.isNaN(an) && !Number.isNaN(bn)) return (an - bn) * factor;

      return String(av).localeCompare(String(bv)) * factor;
    });
  });

  onFilterInput(value: string): void {
    this.filterText.set(value);
  }

  toggleSort(key: string): void {
    if (this.sortKey() !== key) {
      this.sortKey.set(key);
      this.sortDir.set('asc');
      return;
    }
    // asc -> desc -> none, cycling back to the original (unsorted/filtered-only) order.
    const next: SortDirection = this.sortDir() === 'asc' ? 'desc' : this.sortDir() === 'desc' ? null : 'asc';
    this.sortDir.set(next);
    if (next === null) this.sortKey.set(null);
  }
}
