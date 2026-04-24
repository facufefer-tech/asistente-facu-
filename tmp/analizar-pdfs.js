const fs = require("fs");
const path = require("path");
const { PDFParse } = require("pdf-parse");

const baseDir = "c:/Users/COMPU/Documents/Cursor/Protectos/Asistente Facu/tmp/analisis-pdfs";
const reportPath = "c:/Users/COMPU/Documents/Cursor/Protectos/Asistente Facu/informes/analisis-patrones-pdfs-2026-04-24.md";

function walk(dir, out=[]) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.pdf$/i.test(e.name)) out.push(p);
  }
  return out;
}

function norm(s){return String(s||"").toLowerCase();}

function detectType(filename, text){
  const s = norm(filename+" "+text);
  if (/\bbordad/.test(s) || /\bebad\b|\bebat\b|\bebt\b/.test(s)) return "bordada";
  if (/\bbadana\b|\bbad\b/.test(s)) return "badana";
  if (/\bestampad|\bsaten\b|\bes\b/.test(s)) return "estampada";
  if (/\bbolsa\b|ecommerce|camiseta/.test(s)) return "bolsa";
  if (/\bplastisol\b|\bpl\b/.test(s)) return "plastisol";
  return "otro";
}

function detectTerminacion(filename, text){
  const s = norm(filename+" "+text);
  if (/\bcdm\b|doblad[oa]\s+al\s+medio/.test(s)) return "CDM";
  if (/\bcde\b|doblad[oa]\s+a\s+los\s+extremos/.test(s)) return "CDE";
  if (/\bcs\b|soldad/.test(s)) return "CS";
  if (/\brollo\b|\br\d?\b/.test(s)) return "Rollo";
  return "otro";
}

function extractMeasures(text, filename){
  const combined = `${text} ${filename}`;
  const re = /(\d{1,3}(?:[.,]\d+)?)\s*(mm|cm)\s*[xX]\s*(\d{1,3}(?:[.,]\d+)?)\s*(mm|cm)?/g;
  let m; let best = null;
  while((m = re.exec(combined))!==null){
    let a = parseFloat(String(m[1]).replace(',', '.'));
    let b = parseFloat(String(m[3]).replace(',', '.'));
    const u1 = (m[2]||'').toLowerCase();
    const u2 = (m[4]||m[2]||'').toLowerCase();
    if(u1==='cm') a*=10;
    if(u2==='cm') b*=10;
    if(!best || (a*b) > (best.ancho*best.alto)) best = {ancho: Math.round(a*10)/10, alto: Math.round(b*10)/10};
  }
  return best || {ancho:null, alto:null};
}

const colorWords = ["negro","blanco","beige","arena","rojo","azul","gris","marron","marrón","amarillo","dorado","plateado","fucsia","rosa","verde","naranja","violeta","bordo","camel","natural"];
function extractColors(text){
  const s = norm(text);
  const found = [];
  for(const c of colorWords){
    const r = new RegExp(`\\b${c}\\b`, 'g');
    const count = (s.match(r)||[]).length;
    if(count) found.push({c, count});
  }
  found.sort((a,b)=>b.count-a.count);
  return found.map(x=>x.c);
}

function colorCount(text){
  const s = norm(text);
  const m = s.match(/(\d{1,2})\s*colores?/);
  if(m) return parseInt(m[1],10);
  const u = extractColors(text);
  return u.length || null;
}

function hasSizes(text){
  const s = norm(text);
  return /\btalle\b|\btalles\b|\bxs\b|\bs\b|\bm\b|\bl\b|\bxl\b|\bxxl\b|\b3xl\b/.test(s);
}

function hasLogoImage(text){
  const s = norm(text);
  return /logo|isologo|logotipo|imagen/.test(s);
}

function orientation(tipo, term, ancho, alto){
  if(term === 'Rollo' || term === 'CDM') return 'vertical';
  if(term === 'CDE') return 'horizontal';
  if(tipo === 'badana') return 'horizontal';
  if(tipo === 'bolsa') return 'vertical';
  if(ancho && alto) return alto > ancho ? 'vertical' : 'horizontal';
  return 'otro';
}

function layoutLine(tipo, term, orient, colors, talles, logo){
  const vars = (colors && colors > 1) ? 'multi-variante' : '1 variante';
  return `${tipo} ${orient}, ${term}, ${vars}, ${talles?'con talles':'sin talles'}, ${logo?'con logo':'sin logo'}`;
}

