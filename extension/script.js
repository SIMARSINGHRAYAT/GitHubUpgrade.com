const REMOTE_BASE_URL = 'https://app-commit-ten.vercel.app';
const BASE_URL = window.location.protocol === 'file:' || window.location.origin.startsWith('chrome-extension:')
  ? REMOTE_BASE_URL
  : window.location.origin;

// Intercept fetch calls to redirect /api to the remote Vercel backend
const originalFetch = window.fetch;
window.fetch = async function() {
  let [resource, config] = arguments;
  if (typeof resource === 'string' && resource.startsWith('/api')) {
    resource = BASE_URL + resource;
    config = config || {};
    config.credentials = 'include';
  }
  return originalFetch(resource, config);
};

const schedulerPanel = document.getElementById("schedulerPanel");
const userSummary = document.getElementById("userSummary");
const signOutBtn = document.getElementById("signOutBtn");
const form = document.getElementById("commitForm");
const resultBox = document.getElementById("result");
const filterMode = document.getElementById("filterMode");
const selectedDaysPanel = document.getElementById("selectedDays");
const repoOwnerInput = document.getElementById("repoOwner");
const repoNameInput = document.getElementById("repoName");
const submitBtn = form ? form.querySelector("button[type='submit']") : null;
const randomizeInput = document.getElementById('randomize');

let currentUser = null;
let userRepos = [];

function setSignedOutState(message) {
  currentUser = null;
  userRepos = [];
  window.location.replace('/auth.html');
}

function setSignedInState(user) {
  currentUser = user;
  signOutBtn.style.display = 'inline-flex';
  document.body.classList.add('dashboard-ready');
  schedulerPanel.classList.remove('hidden');
  userSummary.textContent = user.login || 'GitHub account';

  // Auto-fill repo owner from the authenticated user
  if (repoOwnerInput && !repoOwnerInput.value) {
    repoOwnerInput.value = user.login || '';
    repoOwnerInput.placeholder = user.login || 'your GitHub username';
  }

  fetchRepos();
}

async function fetchRepos() {
  if (repoNameInput.tagName !== 'SELECT') return;
  
  repoNameInput.innerHTML = '<option value="" disabled selected>Loading repositories...</option>';
  try {
    const response = await fetch('/api/repos');
    const data = await response.json();
    if (data.success && data.repos) {
      userRepos = data.repos;
      repoNameInput.innerHTML = '<option value="" disabled selected>Select a repository</option>';
      userRepos.forEach(repo => {
        const option = document.createElement('option');
        option.value = repo.name;
        option.textContent = repo.name + (repo.private ? ' (Private)' : '');
        repoNameInput.appendChild(option);
      });
    } else {
      repoNameInput.innerHTML = '<option value="" disabled selected>Failed to load repos</option>';
    }
  } catch (err) {
    repoNameInput.innerHTML = '<option value="" disabled selected>Error loading repos</option>';
  }
}

if (repoNameInput && repoNameInput.tagName === 'SELECT') {
  repoNameInput.addEventListener('change', () => {
    const selected = userRepos.find(r => r.name === repoNameInput.value);
    if (selected && selected.defaultBranch) {
      document.getElementById('branch').value = selected.defaultBranch;
    }
  });
}

function showInlineMessage(message) {
  resultBox.classList.remove('hidden');
  resultBox.className = 'result result-error';
  resultBox.textContent = message;
}

async function checkGitHubConfig() {
  try {
    const response = await fetch('/api/auth/configured');
    const data = await response.json();
    if (!response.ok || !data.success) {
      return { configured: false, missing: [] };
    }
    return { configured: data.configured, missing: data.missing || [] };
  } catch {
    return { configured: false, missing: [] };
  }
}

async function checkGitHubAuth() {
  try {
    const response = await fetch('/api/auth/status');
    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.message || 'GitHub sign-in is required.');
    }

    setSignedInState(data.user);
  } catch (error) {
    setSignedOutState(error.message);
  }
}

async function initializeApp() {
  const config = await checkGitHubConfig();
  if (!config.configured) {
    setSignedOutState('GitHub OAuth is not configured.');
    return;
  }

  await checkGitHubAuth();
}

signOutBtn?.addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout');
    setSignedOutState('Signed out. Connect your GitHub account to continue.');
  } catch {
    showInlineMessage('Unable to sign out at this time.', 'danger');
  }
});

if (filterMode) {
  filterMode.addEventListener('change', () => {
    selectedDaysPanel.classList.toggle('hidden', filterMode.value !== 'selected');
    updateWeekdayInputsState();
  });
}

if (randomizeInput) {
  randomizeInput.addEventListener('change', () => {
    if (!randomizeInput.checked) return;
    document.querySelectorAll('[data-weekday]').forEach((input) => {
      input.value = Math.floor(Math.random() * 10) + 1;
    });
  });
}

