import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'admin-selected-research';

/**
 * The research currently in view. For a superadmin this is whatever they picked in the
 * research picker (persisted across a refresh); for a scoped researcher it's always their
 * own research id, set once by the dashboard shell on login and never changed client-side —
 * the server enforces this independently via scope.mjs, this is purely for UI convenience.
 */
@Injectable({ providedIn: 'root' })
export class ScopeService {
  readonly selectedResearchId = signal<number | null>(this.restore());

  select(id: number | null): void {
    this.selectedResearchId.set(id);
    try {
      if (id == null) sessionStorage.removeItem(STORAGE_KEY);
      else sessionStorage.setItem(STORAGE_KEY, String(id));
    } catch { /* ignore */ }
  }

  private restore(): number | null {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? Number(raw) : null;
    } catch {
      return null;
    }
  }
}
