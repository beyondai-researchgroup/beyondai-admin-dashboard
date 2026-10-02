import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [ReactiveFormsModule, TranslateModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent {
  private fb = inject(FormBuilder);
  private auth = inject(AuthService);
  private router = inject(Router);
  private translate = inject(TranslateService);

  readonly isChecking = signal(false);
  readonly loginFailed = signal(false);

  // Language is chosen here once, before/at login, and locked afterward — the header's language
  // toggle is commented out for exactly this reason. Mirrors global-header.component.ts's setLang.
  readonly currentLang = signal(this.translate.currentLang || 'sr');

  setLang(lang: string): void {
    this.translate.use(lang);
    this.currentLang.set(lang);
    try { localStorage.setItem('admin-lang', lang); } catch { /* ignore */ }
  }

  form = this.fb.group({
    email: ['', [Validators.required, Validators.email, Validators.maxLength(255)]],
    password: ['', [Validators.required, Validators.maxLength(200)]],
  });

  onInput(): void {
    this.loginFailed.set(false);
  }

  async submit(): Promise<void> {
    if (this.form.invalid || this.isChecking()) return;

    const email = this.form.value.email!.trim();
    const password = this.form.value.password!;

    this.loginFailed.set(false);
    this.isChecking.set(true);

    try {
      await this.auth.login(email, password);
    } catch {
      this.loginFailed.set(true);
      this.isChecking.set(false);
      return;
    }

    this.isChecking.set(false);
    this.router.navigate(['/overview']);
  }
}
