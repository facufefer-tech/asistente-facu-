# Automatización de Illustrator — Análisis y Posibilidades

Fecha: 24/04/2026 · Fuentes: `server.js` (flujo propuestas, Vision, HTML/CSS, Puppeteer), `data/informe-cobertura-diseno.md`, búsqueda de documentación pública (Adobe ExtendScript/UXP, Firefly API).

## Lo que ya hace el sistema hoy

Flujo real implementado (resumen de código):

1. **Origen de datos:** `sale.order` (OV), `sale.order.line` (SKU en texto de línea), `mail.message` (chatter tipo comentario), `ir.attachment` (imagen en la OV, preferencia `image/*`).
2. **Notas de diseño:** `parseChatterNotes` + texto plano; opcionalmente **`enrichChatterNotesWithGroqIfNeeded`** (Groq) para condensar instrucciones desde el hilo.
3. **Imagen de logo en OV:** base64 a data-URI; **Google Cloud Vision** (`images:annotate`) extrae **texto** y colores aproximados.
4. **SKU:** heurísticas `extractSkuCandidateFromLine` + **`parseSKU`** (familia, medidas, terminación) para armar el layout.
5. **Diseño visual:** `build*SheetHtml` (plastisol, bolsa, badana, bordada, genérico) → **un HTML** con CSS (tipografía web vía Google Fonts en algunos casos) → **`htmlToPdf`** con **Puppeteer** (Chromium) → PDF en `propuestas/`.
6. **Cambios de texto** del usuario: `applyProposalDesignCambiosToNotas` aplica reglas por palabra (fondos, relieves, colores) sobre el objeto de notas.

**Qué funciona bien:** entrega de **PDF listo** sin Illustrator; reutiliza datos de Odoo; Vision da pistas de color y texto; layouts por familia de producto.

**Limitaciones:** no se genera **.ai** editable; la tipografía final depende de **fuentes web** y de heurística sobre textos de Vision, no de la caja de márgenes de Illustrator; colores de Vision no son “Pantone oficiales”; múltiples variantes (negro/blanco) no generan múltiples hojas automáticamente; **`productDesignDB`** no alimenta aún al motor de `generateProposalPDF`.

**Endpoint paralelo:** `GET /api/producto-diseno/:sku` lee la ingesta de PDFs; **separado** del PDF de propuesta comercial.

## Lo que aprendí de los PDFs de producción

(De `data/informe-cobertura-diseno.md` y estadísticas de ingesta — la extracción es heurística; los “patrones” son tendencias, no reglas estrictas.)

| Tema | Hallazgo |
|---|---|
| Volumen | 289 PDFs; 1 registro por archivo; 132 con match Odoo, 157 sin `default_code` o sin SKU. |
| Confianza | Alta: 8 · Media: 96 · Baja: 185 (cabecera de nota: muchos textos poco estructurados). |
| Tipografías en top 10 (informe) | El bloque quedó “_Sin datos_” (detector de tipos aún pobre o texto sin nombres de fuente en PDF). |
| Colores (nombres) | Frecuentes: negro, blanco, plata, amarillo, azul, beige, oro, rojo. |
| Inconsistencias | Mismo código tipo `EP3x3T1` repetido; strings basura o nombre de archivo como “SKU” (`00000014-MOSCU…`); variantes bordada/fondo/camiseta con mismas marcas. |
| Medidas y familias | El `parseSKU` en servidor ya entiende familias comerciales (BOPO, EESN, etc.); en PDFs hay mezcla de bordada, e-commerce, pliegos. |

**Inconsistencias entre PDFs del mismo “tipo” de producto:** nombres de archivo no normalizados; a veces solo descripción de producto en el nombre, no en el cuerpo; duplicación de términos (PP/NP) según `notas` unificadas en ingesta.

## Gap actual

Información frecuente en PDFs reales de producción (Preimpresos / Ficha técnica) que **aún no** alimenta el flujo de propuesta con Odoo+HTML:

- Guías de corte, sangrado, color de hilo, secuencia de colores bordado (orden real).
- **Pantone** sólido con código exacto (la ingesta busca el texto, pero no pasa a plantilla PDF de propuesta).
- Capas, sobreposición “bordado sobre tela” vs mockup plano.
- Fuentes: muchos PDFs no exponen el nombre de fuente en el texto extraíble → heurística y Vision quedan cortas.
- Relación **SKU ↔ múltiples variaciones** (talle, color) en un solo paquete.
- Historial de revisiones (NP vs PP) con diff explícito.

## Opciones de automatización real de Illustrator

