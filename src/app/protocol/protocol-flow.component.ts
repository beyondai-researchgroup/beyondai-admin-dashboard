import { Component, computed, inject, input, signal } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ProtocolStep, ReviewMode, ResearchGroupData } from '../services/admin-api.service';

interface FlowNode {
  step: ProtocolStep;
  index: number;
  title: string;
  /** Who moves this step forward: the participant (opens a link and finishes it), nobody (a message), or the researcher by hand. */
  actor: 'PARTICIPANT' | 'RESEARCHER' | 'NONE';
  /** Wait shown on the connector leading INTO this step (null for the first step or an immediate one). */
  gap: { kind: 'DELAY'; days: number } | { kind: 'MANUAL' } | null;
  details: { label: string; value: string }[];
}

/**
 * A read-only diagram of a protocol: the steps top to bottom as a flow, with the wait between them on the
 * connectors and who acts on each one. Used by the study wizard's review, and small enough for any page.
 */
@Component({
  selector: 'app-protocol-flow',
  standalone: true,
  imports: [TranslateModule],
  template: `
    @if (nodes().length === 0) {
      <p class="flow-empty">{{ 'PROTOCOL_FLOW.EMPTY' | translate }}</p>
    } @else {
      <ol class="flow">
        @for (n of nodes(); track n.step.id) {
          @if (n.gap; as gap) {
            <li class="flow-gap" aria-hidden="true">
              <span class="flow-gap__line"></span>
              <span class="flow-gap__label">
                @if (gap.kind === 'DELAY') {
                  {{ 'PROTOCOL_FLOW.GAP_DELAY' | translate: { count: gap.days } }}
                } @else {
                  {{ 'PROTOCOL_FLOW.GAP_MANUAL' | translate }}
                }
              </span>
            </li>
          } @else if (n.index > 0) {
            <li class="flow-gap flow-gap--plain" aria-hidden="true"><span class="flow-gap__line"></span></li>
          }
          <li class="flow-node" [class.flow-node--researcher]="n.actor === 'RESEARCHER'" [class.flow-node--none]="n.actor === 'NONE'">
            <span class="flow-node__num">{{ n.index + 1 }}</span>
            <div class="flow-node__card">
              <div class="flow-node__head">
                <span class="flow-node__title">{{ n.title }}</span>
                <span class="flow-node__type">{{ 'PROTOCOL.TYPE_' + n.step.stepType | translate }}</span>
              </div>
              <div class="flow-node__actor">
                <span class="flow-node__dot"></span>
                {{ 'PROTOCOL_FLOW.ACTOR_' + n.actor | translate }}
              </div>
              @if (n.details.length) {
                <dl class="flow-node__details">
                  @for (d of n.details; track d.label) {
                    <dt>{{ d.label }}</dt>
                    <dd>{{ d.value }}</dd>
                  }
                </dl>
              }
            </div>
          </li>
        }
      </ol>
      <div class="flow-legend">
        <span class="flow-legend__item"><span class="flow-node__dot"></span>{{ 'PROTOCOL_FLOW.LEGEND_PARTICIPANT' | translate }}</span>
        <span class="flow-legend__item flow-legend__item--researcher"><span class="flow-node__dot"></span>{{ 'PROTOCOL_FLOW.LEGEND_RESEARCHER' | translate }}</span>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .flow { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .flow-empty { margin: 0; color: var(--color-text-secondary); }

    .flow-node { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 14px; align-items: start; }
    .flow-node__num {
      width: 36px; height: 36px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 14px;
      color: var(--color-on-accent); background: var(--color-accent);
    }
    .flow-node--researcher .flow-node__num {
      color: var(--color-text); background: var(--color-surface-alt); border: 2px dashed var(--color-border-strong);
    }
    .flow-node--none .flow-node__num { background: var(--color-text-secondary); }

    .flow-node__card {
      min-width: 0; padding: 12px 14px;
      background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-input);
    }
    .flow-node__head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 12px; }
    .flow-node__title { font-weight: 700; overflow-wrap: anywhere; }
    .flow-node__type {
      font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-text-secondary);
      padding: 2px 8px; border: 1px solid var(--color-border-strong); border-radius: var(--radius-tag); white-space: nowrap;
    }
    .flow-node__actor { margin-top: 6px; display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--color-text-secondary); }
    .flow-node__dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-accent); flex: none; }
    .flow-node--researcher .flow-node__dot, .flow-legend__item--researcher .flow-node__dot { background: transparent; border: 2px solid var(--color-text-secondary); box-sizing: border-box; }
    .flow-node--none .flow-node__dot { background: var(--color-text-secondary); }

    .flow-node__details { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 14px; margin: 10px 0 0; font-size: 13px; }
    .flow-node__details dt { color: var(--color-text-secondary); }
    .flow-node__details dd { margin: 0; overflow-wrap: anywhere; }

    .flow-gap { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 14px; align-items: center; min-height: 34px; }
    .flow-gap__line { justify-self: center; width: 2px; height: 100%; min-height: 34px; background: var(--color-border-strong); }
    .flow-gap--plain { min-height: 18px; }
    .flow-gap--plain .flow-gap__line { min-height: 18px; }
    .flow-gap__label { font-size: 12px; color: var(--color-text-secondary); font-style: italic; }

    .flow-legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 14px; font-size: 12px; color: var(--color-text-secondary); }
    .flow-legend__item { display: inline-flex; align-items: center; gap: 7px; }
  `],
})
export class ProtocolFlowComponent {
  private translate = inject(TranslateService);

