const fs = require("fs");
const path = require("path");
const { buildBordadaSVG } = require("./svg-builder");
const { exportSVGtoPDF } = require("./inkscape-exporter");

function normalizeSku(v) {
  return String(v || "")
    .trim()
    .toUpperCase();
}

function coercePosNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseSKUFallback(raw) {
  const s = String(raw || "").toUpperCase();
  const m = s.match(/(\d{2,3})/);
  return { raw: s, ancho: m ? Number(m[1]) : null, alto: null };
}

async function jsonRpc(env, service, method, args) {
  const url = String(env.ODOO_URL || "").replace(/\/$/, "");
  const res = await fetch(`${url}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() })
  });
  if (!res.ok) throw new Error(`ODOO JSON-RPC HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error?.data?.message || data.error?.message || "Error ODOO");
  return data.result;
}

async function createOdooSession(env) {
  const uid = await jsonRpc(env, "common", "authenticate", [env.ODOO_DB, env.ODOO_USERNAME, env.ODOO_API_KEY, {}]);
  return {
    uid,
    executeKw(model, method, positionalArgs = [], keywordArgs = {}) {
      return jsonRpc(env, "object", "execute_kw", [
        env.ODOO_DB,
        uid,
        env.ODOO_API_KEY,
        model,
        method,
        positionalArgs,
        keywordArgs
      ]);
    }
  };
}

