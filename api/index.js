import moment from 'moment';

function sendJson(res, statusCode, payload) {
  const origin = res.req?.headers?.origin || '*';
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  });
  res.end(JSON.stringify(payload));
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return index === -1 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function decodeSessionCookie(req) {
  const cookieValue = parseCookies(req).gh_session;
  if (!cookieValue) return null;

  try {
    return JSON.parse(Buffer.from(cookieValue, 'base64url').toString('utf8'));
  } catch (error) {
    return null;
  }
}

function setSessionCookie(res, user) {
  const session = Buffer.from(JSON.stringify(user)).toString('base64url');
  // Use SameSite=None; Secure to allow the extension to send the cookie cross-origin
  res.setHeader('Set-Cookie', `gh_session=${session}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=86400`);
}

function resolveGitHubIdentity(user = {}, env = process.env) {
  const login = user.login || env.GITHUB_LOGIN || 'github-user';
  const id = user.id || null;
  // GitHub requires the ID-based noreply email for contribution graph attribution
  const email = user.email || env.GITHUB_EMAIL || (id ? `${id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`);
  const accessToken = user.accessToken || env.GITHUB_TOKEN || null;
  const repoOwner = user.repoOwner || env.REPO_OWNER || login;
  const repoName = user.repoName || env.REPO_NAME || 'APP_Commit';

  return { login, id, email, accessToken, repoOwner, repoName };
}

// ─── Enhanced fetch with contextual error messages ──────────────────────────

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'GitHubUpgrade',
      ...(init.headers || {}),
    },
  });

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();

  if (!response.ok) {
    const detail = typeof payload === 'string' ? payload : payload.message || '';
    const urlPath = new URL(url).pathname;
    const statusText = response.status === 404
      ? `Not found: ${urlPath}`
      : response.status === 422
        ? `Validation failed for ${urlPath}: ${detail}`
        : response.status === 409
          ? `Conflict (SHA mismatch) on ${urlPath}: ${detail}`
          : `GitHub API error ${response.status} on ${urlPath}: ${detail}`;
    const error = new Error(statusText);
    error.status = response.status;
    error.detail = detail;
    throw error;
  }

  return payload;
}

// ─── Auth helpers ───────────────────────────────────────────────────────────

async function getCurrentUser(req) {
  const sessionUser = decodeSessionCookie(req);
  if (sessionUser) {
    return resolveGitHubIdentity(sessionUser, process.env);
  }
  return null;
}

async function getGitHubUserFromToken(accessToken) {
  const user = await fetchJson('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const userId = user.id;
  let email = user.email || null;
  if (!email) {
    try {
      const emailList = await fetchJson('https://api.github.com/user/emails', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const primary = Array.isArray(emailList)
        ? emailList.find((entry) => entry.primary && entry.verified) || emailList.find((entry) => entry.verified)
        : null;
      email = primary ? primary.email : null;
    } catch (e) {
      // user:email scope might not be available, that's ok
      email = null;
    }
  }

  // If we still don't have an email, use the GitHub ID-based noreply format
  // This is CRITICAL for the contribution graph to work
  if (!email) {
    email = `${userId}+${user.login}@users.noreply.github.com`;
  }

  return { login: user.login, id: userId, email, accessToken };
}

async function exchangeCodeForToken(code) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
  });

  const tokenResponse = await fetchJson(`https://github.com/login/oauth/access_token?${params.toString()}`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });

  if (!tokenResponse.access_token) {
    throw new Error('GitHub OAuth token exchange did not return an access token.');
  }

  return tokenResponse.access_token;
}

// ─── Repository & branch validation ────────────────────────────────────────

async function validateRepo(owner, repo, token) {
  try {
    const repoData = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return {
      exists: true,
      fullName: repoData.full_name,
      defaultBranch: repoData.default_branch,
      permissions: repoData.permissions || {},
      private: repoData.private,
    };
  } catch (error) {
    if (error.status === 404) {
      return { exists: false, message: `Repository "${owner}/${repo}" was not found. Check the owner and name, or make sure your GitHub token has access to it.` };
    }
    if (error.status === 403) {
      return { exists: false, message: `Access denied to "${owner}/${repo}". Your GitHub token may lack the required permissions.` };
    }
    throw error;
  }
}

async function ensureBranchExists(owner, repo, branch, token) {
  // Check if the branch already exists
  try {
    const ref = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { exists: true, sha: ref.object.sha };
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  // Branch doesn't exist — try to create it from the default branch
  try {
    const repoData = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const defaultBranch = repoData.default_branch || 'main';

    const defaultRef = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const newRef = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        ref: `refs/heads/${branch}`,
        sha: defaultRef.object.sha,
      }),
    });

    return { exists: true, created: true, sha: newRef.object.sha };
  } catch (createError) {
    throw new Error(`Branch "${branch}" does not exist and could not be created: ${createError.message}`);
  }
}

