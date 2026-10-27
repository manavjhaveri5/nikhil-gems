/**
 * xlsxWriter.js
 * A small .xlsx writer that keeps the formatting: fonts, fills, borders,
 * number formats, merged cells, column widths, row heights and print setup.
 * SheetJS community edition writes values only, so the sheet XML is written
 * here and SheetJS's zip (CFB) packs it. SheetJS is loaded on first use.
 */

// ─────────────────────────────────────────────
//  SHEET MODEL  (rows and columns are 0-based)
//
//  A cell holds a value and a style:
//    value  number | string | [{t, b, i, sz, color}] (rich text runs) | null
//    style  { b, i, sz, color, fill, h, v, wrap, fmt, bt, bb, bl, br, bc }
//           bt/bb/bl/br are border lines ("thin", "medium", "double"),
//           bc their colour; colours are "RRGGBB".
// ─────────────────────────────────────────────
export function createSheet(name){
  const cells=new Map();
  const key=(r,c)=>r+":"+c;
  const sheet={
    name, cells,
    cols:[],             // widths in characters
    heights:new Map(),   // row → points
    merges:[],           // [r1,c1,r2,c2]
    repeatRows:null,     // [r1,r2] printed at the top of every page
    font:{name:"Arial",sz:10},
    set(r,c,v,s={}){const p=cells.get(key(r,c));cells.set(key(r,c),{v,s:{...(p?.s||{}),...s}});return sheet;},
    style(r,c,s){const p=cells.get(key(r,c));cells.set(key(r,c),{v:p?p.v:null,s:{...(p?.s||{}),...s}});return sheet;},
    merge(r1,c1,r2,c2){if(r2>r1||c2>c1)sheet.merges.push([r1,c1,r2,c2]);return sheet;},
    height(r,pt){sheet.heights.set(r,pt);return sheet;},
    // Outline a block. Excel draws borders cell by cell, so a merged range
    // needs its edge cells styled too, not just the first one.
    box(r1,c1,r2,c2,line="thin",bc){
      for(let r=r1;r<=r2;r++)for(let c=c1;c<=c2;c++){
        const s={};
        if(r===r1)s.bt=line;if(r===r2)s.bb=line;
        if(c===c1)s.bl=line;if(c===c2)s.br=line;
        if(bc)s.bc=bc;
        if(Object.keys(s).length)sheet.style(r,c,s);
      }
      return sheet;
    },
  };
  return sheet;
}

const XML_HEAD='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN="http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL="http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL="http://schemas.openxmlformats.org/package/2006/relationships";

// eslint-disable-next-line no-control-regex
const esc=v=>String(v??"").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const colName=c=>{let s="";for(c++;c>0;c=Math.floor((c-1)/26))s=String.fromCharCode(65+(c-1)%26)+s;return s;};
const ref=(r,c)=>colName(c)+(r+1);
const argb=hex=>"FF"+String(hex||"000000").replace("#","").toUpperCase();
const BUILTIN_FMT={"General":0,"0":1,"0.00":2,"#,##0":3,"#,##0.00":4,"0%":9,"0.00%":10};

