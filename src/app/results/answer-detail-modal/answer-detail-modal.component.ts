import { Component, computed, inject, input, output } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { REI40_ITEMS_META, REI40_SUBSCALE_ORDER, Rei40Subscale } from '../../data/rei40-items-meta';
import { BIGFIVE_ITEMS_META, BIGFIVE_FACTOR_ORDER, BigFiveFactor } from '../../data/bigfive-items-meta';

export type AnswerDetailInstrument = 'rei40' | 'bigfive';

interface AnswerRow {
  id: number;
  text: string;
  value: number | string;
  reverse?: boolean;
}

interface AnswerGroup {
  label: string;
  rows: AnswerRow[];
}

const REI40_SUBSCALE_LABEL: Record<Rei40Subscale, string> = {
  RA: 'Rational Ability',
  RE: 'Rational Engagement',
  EA: 'Experiential Ability',
  EE: 'Experiential Engagement',
};

const BIGFIVE_FACTOR_LABEL: Record<BigFiveFactor, string> = {
  O: 'Openness',
  C: 'Conscientiousness',
  E: 'Extraversion',
  A: 'Agreeableness',
  N: 'Neuroticism',
};

/**
 * Per-item raw-answer drill-down for a single REI-40/Big Five result — reachable from a "View
 * answers" action on the raw-data tables (results-rei40/results-bigfive, participant-detail).
 * Only shows aggregated score columns otherwise; this is the one place the actual 1-5 answer to
 * every individual item is visible. Item text/subscale metadata is duplicated locally (see
 * data/rei40-items-meta.ts, data/bigfive-items-meta.ts) rather than fetched from the REI-
 * 40/Big Five apps, matching this project's established per-app duplication convention.
 */
@Component({
  selector: 'app-answer-detail-modal',
  standalone: true,
  imports: [TranslateModule],
  templateUrl: './answer-detail-modal.component.html',
  styleUrl: './answer-detail-modal.component.scss',
})
export class AnswerDetailModalComponent {
  private translate = inject(TranslateService);

  readonly instrument = input.required<AnswerDetailInstrument>();
  readonly participantId = input.required<string>();
  /** Raw {"1": n, "2": n, ...} JSON from Rei40Result.Answers / BigFiveResult.Answers. */
  readonly answers = input.required<Record<string, number> | null>();
  /** Rei40Result.Variant — ignored for Big Five (no variant concept there). */
  readonly variant = input<string | null>(null);

  readonly close = output<void>();

  private itemText(item: { textSr: string; textEn: string }): string {
    return this.translate.currentLang === 'en' ? item.textEn : item.textSr;
  }

  readonly itemsUnavailable = computed(() => {
    if (this.instrument() !== 'rei40') return false;
    return !REI40_ITEMS_META[this.variant() ?? 'v1'];
  });

  readonly groups = computed<AnswerGroup[]>(() => {
    const answers = this.answers();
    if (!answers) return [];

    if (this.instrument() === 'bigfive') {
      return BIGFIVE_FACTOR_ORDER.map((factor) => ({
        label: BIGFIVE_FACTOR_LABEL[factor],
        rows: BIGFIVE_ITEMS_META.filter((item) => item.factor === factor).map((item) => ({
          id: item.id,
          text: this.itemText(item),
          value: answers[item.id] ?? answers[String(item.id)] ?? '—',
        })),
      }));
    }

    const items = REI40_ITEMS_META[this.variant() ?? 'v1'];
    if (!items) return [];
    return REI40_SUBSCALE_ORDER.map((subscale) => ({
      label: REI40_SUBSCALE_LABEL[subscale],
      rows: items
        .filter((item) => item.subscale === subscale)
        .map((item) => ({
          id: item.id,
          text: this.itemText(item),
          value: answers[item.id] ?? answers[String(item.id)] ?? '—',
          reverse: item.reverse,
        })),
    }));
  });
}
