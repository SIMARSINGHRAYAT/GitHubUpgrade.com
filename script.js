const authPanel = document.getElementById("authPanel");
const schedulerPanel = document.getElementById("schedulerPanel");
const authStatus = document.getElementById("authStatus");
const userSummary = document.getElementById("userSummary");
const githubLoginBtn = document.getElementById("githubLoginBtn");
const signOutBtn = document.getElementById("signOutBtn");
const form = document.getElementById("commitForm");
const resultBox = document.getElementById("result");
const filterMode = document.getElementById("filterMode");
const selectedDaysPanel = document.getElementById("selectedDays");
const repoOwnerInput = document.getElementById("repoOwner");
const repoNameInput = document.getElementById("repoName");
const submitBtn = form.querySelector("button[type='submit']");

let currentUser = null;
let userRepos = [];

function setSignedOutState(message) {
  currentUser = null;
  userRepos = [];
  signOutBtn.style.display = 'none';
  authPanel.classList.remove('hidden');
  schedulerPanel.classList.add('hidden');
  authStatus.textContent = message || 'Connect your GitHub account to continue.';
  authStatus.classList.remove('success');
  authStatus.classList.add('danger');
  githubLoginBtn.disabled = false;
  githubLoginBtn.textContent = 'Continue with GitHub';
}

function setSignedInState(user) {
  currentUser = user;
  signOutBtn.style.display = 'inline-flex';
  authPanel.classList.add('hidden');
  schedulerPanel.classList.remove('hidden');
  userSummary.textContent = user.login || 'GitHub account';
  authStatus.textContent = 'GitHub account connected.';
  authStatus.classList.remove('danger');
  authStatus.classList.add('success');

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

function showInlineMessage(message, type = 'danger') {
  authStatus.textContent = message;
  authStatus.classList.toggle('success', type === 'success');
  authStatus.classList.toggle('danger', type === 'danger');
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
    setSignedOutState('GitHub OAuth missing: ' + (config.missing.length ? config.missing.join(', ') : 'GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET'));
    githubLoginBtn.disabled = true;
    githubLoginBtn.textContent = 'Configuration needed';
    return;
  }

  await checkGitHubAuth();
}

githubLoginBtn.addEventListener('click', () => {
  if (githubLoginBtn.disabled) return;
  window.location.href = '/api/auth/login';
});

signOutBtn.addEventListener('click', async () => {
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
  resultBox.classList.remove('hidden');
  resultBox.className = 'result result-success';
  const pushNote = data.pushResult?.message || '';
  resultBox.innerHTML = `
    <div class="result-icon"><i class="ph-bold ph-check"></i></div>
    <div class="result-body">
      <strong>Success!</strong>
      <div class="result-stats">
        <div class="stat"><span class="stat-label">Repository</span><span class="stat-value">${escapeHtml(data.repoOwner)}/${escapeHtml(data.repoName)}</span></div>
        <div class="stat"><span class="stat-label">Branch</span><span class="stat-value">${escapeHtml(data.branch)}</span></div>
        <div class="stat"><span class="stat-label">Commits</span><span class="stat-value">${data.commitsCreated}</span></div>
        <div class="stat"><span class="stat-label">Date range</span><span class="stat-value">${escapeHtml(data.startDate)} → ${escapeHtml(data.endDate)}</span></div>
        <div class="stat"><span class="stat-label">Days</span><span class="stat-value">${escapeHtml(data.selectedDays)}</span></div>
        <div class="stat"><span class="stat-label">Pushed</span><span class="stat-value">${data.pushToRemote ? 'Yes' : 'Dry-run'}</span></div>
      </div>
      <p class="result-note"><i class="ph-bold ph-info"></i> ${escapeHtml(pushNote)}</p>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const weekdayInputs = document.querySelectorAll("[data-weekday]");
  const weekdayCounts = {};
  weekdayInputs.forEach((input) => {
    weekdayCounts[input.dataset.weekday] = Number(input.value || 0);
  });

  const VALID_WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const selectedDays = Array.from(document.querySelectorAll("#selectedDays input:checked"))
    .map((input) => input.value)
    .filter((day) => VALID_WEEKDAYS.includes(day));

  const repoOwner = repoOwnerInput.value.trim() || (currentUser ? currentUser.login : '');
  const repoName = repoNameInput.value.trim();
  const pushToRemote = document.getElementById("pushToRemote").checked;

  const payload = {
    startDate: document.getElementById("startDate").value,
    endDate: document.getElementById("endDate").value,
    dailyCount: Number(document.getElementById("dailyCount").value || 1),
    maxPerDay: Number(document.getElementById("maxPerDay").value || 1),
    randomize: document.getElementById("randomize").checked,
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
  const estimatedTotal = Math.max(1, Math.round((payload.dailyCount || 1) * differenceDays));
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

initializeApp();