// ─── Date/time helpers ──────────────────────────────────────────────────────

function getDayName(date) {
  const value = moment.isMoment(date) ? date : moment(date);
  return value.format('dddd').toLowerCase();
}

function isDateSelected(date, payload) {
  const safeDate = moment.isMoment(date) ? date : moment(date);
  const mode = payload.filterMode || 'all';
  const selectedDays = Array.isArray(payload.selectedDays) ? payload.selectedDays.map((d) => d.toLowerCase()) : [];
  const dayName = getDayName(safeDate);
  const dayNumber = safeDate.date();

  if (mode === 'odd') return dayNumber % 2 === 1;
  if (mode === 'even') return dayNumber % 2 === 0;
  if (mode === 'weekends') return ['saturday', 'sunday'].includes(dayName);
  if (mode === 'weekdays') return !['saturday', 'sunday'].includes(dayName);
  if (mode === 'selected') return selectedDays.includes(dayName);
  return true;
}

function resolveDailyCount(date, payload) {
  const safeDate = moment.isMoment(date) ? date : moment(date);
  const weekdayMap = payload.weekdayCounts || {};
  const weekdayKey = getDayName(safeDate);
  const baseCount = Number(payload.dailyCount || 1);

  if (weekdayMap[weekdayKey] !== undefined && Number(weekdayMap[weekdayKey]) >= 0) {
    return Number(weekdayMap[weekdayKey]);
  }

  if (payload.randomize) {
    const max = Number(payload.maxPerDay || baseCount || 1);
    const min = Math.min(1, max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  return baseCount;
}

function buildDateWindow(startDate, endDate) {
  const start = moment(startDate, 'YYYY-MM-DD');
  const end = moment(endDate, 'YYYY-MM-DD');

  if (!start.isValid() || !end.isValid()) {
    throw new Error('Please choose a valid start date and end date.');
  }

  if (end.isBefore(start)) {
    throw new Error('The end date must be after the start date.');
  }

  const dates = [];
  let current = start.clone();
  while (current.isSameOrBefore(end)) {
    dates.push(current.clone());
    current.add(1, 'day');
  }
  return dates;
}

function spreadTimesForDay(date, count) {
  const start = moment(date).hour(9).minute(0).second(0).millisecond(0);
  const end = moment(date).hour(20).minute(0).second(0).millisecond(0);

  if (count <= 1) return [start.clone()];

  const diffMinutes = end.diff(start, 'minutes');
  const step = diffMinutes / (count - 1);
  const times = [];

  for (let i = 0; i < count; i += 1) {
    times.push(start.clone().add(Math.round(step * i), 'minutes'));
  }

  return times;
}

// ─── Git Database API operations (True Backdating) ──────────

async function getBranchRef(owner, repo, branch, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`;
  const data = await fetchJson(url, { headers: { Authorization: `Bearer ${token}` } });
  return data.object.sha;
}

async function getCommit(owner, repo, commitSha, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/commits/${commitSha}`;
  return fetchJson(url, { headers: { Authorization: `Bearer ${token}` } });
}

async function createBlob(owner, repo, content, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/blobs`;
  const data = await fetchJson(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content, encoding: 'utf-8' }),
  });
  return data.sha;
}

async function createTree(owner, repo, baseTreeSha, path, blobSha, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees`;
  const data = await fetchJson(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: [
        {
          path,
          mode: '100644',
          type: 'blob',
          sha: blobSha,
        },
      ],
    }),
  });
  return data.sha;
}

async function createGitCommit({ owner, repo, message, treeSha, parentSha, author, token }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/commits`;
  const payload = {
    message,
    tree: treeSha,
    parents: [parentSha],
    author,
    committer: author,
  };
  const data = await fetchJson(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  return data.sha;
}

async function updateBranchRef(owner, repo, branch, commitSha, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`;
  await fetchJson(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sha: commitSha, force: false }),
  });
}

// ─── Core commit generation ─────────────────────────────────────────────────

