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

## El E2E: cuatro fallos por habilitarlo sin haberlo corrido

El spec se escribió con la guarda `E2E_MANAGE` puesta, antes de que existiera
el backend, y se habilitó razonando que "los endpoints ya están en main". La
inferencia era correcta y aun así insuficiente: que el backend exista no
significa que el test funcione. Al ejecutarse por primera vez en CI falló, y
detrás había **cuatro** errores encadenados — **tres de ellos del test, no del
producto**:

1. **El presupuesto se agotaba antes de la primera acción.**
   `waitForFreshRateLimitBucket` espera hasta 60 s y el timeout por test son
   60 s: aritmética. El síntoma que se veía (`element is not stable` sobre una
   opción de Radix) era sólo dónde pilló el reloj, y perseguirlo habría llevado
   a "arreglar" un selector que nunca estuvo roto. El trace lo zanjó en un
   minuto: primer clic en el segundo 60,3.
2. **Leía el link de `sessionStorage` después de que la página lo consumiera.**
   `ThanksManageLink` borra la clave al montarse —a propósito, es un token
   bearer— así que el test miraba un hueco. Se lee del `href` del enlace
   pintado, que además prueba lo que el paciente ve.
3. **La corrección del punto 2 trajo un falso positivo**: comprobar que la URL
   no contiene `t=` matchea `star`**`t=`**, un parámetro legítimo de
   `/gracias`. Se comprueba el **valor** del token.
4. **Leía `page.url()` una sola vez.** El aviso de éxito lo pinta React un
   instante antes de que `router.replace` cambie la URL: pasaba aislado y
   fallaba en la suite completa, y la única diferencia era la carga de la
   máquina. Con `expect(page).toHaveURL`, que reintenta, deja de ser una
   carrera.

La lección: **un spec que no se ha visto pasar no está terminado**, aunque
compile y aunque su dependencia ya esté desplegada. El coste no desaparece por
no ejecutarlo; se difiere, y lo acaba pagando quien vea su PR en rojo por un
test que no es suyo.

## Pendiente

El E2E del flujo completo (`apps/web/e2e/cita-gestion.spec.ts`) está detrás de
`E2E_MANAGE=1` porque necesita los endpoints de M2-a. **Quitar la guarda cuando
M2-a esté en `main`.** Los dos tests de link inválido sí corren siempre: esa
pantalla se pinta con cualquier 404.

## El rate-limit del GET en SSR (resuelto en M2-a)

El `GET manage` se hace en **SSR**, así que el cubo de rate-limit por `slug+ip`
lo veía con la IP del servidor Next, **compartida por todos los pacientes de la
clínica**: una tanda de recordatorios a las 9:00, varios abriendo su link en el
mismo minuto, y el 11º se comía un 429.

M2-a lo cerró limitando **ese GET por token en vez de por IP** (los dos POST
siguen por IP, donde el cubo sí discrimina porque salen del navegador). Se
descartó la alternativa de mandar la IP real en una cabecera, que es justo el
vector de spoofing que `TRUST_PROXY` existe para cerrar. Limitar por token es
aceptable en lectura porque el token tiene ~192 bits: no es iterable, así que
ese cubo nunca estuvo para frenar fuerza bruta sino para que nadie martillee una
misma cita.

La mitigación del lado web se queda igual aunque el 429 ya no pase: distinguir
"no pude hablar con el backend" de "este link no vale" es lo que evita el peor
resultado, que era empujar con un CTA de *Agendar una cita* a alguien cuya cita
seguía viva.

## Reagendar devuelve la cita a PENDIENTE y gasta cupo

Dos cosas que cambiaron después del contrato inicial y que la página contempla:

- **El estado no se conserva**: mover la cita invalida la confirmación anterior,
  así que el backend la devuelve a `PENDIENTE` y limpia `confirmedAt`. La
  tarjeta lo refleja sola porque el estado sale de la respuesta.
- **Hay un tope de reagendamientos del paciente**, separado de los movimientos
  que hace recepción desde el panel. El `POST reschedule` devuelve
  `canReschedule` ya actualizado, así que se usa eso en vez de volver a pedir el
  GET. Sin ello, quien acabara de gastar su último cambio seguiría viendo el
  botón y sólo se enteraría al elegir horario y comerse el rechazo. Cuando el
  cupo se acaba, el mensaje de éxito lo dice.

Los dos campos (`rescheduleCount`, `canReschedule` en la respuesta del POST) van
**opcionales** en los tipos: llegaron después del contrato inicial y la web no
puede dar por hecho que el backend desplegado ya los manda.

Relacionado: [[adr/0004-pii-y-compliance]], [[notas/2026-09-11-feedback-cross-tenant]].
