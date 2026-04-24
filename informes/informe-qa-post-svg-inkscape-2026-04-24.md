# Informe QA — Asistente Facu
Fecha: 2026-04-24
Local: http://localhost:3000
Prod: https://asistente-facu.fly.dev

## Resumen ejecutivo
| Métrica | Local | Prod |
|---|---|---|
| Total pruebas | 50 | 50 |
| PASS | 45 | 45 |
| FAIL | 0 | 0 |
| WARN | 5 | 5 |
| Latencia promedio | 1982ms | 1160ms |
| Latencia máxima | 60604ms | 29700ms |

## Resultados por módulo
### PAGOS CLIENTE

| # | Mensaje | Local | Prod | Notas |
|---|---|---|---|---|
| 1 | `me pagó holster 500k en banco` | ✅ | ✅ |  |
| 2 | `calzon quitao me mandó 400k por mp` | ✅ | ✅ |  |
| 3 | `me entró 200k de diegmarc en efectivo` | ✅ | ✅ |  |
| 4 | `cobré 150k de versao por mercadopago` | ✅ | ✅ |  |
| 5 | `me dio 80k jhonkey en efectivo` | ✅ | ✅ |  |
| 6 | `pago` | ✅ | ✅ |  |
| 7 | `me pagó alguien` | ⚠️ | ⚠️ | no se detectó pregunta por dato faltante / no se detectó pregunta por dato faltante |
| 8 | `cobro de cliente sin nombre` | ✅ | ✅ |  |

### PAGOS PROVEEDOR

| # | Mensaje | Local | Prod | Notas |
|---|---|---|---|---|
| 9 | `le pagué a carvi 200k en efectivo` | ✅ | ✅ |  |
| 10 | `le pague a omar 100k en mp` | ✅ | ✅ |  |
| 11 | `le mandé 300k a arslanian por banco` | ✅ | ✅ |  |
| 12 | `pagué a acuario 50k en efectivo` | ✅ | ✅ |  |
| 13 | `le transferí 180k a carvi por santander` | ✅ | ✅ |  |
| 14 | `le pague a alguien` | ⚠️ | ⚠️ | no se detectó pregunta por dato faltante / no se detectó pregunta por dato faltante |
| 15 | `pague a proveedor sin monto` | ⚠️ | ⚠️ | no se detectó pregunta por dato faltante / no se detectó pregunta por dato faltante |

### RECEPCIONES

| # | Mensaje | Local | Prod | Notas |
|---|---|---|---|---|
| 16 | `carvi entregó de dafne` | ✅ | ✅ |  |
| 17 | `arslanian trajo los hang tag de buenos hijos` | ✅ | ✅ |  |
| 18 | `llegó mercadería de carvi para pierrs` | ✅ | ✅ |  |
| 19 | `recibí de acuario` | ✅ | ✅ |  |
| 20 | `carvi entregó` | ✅ | ✅ |  |
| 21 | `entregó mercadería` | ✅ | ✅ |  |

### VENTAS

| # | Mensaje | Local | Prod | Notas |
|---|---|---|---|---|
| 22 | `armá una cotización para holster` | ✅ | ✅ |  |
| 23 | `nueva OV para diegmarc` | ✅ | ✅ |  |
| 24 | `generá propuesta para pierrs` | ⚠️ | ⚠️ | latencia 60604ms > 5s / latencia 29700ms > 5s |
| 25 | `confirmá la OV de S02275` | ✅ | ✅ |  |
| 26 | `dejá nota en S02275: revisar colores` | ✅ | ✅ |  |
| 27 | `presupuesto para cliente nuevo` | ✅ | ✅ |  |

### COMPRAS

| # | Mensaje | Local | Prod | Notas |
|---|---|---|---|---|
| 28 | `cuándo entrega carvi lo de pierrs` | ✅ | ✅ |  |
| 29 | `pedidos de arslanian` | ✅ | ✅ |  |
| 30 | `qué me debe carvi` | ✅ | ✅ |  |
| 31 | `postergá la entrega de P01234 para el 30/05` | ✅ | ✅ |  |
| 32 | `pedidos en producción de esta semana` | ✅ | ✅ |  |

### REPORTES

| # | Mensaje | Local | Prod | Notas |
|---|---|---|---|---|
| 33 | `pedidos en producción` | ✅ | ✅ |  |
| 34 | `cuentas a cobrar` | ✅ | ✅ |  |
| 35 | `caja de hoy` | ✅ | ✅ |  |
| 36 | `cuánto me debe holster` | ✅ | ✅ |  |
| 37 | `qué facturé este mes` | ✅ | ✅ |  |
| 38 | `resumen de caja de esta semana` | ✅ | ✅ |  |

### PRECIOS

| # | Mensaje | Local | Prod | Notas |
|---|---|---|---|---|
| 39 | `carvi subió un 10%` | ✅ | ✅ |  |
| 40 | `los bordados aumentaron 500 pesos` | ✅ | ✅ |  |
| 41 | `actualizá el costo de arslanian 8%` | ✅ | ✅ |  |
| 42 | `subieron los hang tag 15%` | ✅ | ✅ |  |

### FALLBACK

| # | Mensaje | Local | Prod | Notas |
|---|---|---|---|---|
| 43 | `necesito ver algo de la semana` | ✅ | ✅ |  |
| 44 | `qué hago con esto` | ✅ | ✅ |  |
| 45 | `ayuda` | ✅ | ✅ |  |
| 46 | `hola` | ✅ | ✅ |  |
| 47 | `no sé qué hacer` | ✅ | ✅ |  |

### EDGE

| # | Mensaje | Local | Prod | Notas |
|---|---|---|---|---|
| 48 | `` | ✅ | ✅ |  |
| 49 | `le pague a carvi 200k en efectivo` | ✅ | ✅ |  |
| 50 | `carvi entregó de dafne → sí confirmo (2 pasos)` | ⚠️ | ⚠️ | paso1 200 action=pregunta; paso2 200 action=pregunta; confirmación no ejecutó (pendiente/otra acción) / paso1 200 action |

## FAILs críticos

_Ningún FAIL automático._


## Diferencias LOCAL vs PROD

_Mismo resultado/status en ambas ejecuciones (según heurística)._

## Recomendaciones

1. Muchos WARN: afinar heurísticas de QA o suavizar criterios de negocio documentados.
2. Mantener pruebas #49 (no regresión recepción vs pago) y #50 (confirmación) en CI.
3. Monitorizar latencia >5s (Groq/Odoo) y reintentos/backoff en carga de OCs.
4. Para FALLBACK (#43–47), validar que UNKNOWN siempre devuelve clarification_form sin pasar por consultas genéricas.

---
_Generado por scripts/run-qa-tests.mjs — evaluación heurística; revisar manualmente los casos límite._
