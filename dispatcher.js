// dispatcher.js – StreamVault Dispatcher v2.0
//
// Gere 2 contas GitHub Actions em round-robin.
// Substitui apenas o processQueue/processJob do server.js —
// todas as rotas e lógica do server.js ficam intactas.
//
// VARS DE AMBIENTE (.env — mesmo ficheiro do server.js):
//   DISPATCHER_PORT      — porta do dispatcher (default: 3002)
//   GH_WORKFLOW_FILE     — nome do workflow (default: process.yml)
//   GH_WORKFLOW_REF      — branch (default: main)
//
//   Conta 1:
//   GH_ACCOUNT_1_TOKEN   — PAT (scope: repo, workflow)
//   GH_ACCOUNT_1_OWNER   — username
//   GH_ACCOUNT_1_REPO    — repo com o process.yml
//
//   Conta 2:
//   GH_ACCOUNT_2_TOKEN
//   GH_ACCOUNT_2_OWNER
//   GH_ACCOUNT_2_REPO

import 'dotenv/config';
import express from 'express';

const app  = express();
app.use(express.json({ limit: '1mb' }));

const PORT          = parseInt(process.env.PORT || process.env.DISPATCHER_PORT || '3002');
const WORKFLOW_FILE = process.env.GH_WORKFLOW_FILE || 'process.yml';
const WORKFLOW_REF  = process.env.GH_WORKFLOW_REF  || 'main';
const ADMIN_KEY     = process.env.ADMIN_API_KEY    || '';

// ── Carregar contas ──────────────────────────────────────────────────────────
function loadAccounts() {
  const accounts = [];
  let n = 1;
  while (true) {
    const token = process.env[`GH_ACCOUNT_${n}_TOKEN`];
    const owner = process.env[`GH_ACCOUNT_${n}_OWNER`];
    const repo  = process.env[`GH_ACCOUNT_${n}_REPO`];
    if (!token || !owner || !repo) break;
    accounts.push({ id: n, token, owner, repo, activeJobs: 0, lastUsed: null });
    n++;
  }
  return accounts;
}

const accounts = loadAccounts();
if (accounts.length === 0) {
  console.error('ERRO: Nenhuma conta GitHub configurada.');
  process.exit(1);
}

// ── Round-robin — conta com menos jobs activos, desempate por lastUsed ───────
function selectAccount() {
  return [...accounts].sort((a, b) => {
    if (a.activeJobs !== b.activeJobs) return a.activeJobs - b.activeJobs;
    const at = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
    const bt = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
    return at - bt;
  })[0];
}

// ── GitHub API ───────────────────────────────────────────────────────────────
function ghFetch(url, token, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: {
      'Authorization':        `Bearer ${token}`,
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent':           'StreamVault-Dispatcher/2.0',
      ...(opts.headers || {}),
    },
  });
}

async function triggerWorkflow(account, inputs) {
  return ghFetch(
    `https://api.github.com/repos/${account.owner}/${account.repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    account.token,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ref: WORKFLOW_REF, inputs }),
    }
  );
}

async function cancelRun(account, runId) {
  return ghFetch(
    `https://api.github.com/repos/${account.owner}/${account.repo}/actions/runs/${runId}/cancel`,
    account.token,
    { method: 'POST' }
  );
}

// ── Job store ────────────────────────────────────────────────────────────────
const jobStore = new Map();

