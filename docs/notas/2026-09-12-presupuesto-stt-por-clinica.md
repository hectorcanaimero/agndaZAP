# 2026-09-12 — Cota de transcripciones: detalles de implementación

La decisión y su porqué están en [[adr/0023-cota-de-gasto-en-stt]]. Aquí queda
lo que hay que saber para tocar el código sin romperlo.

## Dónde está cada pieza

| Pieza | Dónde | Qué hace |
|---|---|---|
| `withinSttBudget` | `stt/stt-budget.ts` | **Sólo lee.** Filtro barato en el webhook, para decidir ya si al paciente se le manda el aviso o se le encola el audio |
| `claimSttBudget` | `stt/stt-budget.ts` | **Reserva.** `INCR` y compara el valor devuelto. La autoridad |
| Llamada a `withinSttBudget` | `whatsapp/webhook.controller.ts` | Antes de `handleUnsupportedMessage`, porque decide `transcribable` |
| Llamada a `claimSttBudget` | `bot/bot-inbound.processor.ts` | Después del consent, justo antes de `stt.transcribe` |

## Tres estados, no un booleano

`withinSttBudget` devuelve `'ok' | 'agotado' | 'indeterminado'`, y la diferencia
entre los dos últimos decide si al paciente se le fuerza el aviso
(`forceNotice`). Si alguien lo colapsa a booleano, el caso "Redis mudo" vuelve a
ser silencio absoluto para el paciente.

## El orden de los dos `INCR` importa

Primero el del chat, después el de la clínica. Al revés, quien ya agotó su cota
de chat seguiría quemando la de todos — que es justo lo que la sub-cota viene a
impedir.

Si el `INCR` del chat pasa y el de la clínica falla, se ha consumido una unidad
de chat de más. Es un tope de gasto, no contabilidad: se autocorrige al día
siguiente.

## Cuidado al tocar los fakes de Redis en los tests

Esta cota se apoya en tres cosas que los mocks de este repo suelen dar por
buenas, y cada una ya ha escondido un bug:

- **`SET NX`**: el fake por defecto devuelve siempre `'OK'`, así que un throttle
  es inobservable — la primera vez y la quinta dan lo mismo. El aviso al
  operador (uno por clínica y día) necesita un fake con estado.
- **`pipeline().exec()`**: no rechaza por errores de comandos sueltos, los
  devuelve dentro del array. Un fake que devuelva `[]` hace que la reserva lea
  "respuesta inesperada" y **nada se transcriba**.
- **`mget`**: si falta en el fake, el estado sale `indeterminado` y ninguna nota
  de voz se transcribe. Cuando lo añadí, cuatro tests del webhook se pusieron
  rojos: era el fail-closed funcionando.

Ver [[notas/2026-09-11-cola-bot-inbound]] para el mismo patrón con BullMQ: un
mock nunca valida el contrato de la librería.

## Lo que queda pendiente

- **Mostrarlo en el panel.** El motivo ya se cuenta (`reason:*` en el hash del
  día) y se puede consultar; el gráfico no existe.
- **La validación IANA de `timezone` falta en los DTO de admin**
  (`admin/dto/create-clinic.dto.ts`, `update-clinic.dto.ts`), que sólo piden
  `@IsString() @MaxLength(60)`. `clinics/dto/update-clinic.dto.ts` sí la valida.
  A esta cota ya no le afecta (usa UTC), pero `botStatsKey` sigue expuesto: con
  una zona inválida, `toISODate()` devuelve `null`.
