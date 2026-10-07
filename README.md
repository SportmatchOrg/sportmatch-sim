# sportmatch-sim

Usuarios simulados que usan SportMatch para que los KPIs de negocio tengan datos que evolucionan.
Claude (con la suscripción) decide qué hace cada persona; `src/cli.ts` ejecuta contra la API y sortea
lo que tiene que dar una tasa (no-shows, bajas tardías, quién organiza o se une).

Las cuentas usan el dominio `@sim-sportmatch.test`: para filtrar los bots en cualquier consulta de KPIs,
`WHERE email NOT LIKE '%@sim-sportmatch.test'`.

## Setup

```
cp .env.example .env        # API_URL, FIREBASE_API_KEY (la pública del front), BOT_PASSWORD
node src/create-bots.ts     # alta de las personas que ya "llegaron"
```

Node ≥ 22.18 (corre TypeScript sin compilar). Para correr no hace falta `npm install`; las dev deps (`typescript`, `@types/node`) son para el IDE y `npm run typecheck`.

## Una corrida

```
claude -p "Hacé una corrida según CLAUDE.md" --model sonnet   # tope de personas: hoy --max N
```

- `personas/arquetipos.json` — comportamientos y sus probabilidades
- `personas/pool.json` — las 90 personas (personajes de Harry Potter, Star Wars y El Señor de los Anillos) y el día en que entran a la app
- `state/` — lo que pasó: partidos registrados, asistencia sorteada, diarios, `acciones.log`
