import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { SelectComponent, SelectOption } from '../shared/select/select.component';
import { ResearchDesignStore } from './research-design-store.service';

type OptionField = 'approach' | 'subjectDesign' | 'timeDimension' | 'factorStructure' | 'controlCondition' | 'blinding';

/** i18n group + allowed values per design field (mirrors server/research-design/routes.mjs DESIGN_FIELDS). */
const FIELDS: Record<OptionField, { group: string; values: string[]; hints: boolean }> = {
  approach: { group: 'APPROACH', values: ['EXPERIMENTAL', 'QUASI_EXPERIMENTAL', 'CORRELATIONAL', 'DESCRIPTIVE'], hints: true },
  subjectDesign: { group: 'SUBJECT', values: ['BETWEEN', 'WITHIN', 'MIXED', 'SINGLE_GROUP'], hints: true },
  timeDimension: { group: 'TIME', values: ['CROSS_SECTIONAL', 'PRE_POST', 'REPEATED', 'CROSSOVER'], hints: true },
  factorStructure: { group: 'FACTOR', values: ['SINGLE_FACTOR', 'FACTORIAL'], hints: false },
  controlCondition: { group: 'CONTROL', values: ['NONE', 'NO_TREATMENT', 'PLACEBO_ACTIVE', 'WAITLIST', 'TREATMENT_AS_USUAL'], hints: false },
  blinding: { group: 'BLINDING', values: ['NONE', 'SINGLE', 'DOUBLE'], hints: false },
};

/**
 * "What kind of study is this" — approach, participant structure, time dimension, factors, control
 * condition, blinding, plus free-text hypotheses/notes. Every field is optional ("not specified").
 */
@Component({
  selector: 'app-design-type-section',
  standalone: true,
  imports: [FormsModule, TranslateModule, SelectComponent],
  templateUrl: './design-type-section.component.html',
  styleUrl: './research-design-sections.scss',
})
export class DesignTypeSectionComponent {
  private translate = inject(TranslateService);
  readonly store = inject(ResearchDesignStore);

  private readonly lang = signal(this.translate.currentLang || 'sr');

  readonly fieldKeys: OptionField[] = ['approach', 'subjectDesign', 'timeDimension', 'factorStructure', 'controlCondition', 'blinding'];

  constructor() {
    this.translate.onLangChange.subscribe((e) => this.lang.set(e.lang));
  }

  readonly options = computed<Record<OptionField, SelectOption[]>>(() => {
    this.lang();
    const out = {} as Record<OptionField, SelectOption[]>;
    for (const key of this.fieldKeys) {
      const f = FIELDS[key];
      out[key] = [
        { value: '', label: this.translate.instant('RESEARCH_DESIGN.NOT_SPECIFIED') },
        ...f.values.map((v) => ({ value: v, label: this.translate.instant(`RESEARCH_DESIGN.${f.group}.${v}`) })),
      ];
    }
    return out;
  });

  group(key: OptionField): string {
    return FIELDS[key].group;
  }

  hasHint(key: OptionField): boolean {
    return FIELDS[key].hints && !!this.store.design()[key];
  }

  value(key: OptionField): string {
    return (this.store.design()[key] as string | null) ?? '';
  }

  set(key: OptionField, v: string | number): void {
    this.store.patchDesign({ [key]: v === '' ? null : v } as never);
  }
}
