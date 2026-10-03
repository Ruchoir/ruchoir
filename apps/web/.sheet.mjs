import { chromium } from "playwright";
import fs from "node:fs";
const [out, cols, ...files] = process.argv.slice(2);
const imgs = files.map((f) => `<figure><img src="data:image/png;base64,${fs.readFileSync(f).toString("base64")}"><figcaption>${f.split("/").pop()}</figcaption></figure>`).join("");
const html = `<html><body style="margin:0;background:#888;display:grid;grid-template-columns:repeat(${cols},auto);gap:8px;padding:8px;font:12px sans-serif">${imgs}</body><style>figure{margin:0}img{display:block;width:100%}</style></html>`;
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 800 } });
await p.setContent(html); await p.screenshot({ path: out, fullPage: true }); await b.close();
