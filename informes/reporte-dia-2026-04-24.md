# Reporte del día — Asistente Facu

Fecha: 24/04/2026

## ✅ Tareas completadas

- **Inventario y descompresión de PDFs** — ZIP de producción descomprimido en `tmp_pdfs/`, listado en `inventario.txt` (289 archivos).
- **Pipeline de ingesta** — Script `scripts/ingest-design-pdfs.mjs` con extracción de texto vía `pdf-parse`, heurísticas de SKU, cliente/OV, tipografía, colores, Pantone, tamaño, material, terminación, cantidad de colores y confianza.
- **Salida `data/productos-diseno.json`** — Un registro por PDF, campos `null` si no hubo match (sin datos inventados).
- **Cruce con Odoo** — Script `scripts/enrich-design-odoo.mjs` por `product.template.default_code`, enriquecimiento con `odoo_id` / `match_odoo`.
- **Archivo `data/productos-diseno-con-odoo.json`** — Base lista para consumo por API.
- **`data/informe-cobertura-diseno.md`** — Informe de cobertura (totales, sin match, confianza baja, top tipografías y colores).
- **Integración en `server.js`** — `loadProductDesignDatabase()` al arranque, variable global `productDesignDB`, endpoint `GET /api/producto-diseno/:sku`.
- **Ajuste del esquema de ingesta** — Unificación de `notas` (incluye metadatos PP/NP y hex cuando aplica); eliminación de campo suelto `doc_tipo` del JSON publicado.
- **Corrección `isNegative`** — Evitar que frases tipo “no sé …” se interpreten como cancelación (regex `^no[,.!]` sin `\s` tras `no`).
- **Suite QA** — Ejecución documentada en `informe-qa-2026-04-24.md` (50 casos × local + prod).
- **QA adicional de propuestas** — Script `scripts/run-qa-propuestas.mjs`: **50** casos (generación, modificaciones colores/tipo/medidas, flujos 2 pasos con `sessionId`, edge), LOCAL + PROD; resultados en la sección **Propuestas QA** del mismo informe; resumen ejecutivo unificado **100** pruebas.

## 📊 Estado del sistema

- **Server:** local (`PORT` / 3000) + Fly.io (`https://asistente-facu.fly.dev`).
- **QA (100 pruebas = general + propuestas):** Local **58** PASS / **42** WARN / **0** FAIL; Prod **57** PASS / **43** WARN / **0** FAIL. Subconjunto general (50): **45** PASS / **5** WARN (igual que antes). Subconjunto propuestas (50): Local **13** PASS / **37** WARN; Prod **12** PASS / **38** WARN (heurística: `/propuestas/…`, latencia >10 s, MODIFICAR vía agente sin URL en texto).
- **Latencia promedio (ponderada 50+50):** local **1 961 ms**; prod **2 484 ms**. Máximas históricas de la batería general: local **28 429 ms**; prod **52 962 ms** (propuesta). Máximas batería propuestas: local **28 021 ms**; prod **37 124 ms**.
- **Bug `isNegative`:** **corregido** (comentario y lógica en `server.js` ~752–759).
- **Timeouts Groq / Odoo:** **parcial / a vigilar** — Groq con abort ~**15 s**; cliente JSON-RPC Odoo ~**10 s** en rutas críticas. No se reportaron aborts en el QA del día, pero persisten latencias muy altas en generación de propuesta (WARN), distintas de un timeout duro.

## 🗄️ Base de datos de diseño

- **PDFs procesados:** **289**
- **Productos extraídos:** **289** (1 por PDF)
- **Match con Odoo:** **132**
- **Sin match:** **157** (incluye filas sin SKU útil y códigos sin `default_code` en Odoo)
- **Confianza alta:** **8**
- **Confianza media:** **96**
- **Confianza baja (revisar):** **185**

## ❌ Pendientes para mañana

1. **Revisión manual** de los **185** registros con confianza **baja** y de los **157** sin match Odoo (validar SKU en PDF, crear/ajustar productos en Odoo si corresponde).
2. **Propuestas / Puppeteer** — Investigar por qué “generá propuesta para pierrs” dispara latencias de **28–53 s** (WARN en QA); considerar caché, timeout UX o cola async.
3. **Mensajes ambiguos** — Mejorar detección de “pregunta por dato faltante” en casos **#7, #14, #15** (WARN en QA).
4. **Opcional:** ignorar `tmp_pdfs/` en `.gitignore`; documentar en README el flujo `ingest` → `enrich` → reinicio del servidor.
5. **Recarga en caliente** de `productos-diseno-con-odoo.json` (hoy solo al arranque).

## ⚠️ Alertas

- **Latencia extrema** en al menos un flujo de **ventas/propuesta** (local y prod): supera ampliamente el umbral de 5 s del runner QA; monitorear en horario de uso real.
- **Cobertura de diseño:** solo **~46%** de filas matchean Odoo; riesgo de consultas por SKU sin ficha en ERP hasta completar datos o reglas de extracción.
- **Confianza:** la mayoría de extractos son **media** o **baja**; no usar la base como verdad única sin revisar PDFs en casos críticos.
