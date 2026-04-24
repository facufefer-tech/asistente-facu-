/**
 * PASO 5: Cruza productos-diseno.json con product.template (default_code) en Odoo.
 * Requiere .env con ODOO_*
 * Salida: data/productos-diseno-con-odoo.json
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env") });

const IN_JSON = path.join(ROOT, "data", "productos-diseno.json");
const OUT_JSON = path.join(ROOT, "data", "productos-diseno-con-odoo.json");
const INFORME = path.join(ROOT, "data", "informe-cobertura-diseno.md");

function createOdooClient() {
  const odooUrl = process.env.ODOO_URL.replace(/\/$/, "");
  async function jsonRpc(service, method, args) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response;
    try {
      response = await fetch(`${odooUrl}/jsonrpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "call",
          params: { service, method, args },
          id: Date.now()
        }),
        signal: controller.signal
      });
    } catch (e) {
      if (e && (e.name === "AbortError" || e.code === "ABORT_ERR")) {
        throw new Error("ODOO no respondió a tiempo. Probá de nuevo.");
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ODOO JSON-RPC HTTP error ${response.status}: ${text.slice(0, 400)}`);
    }
    const data = await response.json();
    if (data.error) {
      throw new Error(data.error?.data?.message || data.error?.message || "Error de ODOO");
    }
    return data.result;
  }
  return {
    authenticate() {
      return jsonRpc("common", "authenticate", [
        process.env.ODOO_DB,
        process.env.ODOO_USERNAME,
        process.env.ODOO_API_KEY,
        {}
      ]);
    },
    executeKw(uid, model, method, positionalArgs = [], keywordArgs = {}) {
      return jsonRpc("object", "execute_kw", [
        process.env.ODOO_DB,
        uid,
        process.env.ODOO_API_KEY,
        model,
        method,
        positionalArgs,
        keywordArgs
      ]);
    }
  };
}

function statsFromRecords(records) {
  const tipos = {};
  const cols = {};
  for (const r of records) {
    if (r.tipografia) {
      const k = r.tipografia.split(",")[0].trim();
      tipos[k] = (tipos[k] || 0) + 1;
    }
    for (const c of r.colores || []) {
      cols[c] = (cols[c] || 0) + 1;
    }
  }
  const top = (o, n) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  return { topTipos: top(tipos, 10), topCols: top(cols, 10) };
}

async function main() {
  if (!fs.existsSync(IN_JSON)) {
    console.error("Falta", IN_JSON, "— correr node scripts/ingest-design-pdfs.mjs");
    process.exit(1);
  }
  const records = JSON.parse(fs.readFileSync(IN_JSON, "utf8"));
  const skus = [
    ...new Set(
      records.map((r) => r.sku).filter((s) => s && String(s).trim())
    )
  ];
  if (!skus.length) {
    const out = records.map((r) => ({ ...r, odoo_id: null, match_odoo: "sin_sku" }));
    fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2), "utf8");
    writeInforme({
      totalPdf: records.length,
      unicos: records.length,
      conOdoo: 0,
      sinMatch: records.length,
      bajas: records.filter((r) => r.confianza === "baja")
    });
    return;
  }

  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  const byCode = new Map();
  const chunk = 200;
  for (let i = 0; i < skus.length; i += chunk) {
    const slice = skus.slice(i, i + chunk);
    const found = await odoo.executeKw(
      uid,
      "product.template",
      "search_read",
      [[["default_code", "in", slice]]],
      { fields: ["id", "name", "default_code", "standard_price"], limit: 500 }
    );
    for (const p of found || []) {
      if (p.default_code) byCode.set(String(p.default_code).trim().toUpperCase(), p);
    }
  }

  const enriched = records.map((r) => {
    if (!r.sku) {
      return { ...r, odoo_id: null, match_odoo: "sin_sku" };
    }
    const key = String(r.sku).trim().toUpperCase();
    const p = byCode.get(key);
    if (p) {
      return {
        ...r,
        odoo_id: p.id,
        odoo_name: p.name,
        standard_price: p.standard_price,
        match_odoo: "ok"
      };
    }
    return { ...r, odoo_id: null, match_odoo: "sin_match_odoo" };
  });

  const conMatch = enriched.filter((r) => r.match_odoo === "ok").length;
  const sinMatch = enriched.filter(
    (r) => r.match_odoo === "sin_match_odoo" || r.match_odoo === "sin_sku"
  ).length;

  fs.writeFileSync(OUT_JSON, JSON.stringify(enriched, null, 2), "utf8");
  console.log("Guardado", OUT_JSON, "matches Odoo:", conMatch, "/", enriched.length);
  writeInforme({
    totalPdf: records.length,
    unicos: records.length,
    conOdoo: conMatch,
    sinMatch,
    bajas: enriched.filter((r) => r.confianza === "baja")
  });
}

function writeInforme({ totalPdf, unicos, conOdoo, sinMatch, bajas }) {
  const records = JSON.parse(
    fs.readFileSync(
      fs.existsSync(OUT_JSON) ? OUT_JSON : IN_JSON,
      "utf8"
    )
  );
  const s = statsFromRecords(records);
  const bajaSkus = bajas.map((r) => r.sku || r.fuente_archivo);
  const md = `# Informe de cobertura — base diseño (PDFs + Odoo)

- **Total de PDFs procesados:** ${totalPdf}
- **Productos únicos extraídos (1 por PDF):** ${unicos}
- **Matchearon con Odoo (product.template.default_code):** ${conOdoo}
- **Sin match en Odoo (sin_sku o sin default_code):** ${sinMatch}

## SKUs con confianza baja (revisión manual)
${bajaSkus.length ? bajaSkus.map((x) => `- ${x}`).join("\n") : "_Ninguno_"}

## Top 10 tipografías más usadas
${s.topTipos.length ? s.topTipos.map(([k, v]) => `- ${k}: ${v}`).join("\n") : "_Sin datos_"}

## Top 10 colores más frecuentes
${s.topCols.length ? s.topCols.map(([k, v]) => `- ${k}: ${v}`).join("\n") : "_Sin datos_"}

---
Generado por scripts/enrich-design-odoo.mjs
`;
  fs.writeFileSync(INFORME, md, "utf8");
  console.log("Informe actualizado:", INFORME);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
