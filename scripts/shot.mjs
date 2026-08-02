import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
const local = {
  "leaflet@1.9.4/dist/leaflet.js": ["node_modules/leaflet/dist/leaflet.js", "text/javascript"],
  "leaflet@1.9.4/dist/leaflet.css": ["node_modules/leaflet/dist/leaflet.css", "text/css"],
  "ag-grid-community@31.3.2/dist/ag-grid-community.min.js": ["node_modules/ag-grid-community/dist/ag-grid-community.min.js", "text/javascript"],
  "ag-grid-community@31.3.2/styles/ag-grid.css": ["node_modules/ag-grid-community/styles/ag-grid.css", "text/css"],
  "ag-grid-community@31.3.2/styles/ag-theme-quartz.css": ["node_modules/ag-grid-community/styles/ag-theme-quartz.css", "text/css"],
};
await page.route("**/*", async (route) => {
  const url = route.request().url();
  if (url.startsWith("http://localhost:8787")) return route.continue();
  const hit = Object.keys(local).find((k) => url.includes(k));
  if (hit) {
    const [path, type] = local[hit];
    return route.fulfill({ body: await readFile(path), contentType: type });
  }
  return route.abort(); // fonts, tiles, arcgis: fine to miss for card checks
});
await page.goto("http://localhost:8787/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(3000);
await page.fill("#pcInput", "East Sheen");
await page.click("#pcBtn");
await page.waitForTimeout(2000);
await page.locator("#detail").screenshot({ path: "/tmp/card_move.png" });
await page.click('[data-lens="play"]');
await page.waitForTimeout(800);
await page.locator("#detail").screenshot({ path: "/tmp/card_play.png" });
await page.click('[data-lens="playEquipped"]');
await page.waitForTimeout(800);
await page.locator("#detail").screenshot({ path: "/tmp/card_playeq.png" });
await page.click('[data-lens="move"]');
await page.waitForTimeout(500);
await page.click(".methodology summary");
await page.waitForTimeout(500);
await page.locator(".methodology").screenshot({ path: "/tmp/methodology.png" });
await browser.close();
console.log("done");
