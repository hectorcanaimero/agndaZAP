---
titulo: "El bot habla el idioma de la clínica (es/pt)"
fecha: 2026-09-11
tags: [bot, i18n, copy, b7]
---

# B7 — copy del bot por `clinic.locale`

Todo el copy estaba hardcodeado en español y `clinic.locale` solo cambiaba el formato
de las fechas. Una clínica `pt` recibía un bot en español **con las fechas en
portugués**: peor que uniforme, porque parece un error en vez de una decisión.

## Dónde vive

`apps/backend/src/bot/bot.messages.ts`, un `Record<BotLocale, BotCopy>`. Lo consumen
`bot.service.ts`, `reminders.processor.ts` y `follow-ups.processor.ts`.

**Si alguien añade una clave a `es` y se olvida de `pt`, no compila.** Es la única
forma de que esto no vuelva a quedar a medias, que es exactamente como estaba.

Los textos con datos dentro son **funciones**, no plantillas con `{placeholders}`: así
el compilador comprueba que cada idioma recibe los mismos argumentos y no hay forma de
olvidarse de sustituir uno. Los pools que rotan variantes siguen siendo arrays de
strings con `{clinicName}`, porque ahí el override del tenant es una cadena única y
tiene que poder usar los mismos marcadores.

## Entender vs. responder

**Las palabras clave del matching son es + pt a la vez, no por idioma de la clínica.**

Entender de más no hace daño —un paciente de una clínica `pt` que escriba "sí" quiere
decir que sí— y evita que la comprensión dependa de un campo que puede estar mal
configurado. Si el `locale` está en `es` por error, con matching por idioma el bot
dejaría de entender a todos sus pacientes; con matching unificado, solo responde en el
idioma equivocado, que es recuperable.

Lo que sí depende del idioma es lo que el bot **responde**.

Como `normalizeText` quita las tildes, el portugués entra sin acentos: `não`→`nao`,
`olá`→`ola`, `terça`→`terca`.

## El acoplamiento que importa

El copy dice *"Responda **SIM**"* y el parser tiene que entender `sim`. Si se traduce
el mensaje y no las palabras clave, el paciente hace **exactamente lo que le pedimos**
y el bot no lo entiende — el peor fallo posible, porque parece culpa suya.

Hay un test que lo fija: comprueba que las palabras en negrita del copy pt
(`*SIM*`, `*REMARCAR*`, `*CANCELAR*`, `*humano*`) son las que el matching reconoce.

## Registro

- **es**: tuteo LATAM neutro, nunca voseo. Ver [[notas/2026-09-10-tono-espanol-neutro]].
- **pt**: "você", registro de Brasil.

## Lo que no cubre

El override por tenant (`clinic.botGreeting`, `botFallback`, `botHandoffMsg`) **gana
sobre el idioma**: si la clínica escribió su propio saludo, ese es el que quiere, en el
idioma en que lo haya escrito. No traducimos lo que escribió un operador.