(async()=>{
  const files = walk(baseDir);
  const results = [];
  let processed = 0;
  let failed = 0;
  for(const fp of files){
    const name = path.basename(fp);
    try{
      const buf = fs.readFileSync(fp);
      const parser = new PDFParse({ data: buf });
      const data = await parser.getText();
      await parser.destroy().catch(()=>{});
      const text = String(data?.text||'');
      const tipo = detectType(name, text);
      const term = detectTerminacion(name, text);
      const m = extractMeasures(text, name);
      const ccount = colorCount(text);
      const orient = orientation(tipo, term, m.ancho, m.alto);
      const talles = hasSizes(text);
      const logo = hasLogoImage(text);
      const cols = extractColors(text);
      const combo = cols.length>=2 ? `${cols[0]}/${cols[1]}` : (cols[0]||'desconocido');
      const layout = layoutLine(tipo, term, orient, ccount||0, talles, logo);
      results.push({name,tipo,term,ancho:m.ancho,alto:m.alto,colores:ccount,orient,talles,logo,layout,combo});
      processed++;
    }catch(e){
      failed++;
      results.push({name,tipo:'otro',term:'otro',ancho:null,alto:null,colores:null,orient:'otro',talles:false,logo:false,layout:`no procesable: ${String(e.message||e).slice(0,80)}`,combo:'desconocido',error:true});
    }
  }

  const total = results.length;
  const byType = {};
  for(const r of results){ byType[r.tipo]=(byType[r.tipo]||0)+1; }

  const covered = {A:[],B:[],C:[],D:[],E:[],F:[]};
  const newPatterns = [];
  const special = [];
  for(const r of results){
    if(r.tipo==='bordada' && (r.term==='Rollo'||r.term==='CDM')) covered.A.push(r.name);
    else if(r.tipo==='bordada' && (r.term==='CDE'||(r.term==='CS'&&r.orient==='horizontal'))) covered.B.push(r.name);
    else if(r.tipo==='badana') covered.C.push(r.name);
    else if(r.tipo==='estampada') covered.D.push(r.name);
    else if(r.tipo==='plastisol') covered.E.push(r.name);
    else if(r.tipo==='bolsa') covered.F.push(r.name);
    else newPatterns.push(r);
    if(r.error || r.orient==='otro' || r.term==='otro') special.push(r);
  }

  const measureMap = new Map();
  for(const r of results){
    if(r.ancho && r.alto){
      const k = `${r.ancho}x${r.alto}`;
      measureMap.set(k, (measureMap.get(k)||0)+1);
    }
  }
  const topMeasures = Array.from(measureMap.entries()).sort((a,b)=>b[1]-a[1]).slice(0,10);

  const comboMap = new Map();
  for(const r of results){
    comboMap.set(r.combo, (comboMap.get(r.combo)||0)+1);
  }
  const topCombos = Array.from(comboMap.entries()).sort((a,b)=>b[1]-a[1]).slice(0,5);

  const sample = (arr,n=8)=>arr.slice(0,n).map(x=>`\`${x}\``).join(', ');
  const md = `# Análisis de patrones PDFs — 2026-04-24\n\n## Resumen\n- Total PDFs analizados: ${total}\n- PDFs procesados correctamente: ${processed}\n- PDFs con error de lectura: ${failed}\n- Tipos encontrados: ${Object.entries(byType).map(([k,v])=>`${k} (${v})`).join(', ')}\n\n## Patrones NUEVOS no cubiertos en el prompt actual\n${newPatterns.length?`Se detectaron ${newPatterns.length} casos fuera de A-F o sin clasificación clara.\n\nEjemplos:\n${newPatterns.slice(0,20).map(r=>`- ${r.name}: ${r.layout}`).join('\n')}`:'No se detectaron patrones nuevos fuera de A-F.'}\n\n## Patrones confirmados (ya cubiertos)\n- Layout A (Bordada vertical Rollo/CDM): ${covered.A.length} casos. Ejemplos: ${sample(covered.A)}\n- Layout B (Bordada horizontal CDE/CS ancha): ${covered.B.length} casos. Ejemplos: ${sample(covered.B)}\n- Layout C (Badana): ${covered.C.length} casos. Ejemplos: ${sample(covered.C)}\n- Layout D (Estampada satén): ${covered.D.length} casos. Ejemplos: ${sample(covered.D)}\n- Layout E (Plastisol): ${covered.E.length} casos. Ejemplos: ${sample(covered.E)}\n- Layout F (Bolsa ecommerce): ${covered.F.length} casos. Ejemplos: ${sample(covered.F)}\n\n## Medidas más frecuentes\n${topMeasures.length?topMeasures.map(([k,v],i)=>`${i+1}. ${k} mm — ${v} casos`).join('\n'):'No se pudieron extraer medidas consistentes.'}\n\n## Combinaciones de color más frecuentes\n${topCombos.length?topCombos.map(([k,v],i)=>`${i+1}. ${k} — ${v} casos`).join('\n'):'No se pudieron inferir combinaciones de color.'}\n\n## Casos especiales o raros\n${special.length?special.slice(0,40).map(r=>`- ${r.name}: tipo=${r.tipo}, term=${r.term}, orientación=${r.orient}, layout=${r.layout}`).join('\n'):'Sin casos especiales detectados.'}\n`;

  fs.mkdirSync(path.dirname(reportPath), {recursive:true});
  fs.writeFileSync(reportPath, md, 'utf8');
  console.log(`REPORT: ${reportPath}`);
  console.log(`TOTAL: ${total} | OK: ${processed} | ERR: ${failed}`);
})();
