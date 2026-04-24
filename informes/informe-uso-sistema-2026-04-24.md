# Reporte de Uso del Sistema — Asistente Facu

Fecha: 24/04/2026 · Fuente principal: análisis estático de `server.js` (≈7 613 líneas), `informe-qa-2026-04-24.md` (100 pruebas) y `data/informe-cobertura-diseno.md`.

## Módulos más usados (inferido de la complejidad del código)

Los límites de “módulo” no están declarados en el archivo; se agrupó por **dominios funcionales** según dónde viven las funciones. Las cifras de **líneas** son aproximadas; **funciones** cuenta declaraciones `function` / `async function` cuyo cuerpo pertenece a ese bloque; **executeKw** e **indirectas Groq** se obtuvieron por búsqueda en todo el archivo (113 llamadas a `executeKw` en total, 2 `fetch` a `api.groq.com` explícitos + uso de `enrichChatterNotesWithGroqIfNeeded` en propuestas).

| Módulo (dominio) | Líneas (~) | Funciones (~) | Llamadas Odoo (`executeKw`) | Groq / LLM |
|---|---:|---:|---:|---:|
| Agente, sesión, intent, prompts, pre-LLM | 400–1 750 | 25+ | 15–25 | 1 (cadena principal `runAgentWithHistory` → `fetch` Groq) |
| Consultas directas: deuda, OC, caja, reportes, contactos, precios, WhatsApp, crédito | 800–3 200 | 55+ | 45–55 | 0 (salvo vía flujo agente) |
| Propuestas: OV, líneas, chatter, Vision, `generateProposalPDF`, Puppeteer | 3 250–4 500 & 6 200–7 600 | 20+ | 18–25 | 1 (notas del chatter) + enriquecimiento opcional |
| Pagos, facturas, movimientos, recepción stock, entregas | 1 800–2 200 & 5 200–5 900 | 35+ | 35–45 | 0 directo |
| Compras, OCs, proveedores, caché `pendingPurchaseOrders` | 2 100–2 800 & 5 200–5 400 | 20+ | 20–30 | 0 directo |
| Cliente JSON-RPC Odoo, validación entorno, utilidades | 4 600–4 900 | 5 | — | 0 |
| **Total / archivo** | **~7 613** | **~195** | **113** | **2 fetch Groq** + **Vision** (`vision.googleapis.com` vía `analyzeImageWithVision`) |

*Google Vision: no hay contador de llamadas fijas; al menos un uso por generación de propuesta cuando hay imagen en adjuntos de la OV.*

## Endpoints activos

| Método y ruta | Qué hace |
|---|---|
| `POST /api/agent` | Cuerpo principal del chat: sesión, historial, pre-LLM (propuestas, pagos, recepción, reportes, etc.), llamada a Groq para intención/JSON, ejecución de acciones, respuesta JSON con `reply`, `options`, `action`, `sessionId`. |
| `POST /api/generar-propuesta` | Genera PDF de propuesta para una OV: lee `sale.order`, líneas, chatter, adjuntos, opcionalmente Vision; devuelve JSON con `success`, `pdf_url`, `orden_id`. |
| `GET /api/producto-diseno/:sku` | Devuelve ficha de la base de diseño (`productDesignDB` desde `data/productos-diseno-con-odoo.json`) por `default_code`/SKU. |
| `GET /` (y estáticos) | `express.static` sobre `public/`. |
| `GET /propuestas/...` | Archivos HTML/PDF generados bajo el directorio `propuestas/`. |

No hay router aparte: todo el API está declarado al inicio del archivo (~líneas 25–361).

## Cargas al arrancar

| Dato en memoria | Origen / función | Refresco |
|---|---|---|
| `pendingPurchaseOrders` | `loadPendingPurchaseOrders()` — OCs en estado `purchase` con líneas pendientes de recepción | Cada **30 min** (`setInterval`) y al inicio |
| `productDesignDB` | `loadProductDesignDatabase()` — JSON `data/productos-diseno-con-odoo.json` | **Solo al arranque** (no hay interval) |
| `allSuppliers` | `loadAllSuppliers()` — nombres de `res.partner` proveedores | Cada **30 min** y al inicio |
| `whatsappTemplates` | `loadWhatsappTemplates()` | Cada **30 min** y al inicio |
| `saleOrderTemplates` | `loadSaleOrderTemplates(odoo, uid)` en IIFE y en `setInterval` de 30 min | Inicio (async) + cada **30 min** |
| `sessions` (Map) | Nuevo al primer mensaje por `sessionId` | En RAM hasta reinicio de proceso; **no** persistido |

