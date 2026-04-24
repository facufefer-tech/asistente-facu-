# Informe de ajustes recomendados (código + LLM + Odoo)
Fecha: 2026-04-24

## Objetivo
Mejorar el desempeño general del asistente para reflejar la operativa real del rubro (pagos, mercadería, entregas, documentación), reduciendo ambigüedad y errores en registro/ejecución.

## 1) Ajustes de modelo de datos (clave)
- Crear un **evento canónico** único para cualquier mensaje operativo:
  - `tipo_evento` (pago_cliente, pago_proveedor, recepcion, control_calidad, remito_factura, entrega, seña, ajuste_cc, etc.)
  - `contraparte` (cliente/proveedor/persona)
  - `monto`, `moneda`, `medio_pago`, `cuenta_destino`
  - `referencia_documental` (adjunto, nro comprobante, remito, factura)
  - `estado_flujo` (pendiente, validado, ejecutado, observado)
  - `origen` (whatsapp_pagos / whatsapp_mercaderia / whatsapp_movimientos / odoo)
- Separar explícitamente:
  - **hecho económico** (pago/cobro),
  - **hecho logístico** (entrega/recepción),
  - **hecho de calidad** (ok/mal de diseño/producción).

## 2) Ajustes de extracción LLM/NLU
- Pasar de intentos “1-shot libres” a pipeline por etapas:
  1. normalización de texto,
  2. clasificación primaria del evento,
  3. extracción de entidades obligatorias,
  4. score de confianza por campo.
- Implementar diccionario de sinónimos/abreviaturas del rubro:
  - `efvo=efectivo`, `mp=mercadopago`, `seña/sena`, alias bancarios recurrentes, nombres comerciales abreviados.
- Agregar validaciones duras:
  - sin `monto` + `contraparte` + `tipo_evento`, no ejecutar; pedir aclaración estructurada.
- Soportar múltiples eventos en un solo mensaje:
  - ejemplo: “transferirle a X y 90k a Y” -> dividir en eventos hijos.

## 3) Ajustes de integración Odoo
- Incorporar una capa de mapeo estable entre evento canónico y modelos Odoo:
  - pagos (`account.payment`),
  - notas/chatter (`mail.message`),
  - entrega/stock (`stock.picking`, `stock.move.line`),
  - ventas (`sale.order`, `sale.order.line`),
  - facturación (`account.move`).
- Implementar tabla de equivalencias para nomenclatura de trabajo vs nomenclatura Odoo:
  - nombres informales de clientes/proveedores -> `res.partner`.
- Incorporar idempotencia por hash de evento para evitar doble carga.
- Aplicar control de tasa/reintento exponencial para Odoo (`429`, timeout, redes inestables).

## 4) Ajustes en visión/documentos (Google Vision + adjuntos)
- Crear una cola de procesamiento de adjuntos (async) con estados:
  - recibido -> OCR pendiente -> OCR parseado -> vinculado a evento/Odoo.
- Extraer automáticamente:
  - importe,
  - fecha,
  - banco/medio,
  - nro operación/comprobante,
  - titular/cuenta destino.
- Vincular OCR a mensaje fuente y al evento canónico para trazabilidad completa.

## 5) Ajustes de flujo operativo (según chats reales)
- Modelar el flujo de mercadería por hitos con responsables:
  - ingreso con foto -> validación diseño -> remito/factura -> coordinación -> entrega/despacho.
- Exigir confirmaciones intermedias donde hoy hay fricción:
  - validación de Mile antes de pasar a remito/factura,
  - confirmación de pago cuando hay saldo pendiente.
- Implementar alertas de “bloqueo de flujo”:
  - pedido sin validación,
  - remito sin entrega,
  - entrega sin comprobante,
  - pago informado sin respaldo documental.

## 6) Ajustes de observabilidad y QA
- Consolidar QA automático + QA operativo:
  - mantener 50 pruebas funcionales existentes,
  - sumar suite de regresión con corpus real anonimizado de chats.
- Crear tablero mínimo de salud:
  - tasa de parseo exitoso,
  - eventos con faltantes,
  - discrepancias con Odoo,
  - latencia por módulo.
- Establecer QA por lotes semanales sobre al menos 1000 registros reales (muestreo estratificado por tipo de evento).

## 7) Prioridad de implementación recomendada
1. Evento canónico + validaciones obligatorias + diccionario de sinónimos.
2. Mapeo formal a modelos Odoo + idempotencia + reintentos/rate limit.
3. Cola de OCR/adjuntos con vinculación a eventos.
4. Automatización de hitos de mercadería y bloqueos de flujo.
5. QA operativo continuo con corpus real.

## 8) Ajustes fuera de ejemplos puntuales (generalidades del trabajo)
- Estandarizar lenguaje operativo sin pedir formato rígido al usuario.
- Tratar cada mensaje como evidencia parcial de un proceso mayor.
- Priorizar consistencia contable/logística por sobre “respuesta conversacional”.
- Alinear el LLM a entidades de negocio y no solo a intención textual.
- Convertir el chat en un sistema transaccional auditable (no solo asistente).
