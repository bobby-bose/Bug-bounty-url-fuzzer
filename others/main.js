// server.js
const express = require('express');
const { Worker } = require('worker_threads');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { randomBytes } = require('crypto');

const app = express();
app.use(express.json());

const SCANS_DIR = path.resolve(__dirname, 'scans');
if (!fsSync.existsSync(SCANS_DIR)) fsSync.mkdirSync(SCANS_DIR, { recursive: true });

// In-memory job tracking
// jobId -> { status: 'queued'|'running'|'done'|'failed', worker?: Worker, meta?: {...} }
const jobs = new Map();

function validateHostname(hostname) {
  if (!hostname) return false;
  return /^[a-z0-9.-]+$/.test(hostname.toLowerCase()) && hostname.includes('.');
}

// Start a worker thread for the scan
function startScanWorker({ jobId, hostname, workdir }) {
  return new Promise((resolve, reject) => {
    // Prepare inline worker code as string; uses eval mode
    const workerCode = `
      const { parentPort, workerData } = require('worker_threads');
      const { spawn } = require('child_process');
      const fs = require('fs/promises');
      const path = require('path');

      function nowMs(){ return Date.now(); }
      function minutesFromMs(ms){ return +(ms/60000).toFixed(2); }

      function spawnCmd(cmd, args, opts = {}) {
        return new Promise((resolve, reject) => {
          const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '';
          let stderr = '';

          child.stdout.on('data', (d) => { stdout += d.toString(); });
          child.stderr.on('data', (d) => { stderr += d.toString(); });

          child.on('error', (err) => reject(err));
          child.on('close', (code) => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(\`\${cmd} exited \${code}: \${stderr}\`));
          });

          if (opts.timeout) {
            setTimeout(() => {
              try { child.kill('SIGTERM'); } catch(e){}
              reject(new Error(\`\${cmd} timed out after \${opts.timeout}ms\`));
            }, opts.timeout);
          }
        });
      }

      (async () => {
        const { jobId, hostname, workdir } = workerData;
        try {
          // Ensure workdir exists
          await fs.mkdir(workdir, { recursive: true });

          const meta = { jobId, hostname, tasks: [], startedAt: new Date().toISOString() };
          parentPort.postMessage({ type: 'log', message: \`[JOB \${jobId}] Starting scan for: \${hostname}\` });

          // TASK 1: Run subfinder
          parentPort.postMessage({ type: 'log', message: '[TASK] About to run subfinder (passive discovery). Estimated time: ~1.5 minutes' });
          let t0 = nowMs();
          const subfinderOut = path.join(workdir, 'subfinder.txt');
          await spawnCmd('subfinder', ['-d', hostname, '-silent', '-o', subfinderOut], { timeout: 2 * 60 * 1000 }).catch(err => {
            // log and continue (subfinder may not be present)
            parentPort.postMessage({ type: 'log', message: '[TASK] subfinder failed or not present: ' + err.message });
          });
          let t1 = nowMs();
          meta.tasks.push({ name: 'subfinder', duration_minutes: minutesFromMs(t1-t0) });

          // TASK 2: (optional) amass passive
          parentPort.postMessage({ type: 'log', message: '[TASK] About to run amass (passive). Estimated time: ~2.5 minutes' });
          t0 = nowMs();
          const amassOut = path.join(workdir, 'amass.txt');
          await spawnCmd('amass', ['enum', '-passive', '-d', hostname, '-o', amassOut], { timeout: 3 * 60 * 1000 }).catch(err => {
            parentPort.postMessage({ type: 'log', message: '[TASK] amass failed or not present: ' + err.message });
          });
          t1 = nowMs();
          meta.tasks.push({ name: 'amass', duration_minutes: minutesFromMs(t1-t0) });

          // TASK 3: merge lists
          parentPort.postMessage({ type: 'log', message: '[TASK] Merging and deduplicating subdomain lists. Estimated time: ~0.2 minutes' });
          t0 = nowMs();
          const allList = path.join(workdir, 'all.txt');
          // Compose a safe merge: check which files exist, then cat them
          const parts = [];
          try { await fs.access(subfinderOut); parts.push(subfinderOut); } catch(e){}
          try { await fs.access(amassOut); parts.push(amassOut); } catch(e){}
          // If none exist, create an empty all.txt (scan still runs)
          if (parts.length > 0) {
            // Use a node child process to sort -u via shell for simplicity; it's safe as workdir is server-controlled
            await spawnCmd('bash', ['-lc', 'cat ${parts.map(p=>"'"+p.replace(/'/g,"'\\''")+"'").join(' ')} | sort -u > "${allList}"'], { timeout: 30*1000 });
          } else {
            // create empty file
            await fs.writeFile(allList, '');
          }
          t1 = nowMs();
          meta.tasks.push({ name: 'merge', duration_minutes: minutesFromMs(t1-t0) });

          // TASK 4: httpx probe
          parentPort.postMessage({ type: 'log', message: '[TASK] About to run httpx to probe HTTP(s) and collect status codes. Estimated time: ~2.0 minutes' });
          t0 = nowMs();
          const httpxOut = path.join(workdir, 'httpx.jsonl');
          await spawnCmd('httpx', ['-l', allList, '-silent', '-status-code', '-title', '-cl', '-json', '-o', httpxOut], { timeout: 3 * 60 * 1000 }).catch(err => {
            parentPort.postMessage({ type: 'log', message: '[TASK] httpx failed or not present: ' + err.message });
            // Ensure an empty file exists so downstream parsing is predictable
            return fs.writeFile(httpxOut, '');
          });
          t1 = nowMs();
          meta.tasks.push({ name: 'httpx', duration_minutes: minutesFromMs(t1-t0) });

          // TASK 5: parse httpx JSON-lines into array
          parentPort.postMessage({ type: 'log', message: '[TASK] Parsing httpx output into JSON. Estimated time: ~0.05 minutes' });
          t0 = nowMs();
          let jsonLines = [];
          try {
            const raw = await fs.readFile(httpxOut, 'utf8');
            jsonLines = raw.split('\\n').filter(Boolean).map(l => {
              try { return JSON.parse(l); } catch(e) { return { _parseError: true, raw: l }; }
            });
          } catch(e) {
            jsonLines = [];
          }
          t1 = nowMs();
          meta.tasks.push({ name: 'parse_httpx', duration_minutes: minutesFromMs(t1-t0) });

          // TASK 6: save results.json and results.txt and meta.json
          parentPort.postMessage({ type: 'log', message: '[TASK] Saving results and metadata to server. Estimated time: ~0.02 minutes' });
          t0 = nowMs();
          await fs.writeFile(path.join(workdir, 'results.json'), JSON.stringify(jsonLines, null, 2), 'utf8');
          // results.txt: create a human-friendly dump
          const txtLines = jsonLines.map(it => {
            if (it._parseError) return 'PARSE_ERROR: ' + it.raw;
            // Common fields from httpx: url, status_code, title, content_length, ip, timestamp
            return [
              'url: ' + (it.url || it.input || ''),
              'status: ' + (it.status_code || ''),
              'title: ' + (it.title || ''),
              'content_length: ' + (it.content_length || ''),
              'ip: ' + (it.ip || (it.host || '')),
              '---'
            ].join('\\n');
          }).join('\\n');
          await fs.writeFile(path.join(workdir, 'results.txt'), txtLines, 'utf8');
          await fs.writeFile(path.join(workdir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
          t1 = nowMs();
          meta.tasks.push({ name: 'save_results', duration_minutes: minutesFromMs(t1-t0) });

          meta.finishedAt = new Date().toISOString();
          parentPort.postMessage({ type: 'done', meta });
        } catch (err) {
          parentPort.postMessage({ type: 'error', error: err.message || String(err) });
        }
      })();
    `;

    const worker = new Worker(workerCode, {
      eval: true,
      workerData: { jobId, hostname, workdir },
      // Small worker memory limit could be set via resourceLimits if desired
    });

    // Save worker reference
    jobs.set(jobId, { status: 'running', worker });

    worker.on('message', (m) => {
      if (m && m.type === 'log') {
        console.log(m.message);
      } else if (m && m.type === 'done') {
        jobs.set(jobId, { status: 'done', meta: m.meta });
        console.log(`[JOB ${jobId}] done; meta saved.`);
        resolve(m.meta);
      } else if (m && m.type === 'error') {
        jobs.set(jobId, { status: 'failed', error: m.error });
        console.error(`[JOB ${jobId}] worker error:`, m.error);
        reject(new Error(m.error));
      } else {
        // Generic message
        console.log('worker message', m);
      }
    });

    worker.on('error', (err) => {
      jobs.set(jobId, { status: 'failed', error: err.message });
      console.error(`[JOB ${jobId}] worker thread error:`, err);
      reject(err);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        const job = jobs.get(jobId) || {};
        if (job.status !== 'done' && job.status !== 'failed') {
          jobs.set(jobId, { status: 'failed', error: 'worker exited with code ' + code });
          reject(new Error('worker exited with code ' + code));
        }
      }
    });
  });
}

