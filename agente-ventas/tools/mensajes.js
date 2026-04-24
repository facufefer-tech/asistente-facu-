/**
 * Plantillas y respuestas (español argentino, voseo)
 * Textos aprobados; data/templates/ para versiones largas.
 */

const TEMPLATES = {
  bienvenida_nuevo_cliente: (params) => {
    void params;
    return "";
  },
  presupuesto_enviado: (params) => {
    void params;
    return "";
  },
  pedido_confirmado: (params) => {
    void params;
    return "";
  },
  pago_recibido: (params) => {
    void params;
    return "";
  },
  entrega_lista: (params) => {
    void params;
    return "";
  },
  solicitar_comprobante: (params) => {
    void params;
    return "";
  },
  escalar_a_axel: (params) => {
    void params;
    return "";
  }
};

/**
 * @param {keyof typeof TEMPLATES} name
 * @param {Record<string, string | number>} [params]
 */
function render(name, params = {}) {
  const fn = TEMPLATES[name];
  if (typeof fn !== "function") throw new Error(`Template desconocido: ${name}`);
  return fn(params);
}

module.exports = {
  TEMPLATES,
  render
};
