## El sistema está listo para producción: CONDICIONAL

## Módulos en verde (listos)
- FALLBACK_EDGE

## Módulos en amarillo (usar con cuidado)
- Ninguno

## Módulos en rojo (NO usar aún)
- PAGOS_CLIENTE
- PAGOS_PROVEEDOR
- RECEPCIONES
- VENTAS_CONSULTAS
- COMPRAS
- CUENTAS_COBRAR_PAGAR
- REPORTES_PRODUCCION
- WHATSAPP
- CONSULTAS_ESTADO

## Las 5 acciones prioritarias antes de lanzar
1. Subir precisión de pagos ambiguos con ejemplos adicionales y validación de sujeto.
2. Endurecer fallback de recepciones cuando hay múltiples OCs candidatas.
3. Mejorar matcheo de plantillas WhatsApp y teléfonos inválidos.
4. Reducir latencia >10s en consultas masivas de reportes.
5. Agregar test de regresión dedicado por módulo crítico en CI.

## Estimación de confianza por módulo
| Módulo | Confianza | Justificación |
|---|---:|---|
| PAGOS_CLIENTE | 0% | PASS 0/300, FAIL 300, WARN 0 |
| PAGOS_PROVEEDOR | 0% | PASS 0/250, FAIL 250, WARN 0 |
| RECEPCIONES | 7% | PASS 0/200, FAIL 171, WARN 29 |
| VENTAS_CONSULTAS | 53% | PASS 9/150, FAIL 0, WARN 141 |
| COMPRAS | 55% | PASS 15/150, FAIL 0, WARN 135 |
| CUENTAS_COBRAR_PAGAR | 59% | PASS 27/150, FAIL 0, WARN 123 |
| REPORTES_PRODUCCION | 58% | PASS 24/150, FAIL 0, WARN 126 |
| WHATSAPP | 51% | PASS 2/150, FAIL 0, WARN 148 |
| CONSULTAS_ESTADO | 58% | PASS 25/150, FAIL 0, WARN 125 |
| FALLBACK_EDGE | 93% | PASS 129/150, FAIL 0, WARN 21 |

## Las 20 propuestas visuales
| OV | cliente | layout usado | archivo generado | warnings de datos |
|---|---|---|---|---|
| S02301 | Gary | B | C:\Users\COMPU\Desktop\aprobar\S02301-Gary-B.pdf | - |
| S02300 | Kusaw | B | C:\Users\COMPU\Desktop\aprobar\S02300-Kusaw-B.pdf | - |
| S02284 | G-LAB-STUDIOS | H | C:\Users\COMPU\Desktop\aprobar\S02284-G-LAB-STUDIOS-H.pdf | sin talles claros: usar COMPLETAR; sin colores de designDB/vision: usando placeholder |
| S02280 | Galería-Punta-Mogote---Joda-Black | B | C:\Users\COMPU\Desktop\aprobar\S02280-Galería-Punta-Mogote---Joda-Black-B.pdf | - |
| S02278 | Axel-Praigrot | B | C:\Users\COMPU\Desktop\aprobar\S02278-Axel-Praigrot-B.pdf | sin colores de designDB/vision: usando placeholder |
| S02299 | MOJHADO-(ROMER-CATARI) | B | C:\Users\COMPU\Desktop\aprobar\S02299-MOJHADO-(ROMER-CATARI)-B.pdf | - |
| S02298 | Dalerey-Premium | A | C:\Users\COMPU\Desktop\aprobar\S02298-Dalerey-Premium-A.pdf | sin colores de designDB/vision: usando placeholder |
| S02291 | Galería-Urkupiña---Laura | B | C:\Users\COMPU\Desktop\aprobar\S02291-Galería-Urkupiña---Laura-B.pdf | - |
| S02289 | Galería-Punta-Mogote---Rodas | C | C:\Users\COMPU\Desktop\aprobar\S02289-Galería-Punta-Mogote---Rodas-C.pdf | sin talles claros: usar COMPLETAR; sin colores de designDB/vision: usando placeholder |
| S02276 | Axel-Praigrot | A | C:\Users\COMPU\Desktop\aprobar\S02276-Axel-Praigrot-A.pdf | sin colores de designDB/vision: usando placeholder |
| S02281 | Galería-Urkupiña---DCA | B | C:\Users\COMPU\Desktop\aprobar\S02281-Galería-Urkupiña---DCA-B.pdf | - |
| S02297 | Jos | D | C:\Users\COMPU\Desktop\aprobar\S02297-Jos-D.pdf | sin colores de designDB/vision: usando placeholder |
| S02293 | Public-user | D | C:\Users\COMPU\Desktop\aprobar\S02293-Public-user-D.pdf | sin talles claros: usar COMPLETAR; sin colores de designDB/vision: usando placeholder |
| S02295 | Galeria-Ocean---Michee | F | C:\Users\COMPU\Desktop\aprobar\S02295-Galeria-Ocean---Michee-F.pdf | sin talles claros: usar COMPLETAR; sin colores de designDB/vision: usando placeholder |
| S02292 | TEAM-PRO-S.A. | B | C:\Users\COMPU\Desktop\aprobar\S02292-TEAM-PRO-S.A.-B.pdf | sin colores de designDB/vision: usando placeholder |
| S02296 | josefina-✨ | E | C:\Users\COMPU\Desktop\aprobar\S02296-josefina-✨-E.pdf | sin talles claros: usar COMPLETAR; sin colores de designDB/vision: usando placeholder |
| S02294 | Agustin-Ruiz | F | C:\Users\COMPU\Desktop\aprobar\S02294-Agustin-Ruiz-F.pdf | sin talles claros: usar COMPLETAR; sin colores de designDB/vision: usando placeholder |
| S02290 | Avios-Textiles,-facu-fefer | B | C:\Users\COMPU\Desktop\aprobar\S02290-Avios-Textiles,-facu-fefer-B.pdf | - |
| S02288 | Galería-Punta-Mogote---Bellakeo | B | C:\Users\COMPU\Desktop\aprobar\S02288-Galería-Punta-Mogote---Bellakeo-B.pdf | sin colores de designDB/vision: usando placeholder |
| S02287 | Public-user | D | C:\Users\COMPU\Desktop\aprobar\S02287-Public-user-D.pdf | sin colores de designDB/vision: usando placeholder |

## Resumen QA global
Total: 1800 | PASS: 231 | FAIL: 721 | WARN: 848 | Confianza: 36%