async function generateCommits(payload, req) {
  const user = await getCurrentUser(req);
  if (!user) {
    throw new Error('GitHub sign-in is required before generating commits.');
  }

  const startDate = payload.startDate;
  const endDate = payload.endDate;
  const dailyCount = Number(payload.dailyCount || 1);
  const pushToRemote = Boolean(payload.pushToRemote);
  const branchName = (payload.branch || 'main').toString().trim() || 'main';
  const repoOwner = payload.repoOwner?.trim() || user.repoOwner || user.login;
  const repoName = payload.repoName?.trim() || user.repoName || 'APP_Commit';
  const token = user.accessToken;

  if (!token) {
    throw new Error('GitHub OAuth token is missing. Sign in again and grant repository access.');
  }

  if (!startDate || !endDate) {
    throw new Error('Please choose a valid start date and end date.');
  }

  if (!Number.isInteger(dailyCount) || dailyCount < 1) {
    throw new Error('Daily commit count must be a whole number greater than zero.');
  }

  // ── Validate repo & branch before starting ────────────────────────────
  if (pushToRemote) {
    const repoCheck = await validateRepo(repoOwner, repoName, token);
    if (!repoCheck.exists) {
      throw new Error(repoCheck.message);
    }
    if (repoCheck.permissions && !repoCheck.permissions.push) {
      throw new Error(`You don't have write access to "${repoOwner}/${repoName}". Make sure you are a collaborator or owner.`);
    }

    await ensureBranchExists(repoOwner, repoName, branchName, token);
  }

  const selectedDates = buildDateWindow(startDate, endDate).filter((date) => isDateSelected(date, payload));
  if (!selectedDates.length) {
    throw new Error('No days match your selected filter.');
  }

  const created = [];
  let totalCount = 0;
  const commitLogPath = 'commit-log.json';

  let currentCommitSha = null;
  let currentTreeSha = null;
  let currentLogEntries = [];

  if (pushToRemote) {
    currentCommitSha = await getBranchRef(repoOwner, repoName, branchName, token);
    const commitData = await getCommit(repoOwner, repoName, currentCommitSha, token);
    currentTreeSha = commitData.tree.sha;

    // Try to fetch existing log file to append to it
    try {
      const fileUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${encodeURIComponent(commitLogPath)}?ref=${encodeURIComponent(branchName)}`;
      const file = await fetchJson(fileUrl, { headers: { Authorization: `Bearer ${token}` } });
      const content = Buffer.from(file.content, 'base64').toString('utf8');
      currentLogEntries = JSON.parse(content);
    } catch (e) {
      currentLogEntries = []; // File doesn't exist or is invalid
    }
  }

  for (const selectedDate of selectedDates) {
    const countForDay = resolveDailyCount(selectedDate, payload);
    const times = spreadTimesForDay(selectedDate, countForDay);

    for (const commitTime of times) {
      totalCount += 1;
      const message = `Auto commit ${totalCount} — ${commitTime.format('YYYY-MM-DD HH:mm')}`;

      if (pushToRemote) {
        currentLogEntries.push({
          commitNumber: totalCount,
          date: commitTime.format('YYYY-MM-DD'),
          time: commitTime.format('HH:mm'),
          message,
          author: { name: user.login, email: user.email },
          branch: branchName,
        });
        const content = JSON.stringify(currentLogEntries, null, 2) + '\n';

        const blobSha = await createBlob(repoOwner, repoName, content, token);
        currentTreeSha = await createTree(repoOwner, repoName, currentTreeSha, commitLogPath, blobSha, token);
        
        const authorInfo = {
          name: user.login,
          email: user.email,
          date: commitTime.toISOString()
        };
        
        currentCommitSha = await createGitCommit({
          owner: repoOwner,
          repo: repoName,
          message,
          treeSha: currentTreeSha,
          parentSha: currentCommitSha,
          author: authorInfo,
          token
        });
      }

      created.push({
        number: totalCount,
        date: commitTime.format('YYYY-MM-DD'),
        time: commitTime.format('HH:mm'),
        message,
      });
    }
  }

  if (pushToRemote && totalCount > 0) {
    await updateBranchRef(repoOwner, repoName, branchName, currentCommitSha, token);
  }

  return {
    success: true,
    branch: branchName,
    repoOwner,
    repoName,
    startDate,
    endDate,
    selectedDays: selectedDates.length,
    commitsCreated: totalCount,
    pushToRemote,
    pushResult: {
      enabled: pushToRemote,
      status: pushToRemote ? 'success' : 'skipped',
      message: pushToRemote
        ? `${totalCount} commit(s) successfully created on ${repoOwner}/${repoName} (${branchName}).`
        : 'Dry-run mode — no commits were pushed to GitHub. Enable "Push to remote" to create real commits.',
    },
    created,
  };
}

// ─── Body parser ────────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

// ─── Request handler ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 200, { success: true });
    return;
  }

  const url = new URL(req.url, 'https://example.com');
  const normalizedPath = url.pathname.replace(/^\/api/, '');
  console.log('API request', req.method, 'req.url=', req.url, 'pathname=', url.pathname, 'normalized=', normalizedPath);

  // Attach req to res so sendJson can access headers.origin
  res.req = req;

  // ── Auth routes ─────────────────────────────────────────────────────────

  if (req.method === 'GET' && normalizedPath === '/auth/status') {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        throw new Error('Not authenticated.');
      }
      sendJson(res, 200, { success: true, user });
    } catch (error) {
      sendJson(res, 401, { success: false, message: error.message });
    }
    return;
  }

  if (req.method === 'GET' && normalizedPath === '/auth/configured') {
    const configured = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
    const missing = [];
    if (!process.env.GITHUB_CLIENT_ID) missing.push('GITHUB_CLIENT_ID');
    if (!process.env.GITHUB_CLIENT_SECRET) missing.push('GITHUB_CLIENT_SECRET');
    sendJson(res, 200, { success: true, configured, missing });
    return;
  }

  if (req.method === 'GET' && normalizedPath === '/auth/login') {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>GitHub OAuth Not Configured</title><style>body{margin:0;font-family:Inter,sans-serif;background:#081222;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px;}div{max-width:520px;}a{color:#6ee7f9;text-decoration:none;font-weight:700;}</style></head><body><div><h1>GitHub OAuth is not configured</h1><p>This deployment is missing required GitHub OAuth environment variables. Set <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> in Vercel to enable login.</p><p><a href="/">Return to the app</a></p></div></body></html>`);
      return;
    }

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host || 'localhost:3000';
    const baseUrl = process.env.APP_BASE_URL || `${protocol}://${host}`;
    const redirectUri = encodeURIComponent(`${baseUrl}/api/auth/callback`);
    const loginUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=repo%20read:user%20user:email`;
    res.writeHead(302, { Location: loginUrl });
    res.end();
    return;
  }

  if (req.method === 'GET' && normalizedPath === '/auth/callback') {
    try {
      const code = url.searchParams.get('code');
      if (!code) {
        throw new Error('GitHub authorization code was not received.');
      }
      const accessToken = await exchangeCodeForToken(code);
      const user = await getGitHubUserFromToken(accessToken);
      setSessionCookie(res, user);
      res.writeHead(302, { Location: '/extension/index.html' });
      res.end();
    } catch (error) {
      sendJson(res, 400, { success: false, message: error.message || 'GitHub login failed.' });
    }
    return;
  }

  if (req.method === 'GET' && normalizedPath === '/auth/logout') {
    res.setHeader('Set-Cookie', 'gh_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    sendJson(res, 200, { success: true, message: 'Signed out.' });
    return;
  }

  // ── Repo validation endpoint ────────────────────────────────────────────

  if (req.method === 'POST' && normalizedPath === '/validate-repo') {
    try {
      const user = await getCurrentUser(req);
      if (!user || !user.accessToken) {
        sendJson(res, 401, { success: false, message: 'Sign in first.' });
        return;
      }
      const payload = await parseBody(req);
      const owner = payload.repoOwner?.trim() || user.login;
      const repo = payload.repoName?.trim();

      if (!repo) {
        sendJson(res, 400, { success: false, message: 'Repository name is required.' });
        return;
      }

      const repoCheck = await validateRepo(owner, repo, user.accessToken);
      if (!repoCheck.exists) {
        sendJson(res, 200, { success: true, valid: false, message: repoCheck.message });
        return;
      }

      sendJson(res, 200, {
        success: true,
        valid: true,
        fullName: repoCheck.fullName,
        defaultBranch: repoCheck.defaultBranch,
        canPush: Boolean(repoCheck.permissions.push),
        private: repoCheck.private,
      });
    } catch (error) {
      sendJson(res, 500, { success: false, message: error.message });
    }
    return;
  }

  // ── List user repos endpoint ────────────────────────────────────────────

  if (req.method === 'GET' && normalizedPath === '/repos') {
    try {
      const user = await getCurrentUser(req);
      if (!user || !user.accessToken) {
        sendJson(res, 401, { success: false, message: 'Sign in first.' });
        return;
      }

      const repos = await fetchJson('https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator', {
        headers: { Authorization: `Bearer ${user.accessToken}` },
      });

      const repoList = repos.map((r) => ({
        fullName: r.full_name,
        name: r.name,
        owner: r.owner.login,
        defaultBranch: r.default_branch,
        private: r.private,
      }));

      sendJson(res, 200, { success: true, repos: repoList });
    } catch (error) {
      sendJson(res, 500, { success: false, message: error.message });
    }
    return;
  }

  // ── Commit generation ───────────────────────────────────────────────────

  if (req.method === 'POST' && normalizedPath === '/generate') {
    try {
      const payload = await parseBody(req);
      const result = await generateCommits(payload, req);
      sendJson(res, 200, result);
    } catch (error) {
      const statusCode = error.status || 400;
      sendJson(res, statusCode, { success: false, message: error.message || 'Failed to generate the commit schedule.' });
    }
    return;
  }

  sendJson(res, 404, { success: false, message: 'Route not found.' });
}
