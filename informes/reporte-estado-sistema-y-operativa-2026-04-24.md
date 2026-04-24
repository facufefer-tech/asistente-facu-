# Reporte general del sistema y últimas actualizaciones
Fecha: 2026-04-24

## 1) Estado actual del sistema (hoy)
- **API local**: activa y respondiendo en `http://localhost:3000`.
- **QA base (50 pruebas Local + Prod)**: ejecutado y guardado en `informes/informe-qa-post-illustrator-2026-04-24.md`.
- **Resultado QA**:
  - Local: PASS 45 / FAIL 1 / WARN 4
  - Prod: PASS 45 / FAIL 0 / WARN 5
- **Punto crítico detectado en QA**:
  - Caso de VENTAS `generá propuesta para pierrs`: FAIL local por `network: fetch failed` y WARN en prod por latencia alta.

## 2) Últimas actualizaciones técnicas aplicadas
- Se implementó pipeline de propuestas bordadas orientado a **Illustrator + ExtendScript**, con:
  - generación dinámica de `.jsx` por OV,
  - ejecución por `.cmd` (`EJECUTAR-ILLUSTRATOR-SCRIPTE.cmd`) con argumento de script,
  - salida esperada en `Desktop/aprobar` (AI/PDF),
  - logging de fallos en `Desktop/aprobar/logs`.
- Se agregó endpoint para listar candidatas bordadas:
  - `GET /api/propuestas-bordadas/candidatas?limit=...`
- Se agregó runner batch:
  - `scripts/run-illustrator-bordada-batch.mjs`

## 3) Estado de la prueba batch Illustrator (20 OVs)
- Corrida completada: `informes/illustrator-batch-2026-04-24.json`
- Resultado: **20 procesadas / 0 OK / 20 FALLO**
- Motivo registrado en todas: `fetch failed`
- Conclusión operativa: el pipeline quedó integrado, pero la ejecución batch no logró completar generación E2E en esta corrida por fallas de conectividad/ejecución entre llamadas.

## 4) Análisis de operativa real (WhatsApp)
Fuentes usadas:
- `tmp-whatsapp/pagos/_chat.txt`
- `tmp-whatsapp/mercaderia/_chat.txt`
- `tmp-whatsapp/movimientos/_chat.txt`

Resumen cuantitativo:
- Mensajes parseados:
  - Pagos: 832
  - Mercadería: 370
  - Movimientos diarios: 368
  - Total: 1570
- QA manual-operativa sobre registros: **1000 registros revisados** (subset controlado sobre total 1570).

Patrones de trabajo observados:
- **Pagos**:
  - Alta frecuencia de mensajes cortos con formato libre.
  - Mezcla de conceptos en una misma línea: cliente/proveedor, cuenta destino, importe y medio.
  - Uso fuerte de adjuntos (fotos/PDF comprobantes) y referencias de caja/alias.
  - Nomenclatura variable y con abreviaturas (`efvo`, `mp`, nombres truncados, errores tipográficos).
- **Mercadería**:
  - Flujo explícito por etapas: recepción con foto -> validación diseño (`ok/mal`) -> remito/factura -> entrega/despacho.
  - Dependencia de confirmación cruzada entre roles (Mati/Mile/Guido/Achu/Facu).
  - Eventos de calidad (`está mal`, diferencia de medida/color) que requieren trazabilidad.
- **Movimientos diarios**:
  - Canal mixto (ingresos, egresos, coordinación logística, consultas de saldo).
  - Muchos eventos son “seña + comprobante + instrucción”.
  - Hay eventos no estandarizados que requieren interpretación contextual humana.

## 5) Riesgos actuales para automatización Odoo + LLM
- Falta de estructura fija en mensajes (múltiples formatos para la misma acción).
- Ambigüedad de entidad (cliente/proveedor/persona interna) en textos cortos.
- Faltantes de campos clave en un solo mensaje (monto, medio, contraparte, comprobante).
- Interdependencia entre grupos (Pagos/Movimientos/Mercadería) para completar contexto.
- Rate limit/errores intermitentes de Odoo durante procesos largos.

## 6) Qué quedó pendiente para cerrar la estrategia completa
- Reintentar batch de 20 propuestas bordadas cuando la conectividad del entorno esté estable.
- Confirmar disponibilidad de la planilla de facturas/pagos mencionada (no encontrada en workspace/Desktop al momento del análisis).
- Ejecutar cruce directo de muestras del chat contra Odoo (campos reales por modelo) con ventana de tiempo más amplia y sin límites de tasa.

## 7) Entregables generados en esta instancia
- `informes/informe-qa-post-illustrator-2026-04-24.md`
- `informes/illustrator-batch-2026-04-24.json`
- `informes/whatsapp-operativa-analisis-2026-04-24.json`
- `informes/informe-ajustes-codigo-llm-odoo-2026-04-24.md`
