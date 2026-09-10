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
(a) redactar las FAQ con la pregunta incluida en el texto ("¿Dónde están?
Estamos en…") para mejorar el matching, y (b) evaluar un fallback léxico
(pg_trgm) para preguntas muy cortas.

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
