/**
 * Conexión Odoo JSON-RPC (misma lógica que el agente admin).
 * Implementación: copiar/adaptar createOdooClient y helpers desde server.js del admin.
 */
function createOdooClient() {
  void process.env.ODOO_URL;
  throw new Error("Pendiente: implementar (reutilizar lógica del admin)");
}

/**
 * @param {ReturnType<createOdooClient>} odoo
 * @param {number} uid
 * @param {string} model
 * @param {string} method
 * @param {unknown[]} [positionalArgs]
 * @param {Record<string, unknown>} [keywordArgs]
 */
async function executeKw(odoo, uid, model, method, positionalArgs = [], keywordArgs = {}) {
  void odoo;
  void uid;
  void model;
  void method;
  void positionalArgs;
  void keywordArgs;
  throw new Error("Pendiente: implementar (execute_kw vía createOdooClient().executeKw o wrapper)");
}

/**
 * Atajo para search_read
 * @param {ReturnType<createOdooClient>} odoo
 * @param {number} uid
 * @param {string} model
 * @param {unknown[]} domain
 * @param {Record<string, unknown>} [options]
 */
async function searchRead(odoo, uid, model, domain, options = {}) {
  return executeKw(odoo, uid, model, "search_read", [domain], options);
}

module.exports = {
  createOdooClient,
  executeKw,
  searchRead
};
