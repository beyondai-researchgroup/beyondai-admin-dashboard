import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { VariableRole } from '../services/admin-api.service';
import { SelectComponent, SelectOption } from '../shared/select/select.component';
import { ResearchDesignStore } from './research-design-store.service';

const ROLES: VariableRole[] = ['INDEPENDENT', 'DEPENDENT', 'CONTROL', 'MODERATOR', 'MEDIATOR', 'COVARIATE'];

/**
 * Optional list of the study's variables: independent / dependent / control (and moderator, mediator,
 * covariate). An independent variable lists its levels (e.g. control, treatment), which can later be
 * turned into groups in one click. The whole step can be skipped.
 */
@Component({
  selector: 'app-variables-section',
  standalone: true,
  imports: [FormsModule, TranslateModule, SelectComponent],
  templateUrl: './variables-section.component.html',
  styleUrl: './research-design-sections.scss',
})
export class VariablesSectionComponent {
  private translate = inject(TranslateService);
  readonly store = inject(ResearchDesignStore);

  private readonly lang = signal(this.translate.currentLang || 'sr');
  readonly newRole = signal<VariableRole>('INDEPENDENT');
  /** Text being typed into each variable's "add level" field, by variable index. */
  readonly levelDraft = signal<Record<number, string | undefined>>({});

  constructor() {
    this.translate.onLangChange.subscribe((e) => this.lang.set(e.lang));
  }

  readonly roleOptions = computed<SelectOption[]>(() => {
    this.lang();
    return ROLES.map((r) => ({ value: r, label: this.translate.instant('RESEARCH_DESIGN.VAR_ROLE.' + r) }));
  });

  setDraft(i: number, text: string): void {
    this.levelDraft.update((d) => ({ ...d, [i]: text }));
  }

  addLevel(i: number): void {
    const text = (this.levelDraft()[i] ?? '').trim();
    if (!text) return;
    const current = this.store.variables()[i];
    if (!current.levels.some((l) => l.toLowerCase() === text.toLowerCase()) && current.levels.length < 20) {
      this.store.patchVariable(i, { levels: [...current.levels, text.slice(0, 100)] });
    }
    this.setDraft(i, '');
  }

  removeLevel(i: number, level: string): void {
    this.store.patchVariable(i, { levels: this.store.variables()[i].levels.filter((l) => l !== level) });
  }

  onRole(i: number, value: string | number): void {
    this.store.patchVariable(i, { role: value as VariableRole });
  }
}
