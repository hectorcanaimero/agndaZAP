# 2026-09-11 — Gestión de cita por link: decisiones de la web (M2-b)

Página `/[locale]/agendar/[clinicSlug]/cita?t=<token>`. Contrato del backend en
[[plans/2026-09-11-p0-bot-reparto]] §P1; la implementa M2-a.

## El link es un token bearer, y eso manda en el diseño

Quien tenga el link puede **cancelar la cita**. De ahí tres decisiones:

- **Nunca en la query string de `/gracias`.** Ahí quedaría en el `Referer`, en el
  historial del navegador y en los logs del CDN. Viaja por `sessionStorage`
  (`agz.thanks.manageUrl`), que es exactamente el canal y el motivo que el ADR
  [[adr/0004-pii-y-compliance]] §B.4 ya fijó para el nombre del paciente. Se
  consume al leerlo.
- **De `patient` sólo llega el nombre, nunca el teléfono.** El link acaba
  reenviado por WhatsApp con facilidad; el nombre basta para que el paciente
  reconozca que la cita es suya.
- **Una sola pantalla para todos los fallos de token.** El backend responde el
  mismo 404 si expiró, si es de otra clínica o si la cita ya no existe, para no
  confirmarle nada a quien prueba tokens. La web **no puede distinguirlos y
  tampoco debe intentarlo**: decir "expiró" en vez de "no existe" filtraría
  justo lo que el 404 uniforme protege.

## `canCancel` es una pista, no una garantía

El `GET` los devuelve para pintar la UI, pero la clínica puede marcar la cita
ATENDIDA entre que se renderiza la página y el clic. Las dos acciones manejan el
409 igual, y ante él **no adivinamos el estado nuevo**: `router.refresh()` y que
el server component vuelva a hidratar con la verdad.

> **Gotcha que casi cuesta un bug:** `router.refresh()` re-renderiza el server
> component, pero **React conserva el state del client**. Con
> `useState(initial)` a secas, el refresh no cambiaba nada en pantalla: le
> decíamos al paciente "actualizamos la página" y seguía viendo los datos
> viejos y los mismos botones. Hace falta un `useEffect` que baje `initial` al
> state para que el server siga siendo la fuente de verdad.

## Fallo de token vs. fallo transitorio

Son pantallas distintas **a propósito**. Si un 429 o un backend caído pintaran
"este link no vale" con un botón de *Agendar una cita*, un paciente con una cita
perfectamente viva acabaría creando una duplicada. El 404 (token muerto) lleva
al CTA de agendar; lo transitorio dice "vuelve a intentarlo".

Por lo mismo, un 404 en una acción (cancelar o reagendar) no puede caer en el
"inténtalo de nuevo" genérico: ese reintento no puede funcionar nunca. Tiene su
propio mensaje y **bloquea las acciones**.

## Reagendar mueve la cita in-place

El `id` no cambia: el backend no crea una fila nueva porque una `CANCELADA` por
reagendamiento diluiría el no-show rate, que es la métrica estrella del
producto. Por eso el éxito se detecta por el **200 y el nuevo `startAtISO`**,
nunca comparando ids.

**El token viejo se invalida al reagendar.** Si llega uno nuevo, reescribimos la
URL con `history.replaceState` para que un refresh siga funcionando. Si no llega
—`manageUrl` es opcional: sin Redis el backend mueve la cita pero no emite
token— mostramos un aviso en vez de dejar al paciente con una página que muere
al recargar. Es el caso raro, pero silencioso si no se avisa.

## Por qué no se reutilizó el selector de horarios del form

El plan decía "reutiliza `ScheduleSelection`". Ese archivo **no es un selector**:
es un context provider más el resumen de la sidebar. El selector real vive
dentro de `ScheduleForm.tsx` (930 líneas), acoplado a `react-hook-form`
(`startAtISO` es un campo del form, con roving tabindex y manejo de 409 propio).

Extraerlo entero habría sido refactorizar el embudo de conversión principal
para una página secundaria. Se extrajo sólo lo que es puro y compartible
—`groupSlotsByDay` y `formatSlotTime`, ahora en `slot-format.ts`— y la página de
gestión tiene su propio picker, que además necesita menos (sin form, sin
consentimiento, una sola acción). Duplicar el **formateo** sí habría sido un
problema: es la vía rápida a que las dos páginas muestren la misma hora
distinta.

## Reagendar también se confirma

Cancelar pedía confirmación y mover la cita no, aunque desde el lado del
paciente es igual de irreversible: libera el slot actual e invalida el link. En
móvil, un toque accidental en la lista de horarios movía la cita. Ahora las dos
acciones pasan por `ConfirmDialog`.

Detalle de ese componente que hay que saber: hace `preventDefault` para poder
mostrar el estado "…", así que **cerrar es responsabilidad del caller**. Si no
se cierra, el banner de resultado queda detrás del overlay, el botón de
confirmar vuelve a estar activo (segundo POST sobre una cita ya cancelada) y el
foco sigue atrapado dentro del diálogo.

## Gotchas

- **`next-intl` tipa las claves de mensaje**, así que `t()` no acepta un
  `string` cualquiera ni tiene fallback por clave. Un `t(`status.${x}`)` con un
  estado que no esté en los mensajes **renderiza un error en medio de la
  página**. Por eso hay un type guard sobre la lista de estados conocidos
  (espejo del enum `AppointmentStatus`) y, ante uno desconocido, se muestra el
  valor crudo. Si mañana se añade un estado al enum y no a los mensajes, lo
  cantan los tipos en vez de romperse en producción.
- **Rate-limit de 10/min por slug+ip**: nada de polling ni de reintentos
  automáticos. La query de disponibilidad va con `retry: false`.
- **El `from` de disponibilidad va en la TZ de la clínica**, con
  `todayStartInTZ`. Con `new Date().toISOString().slice(0,10)` —la fecha UTC del
  reloj del navegador— un paciente en Caracas a partir de las ~20:00 pediría los
  slots de mañana y perdería los de hoy, justo cuando reagenda por WhatsApp de
  noche. El resto del formateo sí estaba bien: instante absoluto + `timeZone`
  explícito en `Intl`.
- **La cache de disponibilidad hay que invalidarla tras reagendar.** Con la
  `queryKey` estable y `staleTime: 30 s`, reabrir "cambiar horario" enseguida
  mostraba el slot nuevo como libre y el viejo como ocupado.
- Los botones de slot llevan `data-slot`, la misma convención de selector que
  usa el picker de `ScheduleForm`, para que los E2E compartan locator.

## Pendiente

El E2E del flujo completo (`apps/web/e2e/cita-gestion.spec.ts`) está detrás de
`E2E_MANAGE=1` porque necesita los endpoints de M2-a. **Quitar la guarda cuando
M2-a esté en `main`.** Los dos tests de link inválido sí corren siempre: esa
pantalla se pinta con cualquier 404.

## Pendiente de coordinar con el backend

El `GET manage` se hace en **SSR**, así que el cubo de rate-limit por `slug+ip`
lo ve con la IP del servidor Next, **compartida por todos los pacientes de la
clínica**. Una tanda de recordatorios a las 9:00, varios pacientes abriendo su
link en el mismo minuto, y el 11º se come un 429. Hoy eso ya no dice "link
inválido" (se distingue lo transitorio), pero sigue siendo una página que no
carga. Hay que resolverlo en M2-a: excluir el `GET` del cubo por IP, o
reenviarle la IP real del paciente.

Relacionado: [[adr/0004-pii-y-compliance]], [[notas/2026-09-11-feedback-cross-tenant]].