function loadProductDesignDB(dbPath) {
  try {
    const raw = fs.readFileSync(dbPath, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function colorNameToHex(name) {
  const n = String(name || "")
    .trim()
    .toLowerCase();
  const map = {
    negro: "#000000",
    blanco: "#ffffff",
    beige: "#c8b89a",
    arena: "#c8b89a",
    rojo: "#cc0000",
    azul: "#003399",
    gris: "#888888",
    marron: "#5c3317",
    "marrón": "#5c3317",
    amarillo: "#f0c020",
    dorado: "#c8a400",
    plateado: "#aaaaaa",
    fucsia: "#cc007a",
    rosa: "#e87da8",
    verde: "#2d7a2d"
  };
  return map[n] || "#1a1a1a";
}

async function generarPropuestaBordada(ovId, deps = {}) {
  const warnings = [];
  const env = deps.env || process.env;
  const parseSKU = deps.parseSKU || parseSKUFallback;
  const analyzeImageWithVision =
    deps.analyzeImageWithVision ||
    (async () => ({
      colors: []
    }));
  const baseDir = deps.baseDir || path.resolve(__dirname, "..");
  const deskDir = path.join(env.USERPROFILE || env.HOME || baseDir, "Desktop", "aprobar");
  fs.mkdirSync(deskDir, { recursive: true });

  const odoo = deps.odooSession || (await createOdooSession(env));
  const orders = await odoo.executeKw("sale.order", "read", [[ovId]], {
    fields: ["id", "name", "partner_id", "order_line"]
  });
  const order = Array.isArray(orders) ? orders[0] : null;
  if (!order) throw new Error(`OV ${ovId} no encontrada`);

  const lineIds = Array.isArray(order.order_line) ? order.order_line : [];
  const lines = lineIds.length
    ? await odoo.executeKw("sale.order.line", "read", [lineIds], {
        fields: ["id", "product_id", "name", "product_uom_qty"]
      })
    : [];
  if (!lines.length) warnings.push("OV sin líneas");

  const productIds = Array.from(
    new Set(
      lines
        .map((ln) => (Array.isArray(ln.product_id) ? ln.product_id[0] : null))
        .filter((x) => Number.isFinite(x) && x > 0)
    )
  );
  const products = productIds.length
    ? await odoo.executeKw("product.product", "read", [productIds], { fields: ["id", "default_code", "name"] })
    : [];
  const productById = new Map(products.map((p) => [p.id, p]));

  const dbPath = deps.productDesignPath || path.join(baseDir, "data", "productos-diseno-con-odoo.json");
  const productDesignDB = deps.productDesignDB || loadProductDesignDB(dbPath);

  let chosenLine = null;
  let skuParsed = null;
  let skuNorm = "";
  for (const ln of lines) {
    const pid = Array.isArray(ln.product_id) ? ln.product_id[0] : null;
    const prod = pid ? productById.get(pid) : null;
    const sku = normalizeSku(prod?.default_code || ln.name || "");
    const parsed = parseSKU(sku);
    const key = String(parsed?.layoutFamily || parsed?.familia || parsed?.raw || sku || "").toLowerCase();
    if (/\bbordad|\bebad|\bebat|^e[a-z]/i.test(key) || /\bbordad/i.test(String(ln.name || ""))) {
      chosenLine = ln;
      skuParsed = parsed;
      skuNorm = sku;
      break;
    }
  }
  if (!chosenLine && lines[0]) {
    const ln = lines[0];
    const pid = Array.isArray(ln.product_id) ? ln.product_id[0] : null;
    const prod = pid ? productById.get(pid) : null;
    skuNorm = normalizeSku(prod?.default_code || ln.name || "");
    skuParsed = parseSKU(skuNorm);
    chosenLine = ln;
    warnings.push("No se detectó línea bordada clara; usando primera línea");
  }

  const designExact = productDesignDB.find((r) => normalizeSku(r?.sku) === skuNorm) || null;
  let designRecord = designExact;
  if (!designRecord) {
    const fam = String(skuNorm || "").replace(/[^A-Z]/g, "").slice(0, 4);
    designRecord = productDesignDB.find((r) => normalizeSku(r?.sku).startsWith(fam)) || null;
    if (designRecord) warnings.push("match parcial por familia SKU");
  }
  if (!designRecord) warnings.push("sin match en productDesignDB");

  const adjuntos = await odoo.executeKw(
    "ir.attachment",
    "search_read",
    [[["res_model", "=", "sale.order"], ["res_id", "=", ovId], ["mimetype", "ilike", "image/"]]],
    { fields: ["datas", "mimetype"], limit: 1 }
  );
  const adj = Array.isArray(adjuntos) && adjuntos.length ? adjuntos[0] : null;
  let logoDataUri = "";
  if (adj?.datas) {
    const mime = String(adj.mimetype || "image/png");
    logoDataUri = `data:${mime};base64,${String(adj.datas).replace(/\s/g, "")}`;
  } else {
    warnings.push("sin logo_base64 en ir.attachment");
  }

  let colores = Array.isArray(designRecord?.colores)
    ? designRecord.colores.map((n) => ({ nombre: String(n || "COMPLETAR"), hex: colorNameToHex(n) }))
    : [];
  if (!colores.length && logoDataUri) {
    const rawB64 = logoDataUri.split("base64,")[1] || "";
    const mime = logoDataUri.slice(5, logoDataUri.indexOf(";")) || "image/png";
    const vision = await analyzeImageWithVision(rawB64, mime);
    const fromVision = Array.isArray(vision?.colors) ? vision.colors : [];
    colores = fromVision
      .filter((c) => /^#[0-9a-f]{6}$/i.test(String(c?.hex || "")))
      .slice(0, 4)
      .map((c, i) => ({ nombre: `Vision-${i + 1}`, hex: c.hex }));
    if (colores.length) warnings.push("colores por fallback Vision");
  }
  if (!colores.length) {
    colores = [{ nombre: "COMPLETAR", hex: "#1a1a1a" }];
    warnings.push("colores faltantes -> COMPLETAR");
  }

  const notasTalles = deps.notasTallesByOvId ? deps.notasTallesByOvId[ovId] : null;
  const talles = Array.isArray(notasTalles)
    ? notasTalles
    : [{ talle: "COMPLETAR", metros: "COMPLETAR" }];
  if (!Array.isArray(notasTalles)) warnings.push("talles faltantes en notas OV");

  const datos = {
    ov_name: String(order.name || "COMPLETAR"),
    partner_name: Array.isArray(order.partner_id) ? String(order.partner_id[1] || "COMPLETAR") : "COMPLETAR",
    texto_escrito: String(designRecord?.texto_escrito || "COMPLETAR"),
    ancho_mm: coercePosNum(designRecord?.tamano_mm?.ancho) || coercePosNum(skuParsed?.ancho) || null,
    alto_mm: coercePosNum(designRecord?.tamano_mm?.alto) || coercePosNum(skuParsed?.alto) || null,
    colores,
    talles,
    logo_base64: logoDataUri,
    tipografia: String(designRecord?.tipografia || "Arial")
  };
  if (!datos.ancho_mm) warnings.push("ancho_mm faltante");
  if (!datos.alto_mm) warnings.push("alto_mm faltante");

  const { svg, warnings: svgWarnings } = buildBordadaSVG(datos);
  warnings.push(...svgWarnings);

  const safeOvName = String(datos.ov_name || "OV")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .trim();
  const outputPath = path.join(deskDir, `${safeOvName}-propuesta.pdf`);
  await exportSVGtoPDF(svg, outputPath);
  return { pdfPath: outputPath, warnings };
}

module.exports = { generarPropuestaBordada };
