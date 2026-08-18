import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SentryModule as OfficialSentryModule } from '@sentry/nestjs/setup';
import { SentryFilter } from './sentry.filter';

// Wrap del SentryModule oficial + registro del filter global.
// El SentryModule oficial engancha los tracing integrations con NestJS
// (controllers, providers, guards) — sin él perdemos performance monitoring
// de endpoints. El filter reporta las excepciones a Sentry.
@Module({
  imports: [OfficialSentryModule.forRoot()],
  providers: [{ provide: APP_FILTER, useClass: SentryFilter }],
})
export class SentryAppModule {}
