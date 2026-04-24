/**
 * PASO 2–4: Extrae metadatos de PDFs de diseño (PP/NP) y genera data/productos-diseno.json
 * Uso: node scripts/ingest-design-pdfs.mjs [--sample]   (5 primeros + JSON muestra a consola)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PDFParse } from "pdf-parse";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const TMP_PDFS = path.join(ROOT, "tmp_pdfs");
const DATA = path.join(ROOT, "data");
const INVENTARIO = path.join(TMP_PDFS, "inventario.txt");
const OUT_JSON = path.join(DATA, "productos-diseno.json");
const SAMPLE = process.argv.includes("--sample");

const TIPO_FUENTE = new Set(
  "arial helvetica times montserrat oswald roboto open lato lora playfair gotham myriad calibri candara century futura garamond bebas pacifico dancing comic georgia tahoma verdana segoe corbel ebrima nirmala leelawadee sitka constantia"
    .split(/\s+/)
);
const MATERIAL_WORDS = [
  "tafeta",
  "algodon",
  "algodón",
  "poliester",
  "poliéster",
  "saten",
  "satin",
  "friselina",
  "plastisol",
  "polipropileno",
  "polietileno",
  "papel",
  "pu ",
  " pu",
  "nylon",
  "hang tag",
  "etiqueta"
];

const TERM_WORDS = [
  "rollo",
  "cortada y soldada",
  "cortada y doblada",
  "cortada doblada",
  "cortada soldada",
  "cortada",
  "soldada",
  "doblada",
  "troquelado",
  "troquelada",
  "laminado",
  "termosellado"
];

const COLOR_WORDS = new Set(
  "negro blanco rojo azul amarillo verde gris marrón marron natural naranja violeta fucsia celeste rosa oro plata bordo beige nude lila ocre tiza".split(
    /\s+/
  )
);

function listPdfFiles() {
  if (fs.existsSync(INVENTARIO)) {
    return fs
      .readFileSync(INVENTARIO, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.toLowerCase().endsWith(".pdf") && fs.existsSync(l));
  }
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (n.name.toLowerCase().endsWith(".pdf")) out.push(p);
    }
  };
  walk(TMP_PDFS);
  return out.sort();
}

async function extractTextPdf(filePath) {
  const buf = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buf });
  try {
    const r = await parser.getText();
    return r.text || "";
  } finally {
    await parser.destroy();
  }
}

function parseFilename(basename) {
  const n = path.basename(basename, ".pdf");
  const tipo = /\b(NP|PP)\b/i.exec(n);
  const sinNum = n.replace(/^\d+\s*[-–]?\s*/i, "").trim();
  const cliente = sinNum
    .replace(new RegExp(`\\s*${tipo ? tipo[1] : ""}\\s*$`, "i"), "")
    .replace(/\s+\(\d+\)\s*$/g, "")
    .trim();
  return {
    fuente_archivo: path.basename(basename),
    _doc_tipo: tipo ? tipo[1].toUpperCase() : null,
    cliente_desde_nombre: cliente || null
  };
}

function extractSku(text) {
  const br = text.match(/\[([^\]]+)\]/);
  if (br) return br[1].trim();
  const lines = text.split(/\r?\n/);
  const patterns = [
    /\b(EBAD[A-Z0-9]+)\b/i,
    /\b(EBAT[A-Z0-9]+)\b/i,
    /\b(BoPo[A-Z0-9]+|BOPO[A-Z0-9]+)\b/i,
    /\b(EP\d+x\d+[A-Z0-9]*)\b/i,
    /\b(EESN\d+|EEAL\d+|EE[A-Z]{2,4}\d+)\b/i,
    /\b(HTZ|CART[0-9A-Z]+)\b/i,
    /\b(BaPUFr[0-9A-Z]+)\b/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

function extractOv(text) {
  const m = text.match(/\b(S0\d{4,5})\b/);
  return m ? m[1] : null;
}

function extractPantone(text) {
  const s = new Set();
  const re = /Pantone\s*[#]?\s*([0-9A-Za-z]+(?:\s*C|U|TPX)?)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    s.add(`Pantone ${m[1].replace(/\s+/g, " ")}`.trim());
  }
  return [...s];
}

function extractHex(text) {
  const s = new Set();
  const re = /#([0-9A-Fa-f]{3,6})\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    s.add(`#${m[1]}`);
  }
  return [...s];
}

