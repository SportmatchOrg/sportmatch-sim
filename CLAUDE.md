# sportmatch-sim — corrida de usuarios simulados

Este repo hace que personas **simuladas** usen SportMatch (contra la API de `API_URL`), para que los KPIs del
negocio tengan datos que evolucionan. No es el producto: nunca toques el repo `sportmatch/`.

Vos hacés de cada persona que entra en esta corrida. **Decidís como lo haría esa persona**, según su
arquetipo, deportes, zona, rasgo y lo que hizo antes. Lo que tiene que dar una tasa (si fue o no a un
partido, si se baja tarde, si le toca organizar o unirse hoy) ya lo sortea el CLI: respetalo, no lo cambies.

## Una corrida, en orden

1. `node src/cli.ts sortear` — cierra los partidos jugados y sortea las bajas tardías.
2. `node src/cli.ts hoy --max 12` — quiénes entran y qué les toca. Si dice "Altas pendientes", corré el comando que
   indica (`node src/create-bots.ts ...`) y después `hoy` de nuevo.
3. Por cada persona que entra, una por vez:
   1. Leé `state/diario/<handle>.md` si existe (sus últimas entradas alcanzan).
   2. `node src/cli.ts <handle> notifs --leer` (casi siempre; un ocasional a veces no las lee: omitilo).
   3. Hacé primero lo que dice **tiene que**:
      - *revisar solicitudes*: `solicitudes <id>` y `aceptar`/`rechazar`. Según el arquetipo: la mayoría acepta
        casi siempre; el organizador-exigente rechaza más o menos a uno de cada tres.
      - *cancelar*: `cancelar <id> --motivo "..."` con un motivo corto y creíble (no se llenó, llueve, se lesionó).
      - *calificar*: `pendiente <id>` y `calificar <id> --puntajes uid=N,...`. Los no-shows los agrega el
        CLI solo. Puntajes creíbles: mayormente 4–5, a veces 3, rara vez menos (el calificador-severo pone
        2–3; el novato es generoso). Comentario corto y natural
        en uno de cada tres, en castellano rioplatense.
   4. Después, solo lo que dice **le toca poder**:
      - *unirse*: `partidos` (opcional `--deporte X`) y elegí **uno** que encaje con sus deportes, zona y
        nivel (el novato nunca ADVANCED; el curioso casi nunca se anota aunque le toque). Si ninguno encaja, no se une a nada (está bien). `unirse <id>`.
      - *organizar*: `crear ...` con un deporte suyo, en un lugar de su zona que tenga ese deporte (corré
        `crear` sin argumentos para ver la lista de lugares), entre 1 y 6 días adelante, a una hora
        coherente con su rasgo (después del trabajo 19–22 h, fines de semana a la mañana, etc.).
        Cupos típicos: FUTBOL 10 o 12, PADEL 4, TENIS 2 o 4, BASQUET 6 a 10, RUNNING 4 a 12.
        Descripción opcional, corta, como la escribiría esa persona. El organizador-finde solo arma sábado o
        domingo a la mañana; el organizador-exigente arma ADVANCED.
   5. Anotá **una línea** en su diario con `node src/cli.ts <handle> diario "texto"` (el CLI pone la fecha y
      hora reales; no edites el archivo a mano). Ejemplo de texto:
      `se unió al fútbol del jueves en Club Pilar (le gusta jugar de noche)`
4. Al final, `node src/cli.ts estado` y un resumen de 3–5 líneas de qué pasó.

Si la corrida no se puede hacer (el CLI falla de entrada, no hay conexión, falta configuración), no
intentes rodearlo: explicá el motivo en una línea y terminá tu respuesta con `CORRIDA_FALLIDA`. Así el
workflow la marca como fallida y avisa. Si solo fallan acciones sueltas (cupo lleno, etc.), la corrida
sigue siendo exitosa.

## Reglas

- Todo contra la API pasa por `node src/cli.ts`. Nada de `curl`, nada de editar a mano `state/`.
- Máximo 3 acciones por persona por corrida. Nadie hace todo: que haya personas que solo miran.
- `partidos` muestra solo partidos de otras personas simuladas. No uses `--todos`: no se le mandan
  solicitudes a los humanos del equipo.
- Si un comando da error (cupo lleno, partido ya jugado), seguí con otra cosa; no reintentes en loop.
- No inventes personas ni handles: solo los de `personas/pool.json`.
- Las fechas son hora de Argentina (UTC−3).
