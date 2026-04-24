/**
 * Contactos (res.partner) en Odoo
 */

/**
 * @param {string} telefono
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function buscarContacto(telefono) {
  void telefono;
  throw new Error("Pendiente: implementar (search por teléfono normalizado)");
}

/**
 * @param {string} nombre
 * @param {string} telefono
 * @param {string} [email]
 * @returns {Promise<number>} partner id
 */
async function crearContacto(nombre, telefono, email) {
  void nombre;
  void telefono;
  void email;
  throw new Error("Pendiente: implementar");
}

/**
 * @param {number} id
 * @param {Record<string, unknown>} datos
 */
async function actualizarContacto(id, datos) {
  void id;
  void datos;
  throw new Error("Pendiente: implementar");
}

module.exports = {
  buscarContacto,
  crearContacto,
  actualizarContacto
};
