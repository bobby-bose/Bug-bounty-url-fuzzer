/**
 * url-checker.js
 *
 * Defaults (used when you run `node .\url-checker.js` with no arguments):
 *   base URL:   https://api.crm.luminartechnolab.com
 *   concurrency: 10
 *   timeout: 5000 ms
 *   out file: results.txt
 *   port: 3000
 *
 * Usage:
 *   node url-checker.js
 *   node url-checker.js https://example.com --concurrency 20 --timeout 8000 --out myresults.txt --port 8080
 *
 * Behavior additions:
 *  - The script truncates `results.txt` at start and appends each result (one-by-one) as it completes.
 *  - HTTP endpoint GET /results serves the results file for download (Content-Disposition: attachment).
 *
 * Requirements: Node 18+ (global fetch, AbortController).
 */

import fs from "fs/promises";
import fsSync from "fs";
import http from "http";
import { setTimeout as wait } from "timers/promises";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// defaults requested by the user
const DEFAULT_BASE_URL = "https://api.crm.luminartechnolab.com/api";
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_OUT_FILE = "results.txt";
const DEFAULT_PORT = 3000;

async function readLines(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith("#")); // ignore empty & comments
}

function buildUrl(base, suffix) {
  // keep full URLs as-is
  const sRaw = suffix.trim();
  if (/^https?:\/\//i.test(sRaw)) return sRaw;

  // If suffix is only a query like "?q=1", let URL() handle it against base.
  // Otherwise make suffix relative by removing a leading slash so it doesn't
  // override the base path.
  let s = sRaw;
  if (!s.startsWith("?")) {
    s = s.replace(/^\/+/, ""); // remove leading slashes to force relative join
  }

  // Ensure base ends with a slash so new URL('x', base) appends under base's path
  let baseNorm = base;
  if (!baseNorm.endsWith("/")) baseNorm = baseNorm + "/";

  try {
    return new URL(s, baseNorm).toString();
  } catch (e) {
    // fallback: naive join
    if (!baseNorm.endsWith("/") && !s.startsWith("/")) return baseNorm + "/" + s;
    return baseNorm + s;
  }
}


async function fetchWithTimeout(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    clearTimeout(id);
    return { ok: true, res };
  } catch (err) {
    clearTimeout(id);
    return { ok: false, err };
  }
}

function parseArgs(argvRaw) {
  // returns { baseUrl, concurrency, timeoutMs, outFile, port }
  const argv = argvRaw.slice(); // copy
  let baseUrl = DEFAULT_BASE_URL;
  let concurrency = DEFAULT_CONCURRENCY;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let outFile = DEFAULT_OUT_FILE;
  let port = DEFAULT_PORT;

  // If first arg exists and is not a flag (--...), treat it as baseUrl override
  if (argv.length > 0 && !argv[0].startsWith("--")) {
    baseUrl = argv.shift();
  }

  // parse remaining flags
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "-c" || a === "--concurrency") && argv[i + 1]) {
      concurrency = parseInt(argv[i + 1], 10) || concurrency;
      i++;
    } else if ((a === "-t" || a === "--timeout") && argv[i + 1]) {
      timeoutMs = parseInt(argv[i + 1], 10) || timeoutMs;
      i++;
    } else if (a === "--out" && argv[i + 1]) {
      outFile = argv[i + 1];
      i++;
    } else if (a === "--port" && argv[i + 1]) {
      port = parseInt(argv[i + 1], 10) || port;
      i++;
    } else {
      // unknown flag: ignore
    }
  }

  return { baseUrl, concurrency, timeoutMs, outFile, port };
}

function makeReadableLine(result) {
  if (result.status === "ERROR") {
    return `[${result.index}] ${result.url} -> ERROR: ${result.detail} (${result.time}ms)`;
  } else {
    return `[${result.index}] ${result.url} -> ${result.status} ${result.tag} (${result.time}ms)`;
  }
}

async function startFileServer(outPath, port) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/results" || req.url === "/results.txt")) {
      // if file doesn't exist, respond 404
      if (!fsSync.existsSync(outPath)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("results file not found\n");
        return;
      }

      const stat = fsSync.statSync(outPath);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${path.basename(outPath)}"`,
        "Content-Length": stat.size,
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      const stream = fsSync.createReadStream(outPath);
      stream.pipe(res);
      stream.on("error", (err) => {
        res.end();
      });
      return;
    }

    // root page: quick status/help
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      const html = `<html><head><meta charset="utf-8"><title>URL Checker</title></head><body>
        <h3>URL Checker</h3>
        <p>Download results: <a href="/results">/results</a></p>
        <p>File: ${path.basename(outPath)}</p>
        </body></html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // anything else -> 404
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found\n");
  });

  return new Promise((resolve, reject) => {
    server.listen(port, () => {
      console.log(`HTTP server listening on http://localhost:${port}  —  GET /results to download the results file`);
      resolve(server);
    });
    server.on("error", reject);
  });
}

