#!/usr/bin/env node
/**
 * Node alternatív ugyanahhoz a riporthoz (ha nincs telepített Python).
 * Nem módosít HTML-et; CSV-t ír ugyanoda, mint a .py változat.
 *
 * node korzika_lastrada_poi_title_compare.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_KORZIKA_ROOT =
  String.raw`C:\Users\lajos\Documents\Korzika 2026`;
const DEFAULT_LASTRADA_ROOT =
  String.raw`C:\Users\lajos\Documents\Kirándulás szerkesztő`;
const DEFAULT_REPORT_DOCUMENTS =
  String.raw`C:\Users\lajos\Documents\korzika_lastrada_title_match_report.csv`;
const LOCAL_REPORT_COPY = path.join(
  __dirname,
  "korzika_lastrada_title_match_report.csv",
);

const LASTRADA_PATH_MARKERS = [
  "france",
  "francia",
  "franciaorszag",
  "franciaország",
  "corsica",
  "korzika",
];

function collapseWhitespace(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

function stripTagsDecode(s) {
  let t = String(s).replace(/<[^>]+>/g, " ");
  t = t
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    );
  return t;
}

function stripNonContent(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, "");
}

function findTagTexts(html, tag) {
  const re = new RegExp(
    `<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    "gi",
  );
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = collapseWhitespace(stripTagsDecode(m[1]));
    if (text) out.push(text);
  }
  return out;
}

function extractPoiTitle(htmlText) {
  const h = stripNonContent(htmlText);
  const h1 = findTagTexts(h, "h1");
  if (h1.length) return h1[0];
  const h2 = findTagTexts(h, "h2");
  if (h2.length) return h2[0];
  const tm = h.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (tm) return collapseWhitespace(stripTagsDecode(tm[1]));
  return "";
}

function normalizeTitle(title) {
  if (!title) return "";
  const noMarks = String(title).normalize("NFD").replace(/\p{M}/gu, "");
  const simplified = noMarks.toLowerCase().replace(/[^\w]+/gu, " ");
  return collapseWhitespace(simplified);
}

function* walkHtmlFiles(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.html?$/i.test(e.name)) yield p;
    }
  }
}

function lastradaPathIsRelevant(fullPath) {
  const p = fullPath.replace(/\//g, "\\").toLowerCase();
  return LASTRADA_PATH_MARKERS.some((m) => p.includes(m.toLowerCase()));
}

function collectFileRecords(root, filterPaths) {
  const rows = [];
  const files = [...walkHtmlFiles(root)].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
  for (const fp of files) {
    if (filterPaths && !lastradaPathIsRelevant(fp)) continue;
    let text;
    try {
      text = fs.readFileSync(fp, { encoding: "utf8" });
    } catch {
      continue;
    }
    const rawTitle = extractPoiTitle(text);
    const normalizedTitle = normalizeTitle(rawTitle);
    rows.push({
      file: path.resolve(fp),
      raw_title: rawTitle,
      normalized_title: normalizedTitle,
    });
  }
  return rows;
}

function buildIndex(records) {
  const idx = new Map();
  for (const r of records) {
    const k = r.normalized_title;
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(r);
  }
  return idx;
}

function computeReportRows(korRecords, lsRecords) {
  const kIdx = buildIndex(korRecords);
  const lIdx = buildIndex(lsRecords);
  const allKeys = [...new Set([...kIdx.keys(), ...lIdx.keys()])].sort((a, b) => {
    const ae = a === "";
    const be = b === "";
    if (ae !== be) return ae ? 1 : -1;
    return a.localeCompare(b);
  });

  const out = [];
  for (const key of allKeys) {
    const ks = [...(kIdx.get(key) ?? [])].sort((a, b) =>
      String(a.file).localeCompare(String(b.file)),
    );
    const ls = [...(lIdx.get(key) ?? [])].sort((a, b) =>
      String(a.file).localeCompare(String(b.file)),
    );

    if (!ks.length) {
      for (const r of ls) {
        out.push({
          match_status: "lastrada_only",
          korzika_title: "",
          lastrada_title: r.raw_title,
          korzika_file: "",
          lastrada_file: r.file,
          normalized_title: key,
        });
      }
      continue;
    }
    if (!ls.length) {
      for (const r of ks) {
        out.push({
          match_status: "korzika_only",
          korzika_title: r.raw_title,
          lastrada_title: "",
          korzika_file: r.file,
          lastrada_file: "",
          normalized_title: key,
        });
      }
      continue;
    }

    const pairs = Math.min(ks.length, ls.length);
    for (let i = 0; i < pairs; i++) {
      const kr = ks[i];
      const lr = ls[i];
      out.push({
        match_status: "exact_normalized_match",
        korzika_title: kr.raw_title,
        lastrada_title: lr.raw_title,
        korzika_file: kr.file,
        lastrada_file: lr.file,
        normalized_title: key,
      });
    }

    const refL = ls[0];
    for (const kr of ks.slice(pairs)) {
      out.push({
        match_status: "duplicate_in_korzika",
        korzika_title: kr.raw_title,
        lastrada_title: refL.raw_title,
        korzika_file: kr.file,
        lastrada_file: refL.file,
        normalized_title: key,
      });
    }

    const refK = ks[0];
    for (const lr of ls.slice(pairs)) {
      out.push({
        match_status: "duplicate_in_lastrada",
        korzika_title: refK.raw_title,
        lastrada_title: lr.raw_title,
        korzika_file: refK.file,
        lastrada_file: lr.file,
        normalized_title: key,
      });
    }
  }
  return out;
}

function csvEscape(cell) {
  const s = String(cell ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(reportPath, rows) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const header = [
    "match_status",
    "korzika_title",
    "lastrada_title",
    "korzika_file",
    "lastrada_file",
    "normalized_title",
  ];
  const lines = [
    "\ufeff" + header.map(csvEscape).join(","),
    ...rows.map((r) =>
      header.map((h) => csvEscape(r[h])).join(","),
    ),
  ];
  fs.writeFileSync(reportPath, lines.join("\r\n"), { encoding: "utf8" });
}

function parseArgs(argv) {
  let korRoot = DEFAULT_KORZIKA_ROOT;
  let lsRoot = DEFAULT_LASTRADA_ROOT;
  let reportCsv = DEFAULT_REPORT_DOCUMENTS;
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--korzika-root" && rest[i + 1]) {
      korRoot = rest[++i];
    } else if (rest[i] === "--lastrada-root" && rest[i + 1]) {
      lsRoot = rest[++i];
    } else if (rest[i] === "--report-csv" && rest[i + 1]) {
      reportCsv = rest[++i];
    } else if (rest[i] === "-h" || rest[i] === "--help") {
      console.log(`node korzika_lastrada_poi_title_compare.mjs
  [--korzika-root PATH] [--lastrada-root PATH] [--report-csv PATH]`);
      process.exit(0);
    } else {
      console.error("Ismeretlen argumentum:", rest[i]);
      process.exit(2);
    }
  }
  return { korRoot, lsRoot, reportCsv };
}

const { korRoot, lsRoot, reportCsv } = parseArgs(process.argv);

const korRecords = collectFileRecords(korRoot, false);
const lsRecords = collectFileRecords(lsRoot, true);
const reportRows = computeReportRows(korRecords, lsRecords);
writeCsv(reportCsv, reportRows);
writeCsv(LOCAL_REPORT_COPY, reportRows);

const nExact = reportRows.filter((r) => r.match_status === "exact_normalized_match").length;
const nK = reportRows.filter((r) => r.match_status === "korzika_only").length;
const nL = reportRows.filter((r) => r.match_status === "lastrada_only").length;
const nDupK = reportRows.filter((r) => r.match_status === "duplicate_in_korzika").length;
const nDupL = reportRows.filter((r) => r.match_status === "duplicate_in_lastrada").length;

const kI = buildIndex(korRecords);
const lI = buildIndex(lsRecords);
let duplicateTitles = 0;
for (const key of new Set([...kI.keys(), ...lI.keys()])) {
  if (key === "") continue;
  if ((kI.get(key)?.length ?? 0) > 1 || (lI.get(key)?.length ?? 0) > 1) {
    duplicateTitles++;
  }
}

console.log(`Riport elkészült: ${reportCsv}`);
console.log(`Riport másolat (projektmappa): ${LOCAL_REPORT_COPY}`);
console.log(`- Korzika HTML (összes rekurzív): ${korRecords.length}`);
console.log(
  `- LaStrada HTML (útban francia/korzikai kulcsszűrővel): ${lsRecords.length}`,
);
console.log(`- Pontos normalizált cím egyezés (sor): ${nExact}`);
console.log(`- Korzika-only sorok: ${nK}`);
console.log(`- LaStrada-only sorok: ${nL}`);
console.log(`- Duplikátum sor duplicate_in_korzika: ${nDupK}`);
console.log(`- Duplikátum sor duplicate_in_lastrada: ${nDupL}`);
console.log(`- Összesen „duplikált utasítás” típus sor: ${nDupK + nDupL}`);
console.log(
  `- Olyan normalizált címek száma, amely több fájlra is ráillik ( bármelyik oldalon ): ${duplicateTitles}`,
);
