/**
 * Órdenes de venta (sale.order) en Odoo
 */

/**
 * @param {number} clienteId
 * @param {Array<{ productId: number, productUomQty: number, [k: string]: unknown }>} items
 * @returns {Promise<number>} sale.order id
 */
async function crearOV(clienteId, items) {
  void clienteId;
  void items;
  throw new Error("Pendiente: implementar");
}

/**
 * @param {number|undefined} ovId
 * @param {number|undefined} clienteId
 */
async function consultarEstado(ovId, clienteId) {
  void ovId;
  void clienteId;
  throw new Error("Pendiente: implementar");
}

/**
 * @param {number} ovId
 */
async function confirmarPedido(ovId) {
  void ovId;
  throw new Error("Pendiente: implementar (action_confirm o flujo de negocio)");
}

/**
 * @param {number} clienteId
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function listarPedidosCliente(clienteId) {
  void clienteId;
  throw new Error("Pendiente: implementar");
}

module.exports = {
  crearOV,
  consultarEstado,
  confirmarPedido,
  listarPedidosCliente
};
