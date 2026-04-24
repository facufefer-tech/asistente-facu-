# Recomendaciones de Mejora — Código y Arquitectura

Fecha: 24/04/2026 · Alcance: revisión orientada a `server.js` como monolito principal (~7 600 líneas), sin ejecutar refactors en este documento.

## Crítico (afecta funcionamiento)

| # | Descripción | Ubicación (~) | Impacto | Solución propuesta |
|---|---|---|---|---|
| C1 | **Sesiones solo en memoria** (`Map` global): un redeploy o segundo instancia Fly invalida contexto de confirmación, OCs pendientes en flujo, etc. | `sessions` ~20, `getOrCreateSession` ~380+ | Usuario pierde flujo a mitad; comportamiento distinto entre instancias. | Externalizar sesión (ver sección Arquitectura) o al menos persistir `sessionId` críticos en cliente con rehidratación mínima desde Odoo. |
| C2 | **Múltiples `setInterval` 30 min** sin coordinación entre instancias ni lock. | ~366–383 | N instancias = N× lecturas a Odoo; posible contención o rate limits. | Un solo job programado (cron Fly, o cola) o **advisory lock** + instancia líder. |
| C3 | **Timeouts** distintos (Groq 15s en un sitio, Odoo 10s en cliente JSON-RPC): carreras difíciles de razonar en producción lenta. | ~655, ~4801 | Timeout aparente “al azar” según ruta. | Centralizar constantes y métrica de `requestId` por request. |
| C4 | **Puppeteer por request** sin pool ni reutilización de browser. | `htmlToPdf` ~7369+ | Picos de memoria/CPU; fallos en contenedores con límite bajo. | Pool de 1 browser con `browser.newPage()` o worker separado. |
| C5 | **Errores silenciados** en varios `try/catch` que solo hacen `console.log` (p. ej. adjuntos propuesta). | ~3430+ | Fallo parcial sin visibilidad para operación (p. ej. sin logo sin avisar). | Log estructurado + contador + mensaje usuario si afecta calidad del PDF. |

## Importante (afecta performance)

- **Odoo en cadena:** en flujos de propuesta y compras se encadenan muchas lecturas que no dependen entre sí en el resultado final (p. ej. tras tener `order.id`, líneas y mensajes podrían prepararse con cuidado de dependencias usando `Promise.all` donde el modelo lo permita).
- **Sin `Promise.all` en el repo** (búsqueda en `server.js`): confirmado; oportunidad clara para reducir latencia percibida.
- **Caché de lecturas repetidas:** mismo `sale.order` / producto / partner en pocos segundos podría cachearse en memoria con TTL corto (Map + `setTimeout` invalidación) para el agente.
- **Funciones largas duplicadas conceptualmente:** lógica de lectura de OV + líneas + chatter aparece en el flujo del agente y en `handleGenerarPropuestaEndpoint`: mantenimiento doble y riesgo de divergencia.
- **`loadPendingPurchaseOrders`:** bucle anidado OC → líneas; con 200 OCs y muchas líneas, coste alto; considerar `read` batch o menos campos.

## Arquitectura

### Dividir `server.js` sin romper nada (solo plan)

1. **`http/routes.js`** — montar `express`, `app.post/get`, delegar a handlers.
2. **`odoo/client.js`** — `createOdooClient`, `validateEnv`, constantes de timeout.
3. **`agent/index.js`** — `runAgentWithHistory`, prompts, Groq, pre-LLM chain.
4. **`domain/pagos.js`**, **`domain/compras.js`**, **`domain/ventas.js`**, **`domain/reportes.js`** — un archivo por dominio con funciones puras + dependencia inyectada `odoo`.
5. **`proposal/`** — `executeModificarPropuestaFromAgent`, `generateProposalPDF`, Vision, plantillas HTML.
6. **`cache/loaders.js`** — `loadPendingPurchaseOrders`, suppliers, templates, `productDesignDB`.
7. **`server.js`** — solo bootstrap: `import app from './app.js'`, `app.listen(PORT)`.

Mantener la misma firma pública de endpoints; mover **sin cambiar** el comportamiento en el primer PR; tests de humo vía `informe-qa` / curl.

### Logs estructurados (Winston, Pino, etc.)

- Un **correlativo** `reqId` por request de `/api/agent` y propuesta.
- Niveles: `info` (ruta+latencia+acción), `warn` (fallback Groq, retry chatter), `error` (stack + `uid` sin datos sensibles).
- Campos: `moduleHint`, `odooModel`, `executeKw_ms` (si se instrumenta).
- En Fly: JSON a stdout para agregación.

### Sesiones y redeploy

| Opción | Pros | Contras |
|---|---|---|
| **Redis (Upstash, Redis Cloud)** | Rápido, TTL, multi-instancia | Costo, otro servicio |
| **Supabase / Postgres** | Auditable, duradero | Más lento, esquema |
| **Archivo JSON en volumen Fly** | Simple | No sirve con >1 instancia sin fs compartido |
| **Solo stateless + Odoo** | Cero deps | Más lógica para “rehacer” contexto |

Recomendación a corto plazo: **Redis** con TTL 24h para `session` serializado (history truncada a lo ya limitado a 20 mensajes).

### `setInterval` y múltiples instancias en Fly

- **Un cron** vía [Fly Machines scheduled](https://fly.io/docs Machines/guides-examples/schedule) o API externa que golpee `POST /internal/refresh-caches` con secret.
- O **lock distribuido** (Redis `SET key NX EX 60`) al entrar a `loadPendingPurchaseOrders`.
- Evitar N timers idénticos: consolidar en **un** `setInterval` que llame a una cola de tareas en serie.

## Quick wins (< 1 h c/u, orden sugerido)

1. **Constantes** `GROQ_TIMEOUT_MS`, `ODOO_TIMEOUT_MS` en un solo módulo.
2. **Reutilizar instancia Puppeteer** en proceso (variable módulo-level + cierre en `SIGTERM`).
3. **Healthcheck** `GET /health` con chequeo mínimo (memoria + existe `.env` keys sin exponer).
4. **Métrica** `Date.now()` alrededor de `executeModificarPropuestaFromAgent` y log de duración por fase (Odoo / Vision / PDF).
5. **`Promise.all([lines, firstChatter])`** solo si el segundo query no requiere ids de líneas (validar con modelo Odoo 16).
6. **Añadir a `.gitignore`** `tmp_pdfs/`, `propuestas/*.pdf` generados de prueba si aplica.

## Deuda técnica

- **Monolito** dificulta pruebas unitarias aisladas; casi todo depende de `createOdooClient` global.
- **Prompts y reglas** mezclados con lógica de negocio; cambiar copy implica tocar lógica.
- **Heurísticas** (`isNegative`, `detectIntentModule`, rutas pre-LLM) frágiles ante variantes de lenguaje; sin suite unitaria, solo QA integración.
- **Datos sensibles** en logs potenciales (revisar `console.log` con bodies de Odoo en propuesta).
- **`productDesignDB`** desacoplado del flujo de generación de propuesta: la ficha nunca inyecta automáticamente tipografía en el PDF a día de hoy.
- **Sin rate limit** en `/api/agent` a nivel app (solo lo que ponga Fly/proxy).

---
_Documento de trabajo; no sustituye revisiones de seguridad ni pruebas de carga en producción._
