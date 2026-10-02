import { Injectable, inject, signal } from '@angular/core';
import { AdminApiService, ResearchSummary } from './admin-api.service';

/**
 * Single shared source of truth for the superadmin's research list, so the sidebar picker
 * and the Researches management page always agree — e.g. creating a research on the
 * management page immediately shows up in the picker without a full reload.
 */
@Injectable({ providedIn: 'root' })
export class ResearchesStoreService {
  private api = inject(AdminApiService);

  readonly researches = signal<ResearchSummary[]>([]);
  readonly loading = signal(false);
  readonly loaded = signal(false);

  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      this.researches.set(await this.api.getResearches());
      this.loaded.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /** Loads once; subsequent calls are no-ops unless forceReload is set. */
  async ensureLoaded(forceReload = false): Promise<void> {
    if (this.loaded() && !forceReload) return;
    await this.reload();
  }
}