// Fonts, fills, borders and formats are each listed once in styles.xml and
// referenced by index; a cell's style is the combination of the four.
function styleTable(font){
  const lists={fonts:[],fills:[],borders:[],fmts:[],xfs:[]};
  const index=(list,k)=>{let i=list.indexOf(k);if(i<0){list.push(k);i=list.length-1;}return i;};
  const fontXml=f=>`<font>${f.b?"<b/>":""}${f.i?"<i/>":""}<sz val="${f.sz||font.sz}"/><color rgb="${argb(f.color)}"/><name val="${esc(font.name)}"/><family val="2"/></font>`;
  index(lists.fonts,fontXml({}));
  index(lists.fills,'<fill><patternFill patternType="none"/></fill>');
  index(lists.fills,'<fill><patternFill patternType="gray125"/></fill>');
  const side=(tag,line,bc)=>line?`<${tag} style="${line}"><color rgb="${argb(bc||"BFBFBF")}"/></${tag}>`:`<${tag}/>`;
  index(lists.borders,"<border><left/><right/><top/><bottom/><diagonal/></border>");
  index(lists.xfs,'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>');
  const xfOf=s=>{
    if(!s||!Object.keys(s).length)return 0;
    const fontId=index(lists.fonts,fontXml(s));
    const fillId=s.fill?index(lists.fills,`<fill><patternFill patternType="solid"><fgColor rgb="${argb(s.fill)}"/><bgColor indexed="64"/></patternFill></fill>`):0;
    const borderId=index(lists.borders,`<border>${side("left",s.bl,s.bc)}${side("right",s.br,s.bc)}${side("top",s.bt,s.bc)}${side("bottom",s.bb,s.bc)}<diagonal/></border>`);
    const fmt=s.fmt||"General";
    const numFmtId=fmt in BUILTIN_FMT?BUILTIN_FMT[fmt]:164+index(lists.fmts,fmt);
    const align=s.h||s.v||s.wrap?`<alignment${s.h?` horizontal="${s.h}"`:""}${s.v?` vertical="${s.v}"`:""}${s.wrap?' wrapText="1"':""}/>`:"";
    return index(lists.xfs,`<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"${align?' applyAlignment="1">'+align+"</xf>":"/>"}`);
  };
  const xml=()=>XML_HEAD+`<styleSheet xmlns="${NS_MAIN}">`
    +(lists.fmts.length?`<numFmts count="${lists.fmts.length}">${lists.fmts.map((f,i)=>`<numFmt numFmtId="${164+i}" formatCode="${esc(f)}"/>`).join("")}</numFmts>`:"")
    +`<fonts count="${lists.fonts.length}">${lists.fonts.join("")}</fonts>`
    +`<fills count="${lists.fills.length}">${lists.fills.join("")}</fills>`
    +`<borders count="${lists.borders.length}">${lists.borders.join("")}</borders>`
    +'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    +`<cellXfs count="${lists.xfs.length}">${lists.xfs.join("")}</cellXfs>`
    +'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    +"</styleSheet>";
  return {xfOf,xml};
}

// Text goes in the shared string table, the way Excel itself stores it;
// some viewers ignore bold and italic runs kept inline in the cell.
function stringTable(font){
  const list=[],seen=new Map();
  const runXml=x=>`<r><rPr>${x.b?"<b/>":""}${x.i?"<i/>":""}<sz val="${x.sz||font.sz}"/><color rgb="${argb(x.color)}"/><rFont val="${esc(font.name)}"/><family val="2"/></rPr><t xml:space="preserve">${esc(x.t)}</t></r>`;
  const idOf=v=>{
    const si=Array.isArray(v)?v.filter(x=>x&&x.t!=null&&x.t!=="").map(runXml).join(""):`<t xml:space="preserve">${esc(v)}</t>`;
    if(!si)return -1;
    if(!seen.has(si)){seen.set(si,list.length);list.push(si);}
    return seen.get(si);
  };
  const xml=()=>XML_HEAD+`<sst xmlns="${NS_MAIN}" count="${list.length}" uniqueCount="${list.length}">${list.map(si=>`<si>${si}</si>`).join("")}</sst>`;
  return {idOf,xml};
}

function cellXml(r,c,v,xf,strings){
  const at=`r="${ref(r,c)}"${xf?` s="${xf}"`:""}`;
  if(v==null||v==="")return`<c ${at}/>`;
  if(typeof v==="number")return Number.isFinite(v)?`<c ${at}><v>${v}</v></c>`:`<c ${at}/>`;
  const id=strings.idOf(v);
  return id<0?`<c ${at}/>`:`<c ${at} t="s"><v>${id}</v></c>`;
}