  readonly steps = input.required<ProtocolStep[]>();
  readonly groups = input<ResearchGroupData[]>([]);

  private readonly lang = signal(this.translate.currentLang || 'sr');

  constructor() {
    this.translate.onLangChange.subscribe((e) => this.lang.set(e.lang));
  }

  readonly nodes = computed<FlowNode[]>(() => {
    const lang = this.lang();
    return this.steps().map((step, index) => {
      const prev = index > 0 ? this.steps()[index - 1] : null;
      return {
        step,
        index,
        title: (lang === 'en' ? step.titleEn : step.titleSr) || step.titleSr || step.titleEn,
        actor: this.actor(step),
        gap: prev ? this.gap(step) : null,
        details: this.details(step),
      };
    });
  });

  private actor(step: ProtocolStep): FlowNode['actor'] {
    if (step.stepType === 'MESSAGE') return 'NONE';
    if (step.stepType === 'MANUAL') return 'RESEARCHER';
    if (step.stepType === 'EXPERIMENT' && step.config.taskKind === 'OTHER') return 'RESEARCHER';
    return 'PARTICIPANT';
  }

  private gap(step: ProtocolStep): FlowNode['gap'] {
    if (step.delivery === 'AFTER_DELAY') return { kind: 'DELAY', days: step.delayDays ?? 0 };
    if (step.delivery === 'MANUAL' && step.stepType !== 'MANUAL') return { kind: 'MANUAL' };
    return null;
  }

  private details(step: ProtocolStep): FlowNode['details'] {
    const t = (key: string, params?: object) => this.translate.instant(key, params);
    const out: FlowNode['details'] = [];
    if (step.stepType === 'EXPERIMENT' && step.config.taskKind) {
      out.push({ label: t('PROTOCOL.TASK_KIND_LABEL'), value: t('PROTOCOL.TASK_KIND.' + step.config.taskKind) });
      if (step.config.taskKind === 'CODE_REVIEW') {
        const mode = (m: ReviewMode | undefined) => t('PROTOCOL.REVIEW_MODE.' + (m ?? 'AI'));
        out.push({ label: t('PROTOCOL.REVIEW_DEFAULT_MODE'), value: mode(step.config.defaultMode) });
        for (const m of step.config.modeByGroup ?? []) {
          const g = this.groups().find((x) => x.id === m.groupId);
          if (g) out.push({ label: g.name, value: mode(m.mode) });
        }
        if (step.config.includeIntro) out.push({ label: t('PROTOCOL_FLOW.INTRO'), value: t('PROTOCOL_FLOW.YES') });
      }
    }
    if (step.stepType === 'EXTERNAL_LINK' && step.config.url) out.push({ label: t('PROTOCOL.URL_LABEL'), value: step.config.url });
    return out;
  }
}
