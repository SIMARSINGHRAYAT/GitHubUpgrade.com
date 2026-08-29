const REMOTE_BASE_URL = 'https://app-commit-ten.vercel.app';
const BASE_URL = window.location.protocol === 'file:' || window.location.origin.startsWith('chrome-extension:')
  ? REMOTE_BASE_URL
  : window.location.origin;

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

// ===== DOM Elements =====
const userSummary = document.getElementById("userSummary");
const signOutBtn = document.getElementById("signOutBtn");
const form = document.getElementById("commitForm");
const resultBox = document.getElementById("result");
const repoOwnerInput = document.getElementById("repoOwner");
const repoNameInput = document.getElementById("repoName");
const submitBtn = document.getElementById("submitBtn");
const startDateInput = document.getElementById("startDate");
const endDateInput = document.getElementById("endDate");
const branchInput = document.getElementById("branch");
const pushToRemoteCheckbox = document.getElementById("pushToRemote");
const weekdayInputs = document.querySelectorAll("[data-weekday]");
const calendarIcons = document.querySelectorAll('.calendar-icon');

// Filter elements
const filterButtons = document.querySelectorAll('[data-filter]');
const filterOptionButtons = document.querySelectorAll('[data-option]');

let currentUser = null;
let userRepos = [];
let activeFilter = 'all';
let activeOption = 'min';

// ===== Weekday Mapping =====
const dayMap = { 
  monday: 1, 
  tuesday: 2, 
  wednesday: 3, 
  thursday: 4, 
  friday: 5, 
  saturday: 6, 
  sunday: 0 
};

// ===== Filter Logic =====
filterButtons.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    filterButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    applyFilterMode();
  });
});

filterOptionButtons.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    filterOptionButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeOption = btn.dataset.option;
    applyFilterMode();
  });
});

function applyFilterMode() {
  const isRandom = activeFilter === 'custom';
  const value = activeOption === 'min' ? 1 : 5;

  weekdayInputs.forEach(input => {
    const day = dayMap[input.dataset.weekday];
    const isSelected = activeFilter === 'all'
      || (activeFilter === 'even' && day !== 0 && day % 2 === 0)
      || (activeFilter === 'odd' && (day === 0 || day % 2 === 1))
      || isRandom;

    input.disabled = !isSelected;
    input.max = isRandom ? '10' : '5';

    if (!isSelected) {
      input.value = '0';
    } else if (isRandom) {
      input.value = String(Math.floor(Math.random() * 11));
    } else {
      input.value = String(value);
    }
  });
}

// ===== Authentication & Setup =====
function setSignedOutState(message) {
  currentUser = null;
  userRepos = [];
  window.location.replace('/auth.html');
}

async function setSignedInState(user) {
  currentUser = user;
  // Auto-populate repo owner from signed-in user
  if (repoOwnerInput) {
    repoOwnerInput.value = user.login || '';
    repoOwnerInput.readOnly = true; // Make it read-only since it's auto-fetched
  }
  userSummary.textContent = user.login || 'GitHub account';
  await fetchRepos();
}

async function fetchRepos() {
  if (!repoNameInput) return;
  repoNameInput.innerHTML = '<option value="" disabled selected>Loading...</option>';
  try {
    const response = await fetch('/api/repos');
    const data = await response.json();
    if (data.success && data.repos && Array.isArray(data.repos)) {
      userRepos = data.repos;
      repoNameInput.innerHTML = '<option value="" disabled selected>Select repository</option>';
      userRepos.forEach(repo => {
        const option = document.createElement('option');
        option.value = repo.name;
        option.textContent = repo.name + (repo.private ? ' [Private]' : '');
        repoNameInput.appendChild(option);
      });
    } else {
      repoNameInput.innerHTML = '<option value="" disabled selected>No repositories found</option>';
    }
  } catch (err) {
    console.error('Error fetching repos:', err);
    repoNameInput.innerHTML = '<option value="" disabled selected>Error loading repositories</option>';
  }
}

if (repoNameInput) {
  repoNameInput.addEventListener('change', () => {
    const selected = userRepos.find(r => r.name === repoNameInput.value);
    if (selected && selected.defaultBranch && branchInput) {
      branchInput.value = selected.defaultBranch;
    }
  });
}