const selectedDaysCheckboxes = document.querySelectorAll("#selectedDays input");
selectedDaysCheckboxes.forEach(cb => {
  cb.addEventListener('change', updateWeekdayInputsState);
});

function updateWeekdayInputsState() {
  const mode = filterMode.value;
  const weekdayInputs = document.querySelectorAll("[data-weekday]");
  
  const checkedDays = Array.from(selectedDaysCheckboxes)
    .filter(cb => cb.checked)
    .map(cb => cb.value);

  weekdayInputs.forEach(input => {
    const day = input.dataset.weekday;
    let enabled = true;
    
    if (mode === 'odd') enabled = ['monday', 'wednesday', 'friday', 'sunday'].includes(day);
    else if (mode === 'even') enabled = ['tuesday', 'thursday', 'saturday'].includes(day);
    else if (mode === 'weekends') enabled = ['saturday', 'sunday'].includes(day);
    else if (mode === 'weekdays') enabled = !['saturday', 'sunday'].includes(day);
    else if (mode === 'selected') enabled = checkedDays.includes(day);
    
    input.disabled = !enabled;
    input.parentElement.style.opacity = enabled ? '1' : '0.4';
  });
}

// Initial state
updateWeekdayInputsState();

function formatETA(seconds) {
  const totalSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const secondsLeft = totalSeconds % 60;
  return `${minutes}m ${secondsLeft}s remaining`;
}

function estimateProgress(startAt, totalTasks, completedTasks) {
  if (completedTasks <= 0) return 'Estimating...';
  const elapsedSeconds = (Date.now() - startAt) / 1000;
  const averagePerTask = elapsedSeconds / completedTasks;
  const remaining = Math.max(0, totalTasks - completedTasks);
  const eta = averagePerTask * remaining;
  return formatETA(eta);
}

// ─── Pre-submit repo validation ─────────────────────────────────────────────

async function validateRepoBeforeSubmit(repoOwner, repoName) {
  try {
    const response = await fetch('/api/validate-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoOwner, repoName }),
    });
    const data = await response.json();

    if (!response.ok || !data.success) {
      return { valid: false, message: data.message || 'Unable to validate repository.' };
    }

    if (!data.valid) {
      return { valid: false, message: data.message };
    }

    if (!data.canPush) {
      return { valid: false, message: `You don't have write access to "${repoOwner}/${repoName}".` };
    }

    return { valid: true, defaultBranch: data.defaultBranch };
  } catch (error) {
    return { valid: false, message: 'Unable to validate repository. Check your connection and try again.' };
  }
}

// ─── Form submission ────────────────────────────────────────────────────────

function setSubmitting(isSubmitting) {
  if (submitBtn) {
    submitBtn.disabled = isSubmitting;
    submitBtn.innerHTML = isSubmitting 
      ? '<i class="ph-bold ph-spinner" style="animation: spin 1s linear infinite;"></i> Generating...' 
      : '<i class="ph-bold ph-lightning"></i> Generate Schedule';
  }
}

// Add a quick keyframe for the spinner if needed
if (!document.getElementById('spinKeyframe')) {
  const style = document.createElement('style');
  style.id = 'spinKeyframe';
  style.innerHTML = `@keyframes spin { 100% { transform: rotate(360deg); } }`;
  document.head.appendChild(style);
}

function renderError(message) {
  resultBox.classList.remove('hidden');
  resultBox.className = 'result result-error';
  resultBox.innerHTML = `
    <div class="result-icon"><i class="ph-bold ph-x"></i></div>
    <div class="result-body">
      <strong>Error</strong>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

function renderSuccess(data) {
  localStorage.setItem('githubUpgradeLastResult', JSON.stringify(data));
  resultBox.classList.remove('hidden');
  resultBox.className = 'result result-success';
  const pushNote = data.pushResult?.message || '';
  const verificationNote = data.verifiedCommits === null || data.verifiedCommits === undefined
    ? ''
    : ` GitHub verified ${data.verifiedCommits} matching commit(s); contribution graphs can take time to refresh.`;
  const contributionCounts = data.created.reduce((counts, commit) => {
    counts[commit.date] = (counts[commit.date] || 0) + 1;
    return counts;
  }, {});
  const contributionPreview = Object.entries(contributionCounts)
    .map(([date, count]) => `<span class="contribution-day" title="${escapeHtml(date)}: ${count} commit(s)" style="--day-level: ${Math.min(4, Math.ceil(count / 3))}"></span>`)
    .join('');
  const profileUrl = `https://github.com/${encodeURIComponent(data.repoOwner)}`;
  const repoUrl = `https://github.com/${encodeURIComponent(data.repoOwner)}/${encodeURIComponent(data.repoName)}`;
  resultBox.innerHTML = `
    <div class="result-icon"><i class="ph-bold ph-check"></i></div>
    <div class="result-body">
      <strong>Success!</strong>
      <div class="result-stats">
        <div class="stat"><span class="stat-label">Repository</span><span class="stat-value">${escapeHtml(data.repoOwner)}/${escapeHtml(data.repoName)}</span></div>
        <div class="stat"><span class="stat-label">Branch</span><span class="stat-value">${escapeHtml(data.branch)}</span></div>
        <div class="stat"><span class="stat-label">Commits</span><span class="stat-value">${data.commitsCreated}</span></div>
        <div class="stat"><span class="stat-label">Date range</span><span class="stat-value">${escapeHtml(data.startDate)} → ${escapeHtml(data.endDate)}</span></div>
        <div class="stat"><span class="stat-label">Days</span><span class="stat-value">${data.selectedDays}</span></div>
        <div class="stat"><span class="stat-label">Pushed</span><span class="stat-value">${data.pushToRemote ? 'Yes' : 'Dry-run'}</span></div>
      </div>
      <div class="contribution-preview" aria-label="Generated contribution preview">
        <span class="preview-label">Contribution preview</span>
        <div class="contribution-days">${contributionPreview}</div>
      </div>
      <div class="result-links">
        <a href="${repoUrl}" target="_blank" rel="noopener">View repository</a>
        <a href="${profileUrl}" target="_blank" rel="noopener">View GitHub profile</a>
      </div>
      <p class="result-note"><i class="ph-bold ph-info"></i> ${escapeHtml(pushNote + verificationNote)}</p>
    </div>
  `;
}

