import { Component, ElementRef, HostListener, inject, input, output, signal } from '@angular/core';

export interface SelectOption {
  value: string | number;
  label: string;
}

/**
 * Fully CSS-controlled dropdown, used in place of a native <select>. A native <select>'s open
 * option list is rendered by the OS/browser chrome (blue highlight on Windows Chrome, for one)
 * and can't be restyled to match the app's design — this renders its own panel so every color
 * (including the hover/selected state) comes from our own CSS custom properties.
 */
@Component({
  selector: 'app-select',
  standalone: true,
  templateUrl: './select.component.html',
  styleUrl: './select.component.scss',
})
export class SelectComponent {
  private elementRef = inject(ElementRef<HTMLElement>);

  readonly options = input.required<SelectOption[]>();
  readonly value = input<string | number | null>(null);
  readonly placeholder = input('');
  readonly disabled = input(false);

  readonly valueChange = output<string | number>();

  readonly isOpen = signal(false);

  get selectedLabel(): string {
    const opt = this.options().find((o) => this.isSelected(o));
    return opt ? opt.label : this.placeholder();
  }

  isSelected(opt: SelectOption): boolean {
    return String(opt.value) === String(this.value());
  }

  toggle(): void {
    if (this.disabled()) return;
    this.isOpen.set(!this.isOpen());
  }

  select(opt: SelectOption): void {
    this.valueChange.emit(opt.value);
    this.isOpen.set(false);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.elementRef.nativeElement.contains(event.target as Node)) {
      this.isOpen.set(false);
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.isOpen.set(false);
  }
}