async function checkGitHubConfig() {
  try {
    const response = await fetch('/api/auth/configured');
    const data = await response.json();
    return { configured: data.success && data.configured, missing: data.missing || [] };
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
    await setSignedInState(data.user);
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

// ===== Sign Out =====
signOutBtn?.addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout');
    setSignedOutState('Signed out.');
  } catch {}
});

// ===== Result Rendering =====
function renderError(message, box = resultBox) {
  box.className = 'result result-error';
  box.innerHTML = `<strong>ERROR:</strong> ${message}`;
}

function renderProgress(totalCommits) {
  const estimatedSeconds = Math.max(5, totalCommits * 3);
  const startedAt = Date.now();
  resultBox.className = 'result result-progress';
  resultBox.innerHTML = `<strong>GENERATING SCHEDULE</strong><span id="progressStatus">Preparing ${totalCommits} commit${totalCommits === 1 ? '' : 's'}...</span><small id="progressTime">Estimated time remaining: ${formatDuration(estimatedSeconds)}</small>`;

  const timer = window.setInterval(() => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const remaining = Math.max(0, estimatedSeconds - elapsed);
    const timeNode = document.getElementById('progressTime');
    if (timeNode) {
      timeNode.textContent = `Estimated time remaining: ${formatDuration(remaining)}`;
    }
  }, 1000);

  return () => window.clearInterval(timer);
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function renderSuccess(data, box = resultBox) {
  box.classList.remove('hidden', 'result-error');
  box.className = 'result result-success';
  const msg = data.pushResult?.message || data.message || 'Schedule generated successfully!';
  const commitCount = data.commitCount || 0;
  const repository = data.repository || `${repoOwnerInput.value}/${repoNameInput.value}`;
  const owner = repository.split('/')[0];
  box.innerHTML = `<strong>TASK COMPLETE SUCCESSFULLY</strong><span>${msg}</span><small>${commitCount} commits scheduled</small><nav class="result-links"><a href="https://github.com/${owner}" target="_blank" rel="noopener">VIEW GITHUB PROFILE</a><a href="https://github.com/${repository}" target="_blank" rel="noopener">VIEW REPOSITORY</a></nav>`;
}

calendarIcons.forEach(icon => {
  icon.addEventListener('click', () => {
    const input = icon.parentElement.querySelector('input[type="date"]');
    if (input?.showPicker) input.showPicker();
    else input?.focus();
  });
});

applyFilterMode();

// ===== Form Submission =====
form?.addEventListener('submit', async (event) => {
  event.preventDefault();

  // Collect weekday commit counts
  const weekdayInputs = document.querySelectorAll("[data-weekday]");
  const weekdayCounts = {};
  const maximum = activeFilter === 'custom' ? 10 : 5;
  weekdayInputs.forEach((input) => {
    const count = Math.min(maximum, Math.max(0, Number(input.value) || 0));
    input.value = String(count);
    weekdayCounts[input.dataset.weekday] = count;
  });

  const repoOwner = repoOwnerInput.value.trim() || (currentUser ? currentUser.login : '');
  const repoName = repoNameInput.value.trim();
  const pushToRemote = pushToRemoteCheckbox.checked;
  const branch = branchInput.value.trim() || 'main';

  const payload = {
    startDate: startDateInput.value,
    endDate: endDateInput.value,
    weekdayCounts,
    branch,
    pushToRemote,
    repoOwner,
    repoName,
  };

  // ===== Validation =====
  if (!payload.startDate || !payload.endDate) {
    renderError('Please select both start and end dates.');
    return;
  }
  if (!repoName) {
    renderError('Please select a repository.');
    return;
  }
  
  // Validate date range
  const startDate = new Date(payload.startDate);
  const endDate = new Date(payload.endDate);
  if (startDate > endDate) {
    renderError('Start date must be before or equal to end date.');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML = 'GENERATING...';
  const stopProgress = renderProgress(Object.values(weekdayCounts).reduce((total, count) => total + count, 0));

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.message || "Failed to generate commits.");
    }
    stopProgress();
    renderSuccess(data, resultBox);
  } catch (error) {
    stopProgress();
    renderError(error.message, resultBox);
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = 'GENERATE SCHEDULE';
  }
});

// ===== Initialize App =====
initializeApp();