// ── Auth middleware ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  if (!ADMIN_KEY) return next();
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── POST /dispatch ───────────────────────────────────────────────────────────
// Chamado pelo server.js em substituição do processJob local.
// Body: { job_id, video_url?, seg_duration?, max_encode_height?,
//          warm_concurrency?, metadata? }
app.post('/dispatch', auth, async (req, res) => {
  const {
    job_id,
    video_url         = '',
    seg_duration      = '4',
    max_encode_height = '720',
    warm_concurrency  = '8',
    metadata          = {},
  } = req.body;

  if (!job_id) return res.status(400).json({ error: 'job_id obrigatório' });
  if (jobStore.has(job_id)) return res.status(409).json({ error: 'Job já existe' });

  const account = selectAccount();

  const inputs = {
    job_id,
    video_url,
    seg_duration:      String(seg_duration),
    max_encode_height: String(max_encode_height),
    warm_concurrency:  String(warm_concurrency),
    metadata: typeof metadata === 'string' ? metadata : JSON.stringify(metadata),
  };

  try {
    const r = await triggerWorkflow(account, inputs);
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: `GitHub dispatch falhou (${r.status})`, details: t.slice(0,300) });
    }

    account.activeJobs++;
    account.lastUsed = new Date().toISOString();

    jobStore.set(job_id, {
      jobId:        job_id,
      accountId:    account.id,
      accountOwner: account.owner,
      status:       'dispatched',
      dispatchedAt: new Date().toISOString(),
      inputs,
    });

    console.log(`[DISPATCH] job=${job_id} → ${account.owner} (active=${account.activeJobs})`);
    res.json({ ok: true, job_id, account: account.owner, account_id: account.id });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /webhook — callback do Actions quando job termina ───────────────────
app.post('/webhook', async (req, res) => {
  const { job_id, status } = req.body;
  if (!job_id) return res.status(400).json({ error: 'job_id obrigatório' });

  const job = jobStore.get(job_id);
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });

  job.status      = status || 'done';
  job.completedAt = new Date().toISOString();
  job.result      = req.body;

  const account = accounts.find(a => a.id === job.accountId);
  if (account && account.activeJobs > 0) account.activeJobs--;

  console.log(`[WEBHOOK] job=${job_id} status=${status} conta=${account?.owner}`);
  res.json({ ok: true });
});

// ── DELETE /jobs/:jobId — cancelar job ───────────────────────────────────────
app.delete('/jobs/:jobId', auth, async (req, res) => {
  const job = jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });

  const account = accounts.find(a => a.id === job.accountId);
  if (account && job.runId) {
    try { await cancelRun(account, job.runId); } catch {}
  }

  job.status = 'cancelled';
  if (account && account.activeJobs > 0) account.activeJobs--;
  res.json({ ok: true });
});

// ── GET /status ──────────────────────────────────────────────────────────────
app.get('/status', auth, (_, res) => {
  res.json({
    accounts: accounts.map(a => ({
      id: a.id, owner: a.owner, repo: a.repo,
      activeJobs: a.activeJobs, lastUsed: a.lastUsed,
    })),
    jobs: [...jobStore.values()],
  });
});

// ── GET /health ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({
    ok: true,
    accounts: accounts.length,
    active_jobs: accounts.reduce((s,a) => s + a.activeJobs, 0),
    workflow: `${WORKFLOW_FILE}@${WORKFLOW_REF}`,
  });
});

// ── Keep-alive — evita que o Render (free tier) adormeça ────────────────────
// Faz self-ping ao /health a cada 14 minutos (Render dorme após 15min idle).
// Activo se RENDER=true (injectado automaticamente) ou KEEP_ALIVE=true no .env.
function startKeepAlive(port) {
  const interval = 14 * 60 * 1000; // 14 minutos
  const selfUrl  = process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL}/health`
    : `http://localhost:${port}/health`;

  setInterval(async () => {
    try {
      const res = await fetch(selfUrl);
      console.log(`[keep-alive] ping → ${res.status} (${new Date().toISOString()})`);
    } catch (e) {
      console.warn(`[keep-alive] ping falhou: ${e.message}`);
    }
  }, interval);

  console.log(`  ✓ Keep-alive activo — ping cada 14min → ${selfUrl}`);
}

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`StreamVault Dispatcher v2.0 — porta ${PORT}`);
  accounts.forEach(a => console.log(`  ✓ Conta ${a.id}: ${a.owner}/${a.repo}`));

  if (process.env.RENDER || process.env.KEEP_ALIVE === 'true') {
    startKeepAlive(PORT);
  }
});
