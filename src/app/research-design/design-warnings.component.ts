import { Component, inject } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { ResearchDesignStore } from './research-design-store.service';

/** Soft remarks about the design (e.g. "an experiment normally assigns participants at random"). Never blocks saving. */
@Component({
  selector: 'app-design-warnings',
  standalone: true,
  imports: [TranslateModule],
  template: `
    @if (store.warnings().length) {
      <ul class="warnings">
        @for (w of store.warnings(); track w.key) {
          <li [class.warnings__info]="w.level === 'info'">{{ 'RESEARCH_DESIGN.WARN.' + w.key | translate }}</li>
        }
      </ul>
    }
  `,
  styles: [`
    .warnings { list-style: none; margin: 16px 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    li {
      padding: 10px 14px;
      font-size: 13px;
      line-height: 1.5;
      color: var(--color-text);
      background: var(--color-error-bg);
      border: 1px solid var(--color-error-border);
      border-radius: var(--radius-input);
    }
    li.warnings__info {
      color: var(--color-text-secondary);
      background: var(--color-bg);
      border-color: var(--color-border);
    }
  `],
})
export class DesignWarningsComponent {
  readonly store = inject(ResearchDesignStore);
}