function restoreLastResult() {
  try {
    const savedResult = localStorage.getItem('githubUpgradeLastResult');
    if (savedResult) renderSuccess(JSON.parse(savedResult));
  } catch {
    localStorage.removeItem('githubUpgradeLastResult');
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();

  const weekdayInputs = document.querySelectorAll("[data-weekday]");
  const weekdayCounts = {};
  weekdayInputs.forEach((input) => {
    weekdayCounts[input.dataset.weekday] = Number(input.value || 0);
  });

  const selectedDays = Array.from(document.querySelectorAll("#selectedDays input:checked")).map((input) => input.value);

  const repoOwner = repoOwnerInput.value.trim() || (currentUser ? currentUser.login : '');
  const repoName = repoNameInput.value.trim();
  const pushToRemote = document.getElementById("pushToRemote").checked;

  const payload = {
    startDate: document.getElementById("startDate").value,
    endDate: document.getElementById("endDate").value,
    randomize: randomizeInput.checked,
    filterMode: filterMode.value,
    selectedDays,
    weekdayCounts,
    branch: document.getElementById("branch").value,
    pushToRemote,
    repoOwner,
    repoName,
  };

  // Validate inputs
  if (!payload.startDate || !payload.endDate) {
    renderError('Please select both a start date and an end date.');
    return;
  }

  if (pushToRemote && !repoName) {
    renderError('Repository name is required when pushing to remote. Enter a repository name.');
    return;
  }

  setSubmitting(true);

  // Pre-validate repo if pushing to remote
  if (pushToRemote) {
    resultBox.classList.remove('hidden');
    resultBox.className = 'result';
    resultBox.innerHTML = 'Validating repository access...';

    const validation = await validateRepoBeforeSubmit(repoOwner, repoName);
    if (!validation.valid) {
      setSubmitting(false);
      renderError(validation.message);
      return;
    }
  }

  const start = new Date(payload.startDate);
  const end = new Date(payload.endDate);
  const differenceDays = Math.max(1, Math.ceil((end - start) / 86400000) + 1);
  const averageDailyCount = Object.values(weekdayCounts).reduce((total, count) => total + count, 0) / 7;
  const estimatedTotal = Math.max(1, Math.round(averageDailyCount * differenceDays));
  const startedAt = Date.now();
  let completed = 0;

  resultBox.classList.remove('hidden');
  resultBox.className = 'result';
  resultBox.innerHTML = "Generating commits... <span class='progress'>0/" + estimatedTotal + " · Estimating...</span>";

  const progressTimer = setInterval(() => {
    completed = Math.min(completed + 1, estimatedTotal);
    const eta = estimateProgress(startedAt, estimatedTotal, completed);
    const node = resultBox.querySelector(".progress");
    if (node) node.textContent = `${completed}/${estimatedTotal} · ${eta}`;
  }, 800);

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const contentType = response.headers.get("content-type");
    let data;
    if (contentType && contentType.includes("application/json")) {
      data = await response.json();
    } else {
      const textError = await response.text();
      throw new Error(`Server error (${response.status}): The request may have timed out. Try generating fewer commits.`);
    }

    if (!response.ok || !data.success) {
      throw new Error(data.message || "Something went wrong.");
    }

    clearInterval(progressTimer);
    renderSuccess(data);
  } catch (error) {
    clearInterval(progressTimer);
    renderError(error.message);
  } finally {
    setSubmitting(false);
  }
});

initializeApp().then(() => {
  restoreLastResult();
});
