# RAG: umbral de distancia 0.5 → 0.65 (2026-09-10)

**Síntoma**: en la demo, "Donde están ubicados" hacía handoff a humano aunque
existe la FAQ "Estamos en Puerto Ordaz, Orinokia Mall…". Log de prod:
`candidates=3 matches=0 minDist=0.6`.

**Causa**: `DEFAULT_MAX_DISTANCE = 0.5` en `knowledge.service.ts` se fijó
estimando que lo relevante caía en `[0.15, 0.45]`. Con preguntas cortas y
coloquiales de WhatsApp (2 a 4 palabras) `text-embedding-3-small` da
distancias bastante mayores.

**Medición** (script ad hoc: embed de 9 preguntas, `<=>` contra los chunks de
la demo en prod):

| pregunta | mejor chunk | dist |
|---|---|---|
| atienden niños | odontopediatría | 0.454 |
| me duele una muela | urgencias | 0.467 |
| cuánto cuesta una limpieza | precios | 0.488 |
| qué horario tienen | horarios | 0.515 |
| Donde están ubicados | ubicación | 0.619 |
| tienen estacionamiento | ubicación | 0.608 |
| quiero comprar un carro | (nada) | 0.723 |
| hola que tal | (nada) | 0.730 |

**Decisión**: umbral 0.65. Deja pasar lo relevante; lo claramente ajeno sigue
por encima. El LLM de síntesis es el segundo filtro (`NULL_ANSWER` si las
fuentes no responden → handoff).

**Pendiente**: "dónde queda la clínica" da 0.583 contra el chunk equivocado
(urgencias). Con k=3 el chunk de ubicación suele entrar igual, pero conviene
redactar las FAQ con la pregunta incluida en el texto ("¿Dónde están?
Estamos en…") para mejorar el matching.

## Fallback léxico (M8, 2026-09-11)

El punto (b) que quedaba pendiente ya está implementado: cuando el vector no
devuelve ningún match y la pregunta tiene ≤ 6 palabras, se busca por parecido
de texto con `word_similarity` de pg_trgm.

Medido contra las FAQ de la base de desarrollo (4 chunks del seed genérico,
que es lo que había):

| pregunta | similitud | chunk |
|---|---|---|
| aceptan tarjeta | 0.650 | formas de pago ✓ |
| cuanto dura la consulta | 0.548 | duración de la consulta ✓ |
| que horario tienen | 0.368 | horarios ✓ (pero flojo) |
| donde estan ubicados | 0.217 | horarios ✗ (chunk equivocado) |
| atienden niños · hola que tal · quiero comprar un carro | ≤ 0.17 | ruido |

**Umbral 0.5**, deliberadamente conservador: deja pasar los aciertos
inequívocos y corta muy por encima del ruido. La muestra es pequeña, y ante la
duda preferimos no responder a responder desde el chunk equivocado — que es lo
que pasaría bajando a 0.2.

`word_similarity` y no `similarity`: la segunda normaliza sobre las dos cadenas
enteras, así que una pregunta de tres palabras contra un chunk de doscientos
caracteres da siempre un número diminuto. `word_similarity` busca el mejor
fragmento del chunk, que es justo la pregunta que queremos hacer.

El coste de un falso positivo está acotado: el chunk entra como fuente y el LLM
de síntesis responde `NULL_ANSWER` si no sirve. Se paga una llamada, no una
respuesta inventada.

**Re-calibrar cuando haya datos reales.** `rag-calibracion.spec.ts` fija estas
mediciones: si alguien mueve un umbral, el spec le dice exactamente qué
preguntas de pacientes empieza a romper. Si se cambia el modelo de embeddings
hay que re-medir, no ajustar el número hasta que los tests pasen.

**Limpieza pendiente en prod** (SQL manual; `seed-demo-dental.js` no toca
`FaqChunk` ni corrigió `Clinic.address`): la demo tiene 2 chunks del seed
genérico que contradicen a la demo dental y la dirección sigue en Caracas.

```sql
delete from "FaqChunk" f using "Clinic" c
 where c.id = f."clinicId" and c.slug = 'demo'
   and (f.content like 'Dirección: Av. Principal 123, Caracas%'
     or f.content like 'Horarios de atención: L-V de 9:00 a 18:00%');
update "Clinic"
   set address = 'Av. Las Américas, C.C. Orinokia Mall, Torre A, piso 3, oficina 3-12, Puerto Ordaz, Estado Bolívar'
 where slug = 'demo';
```

Relacionado: [[notas/2026-09-10-tono-espanol-neutro]].
