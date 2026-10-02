import { ApplicationConfig, importProvidersFrom } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { HttpClient } from '@angular/common/http';
import { TranslateLoader, TranslateModule } from '@ngx-translate/core';
import { TranslateHttpLoader } from '@ngx-translate/http-loader';
import { routes } from './app.routes';
import { authInterceptor } from './interceptors/auth.interceptor';

export function HttpLoaderFactory(http: HttpClient): TranslateHttpLoader {
  // Cache-bust with a per-bootstrap timestamp so a browser reload always re-fetches the latest
  // translation JSON instead of serving a stale cached copy from before a key was added/changed
  // (this static asset isn't part of the TS build graph, so it doesn't get a content hash).
  return new TranslateHttpLoader(http, './assets/i18n/', `.json?v=${Date.now()}`);
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    importProvidersFrom(
      TranslateModule.forRoot({
        loader: {
          provide: TranslateLoader,
          useFactory: HttpLoaderFactory,
          deps: [HttpClient],
        },
        defaultLanguage: 'sr',
      })
    ),
  ],
};
