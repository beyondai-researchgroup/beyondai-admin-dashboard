import { Component, inject } from '@angular/core';
import { ToastService } from '../services/toast.service';

/** Mounted once in app.component.html, top-right, above everything else — see ToastService. */
@Component({
  selector: 'app-toast-container',
  standalone: true,
  template: `
    <div class="toast-container">
      @for (t of toast.toasts(); track t.id) {
        <div class="toast">
          <span class="toast__message">{{ t.message }}</span>
          <button type="button" class="toast__close" (click)="toast.dismiss(t.id)" aria-label="Zatvori">✕</button>
        </div>
      }
    </div>
  `,
  styles: [`
    .toast-container {
      position: fixed;
      top: 76px;
      right: 24px;
      z-index: 300;
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 340px;
    }

    .toast {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px 14px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-left: 3px solid var(--color-accent);
      border-radius: var(--radius-input);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
      animation: toast-in 180ms ease-out;
    }

    .toast__message {
      flex: 1;
      font-size: 13px;
      line-height: 1.5;
      color: var(--color-text);
    }

    .toast__close {
      background: transparent;
      border: none;
      color: var(--color-text-secondary);
      cursor: pointer;
      font-size: 12px;
      padding: 0;
      line-height: 1;
    }

    .toast__close:hover {
      color: var(--color-text);
    }

    @keyframes toast-in {
      from { opacity: 0; transform: translateX(16px); }
      to { opacity: 1; transform: translateX(0); }
    }

    @media (prefers-reduced-motion: reduce) {
      .toast { animation: none; }
    }
  `],
})
export class ToastContainerComponent {
  readonly toast = inject(ToastService);
}
