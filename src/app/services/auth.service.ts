import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';

const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_KEY = 'admin-token';
const RESEARCHER_KEY = 'admin-researcher';

export interface ResearcherResearchRef {
  id: number;
  name: string;
  /** Role granularity (Phase 6 of the modular-platform plan) — already present in the login
   *  response's JSON (server/auth/routes.mjs), just never typed here until Part B of the platform
   *  re-architecture needed it client-side (gating the Configuration page's Team section to
   *  OWNERs only). */
  role: 'OWNER' | 'COLLABORATOR' | 'VIEWER';
}

export interface Researcher {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  isSuperAdmin: boolean;
  /** Every research this researcher is assigned to (Phase B, 2026-08-18 — was a single
   *  nullable researchId before; a researcher can now belong to several). Always empty for a
   *  superadmin, who sees every research regardless. */
  researches: ResearcherResearchRef[];
}

interface LoginResponse {
  token: string;
  researcher: Researcher;
}

/**
 * Holds the Admin Dashboard's JWT + logged-in researcher, persisted to localStorage so a
 * page refresh doesn't force a re-login. There is no self-registration — researcher accounts
 * are provisioned via the Researchers management page (superadmin only).
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);

  private readonly _token = signal<string | null>(this.restore(TOKEN_KEY));
  private readonly _researcher = signal<Researcher | null>(this.restoreResearcher());

  readonly token = this._token.asReadonly();
  readonly researcher = this._researcher.asReadonly();
  readonly isLoggedIn = computed(() => this._token() !== null);

  async login(email: string, password: string): Promise<void> {
    const res = await firstValueFrom(
      this.http
        .post<LoginResponse>('/api/admin/auth/login', { email, password })
        .pipe(timeout(REQUEST_TIMEOUT_MS))
    );
    this._token.set(res.token);
    this._researcher.set(res.researcher);
    try {
      localStorage.setItem(TOKEN_KEY, res.token);
      localStorage.setItem(RESEARCHER_KEY, JSON.stringify(res.researcher));
    } catch { /* ignore */ }
  }

  /** Called after a self-service profile edit so the header/nav's cached name updates without
   *  requiring a re-login. */
  updateCachedResearcher(patch: Partial<Researcher>): void {
    const current = this._researcher();
    if (!current) return;
    const updated = { ...current, ...patch };
    this._researcher.set(updated);
    try {
      localStorage.setItem(RESEARCHER_KEY, JSON.stringify(updated));
    } catch { /* ignore */ }
  }

  logout(): void {
    this._token.set(null);
    this._researcher.set(null);
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(RESEARCHER_KEY);
    } catch { /* ignore */ }
  }

  private restore(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  private restoreResearcher(): Researcher | null {
    try {
      const raw = localStorage.getItem(RESEARCHER_KEY);
      return raw ? (JSON.parse(raw) as Researcher) : null;
    } catch {
      return null;
    }
  }
}