// POST /scan : create job, start worker, return jobId immediately
app.post('/scan', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch (e) {
    return res.status(400).json({ error: 'invalid url' });
  }

  if (!validateHostname(hostname)) {
    return res.status(400).json({ error: 'invalid hostname' });
  }

  const jobId = randomBytes(6).toString('hex');
  const workdir = path.join(SCANS_DIR, `scan-${jobId}`);
  // Create directory synchronously to ensure it exists before worker runs
  try { fsSync.mkdirSync(workdir, { recursive: true }); } catch(e){}

  // mark queued then start worker
  jobs.set(jobId, { status: 'queued' });

  // Start worker (don't wait) but attach handlers via the startScanWorker promise
  startScanWorker({ jobId, hostname, workdir })
    .then((meta) => {
      // already handled in worker message; nothing else needed here
    })
    .catch((err) => {
      console.error('worker finished with error for job', jobId, err);
    });

  return res.json({ jobId, message: 'scan started' });
});

// GET /status/:jobId -> return job status and meta if available
app.get('/status/:jobId', async (req, res) => {
  const { jobId } = req.params;
  if (!jobs.has(jobId)) {
    // maybe folder exists; try to return meta.json if present
    const workdir = path.join(SCANS_DIR, `scan-${jobId}`);
    const metaFile = path.join(workdir, 'meta.json');
    try {
      const raw = await fs.readFile(metaFile, 'utf8');
      const meta = JSON.parse(raw);
      return res.json({ jobId, status: 'done', meta });
    } catch (e) {
      return res.status(404).json({ error: 'job not found' });
    }
  }
  const job = jobs.get(jobId);
  return res.json({ jobId, status: job.status, error: job.error || null, meta: job.meta || null });
});