function extractColorNames(text) {
  const t = ` ${text.toLowerCase().replace(/á/g, "a").replace(/é/g, "e")} `;
  const out = new Set();
  for (const w of COLOR_WORDS) {
    if (t.includes(` ${w} `) || t.includes(` ${w},`) || t.includes(` ${w}.`)) out.add(w);
  }
  return [...out];
}

function extractTypo(text) {
  const out = new Set();
  for (const line of text.split("\n").slice(0, 30)) {
    for (const f of TIPO_FUENTE) {
      const re = new RegExp(`\\b${f}\\b`, "i");
      if (re.test(line)) {
        const m = line.match(
          new RegExp(`\\b${f}[^\\n]*(?:Bold|Regular|Light|Medium|Italic)?`, "i")
        );
        if (m) out.add(m[0].trim().slice(0, 60));
        else out.add(f.charAt(0).toUpperCase() + f.slice(1));
      }
    }
  }
  const m2 = text.match(
    /(?:fuente|tipografia|font|tipografía)\s*[:#]?\s*([A-Za-z\s\-]+)(?:\n|$)/i
  );
  if (m2) out.add(m2[1].trim().slice(0, 60));
  return [...out].slice(0, 5);
}

function extractSizeMm(text) {
  const t = text.replace(/\s+/g, " ");
  let w = null;
  let h = null;
  const mmPair = t.match(
    /(\d+(?:[.,]\d+)?)\s*mm?\s*x\s*(\d+(?:[.,]\d+)?)\s*mm?/i
  );
  if (mmPair) {
    w = parseFloat(mmPair[1].replace(",", "."));
    h = parseFloat(mmPair[2].replace(",", "."));
  } else {
    const one = t.match(/(\d+(?:[.,]\d+)?)\s*mm(?:\b)/i);
    if (one) w = parseFloat(one[1].replace(",", "."));
  }
  const cm = t.match(/(\d+(?:[.,]\d+)?)\s*cm?\s*x\s*(\d+(?:[.,]\d+)?)\s*cm?/i);
  if (cm && (w == null || h == null)) {
    w = w ?? parseFloat(cm[1].replace(",", ".")) * 10;
    h = h ?? parseFloat(cm[2].replace(",", ".")) * 10;
  }
  if (w == null && h == null) return { ancho: null, alto: null };
  return { ancho: w, alto: h };
}

function extractMaterial(text) {
  const low = text.toLowerCase();
  for (const m of MATERIAL_WORDS) {
    if (low.includes(m)) return m.replace(/^\s+|\s+$/g, "") || m;
  }
  return null;
}

function extractTerminacion(text) {
  const low = text.toLowerCase();
  for (const term of TERM_WORDS) {
    if (low.includes(term)) return term;
  }
  return null;
}

function extractColorCount(text) {
  const m = text.match(/(\d+)\s*color(?:es)?\b/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

function extractCopyLine(text) {
  const lines = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 1 && l.length < 80);
  const caps = lines.find(
    (l) => l === l.toUpperCase() && /[A-Z]{3,}/.test(l) && l.length < 50
  );
  if (caps) return caps;
  return lines[0] || null;
}

function notasResiduos(sku, text, usedBits) {
  if (!text) return null;
  let rest = text.slice(0, 2000);
  for (const u of usedBits) {
    if (u) rest = rest.replaceAll(u, " ");
  }
  rest = rest.replace(/\s+/g, " ").trim();
  return rest.length > 30 ? rest.slice(0, 500) : null;
}

function confianza({ sku, colores, pantone, hex, tamano_mm, material, texto_escrito }) {
  const hasCol = (colores && colores.length) || (pantone && pantone.length) || (hex && hex.length);
  const hasTam = (tamano_mm && (tamano_mm.ancho != null || tamano_mm.alto != null)) || false;
  if (sku && hasCol && hasTam) return "alta";
  if (sku && (hasCol || hasTam)) return "media";
  return "baja";
}

function buildRecord(filePath, text) {
  const fn = parseFilename(filePath);
  const sku = extractSku(text);
  const ov = extractOv(text);
  const colores = extractColorNames(text);
  const pantone = extractPantone(text);
  const hex = extractHex(text);
  const tipos = extractTypo(text);
  const tipografia = tipos[0] || null;
  const tamano_mm = extractSizeMm(text);
  const material = extractMaterial(text);
  const terminacion = extractTerminacion(text);
  const cantidad_colores = extractColorCount(text);
  const texto_escrito = extractCopyLine(text);
  const allUsed = [sku, ov, text.slice(0, 400)].filter(Boolean);
  const notas = notasResiduos(sku, text, allUsed);
  return {
    sku: sku || null,
    fuente_archivo: fn.fuente_archivo,
    cliente: fn.cliente_desde_nombre || null,
    ov: ov || null,
    tipografia: tipografia || (tipos.length ? tipos.join(", ") : null),
    colores: colores.length ? colores : null,
    pantone: pantone.length ? pantone : null,
    texto_escrito: texto_escrito || null,
    tamano_mm,
    material: material || null,
    terminacion: terminacion || null,
    cantidad_colores: cantidad_colores != null ? cantidad_colores : null,
    notas: [notas, fn._doc_tipo ? `PP/NP: ${fn._doc_tipo}` : null, hex.length ? `hex: ${hex.join(", ")}` : null]
      .filter(Boolean)
      .join(" | ") || null,
    confianza: confianza({
      sku,
      colores,
      pantone,
      hex,
      tamano_mm,
      material,
      texto_escrito
    })
  };
}

function statsForReport(records) {
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
  fs.mkdirSync(DATA, { recursive: true });
  const allFiles = listPdfFiles();
  if (!allFiles.length) {
    console.error("No hay PDFs en", TMP_PDFS, "— descomprimir el ZIP primero.");
    process.exit(1);
  }
  const files = SAMPLE ? allFiles.slice(0, 5) : allFiles;
  const sampleOut = [];
  const records = [];

  for (const fp of files) {
    let text = "";
    try {
      text = await extractTextPdf(fp);
    } catch (e) {
      console.error("Error PDF", fp, e.message);
      continue;
    }
    const rec = buildRecord(fp, text);
    records.push(rec);
    if (SAMPLE) {
      sampleOut.push({
        file: path.basename(fp),
        text: text.slice(0, 3000)
      });
    }
  }

  if (SAMPLE) {
    console.log(JSON.stringify(sampleOut, null, 2));
  }
  fs.writeFileSync(OUT_JSON, JSON.stringify(records, null, 2), "utf8");
  console.log("Guardado", OUT_JSON, "registros:", records.length, "/", allFiles.length, "total PDFs");

  const s = statsForReport(records);
  const bajas = records.filter((r) => r.confianza === "baja").map((r) => r.sku || r.fuente_archivo);
  const infoMd = path.join(DATA, "informe-cobertura-diseno.md");
  const md = `# Informe de cobertura — base diseño (PDFs)

- **Total de PDFs en inventario:** ${allFiles.length}
- **Procesados en este run:** ${records.length}
- **Productos extraídos (1 por PDF):** ${records.length}
- **Pendiente:** con Odoo, ejecutar \`node scripts/enrich-design-odoo.mjs\`

## SKUs con confianza baja (revisión manual)
${bajas.length ? bajas.map((x) => `- ${x}`).join("\n") : "_Ninguno_"}

## Top 10 tipografías (si hay)
${s.topTipos.length ? s.topTipos.map(([k, v]) => `- ${k}: ${v}`).join("\n") : "_Sin datos_"}

## Top 10 colores (por nombre, si hay)
${s.topCols.length ? s.topCols.map(([k, v]) => `- ${k}: ${v}`).join("\n") : "_Sin datos_"}

---
Generado por scripts/ingest-design-pdfs.mjs
`;
  fs.writeFileSync(infoMd, md, "utf8");
  console.log("Informe preliminar:", infoMd);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
