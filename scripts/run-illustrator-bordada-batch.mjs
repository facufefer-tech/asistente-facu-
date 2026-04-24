import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const LIMIT = Number(process.env.BATCH_LIMIT || 20);
const APROBAR_DIR = path.join(process.env.USERPROFILE || process.env.HOME || ROOT, "Desktop", "aprobar");
const LOGS_DIR = path.join(APROBAR_DIR, "logs");

function cleanFilePart(v) {
  return String(v || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "-")
    .slice(0, 70) || "cliente";
}

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let data = {};
  try {
    data = JSON.parse(t);
  } catch {
    data = { raw: t };
  }
  return { ok: r.ok, status: r.status, data };
}

async function main() {
  fs.mkdirSync(APROBAR_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  const cand = await fetchJson(`${BASE_URL}/api/propuestas-bordadas/candidatas?limit=${LIMIT}`);
  if (!cand.ok || !Array.isArray(cand.data?.items)) {
    throw new Error(`No se pudieron obtener candidatas: HTTP ${cand.status} ${cand.data?.error || ""}`);
  }
  const items = cand.data.items.slice(0, LIMIT);
  const rows = [];
  for (const it of items) {
    const ov = String(it.ov || "").trim().toUpperCase();
    const cliente = String(it.cliente || "").trim() || "cliente";
    const safeCliente = cleanFilePart(cliente);
    try {
      const res = await fetchJson(`${BASE_URL}/api/generar-propuesta`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orden_id: ov })
      });
      if (!res.ok || !res.data?.success) {
        const err = res.data?.error || `HTTP ${res.status}`;
        rows.push({ ov, cliente, sku: it.sku || "", status: "FALLO", motivo: err });
        continue;
      }
      const illustrator = res.data?.illustrator || {};
      const pdfPath = illustrator.pdfPath || path.join(APROBAR_DIR, `${ov}-${safeCliente}-propuesta.pdf`);
      if (!fs.existsSync(pdfPath)) {
        rows.push({
          ov,
          cliente,
          sku: it.sku || "",
          status: "FALLO",
          motivo: `No existe PDF esperado: ${pdfPath}`
        });
        continue;
      }
      rows.push({ ov, cliente, sku: it.sku || "", status: "OK", motivo: "" });
    } catch (e) {
      rows.push({ ov, cliente, sku: it.sku || "", status: "FALLO", motivo: String(e.message || e) });
    }
  }

  const outJson = path.join(ROOT, "informes", "illustrator-batch-2026-04-24.json");
  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(
    outJson,
    JSON.stringify(
      {
        baseUrl: BASE_URL,
        limit: LIMIT,
        processed: rows.length,
        ok: rows.filter((r) => r.status === "OK").length,
        fail: rows.filter((r) => r.status !== "OK").length,
        rows
      },
      null,
      2
    ),
    "utf8"
  );
  console.log("Procesadas:", rows.length);
  console.log("OK:", rows.filter((r) => r.status === "OK").length);
  console.log("FALLO:", rows.filter((r) => r.status !== "OK").length);
  console.log("Reporte:", outJson);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

