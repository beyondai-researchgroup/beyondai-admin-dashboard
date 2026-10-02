import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { GlobalHeaderComponent } from './global-header/global-header.component';
import { ToastContainerComponent } from './toast/toast-container.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, GlobalHeaderComponent, ToastContainerComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
  private translate = inject(TranslateService);

  constructor() {
    this.translate.setDefaultLang('sr');
    let lang = 'sr';
    try { lang = localStorage.getItem('admin-lang') === 'en' ? 'en' : 'sr'; } catch { /* ignore */ }
    this.translate.use(lang);
  }
}