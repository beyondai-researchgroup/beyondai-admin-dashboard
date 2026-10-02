import { Component, input } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

/**
 * A small animated spinner + "Loading…" label — replaces the app's old plain, static
 * `<p>{{ 'COMMON.LOADING' | translate }}</p>` text everywhere (follow-up request, 2026-09-07 —
 * a static string gives no visible sign of activity, so a stalled request and a slow-but-working
 * one look identical). The spin animation itself is what proves something is actually happening;
 * the label is still translated and can be overridden per call site via `label`.
 */
@Component({
  selector: 'app-loading-spinner',
  standalone: true,
  imports: [TranslateModule],
  templateUrl: './loading-spinner.component.html',
  styleUrl: './loading-spinner.component.scss',
})
export class LoadingSpinnerComponent {
  readonly label = input<string>();
}
