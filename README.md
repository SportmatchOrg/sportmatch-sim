# sportmatch-sim

Usuarios simulados que usan SportMatch para que los KPIs de negocio tengan datos que evolucionan.
Claude (con la suscripción) decide qué hace cada persona; `src/cli.ts` ejecuta contra la API y sortea
lo que tiene que dar una tasa (no-shows, bajas tardías, cancelaciones, quién organiza o se une).

Las cuentas usan el dominio `@sim-sportmatch.test`: para filtrar los bots en cualquier consulta de KPIs,
`WHERE email NOT LIKE '%@sim-sportmatch.test'`.

## Setup

```
cp .env.example .env        # SIM_ENV, API_URL_DEV/PROD, FIREBASE_API_KEY (la pública del front), BOT_PASSWORD
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

## Automático (GitHub Actions)

`.github/workflows/simular.yml` corre cada 3 horas a los :10 (00:10, 03:10 … 21:10, hora argentina; GitHub puede
demorarlas), commitea `state/` a
`main` y, si la corrida falla, avisa en Discord (distingue "sin límite de uso" de otros errores). También se
lanza a mano desde Actions → *Corrida de usuarios simulados* → *Run workflow*, con el tope de personas.

| Nombre | Tipo | Valor |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | secret | `claude setup-token` (usa la suscripción de quien lo genera; vence al año) |
| `FIREBASE_API_KEY` | secret | la del `.env` |
| `BOT_PASSWORD` | secret | la del `.env` |
| `DISCORD_WEBHOOK` | secret | webhook del canal donde avisar |
| `API_URL` | variable | URL del back de dev |
| `API_URL_PROD` | variable | URL del back de prod |
| `SIM_ENTORNOS` | variable | entornos de las corridas programadas: `dev` (default), `prod` o `dev,prod` |
| `SIM_SOLO_BOTS` | variable | `1`: los bots solo juegan entre bots y rechazan a los humanos. Vacío o `0` (default): también juegan con los humanos del equipo |

**Entornos.** Cada entorno tiene su propio estado (`state/dev/`, `state/prod/`) y su URL; dev, prod y local
comparten el proyecto de Firebase, así que las cuentas de los bots son las mismas. Las corridas programadas
recorren `SIM_ENTORNOS` de a uno; *Run workflow* deja elegir uno. Prender prod = cargar `API_URL_PROD` y
poner `SIM_ENTORNOS=dev,prod` (o `prod`): la primera corrida fija su día de inicio y las altas arrancan
desde ahí. Local: `SIM_ENV=prod node src/cli.ts ...` con `API_URL_PROD` en el `.env`.

Para pasar de Claude Pro a pagar por uso, reemplazar `CLAUDE_CODE_OAUTH_TOKEN` por `ANTHROPIC_API_KEY` en el
workflow.

## Retrotraer el inicio (backfill)

`src/backfill.ts` escribe en la base, con sus fechas reales, lo que los bots habrían hecho si la
simulación hubiera arrancado antes. Corre la misma lógica que las corridas en vivo (8 por día, mismos
arquetipos y dados) con reglas simples en lugar de Claude. Va directo a la base porque la API no acepta
partidos en el pasado. Se corre **una vez por entorno**, con `DATABASE_URL_<ENTORNO>` en el `.env`:

```
node src/backfill.ts --desde 2026-09-30            # dry-run: resumen por día, no escribe nada
node src/backfill.ts --desde 2026-09-30 --aplicar  # altas que falten + una transacción + state/
```

Hasta la primera acción en vivo hace todo; desde ahí solo lo obligatorio de sus propios partidos.
Mueve `inicio.json`, suma sus partidos a `partidos.json` (las corridas en vivo los siguen), antepone
las entradas al diario y deja todo en `state/<entorno>/backfill.log`, que además impide correrlo dos
veces. Aplicarlo justo después de una corrida y commitear `state/` enseguida, antes de la siguiente.

## Personas

- `personas/pool.json` — 159 personajes muy conocidos: Harry Potter, Star Wars, El Señor de los Anillos,
  Marvel, DC, Los Simpson, Toy Story, Piratas del Caribe, Volver al futuro, Matrix, Shrek, El rey león,
  Friends, Game of Thrones, Pixar, Breaking Bad y otros clásicos. Cada uno tiene arquetipo, deportes, zona,
  un rasgo y `diaLlegada`: los días después del inicio en que crea su cuenta. El día 0 llegaron 13 (3
  organizadores entre ellos); el resto llega de a 3 a 6 por día (al azar, para que "Usuarios nuevos por
  semana" fluctúe) hasta el día 33, así la serie no se corta antes de noviembre.
- `personas/arquetipos.json` — 18 comportamientos con sus probabilidades (`actividad`, `p_organizar`,
  `p_unirse`, `p_cancelar`, `p_noShow`, `p_bajaTarde`, `p_calificar`) y opcionales de calendario
  (`diasActivo`, `pausa`, `diasSemana`, `p_volver`):
  organizador, organizador-finde, organizador-que-cancela, organizador-exigente, solo-se-une, fanatico,
  novato, curioso, calificador-severo, faltador, faltador-cronico, baja-tarde, irregular, ocasional,
  finde, se-va, vuelve, fantasma.
- `personas/lugares.json` — las canchas donde se pueden armar partidos, con coordenadas y deportes.

## Estado (`state/<entorno>/`)

Uno por entorno. Arranca vacío y lo va llenando la simulación:

- `inicio.json` — el día en que arrancó (lo crea el primer `create-bots`)
- `usuarios.json` — handle → id del usuario en el back
- `backfill.log` — lo que escribió el backfill, si se corrió
- `partidos.json` — partidos de los bots: jugadores, solicitudes pendientes, asistencia sorteada, quién califica
- `diario/<handle>.md` — lo que hizo cada persona (`cli.ts <handle> diario "..."` escribe; sin texto, lee)
- `acciones.log` — cada acción contra la API, con fecha
- `state/.tokens.json` — tokens de Firebase en caché, compartidos entre entornos (no se versiona)

Para empezar de cero un entorno: borrar las filas de los bots en su base y vaciar `state/<entorno>/`. Las
cuentas de Firebase se comparten entre entornos: borrarlas solo si se reinician todos.
