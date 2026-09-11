import { useTranslations } from 'next-intl';
import { SectionCard } from './SectionCard';
import type { BotActivity } from './types';

/**
 * Actividad del bot de WhatsApp en los últimos 30 días.
 *
 * Regla que ordena todo el componente: **un `null` no se pinta como 0**. Los
 * datos vienen de contadores que el bot escribe al vuelo, así que "todavía no
 * se mide" y "se midió y fue cero" son estados distintos que en un panel se
 * ven igual. Un 0% de derivaciones diría que el bot resuelve todo solo, que es
 * justo lo contrario de no saberlo.
 */
/**
 * Orígenes que sabemos traducir (espejo de `AppointmentSource` en Prisma).
 * next-intl tipa las claves y no tiene fallback: un origen nuevo en el backend
 * renderizaría un error en medio del panel, así que ante lo desconocido se
 * muestra el valor crudo.
 */
const KNOWN_SOURCES = ['BOT', 'PUBLIC', 'BOT_WEB'] as const;
type KnownSource = (typeof KNOWN_SOURCES)[number];

function isKnownSource(value: string): value is KnownSource {
  return (KNOWN_SOURCES as readonly string[]).includes(value);
}

export function BotActivityPanel({ data }: { data: BotActivity }) {
  const t = useTranslations('panel.dashboard.botActivity');
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const sourceLabel = (source: string) =>
    isKnownSource(source) ? t(`sources.${source}`) : source;

  if (!data.hasData) {
    return (
      // `description` lleva `{days}`: sin el parámetro, next-intl cae al
      // fallback y pinta la clave cruda en la tarjeta. Y éste es el estado que
      // ve toda clínica sin bot, o sea el 100% el día del deploy.
      <SectionCard
        title={t('title')}
        description={t('description', { days: data.windowDays })}
        icon="Bot"
      >
        <p className="text-sm text-gray-500">{t('empty')}</p>
      </SectionCard>
    );
  }

  const rows: Array<{
    key: 'attended' | 'unsupported' | 'handoff' | 'nullAnswer';
    value: string;
    hint?: string;
  }> = [
    {
      key: 'attended',
      value: String(data.turns.attended),
      hint: t('attendedHint', { total: data.turns.total }),
    },
    { key: 'unsupported', value: String(data.turns.unsupported) },
    {
      key: 'handoff',
      value: data.handoffRate === null ? t('notMeasured') : pct(data.handoffRate),
    },
    {
      key: 'nullAnswer',
      value:
        data.nullAnswerRate === null ? t('notMeasured') : pct(data.nullAnswerRate),
    },
  ];

  return (
    <SectionCard
      title={t('title')}
      description={t('description', { days: data.windowDays })}
      icon="Bot"
    >
      {data.partial ? (
        <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {t('partial')}
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {rows.map((row) => (
          <div key={row.key}>
            <dt className="text-xs text-gray-500">{t(`rows.${row.key}`)}</dt>
            <dd className="mt-0.5 text-xl font-semibold tabular-nums text-gray-900">
              {row.value}
            </dd>
            {row.hint ? (
              <p className="mt-0.5 text-xs text-gray-400">{row.hint}</p>
            ) : null}
          </div>
        ))}
      </dl>

      {data.intents ? (
        <div className="mt-6 border-t border-gray-100 pt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
            {t('intentsTitle')}
          </p>
          <ul className="mt-2 space-y-1.5">
            {data.intents.map((row) => (
              <li
                key={row.intent}
                className="flex items-center justify-between text-sm"
              >
                <span className="text-gray-700">{row.intent}</span>
                <span className="tabular-nums font-medium text-gray-900">
                  {row.count}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        // Se dice por qué no está, y con la causa correcta: "hacen falta 10
        // mensajes" a una clínica que ya tiene 20 es una mentira que el propio
        // usuario puede comprobar.
        <p className="mt-6 border-t border-gray-100 pt-4 text-xs text-gray-500">
          {data.breakdown === 'not-measured'
            ? t('intentsNotMeasured')
            : t('intentsHidden')}
        </p>
      )}

      {data.citasPorOrigen.length > 0 ? (
        <div className="mt-6 border-t border-gray-100 pt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
            {t('sourceTitle')}
          </p>
          <ul className="mt-2 space-y-1.5">
            {data.citasPorOrigen.map((row) => (
              <li
                key={row.source}
                className="flex items-center justify-between text-sm"
              >
                <span className="text-gray-700">{sourceLabel(row.source)}</span>
                <span className="tabular-nums font-medium text-gray-900">
                  {row.count}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </SectionCard>
  );
}
