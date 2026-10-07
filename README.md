# sportmatch-sim

Usuarios simulados que usan SportMatch para que los KPIs de negocio tengan datos que evolucionan.
Claude (con la suscripción) decide qué hace cada persona; `src/cli.ts` ejecuta contra la API y sortea
lo que tiene que dar una tasa (no-shows, bajas tardías, cancelaciones, quién organiza o se une).

Las cuentas usan el dominio `@sim-sportmatch.test`: para filtrar los bots en cualquier consulta de KPIs,
`WHERE email NOT LIKE '%@sim-sportmatch.test'`.

## Setup

```
cp .env.example .env        # API_URL, FIREBASE_API_KEY (la pública del front), BOT_PASSWORD
node src/create-bots.ts     # fija el día de inicio y da de alta a las personas que ya "llegaron"
```

Node ≥ 22.18 (corre TypeScript sin compilar). Para correr no hace falta `npm install`; las dev deps
(`typescript`, `@types/node`) son para el IDE y `npm run typecheck`.

## Una corrida

```
claude -p "Hacé una corrida según CLAUDE.md" --model sonnet
```

`CLAUDE.md` tiene los pasos. En cada corrida entran como mucho 12 personas (`hoy --max 12`): primero las
que tienen algo pendiente (aceptar solicitudes, calificar, cancelar) y después se completa al azar.

## Personas

- `personas/pool.json` — 60 personajes de Harry Potter (21), Star Wars (20) y El Señor de los Anillos
  (19). Cada uno tiene arquetipo, deportes, zona, un rasgo y `diaLlegada`: los días después del inicio
  en que crea su cuenta. El primer día llegan 13 (3 organizadores entre ellos); el resto, de a ~1,6 por
  día durante un mes.
- `personas/arquetipos.json` — 18 comportamientos con sus probabilidades (`actividad`, `p_organizar`,
  `p_unirse`, `p_cancelar`, `p_noShow`, `p_bajaTarde`, `p_calificar`) y opcionales de calendario
  (`diasActivo`, `pausa`, `diasSemana`, `p_volver`):
  organizador, organizador-finde, organizador-que-cancela, organizador-exigente, solo-se-une, fanatico,
  novato, curioso, calificador-severo, faltador, faltador-cronico, baja-tarde, irregular, ocasional,
  finde, se-va, vuelve, fantasma.
- `personas/lugares.json` — las canchas donde se pueden armar partidos, con coordenadas y deportes.

## Estado (`state/`)

Arranca vacío y lo va llenando la simulación:

- `inicio.json` — el día en que arrancó (lo crea el primer `create-bots`)
- `usuarios.json` — handle → id del usuario en el back
- `partidos.json` — partidos de los bots: jugadores, solicitudes pendientes, asistencia sorteada, quién califica
- `diario/<handle>.md` — lo que hizo cada persona; Claude lo lee en la corrida siguiente
- `acciones.log` — cada acción contra la API, con fecha
- `.tokens.json` — tokens de Firebase en caché (no se versiona)

Para empezar de cero: borrar las cuentas `@sim-sportmatch.test` en Firebase, sus filas en la base, y
vaciar `state/` (dejando `.gitkeep`).