Orden aproximado al boot: `app.listen` → inmediatamente `loadPendingPurchaseOrders`, `loadProductDesignDatabase`, `loadAllSuppliers`, `loadWhatsappTemplates`, luego IIFE que autentica Odoo y carga plantillas de OV. Cuatro `setInterval` de 30 minutos (tres directos + uno async para plantillas) pueden **solaparse** si tardan más de 30 min (riesgo bajo de carga, no de lógica duplicada en código).

## Dependencias críticas

| Servicio | Si falla | Impacto real para el usuario |
|---|---|---|
| **Odoo (JSON-RPC)** | Cualquier `authenticate` o `executeKw` que lance / timeout | No hay pagos, no hay propuestas con datos reales, no hay reportes de caché, no confirmación de OV, etc. Mensajes de error genéricos del tipo “no pude conectar con ODOO”. |
| **Groq** | Timeout 15s o 401/5xx en `/chat/completions` | El agente recurre a *fallback* (`GROQ_JSON_FALLBACK_REPLY` y opciones vacías) o respuestas de error suaves: flujo de intención limitado, sin clasificación fiable. |
| **Google Vision** | `GOOGLE_VISION_API_KEY` ausente o API error | Propuesta sigue con logo por archivo o sin análisis de color/texto: `visionData` vacío; heurística de tipografía por defecto. |
| **Puppeteer (Chromium)** | Fallo al `launch` o PDF | Generación de propuesta rota: sin archivo en `/propuestas/`. Típico en Docker sin dependencias; Fly suele requerir flags `--no-sandbox` (ya usados). |
| **Fly.io** | App caída o cold start | Usuario no llega al chat o latencia alta; **no afecta** a la lógica del código en sí. |
| **Archivos locales** | `data/productos-diseno-con-odoo.json` no existe | `productDesignDB` = `[]`; `GET /api/producto-diseno/:sku` devuelve 404. |

## Métricas de las 100 pruebas QA

Fuente: `informe-qa-2026-04-24.md` (batería general 50 + propuestas 50, LOCAL y PROD).

- **Módulo con más FAILs:** **ninguno** (0 FAIL en ambas baterías y ambos entornos).
- **Batería con más WARN (heurístico):** **Propuestas (50)** — 37 LOCAL / 38 PROD frente a 5+5 en la batería general.
- **Más lento (promedio reportado en el informe):** batería **Propuestas** — ~2 923 ms (L) y ~3 351 ms (P) vs. ponderada total ~1 961 / ~2 484 ms. Casos puntuales de **máxima latitud** en la batería general: **VENTAS** #24 “generá propuesta para pierrs” (~28–53 s) por Puppeteer + Odoo.
- **Más rápido (cualitativo):** módulos con respuestas mayormente conversacionales y sin cadena larga a Odoo (p. ej. parte de **FALLBACK** o pasos con respuesta fija) suelen quedar bajo el promedio global; no hay medición por módulo en el script de QA.
- **Diferencia de latencia LOCAL vs PROD:** global ponderada **+523 ms** en prod (1 961 → 2 484). En propuestas: **+428 ms** de promedio. Por **módulo** no se exportaron tiempos separados; conviene extender el runner para guardar `ms` agregado por `module` en el informe.

## Cuellos de botella detectados

1. **Secuencia Odoo en `executeModificarPropuestaFromAgent` (y equivalente en `handleGenerarPropuestaEndpoint`):** `search_read` OV → `read` líneas → `search_read` mensajes (a veces dos intentos) → `search_read` adjuntos → opcional **Vision** → **Groq** notas → **Puppeteer** (nuevo browser por PDF). Más de **3** llamadas Odoo en serie sin `Promise.all`.
2. **Sin `Promise.all` en todo `server.js`:** no hay paralelización explícita de lecturas independientes (p. ej. líneas y primer fetch de chatter podrían evaluarse en paralelo bajo precondiciones).
3. **Puppeteer `launch` por PDF:** en `htmlToPdf` se abre y cierra browser completo por cada generación: costoso en CPU y tiempo (coincide con picos de latencia en QA).
4. **Caché:** `pendingPurchaseOrders` y proveedores se refrescan, pero no hay caché de lecturas frecuentes de `sale.order` por nombre o de productos para propuestas repetidas.
5. **`loadPendingPurchaseOrders`:** bucle secuencial por OC y por líneas: muchas rondas `executeKw` bajo carga.
6. **Varios `setInterval` 30 min:** en Fly con **múltiples instancias** cada una ejecuta su propia carga a Odoo (multiplicación de carga; no es bug de un solo hilo, pero es presión al ERP).

---
_Informe generado por análisis de código; las métricas por “módulo lógico” son estimadas donde no existía separación estricta de archivos._
