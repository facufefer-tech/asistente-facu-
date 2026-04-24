# Reglas por módulo — 2026-04-24

## Pagos Cliente
### Función principal
Registrar cobros de clientes vía `/api/agent` con `executePayment(..., "customer")`.
### Campos ODOO que usa
`res.partner.name`, `account.journal.name`, `account.payment.amount`, `account.payment.partner_id`, `account.payment.memo`.
### Reglas de negocio implementadas
1. Nombre + monto + medio infiere intención de pago.
2. Journal permitido: Cash/Santander/MercadoPago.
3. Si faltan datos pide solo el campo faltante.
### Variaciones de lenguaje natural reconocidas
me pagó, cobré a, entró plata de, depositó, mandó transferencia, abonó.
### Criterios de éxito
Pago en borrador creado con partner, monto y diario correctos.
### Casos límite conocidos
Ambigüedad sin sujeto explícito cliente/proveedor.

## Pagos Proveedor
### Función principal
Registrar pagos salientes vía `executePayment(..., "supplier")`.
### Campos ODOO que usa
`res.partner`, `account.payment`, `account.journal`.
### Reglas de negocio implementadas
1. Verbos “le pagué / transferí a” se interpretan como proveedor.
2. Valida monto positivo y journal.
### Variaciones de lenguaje natural reconocidas
pagué a, mandé a, transferí a, salió plata para.
### Criterios de éxito
Pago a proveedor en borrador con datos correctos.
### Casos límite conocidos
Nombres ambiguos compartidos por cliente/proveedor.

## Recepciones
### Función principal
Registrar recepción en ODOO desde `executeDelivery`.
### Campos ODOO que usa
`purchase.order`, `purchase.order.line`, `stock.picking`, `stock.move.line`, `account.move`.
### Reglas de negocio implementadas
1. Prioriza OC confirmada.
2. No inventa SKU/precio: toma de OC.
3. Valida picking incoming pendiente.
### Variaciones de lenguaje natural reconocidas
llegó mercadería, entró pedido, recibí OC, recepción proveedor.
### Criterios de éxito
Recepción validada + facturas draft proveedor/cliente creadas.
### Casos límite conocidos
Múltiples OCs candidatas sin desambiguación.

## Ventas Consultas
### Función principal
Responder métricas/estado de ventas por `resolveDirectQueries` y `resolveReportQuery`.
### Campos ODOO que usa
`sale.order`, `sale.order.line`, `account.move`.
### Reglas de negocio implementadas
1. Si hay OV exacta prioriza estado puntual.
2. Si hay cliente, agrega contexto de deuda/ventas.
### Variaciones de lenguaje natural reconocidas
ventas del mes, cuánto vendí, cuánto me debe.
### Criterios de éxito
Respuesta coherente con datos reales.
### Casos límite conocidos
Cliente no encontrado o múltiples coincidencias.

## Compras
### Función principal
Reportar OCs abiertas y pendientes.
### Campos ODOO que usa
`purchase.order`, `purchase.order.line`, `res.partner`.
### Reglas de negocio implementadas
1. Usa cache de OCs pendientes.
2. Permite filtro por proveedor/marca.
### Variaciones de lenguaje natural reconocidas
ocs pendientes, qué debo a proveedor, pedidos abiertos.
### Criterios de éxito
Listado/estado de OCs coherente.
### Casos límite conocidos
Cache desactualizada entre corridas.

## Cuentas a Cobrar/Pagar
### Función principal
Consolidar deuda cliente/proveedor.
### Campos ODOO que usa
`account.move.move_type`, `payment_state`, `amount_residual`, `partner_id`.
### Reglas de negocio implementadas
1. out_invoice = cobrar, in_invoice = pagar.
2. Solo posted + not_paid/partial.
### Variaciones de lenguaje natural reconocidas
cuentas por cobrar, por pagar, saldo neto.
### Criterios de éxito
Totales y ranking consistentes.
### Casos límite conocidos
Montos con notas de crédito no conciliadas.

## Reportes Producción
### Función principal
Informar pendientes y fechas de producción.
### Campos ODOO que usa
`purchase.order.line.date_planned`, `qty_received`, `product_qty`, `x_studio_marca`.
### Reglas de negocio implementadas
1. Clasifica vencidos y próximos.
2. Puede agrupar por proveedor.
### Variaciones de lenguaje natural reconocidas
qué está en producción, próximas entregas, vencidos.
### Criterios de éxito
Detalle de pendientes por línea/OC.
### Casos límite conocidos
Fechas faltantes en líneas.

## WhatsApp Plantillas
### Función principal
Resolver plantilla + destinatarios y ejecutar envío.
### Campos ODOO que usa
`whatsapp.template`, `whatsapp.message`, `res.partner`, `sale.order`.
### Reglas de negocio implementadas
1. Requiere plantilla aprobada.
2. Busca teléfono en contacto empresa/hijos.
### Variaciones de lenguaje natural reconocidas
mandá mensaje, avisar, recordatorio de pago.
### Criterios de éxito
Mensaje creado/enviado o aclaración útil.
### Casos límite conocidos
Sin móvil válido o plantilla no matcheada.

## Consultas de Estado
### Función principal
Responder estado de OV/pedido/entrega.
### Campos ODOO que usa
`sale.order.state`, `invoice_status`, `amount_total`.
### Reglas de negocio implementadas
1. Si hay S0XXXX consulta directa.
2. Sin OV pide desambiguación por cliente.
### Variaciones de lenguaje natural reconocidas
cómo va pedido, estado OV, cuándo llega.
### Criterios de éxito
Estado real, no inventado.
### Casos límite conocidos
Pedidos múltiples para mismo cliente.

## Fallback y Edge Cases
### Función principal
Manejar inputs ambiguos sin crash.
### Campos ODOO que usa
No aplica obligatorio; prioriza clarificación.
### Reglas de negocio implementadas
1. Evita fallback ciego en pagos con nombre+monto.
2. Devuelve clarification_form en UNKNOWN.
### Variaciones de lenguaje natural reconocidas
entradas incompletas, typo, mensajes mínimos.
### Criterios de éxito
Pide aclaración útil y estable.
### Casos límite conocidos
Mensajes de una palabra sin contexto.
