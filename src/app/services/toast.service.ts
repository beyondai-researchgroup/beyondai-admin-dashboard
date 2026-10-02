import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  message: string;
}

const TOAST_DURATION_MS = 6000;

/**
 * App-wide toast queue (2026-08-20) — no existing toast/snackbar system anywhere in this app
 * (confirmed via exploration); the closest precedent was a single local "copied" boolean flash
 * in r-analysis.component.ts. This generalizes that idea into a real stack: `<app-toast-
 * container>` (mounted once in app.component.html) renders `toasts()`, each auto-dismissing
 * after TOAST_DURATION_MS via its own timer.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private nextId = 1;

  show(message: string): void {
    const id = this.nextId++;
    this.toasts.set([...this.toasts(), { id, message }]);
    setTimeout(() => this.dismiss(id), TOAST_DURATION_MS);
  }

  dismiss(id: number): void {
    this.toasts.set(this.toasts().filter((t) => t.id !== id));
  }
}