function sheetXml(sheet,styles,strings){
  const byRow=new Map();
  let maxR=0,maxC=Math.max(0,sheet.cols.length-1);
  for(const [k,cell] of sheet.cells){
    const [r,c]=k.split(":").map(Number);
    maxR=Math.max(maxR,r);maxC=Math.max(maxC,c);
    if(!byRow.has(r))byRow.set(r,[]);
    byRow.get(r).push([c,cell]);
  }
  for(const r of sheet.heights.keys())maxR=Math.max(maxR,r);
  const rows=[];
  for(let r=0;r<=maxR;r++){
    const cells=(byRow.get(r)||[]).sort((a,b)=>a[0]-b[0]);
    const ht=sheet.heights.get(r);
    if(!cells.length&&ht==null)continue;
    rows.push(`<row r="${r+1}"${ht!=null?` ht="${ht}" customHeight="1"`:""}>${cells.map(([c,cell])=>cellXml(r,c,cell.v,styles.xfOf(cell.s),strings)).join("")}</row>`);
  }
  const lineHt=Math.round(sheet.font.sz*1.275*100)/100;
  return XML_HEAD+`<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
    +'<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'
    +`<dimension ref="A1:${ref(maxR,maxC)}"/>`
    +'<sheetViews><sheetView workbookViewId="0" showGridLines="0" tabSelected="1"/></sheetViews>'
    +`<sheetFormatPr defaultRowHeight="${lineHt}"/>`
    +(sheet.cols.length?`<cols>${sheet.cols.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join("")}</cols>`:"")
    +`<sheetData>${rows.join("")}</sheetData>`
    +(sheet.merges.length?`<mergeCells count="${sheet.merges.length}">${sheet.merges.map(([r1,c1,r2,c2])=>`<mergeCell ref="${ref(r1,c1)}:${ref(r2,c2)}"/>`).join("")}</mergeCells>`:"")
    +'<printOptions horizontalCentered="1"/>'
    +'<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.6" header="0.3" footer="0.3"/>'
    +'<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>'
    +'<headerFooter><oddFooter>&amp;R&amp;8Page &amp;P of &amp;N</oddFooter></headerFooter>'
    +"</worksheet>";
}

// Excel sheet names: at most 31 characters, none of []:*?/\
export const safeSheetName=s=>String(s||"").replace(/[[\]:*?/\\]/g,"-").replace(/^'+|'+$/g,"").slice(0,31)||"Sheet1";

// Pack sheets into an .xlsx. Returns the file's bytes.
export async function buildXlsx(sheets,{title="",creator=""}={}){
  const {CFB}=await import("xlsx");
  const font=sheets[0]?.font||{name:"Arial",sz:10};
  const styles=styleTable(font);
  const strings=stringTable(font);
  const names=[];
  sheets.forEach(s=>{let n=safeSheetName(s.name),k=2;while(names.includes(n))n=safeSheetName(s.name).slice(0,28)+" "+k++;names.push(n);});
  const parts={};
  sheets.forEach((s,i)=>{parts[`xl/worksheets/sheet${i+1}.xml`]=sheetXml(s,styles,strings);});
  parts["xl/styles.xml"]=styles.xml();
  parts["xl/sharedStrings.xml"]=strings.xml();
  const quoted=n=>`'${n.replace(/'/g,"''")}'`;
  const titles=sheets.map((s,i)=>s.repeatRows?`<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${esc(quoted(names[i]))}!$${s.repeatRows[0]+1}:$${s.repeatRows[1]+1}</definedName>`:"").join("");
  parts["xl/workbook.xml"]=XML_HEAD+`<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><bookViews><workbookView/></bookViews>`
    +`<sheets>${names.map((n,i)=>`<sheet name="${esc(n)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join("")}</sheets>`
    +(titles?`<definedNames>${titles}</definedNames>`:"")+"</workbook>";
  parts["xl/_rels/workbook.xml.rels"]=XML_HEAD+`<Relationships xmlns="${NS_PKG_REL}">`
    +names.map((_,i)=>`<Relationship Id="rId${i+1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join("")
    +`<Relationship Id="rId${names.length+1}" Type="${NS_REL}/styles" Target="styles.xml"/>`
    +`<Relationship Id="rId${names.length+2}" Type="${NS_REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  parts["docProps/core.xml"]=XML_HEAD+'<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    +`<dc:title>${esc(title)}</dc:title><dc:creator>${esc(creator)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/,"Z")}</dcterms:created></cp:coreProperties>`;
  parts["_rels/.rels"]=XML_HEAD+`<Relationships xmlns="${NS_PKG_REL}">`
    +`<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>`
    +`<Relationship Id="rId2" Type="${NS_PKG_REL}/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  parts["[Content_Types].xml"]=XML_HEAD+'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    +'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    +'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    +names.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
    +'<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    +'<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
    +'<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
  const zip=CFB.utils.cfb_new({root:"R"});
  const enc=new TextEncoder();
  for(const [path,xml] of Object.entries(parts))CFB.utils.cfb_add(zip,path,enc.encode(xml));
  return new Uint8Array(CFB.write(zip,{fileType:"zip",type:"array",compression:true}));
}
