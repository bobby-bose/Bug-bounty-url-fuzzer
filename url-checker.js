/**
 * route-checker.js
 *
 * Usage:
 *   node route-checker.js https://www.example.com/    (reads try.txt in same dir)
 *
 * try.txt example:
 *   admin
 *   login
 *   api/v1/users
 *   ?query=1
 */

import fs from "fs/promises";
import { setTimeout as wait } from "timers/promises";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readLines(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith("#")); // ignore empty & comments
}

function buildUrl(base, suffix) {
  // If suffix looks like full URL, just return it
  try {
    const s = suffix.trim();
    if (/^https?:\/\//i.test(s)) return s;
    // Use URL constructor to correctly join paths and queries
    return new URL(s, base).toString();
  } catch (e) {
    // fallback naive join
    if (!base.endsWith("/") && !suffix.startsWith("/")) return base + "/" + suffix;
    return base + suffix;
  }
}

async function fetchWithTimeout(url, timeoutMs = 8000) {
  // use global fetch available in Node 18+. Use AbortController for timeout.
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

async function run() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error("Usage: node route-checker.js <base-url> [--concurrency N] [--timeout ms]");
    process.exit(1);
  }

  const baseUrl = argv[0];
  let concurrency = 10;
  let timeoutMs = 8000;

  // simple flag parser
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--concurrency" && argv[i + 1]) {
      concurrency = parseInt(argv[i + 1], 10) || concurrency;
      i++;
    } else if (argv[i] === "--timeout" && argv[i + 1]) {
      timeoutMs = parseInt(argv[i + 1], 10) || timeoutMs;
      i++;
    }
  }

  const tryFile = path.join(__dirname, "try.txt");

  let lines;
  try {
    lines = await readLines(tryFile);
  } catch (err) {
    console.error("Failed to read try.txt:", err.message);
    process.exit(2);
  }

  if (lines.length === 0) {
    console.log("try.txt is empty (or only comments). Nothing to check.");
    return;
  }

  console.log(`Base URL: ${baseUrl}`);
  console.log(`Items to try: ${lines.length}`);
  console.log(`Concurrency: ${concurrency}, Timeout: ${timeoutMs} ms`);
  console.log("Starting...\n");

  // concurrency worker pool
  let i = 0;
  const results = [];

  async function worker() {
    while (true) {
      const index = i++;
      if (index >= lines.length) break;
      const suffix = lines[index];
      const url = buildUrl(baseUrl, suffix);

      const started = Date.now();
      const { ok, res, err } = await fetchWithTimeout(url, timeoutMs);
      const duration = Date.now() - started;

      if (!ok) {
        const reason = err.name === "AbortError" ? `TIMEOUT (${timeoutMs}ms)` : (err.message || String(err));
        console.log(`[${index + 1}/${lines.length}] ${url} -> ERROR: ${reason} (${duration}ms)`);
        results.push({ url, suffix, status: "ERROR", detail: reason });
        continue;
      }

      const status = res.status;
      // classify: 2xx success, 3xx redirect, 4xx client error, 5xx server error
      let tag = "UNKNOWN";
      if (status >= 200 && status < 300) tag = "OK";
      else if (status >= 300 && status < 400) tag = "REDIRECT";
      else if (status >= 400 && status < 500) tag = "NOTFOUND/CLIENT";
      else if (status >= 500) tag = "SERVERERROR";

      console.log(`[${index + 1}/${lines.length}] ${url} -> ${status} ${tag} (${duration}ms)`);
      results.push({ url, suffix, status, tag, time: duration });
      // small polite delay to avoid hammering target (optional)
      await wait(50);
    }
  }

  // start workers
  const workers = Array(Math.min(concurrency, lines.length)).fill(0).map(() => worker());
  await Promise.all(workers);

  // summary
  const okCount = results.filter(r => r.status === "OK" || (typeof r.status === "number" && r.status >= 200 && r.status < 300)).length;
  const redirectCount = results.filter(r => r.tag === "REDIRECT").length;
  console.log("\nDone.");
  console.log(`Total: ${results.length}, OK(2xx): ${okCount}, Redirects: ${redirectCount}`);
  // optionally write results to results.json
  await fs.writeFile(path.join(__dirname, "route-results.json"), JSON.stringify(results, null, 2), "utf8");
  console.log("Results written to route-results.json");
}

run().catch(e => {
  console.error("Fatal error:", e);
  process.exit(99);
});