async function runMain() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args.baseUrl;
  const concurrency = args.concurrency;
  const timeoutMs = args.timeoutMs;
  const outFile = args.outFile;
  const port = args.port;

  const tryFile = path.join(__dirname, "try.txt");
  const outPath = path.isAbsolute(outFile) ? outFile : path.join(__dirname, outFile);
  const jsonPath = path.join(__dirname, "route-results.json");

  // Ensure try.txt exists
  try {
    await fs.access(tryFile);
  } catch (err) {
    console.error(`try.txt not found in ${__dirname}. Please create try.txt with one path per line.`);
    process.exit(2);
  }

  // Read lines
  let lines;
  try {
    lines = await readLines(tryFile);
  } catch (err) {
    console.error("Failed to read try.txt:", err.message);
    process.exit(2);
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    console.log("try.txt is empty (or only comments). Nothing to check.");
    return;
  }

  // Truncate / create results file at start
  try {
    await fs.writeFile(outPath, `URL checker started: base=${baseUrl}, concurrency=${concurrency}, timeout=${timeoutMs}ms\n`, "utf8");
    console.log(`Truncated/created results file: ${outPath}`);
  } catch (err) {
    console.error("Failed to create/truncate results file:", err.message);
    process.exit(3);
  }

  // Start HTTP server for download (does not block)
  await startFileServer(outPath, port).catch(err => {
    console.error("Failed to start HTTP server:", err);
    process.exit(4);
  });

  console.log(`Base URL: ${baseUrl}`);
  console.log(`Items to try: ${lines.length}`);
  console.log(`Concurrency: ${concurrency}, Timeout: ${timeoutMs} ms`);
  console.log(`Appending results to: ${outPath}`);
  console.log("Starting checks...\n");

  // concurrency worker pool
  let idx = 0;
  const results = [];

  async function worker() {
    while (true) {
      const index = idx++;
      if (index >= lines.length) break;
      const suffix = lines[index];
      const url = buildUrl(baseUrl, suffix);
      const started = Date.now();

      const { ok, res, err } = await fetchWithTimeout(url, timeoutMs);
      const duration = Date.now() - started;

      let resultObj;
      if (!ok) {
        const reason = err && err.name === "AbortError" ? `TIMEOUT (${timeoutMs}ms)` : (err && (err.message || String(err))) || "UNKNOWN";
        console.log(`[${index + 1}/${lines.length}] ${url} -> ERROR: ${reason} (${duration}ms)`);
        resultObj = {
          index: index + 1,
          url,
          suffix,
          status: "ERROR",
          tag: "ERROR",
          time: duration,
          detail: reason,
        };
      } else {
        const status = res.status;
        let tag = "UNKNOWN";
        if (status >= 200 && status < 300) tag = "OK";
        else if (status >= 300 && status < 400) tag = "REDIRECT";
        else if (status >= 400 && status < 500) tag = "NOTFOUND/CLIENT";
        else if (status >= 500) tag = "SERVERERROR";

        console.log(`[${index + 1}/${lines.length}] ${url} -> ${status} ${tag} (${duration}ms)`);
        resultObj = {
          index: index + 1,
          url,
          suffix,
          status,
          tag,
          time: duration,
        };
      }

      // push to memory results
      results.push(resultObj);

      // append readable line to results.txt immediately
      const line = makeReadableLine(resultObj) + "\n";
      try {
        await fs.appendFile(outPath, line, "utf8");
      } catch (err) {
        console.error("Failed to append to results file:", err.message);
      }

      // optional polite delay
      await wait(50);
    }
  }

  // start workers
  const workerCount = Math.min(concurrency, lines.length);
  const workers = Array(workerCount).fill(0).map(() => worker());
  await Promise.all(workers);

  // final summary
  const okCount = results.filter(r => r.status === "OK" || (typeof r.status === "number" && r.status >= 200 && r.status < 300)).length;
  const redirectCount = results.filter(r => r.tag === "REDIRECT").length;
  console.log("\nDone.");
  console.log(`Total: ${results.length}, OK(2xx): ${okCount}, Redirects: ${redirectCount}`);

  // write JSON results
  try {
    await fs.writeFile(jsonPath, JSON.stringify(results, null, 2), "utf8");
    console.log(`JSON results written to ${jsonPath}`);
  } catch (err) {
    console.error("Failed to write JSON results:", err.message);
  }

  // Append summary to results.txt
  try {
    const summary = `\nDone. Total: ${results.length}, OK(2xx): ${okCount}, Redirects: ${redirectCount}\n`;
    await fs.appendFile(outPath, summary, "utf8");
    console.log(`Summary appended to ${outPath}`);
  } catch (err) {
    console.error("Failed to append summary to results file:", err.message);
  }

  // keep server running (do not exit) so you can download results via /results
  console.log(`Checks finished. HTTP server still running on port ${port} — GET /results to download the file.`);
}

runMain().catch(e => {
  console.error("Fatal error:", e);
  process.exit(99);
});