// GET /download/:jobId -> download results.txt
app.get('/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const workdir = path.join(SCANS_DIR, `scan-${jobId}`);
  const file = path.join(workdir, 'results.txt');
  fs.access(file)
    .then(() => {
      res.download(file, `results-${jobId}.txt`, (err) => {
        if (err) {
          console.error('download error', err);
          // don't expose internal details
          if (!res.headersSent) res.status(500).end('download failed');
        }
      });
    })
    .catch(() => res.status(404).json({ error: 'results not found' }));
});

// DELETE /results/:jobId -> delete folder
app.delete('/results/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const workdir = path.join(SCANS_DIR, `scan-${jobId}`);

  // If running, attempt to terminate worker
  const job = jobs.get(jobId);
  if (job && job.worker) {
    try {
      job.worker.terminate();
    } catch (e) {
      console.warn('failed to terminate worker', e);
    }
  }
  // Remove directory
  try {
    await fs.rm(workdir, { recursive: true, force: true });
    jobs.delete(jobId);
    return res.json({ jobId, deleted: true });
  } catch (e) {
    console.error('delete error', e);
    return res.status(500).json({ error: 'failed to delete' });
  }
});

app.get('/status/health', (req, res) => {
  res.json({ ok: true });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(\`listening on :\${PORT}\`));
