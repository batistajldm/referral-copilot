# Anti-cold-start runbook — Referral Copilot

**Por qué importa:** Technical execution es nuestra dimensión de mayor riesgo. El problema no es el código —
es que **cuatro recursos se auto-suspenden** y el primer hit en frío puede tardar 20–60s, justo cuando el
juez está mirando. Warm-up = matar el cold start antes de que importe.

## Los 4 recursos que arrancan en frío
| Recurso | Síntoma en frío | Cómo se calienta |
|---|---|---|
| **App compute** (Databricks App) | primer load de la página lento / 503 | curl al root de la app |
| **SQL Warehouse** `36fdbb817fccbd3b` (2X-Small serverless) | primera búsqueda ~15–30s | un `SELECT 1` vía statements API |
| **Model Serving** `databricks-meta-llama-3-3-70b-instruct` | primer "Ask in plain English" lento/timeout | un POST a `/api/parse-query` |
| **Lakebase** (Postgres) | primer guardar/listar de shortlist lento | un GET a `/api/shortlist` |

> El warehouse y el serving son los que más duelen. Una vez calientes, se mantienen ~10–30 min de inactividad.

---

## T-minus checklist (antes de presentar)

### T-10 min — Warm-up #1
```bash
cd /Users/jorgebatista/Dev/databriks-hackaton-2026/referral-copilot
./docs/warmup.sh
```
Verifica que **todo** salga OK (app 200, warehouse SUCCEEDED, parse devuelve JSON, shortlist responde).

### T-5 min — Warm-up #2 (re-calienta, por si pasó el tiempo)
```bash
./docs/warmup.sh
```
Y abre la app en el navegador, corre **`dialysis near Jaipur`** a mano para confirmar visualmente.

### T-2 min — Estado verde
```bash
databricks apps get referral-copilot -t default --profile DEFAULT -o json \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('app:', d['app_status']['state']); print('compute:', d['compute_status']['state'])"
```
Esperado: `app: RUNNING` / `compute: ACTIVE`.

### Durante la demo
- Deja la pestaña de la app **ya abierta y con una búsqueda hecha** antes de empezar a hablar.
- Si el juez pide otra búsqueda, usa una de las **3 conocidas-buenas** (Jaipur / Mumbai / Rajasthan).

---

## Plan B — Video backup (la red de seguridad real)
1. **Graba un screencast de 3 min** ejecutando el guion completo (`docs/DEMO_SCRIPT.md`) con todo caliente.
   - QuickTime → File → New Screen Recording. Audio opcional (puedes narrar en vivo sobre el video mudo).
2. Guárdalo **local + en la nube** (no dependas del WiFi del venue).
3. Si en vivo algo se cae (red, warehouse no calienta, serving timeout): **cambia al video sin disculparte**,
   narra encima. Un video fluido > una demo en vivo tartamudeando.

## Plan C — Degradación elegante (ya está en el código)
- Si **serving** falla → "Ask in plain English" da 503 limpio, pero **"Search by field" sigue funcionando**.
  Cae a búsqueda estructurada: need=dialysis, city=Jaipur. Misma SQL, mismo resultado.
- Si **Lakebase** falla → la app corre en modo analytics-only; el shortlist degrada suave (fetches fail-soft).
  El core (buscar + evidencia) no depende de Lakebase.
- **Verbaliza la resiliencia** si pasa: "el parseo NL es una capa de conveniencia sobre una búsqueda
  estructurada que siempre está disponible" — convierte un fallo en un punto de diseño.

---

## Dry-run cronometrado (hazlo 1–2 veces antes)
1. Corre `warmup.sh`.
2. Cronometra el guion completo de principio a fin. Meta: **≤ 2:50** para tener colchón.
3. Identifica el beat que se te alarga (suele ser el de los dos ejes de evidencia) y recórtalo a frases.
4. Confirma que cada clic que vas a hacer en vivo **funciona** en el orden del guion.

## Notas
- Si el venue tiene WiFi malo: usa hotspot del celular para la demo en vivo, y ten el video listo igual.
- No corras `bundle deploy` / `apps deploy` el día de la demo salvo emergencia — un deploy reinicia compute
  y vuelve a meter cold start. Congela el código la noche antes.
