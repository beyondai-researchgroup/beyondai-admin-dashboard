import { Component, computed, inject, input, output } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { postSessionQuestions, PostSessionQuestionMeta } from '../../data/post-session-questions-meta';

interface AnswerRow {
  key: string;
  prompt: string;
  low: string | null;
  high: string | null;
  value: number | string;
}

/**
 * Read-only Q&A view for the post-session questionnaire (2026-10-01) — reached via a "Dopunski
 * podaci" action on the NASA-TLX raw table (participant-detail.component), same mechanism as
 * answer-detail-modal.component for REI-40/Big Five. Not a separate Results page — supplementary
 * data for one TLX row, same shell/CSS as answer-detail-modal (duplicated per this project's own
 * per-component-styling convention).
 */
@Component({
  selector: 'app-post-session-answers-modal',
  standalone: true,
  imports: [TranslateModule],
  templateUrl: './post-session-answers-modal.component.html',
  styleUrl: './post-session-answers-modal.component.scss',
})
export class PostSessionAnswersModalComponent {
  private translate = inject(TranslateService);

  /** Sessions.Id (1=Intro, 2=AI, 3=Report, 4=Hybrid) — picks Q4's wording. */
  readonly sessionId = input.required<number>();
  /** PostSessionResponse.Answers, or null if the participant hasn't submitted it yet. */
  readonly answers = input.required<Record<string, unknown> | null>();

  readonly close = output<void>();

  private text(meta: PostSessionQuestionMeta): string {
    return this.translate.currentLang === 'en' ? meta.textEn : meta.textSr;
  }
  private low(meta: PostSessionQuestionMeta): string | null {
    if (meta.lowSr === undefined) return null;
    return this.translate.currentLang === 'en' ? meta.lowEn! : meta.lowSr;
  }
  private high(meta: PostSessionQuestionMeta): string | null {
    if (meta.highSr === undefined) return null;
    return this.translate.currentLang === 'en' ? meta.highEn! : meta.highSr;
  }

  readonly rows = computed<AnswerRow[]>(() => {
    const answers = this.answers();
    if (!answers) return [];
    return postSessionQuestions(this.sessionId()).map((meta) => ({
      key: meta.key,
      prompt: this.text(meta),
      low: this.low(meta),
      high: this.high(meta),
      value: (answers[meta.key] as number | string | null) ?? '—',
    }));
  });
}
