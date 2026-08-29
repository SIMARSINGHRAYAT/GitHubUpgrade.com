import moment from 'moment';

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const origin = res.req?.headers?.origin || '*';
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    ...extraHeaders,
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
    const base64 = cookieValue.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (error) {
    return null;
  }
}

function setSessionCookie(res, user) {
  const session = Buffer.from(JSON.stringify(user)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  res.setHeader('Set-Cookie', `gh_session=${session}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=86400`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'gh_session=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0');
}

function resolveGitHubIdentity(user = {}, env = process.env) {
  const login = user.login || env.GITHUB_LOGIN || 'github-user';
  const id = user.id || null;
  const email = user.email || env.GITHUB_EMAIL || (id ? `${id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`);
  const accessToken = user.accessToken || env.GITHUB_TOKEN || null;
  const repoOwner = user.repoOwner || env.REPO_OWNER || login;
  const repoName = user.repoName || env.REPO_NAME || 'APP_Commit';

  return { login, id, email, accessToken, repoOwner, repoName };
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'GitHubUpgrade.com',
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
  let email = null;
  try {
    const emailList = await fetchJson('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const primary = Array.isArray(emailList)
      ? emailList.find((entry) => entry.primary && entry.verified) || emailList.find((entry) => entry.verified)
      : null;
    email = primary ? primary.email : null;
  } catch (error) {
    email = null;
  }

  email = email || user.email || null;
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
      fork: repoData.fork,
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

async function getRequestBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (!req.body && req.readableEnded === true) {
    return {};
  }

  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        try {
          const params = new URLSearchParams(raw);
          resolve(Object.fromEntries(params.entries()));
        } catch {
          resolve({});
        }
      }
    });
    req.on('error', reject);
  });
}

async function listUserRepos(token) {
  const repos = await fetchJson('https://api.github.com/user/repos?per_page=100&sort=updated', {
    headers: { Authorization: `Bearer ${token}` },
  });

  return (Array.isArray(repos) ? repos : []).map((repo) => ({
    name: repo.name,
    private: repo.private,
    defaultBranch: repo.default_branch,
    fullName: repo.full_name,
  }));
}

export default async function handler(req, res) {
  res.req = req;

  const host = req.headers.host || 'localhost:3000';
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${protocol}://${host}`;
  const pathname = new URL(req.url || '/', `${baseUrl}`).pathname;

  if (req.method === 'OPTIONS') {
    sendJson(res, 200, { success: true }, {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return;
  }

  try {
    if (pathname === '/api/auth/configured') {
      const missing = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'].filter((key) => !process.env[key]);
      sendJson(res, 200, {
        success: true,
        configured: missing.length === 0,
        missing,
      });
      return;
    }

    if (pathname === '/api/auth/status') {
      const user = await getCurrentUser(req);
      if (!user) {
        sendJson(res, 401, { success: false, message: 'GitHub sign-in is required.' });
        return;
      }

      sendJson(res, 200, { success: true, user });
      return;
    }

    if (pathname === '/api/auth/logout') {
      clearSessionCookie(res);
      sendJson(res, 200, { success: true, message: 'Signed out.' });
      return;
    }

    if (pathname === '/api/auth/login') {
      const clientId = process.env.GITHUB_CLIENT_ID;
      if (!clientId) {
        sendJson(res, 500, { success: false, message: 'GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.' });
        return;
      }

      const callbackUrl = `${baseUrl}/api/auth/callback`;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        scope: 'read:user user:email repo',
        state: 'app-commit-auth',
      });

      res.writeHead(302, {
        Location: `https://github.com/login/oauth/authorize?${params.toString()}`,
      });
      res.end();
      return;
    }

    if (pathname === '/api/auth/callback') {
      const url = new URL(req.url || '/', `${baseUrl}`);
      const code = url.searchParams.get('code');
      const errorParam = url.searchParams.get('error');

      if (errorParam) {
        res.writeHead(302, { Location: '/auth.html?error=' + encodeURIComponent(errorParam) });
        res.end();
        return;
      }

      if (!code) {
        res.writeHead(302, { Location: '/auth.html?error=' + encodeURIComponent('Missing GitHub OAuth code.') });
        res.end();
        return;
      }

      const accessToken = await exchangeCodeForToken(code);
      const gitHubUser = await getGitHubUserFromToken(accessToken);
      setSessionCookie(res, {
        ...gitHubUser,
        accessToken,
      });

      res.writeHead(302, { Location: '/auth.html' });
      res.end();
      return;
    }

    if (pathname === '/api/repos') {
      const user = await getCurrentUser(req);
      if (!user || !user.accessToken) {
        sendJson(res, 401, { success: false, message: 'GitHub sign-in is required.' });
        return;
      }

      const repos = await listUserRepos(user.accessToken);
      sendJson(res, 200, { success: true, repos });
      return;
    }

    if (pathname === '/api/validate-repo') {
      const user = await getCurrentUser(req);
      if (!user || !user.accessToken) {
        sendJson(res, 401, { success: false, message: 'GitHub sign-in is required.' });
        return;
      }

      const body = await getRequestBody(req);
      const repoOwner = String(body.repoOwner || user.login || '').trim();
      const repoName = String(body.repoName || '').trim();

      if (!repoOwner || !repoName) {
        sendJson(res, 400, { success: false, message: 'Repository owner and name are required.' });
        return;
      }

      const repoCheck = await validateRepo(repoOwner, repoName, user.accessToken);
      if (!repoCheck.exists) {
        sendJson(res, 404, { success: false, valid: false, message: repoCheck.message });
        return;
      }

      const canPush = Boolean(repoCheck.permissions && repoCheck.permissions.push === true);
      sendJson(res, 200, {
        success: true,
        valid: true,
        canPush,
        defaultBranch: repoCheck.defaultBranch,
        message: canPush ? 'Repository access verified.' : 'Repository exists but write access is unavailable.',
      });
      return;
    }

    if (pathname === '/api/generate') {
      const user = await getCurrentUser(req);
      if (!user || !user.accessToken) {
        sendJson(res, 401, { success: false, message: 'GitHub sign-in is required.' });
        return;
      }

      sendJson(res, 501, {
        success: false,
        message: 'Commit generation is not enabled in this local build. Re-enable the generation backend in the deployed app to create commits.',
      });
      return;
    }

    if (pathname === '/api/health') {
      sendJson(res, 200, { success: true, ok: true, ts: Date.now() });
      return;
    }

    sendJson(res, 404, { success: false, message: 'Route not found.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected server error.';
    sendJson(res, 500, { success: false, message });
  }
}

export { fetchJson, validateRepo, getCurrentUser, resolveGitHubIdentity };
