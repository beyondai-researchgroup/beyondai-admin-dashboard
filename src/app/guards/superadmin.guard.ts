import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

/** Defense in depth: the backend already 403s non-superadmin requests, this just keeps a
 *  scoped researcher from landing on a blank/erroring page if they navigate here directly. */
export const superAdminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.researcher()?.isSuperAdmin) return true;

  router.navigate(['/overview']);
  return false;
};