| Opc | Nombre | Qué hace p/ avíos / textiles | .ai existente / nuevo | Editable en Ilustrador | Costo (típico) | Dificultad con Node+Fly (1-5) | Recom. |
|-----|--------|-----------------------------|------------------------|------------------------|----------------|--------------------------------|--------|
| **1** | **ExtendScript (.jsx) / app scripting** | Abrir .ai, reemplazar texto, colores, exportar PDF/EPS; batch por carpeta. | **Modificar** plantillas; también crear desde cero. | Sí, nativo .ai | Incluido con licencia **Illustrator**; sin API cloud. | 3 (correr en desktop/VM o cola; no en Fly puro) | **Evaluar** para taller interno. |
| **2** | **Creative Cloud + APIs cloud (p. ej. Firefly / servicios documentados)** | Generación/variaciones de imágenes, no edición de vectores de Illustrator por DOM. | **Nuevas** imágenes (raster); no .ai. | No como .ai; output raster o exports genéricos. | **Pago** (FIREFLY_SERVICES, tokens/cuota Adobe). | 3 | **No** como sustituto de .ai; **sí** para pruebas visuales aparte. |
| **3** | **.ai vía SVG / PDF intercambio** | Illustrator abre y exporta **SVG**; el servidor genera o muta **SVG** (posición texto, colores). | Nuevo o round-trip si se define plantilla en SVG. | Sí, con limitaciones (efectos complejos, fuentes). | Bajo (herramientas open). | 3 | **Evaluar** para conectar a plantillas “vectoriales” sin .jsx. |
| **4** | **Puppeteer + HTML/CSS (actual)** | Maquetar ficha y PDF; no es Illustrator. | N/A (PDF) | “Editable” en sentido pobre (re-hacer en AI). | Infra mínima (Chromium en Fly con flags). | 2 (ya hecho) | **Usar** como canal principal corto plazo. |
| **5** | **Fabric.js / Konva** (browser o canvas Node) | Componer pruebas de diseño 2D y exportar a imagen o SVG. | Nuevos assets; no lee .ai binario. | Requiere reimport a AI. | Libre / OSS. | 4 | **Evaluar** para editor web interno, no reemplazar AI de producción. |
| **6** | **Sharp + plantillas SVG** | Renderizar **PNG/PDF** desde SVG rellenado (texto, colores). Muy adecuado para mockups 2D y sellos. | Nuevo; SVG como plantilla. | Cargar SVG en Ilustrator → editable con aviso. | Libre (Sharp) + almacenamiento. | 2–3 | **Usar** para previsualizaciones ligeras y servir PDF más rápido que Chromium si se simplifica. |
| **7** | **Python + `svgwrite` / `reportlab`** | Generar SVG/PDF con datos (similar a 6) desde scripts batch o microservicio. | Nuevos. | Editable vía importación SVG. | Gratis (OSS). | 3 (otro runtime o sidecar) | **Evaluar** si se prefiere microservicio no-Node. |

**Nota UXP/Illustrator:** la documentación pública destaca UXP/JS moderno en **Photoshop**; en **Illustrator** el ecosistema UXP para terceros es más limitado y foros indican **restricciones o uso interno** — no conviene asumir paridad con Photoshop. **ExtendScript** sigue siendo la ruta clásica para scripts `.jsx` en máquina con Illustrator instalado.

**Adobe Firefly** ([developer.adobe.com](https://developer.adobe.com/firefly-services/docs/firefly-api/)) sirve para **imagen** generada/briefs; no reemplaza edición de vectores y plantillas a medida para bordado.

## Funciones nuevas que se podrían agregar al agente

(Impacto aproximado: alto → bajo; todas suponen criterios y permisos en Odoo.)

1. **Auto-completar plantilla (SVG o HTML)** con datos de **`productDesignDB`**: merge `tipografia`, colores, `texto_escrito`, `tamano_mm` al generar propuesta.  
2. **Exportar variantes de color** en un ZIP (varias hojas o PDFs) según colores de línea.  
3. **Validar propuesta vs NP**: diff texto entre notas de OV + PDF ingesta (por SKU) y respuesta estructurada al usuario.  
4. **Biblioteca de logos**: persistir de `ir.attachment` o Vision crop en `S3/MinIO` indexado por `partner_id` / marca.  
5. **Historial de diseño por cliente**: `search_read` OVs con adjuntos + join con `productos-diseno` por `default_code` de líneas.  
6. **Sugerir Pantone** desde ingesta al elegir colores de relieve/fondo.  
7. **Cola de jobs** de PDF (Bull/Redis) para no bloquear el event loop 30+ s.  
8. **Webhook** al terminar un PDF (email/WhatsApp con link).  
9. **Re-run ingesta** desde admin (`POST` protegido) para refrescar `productDesignDB` sin redeploy.  
10. **Plugin ExtendScript** generado: exportar un `.jsx` con parámetros desde el agente (para que diseño ejecute 1 click en oficina).

## Recomendación final (próximas 2 semanas, stack actual)

**Opción ancla:** seguir con **Puppeteer + HTML/CSS (opción 4)** y añadir **capa de datos reales** desde `productDesignDB` y mejor parse de notas; añadir **Sharp + SVG (opción 6)** solo si se mide mejora de **latencia o coste** al retirar Chromium en un subconjunto de layouts.

**Plan en 5 pasos (concreto, sin romper producción):**

1. **Mapear** en código `line.default_code` / SKU parseado → `productDesignDB.find` (normalizado) en `executeModificarPropuestaFromAgent` y pasar a `buildBordadaSheetHtml` (y similares) un objeto `designHints` opcional.  
2. **Ajustar** plantillas HTML para mostrar, si existen, colores, tipografía y medidas de la ingesta (sin inventar: solo si `null`, omitir bloque).  
3. **Cachear** o **pool** Puppeteer (quick win) y medir p95 de `generateProposalPDF`.  
4. **Definir 1–2** plantillas **SVG fijas** (p. ej. bordada genérica) y probar `sharp` o `svg`→PDF; comparar fidelidad con el PDF actual.  
5. **Documentar** un flujo manual opcional: script **ExtendScript** exportado con datos JSON para la diseñadora (out-of-band), mientras no haya estación con Illustrator en el servidor.

---
_Informe orientado a planificación; integración legal de APIs Adobe y licencias corre por cuenta de la organización._
