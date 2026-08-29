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

// DOM Elements
const userSummary = document.getElementById("userSummary");
const signOutBtn = document.getElementById("signOutBtn");
const form = document.getElementById("commitForm");
const resultBox = document.getElementById("result");
const repoOwnerInput = document.getElementById("repoOwner");
const repoNameInput = document.getElementById("repoName");
const submitBtn = document.getElementById("submitBtn");

// Filter elements
const filterButtons = document.querySelectorAll('[data-filter]');
const filterOptionButtons = document.querySelectorAll('[data-option]');
const customWeekdaySection = document.getElementById('customWeekdaySection');
const randomBtn = document.getElementById('randomBtn');

let currentUser = null;
let userRepos = [];
let activeFilter = 'all';
let activeOption = 'min';

// Filter Logic
filterButtons.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    filterButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;

    // Show/hide custom weekday section
    if (activeFilter === 'custom') {
      customWeekdaySection.style.display = 'block';
      randomBtn.style.display = 'inline-block';
    } else {
      customWeekdaySection.style.display = 'none';
      randomBtn.style.display = 'none';
      applyFilterMode();
    }
  });
});

// Filter option buttons
filterOptionButtons.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (btn.dataset.option === 'random') {
      applyRandomCounts();
    } else {
      filterOptionButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeOption = btn.dataset.option;
      applyFilterMode();
    }
  });
});

function applyFilterMode() {
  const weekdayInputs = document.querySelectorAll("[data-weekday]");
  const monday = 1, tuesday = 2, wednesday = 3, thursday = 4, friday = 5, saturday = 6, sunday = 0;
  const dayMap = { monday, tuesday, wednesday, thursday, friday, saturday, sunday };

  let value = activeOption === 'min' ? 1 : 20;

  weekdayInputs.forEach(input => {
    const day = dayMap[input.dataset.weekday];
    let shouldSet = false;

    if (activeFilter === 'all') {
      shouldSet = true;
    } else if (activeFilter === 'even') {
      shouldSet = day !== 0 && day % 2 === 0; // Tue, Thu, Sat
    } else if (activeFilter === 'odd') {
      shouldSet = day !== 0 && day % 2 === 1 || day === 0; // Mon, Wed, Fri, Sun
    }

    if (shouldSet) {
      input.value = value;
    }
  });
}

function applyRandomCounts() {
  const weekdayInputs = document.querySelectorAll("[data-weekday]");
  weekdayInputs.forEach(input => {
    input.value = Math.floor(Math.random() * 30) + 1;
  });
}

function setSignedOutState(message) {
  currentUser = null;
  userRepos = [];
  window.location.replace('/auth.html');
}

function setSignedInState(user) {
  currentUser = user;
  if (repoOwnerInput && !repoOwnerInput.value) {
    repoOwnerInput.value = user.login || '';
  }
  userSummary.textContent = user.login || 'GitHub account';
  fetchRepos();
}

async function fetchRepos() {
  if (!repoNameInput) return;
  repoNameInput.innerHTML = '<option value="" disabled selected>Loading...</option>';
  try {
    const response = await fetch('/api/repos');
    const data = await response.json();
    if (data.success && data.repos) {
      userRepos = data.repos;
      repoNameInput.innerHTML = '<option value="" disabled selected>Select repository</option>';
      userRepos.forEach(repo => {
        const option = document.createElement('option');
        option.value = repo.name;
        option.textContent = repo.name + (repo.private ? ' [Private]' : '');
        repoNameInput.appendChild(option);
      });
    } else {
      repoNameInput.innerHTML = '<option value="" disabled selected>Failed to load</option>';
    }
  } catch (err) {
    repoNameInput.innerHTML = '<option value="" disabled selected>Error loading</option>';
  }
}

if (repoNameInput) {
  repoNameInput.addEventListener('change', () => {
    const selected = userRepos.find(r => r.name === repoNameInput.value);
    if (selected && selected.defaultBranch) {
      document.getElementById('branch').value = selected.defaultBranch;
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
    setSignedOutState('Signed out.');
  } catch {}
});

function renderError(message, box = resultBox) {
  box.classList.remove('hidden', 'result-success');
  box.classList.add('result-error');
  box.innerHTML = `<strong>ERROR:</strong> ${message}`;
}

function renderSuccess(data, box = resultBox) {
  box.classList.remove('hidden', 'result-error');
  box.classList.add('result-success');
  const msg = data.pushResult?.message || data.message || 'Schedule generated successfully!';
  box.innerHTML = `<strong>SUCCESS!</strong><br/>${msg}<br/><small>${data.commitCount || 0} commits scheduled</small>`;
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();

  const weekdayInputs = document.querySelectorAll("[data-weekday]");
  const weekdayCounts = {};
  weekdayInputs.forEach((input) => {
    weekdayCounts[input.dataset.weekday] = Number(input.value || 0);
  });

  const repoOwner = repoOwnerInput.value.trim() || (currentUser ? currentUser.login : '');
  const repoName = repoNameInput.value.trim();
  const pushToRemote = document.getElementById("pushToRemote").checked;

  const payload = {
    startDate: document.getElementById("startDate").value,
    endDate: document.getElementById("endDate").value,
    weekdayCounts,
    branch: document.getElementById("branch").value,
    pushToRemote,
    repoOwner,
    repoName,
  };

  if (!payload.startDate || !payload.endDate) {
    renderError('Select both start and end dates.');
    return;
  }
  if (!repoName) {
    renderError('Select a repository.');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML = 'GENERATING...';

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || "Failed to generate commits.");
    renderSuccess(data, resultBox);
  } catch (error) {
    renderError(error.message, resultBox);
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = 'GENERATE SCHEDULE';
  }
});

// Add spin animation if not exists
if (!document.getElementById('spinKeyframe')) {
  const style = document.createElement('style');
  style.id = 'spinKeyframe';
  style.innerHTML = `@keyframes spin { 100% { transform: rotate(360deg); } }`;
  document.head.appendChild(style);
}

initializeApp();
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
    setSignedOutState('Signed out.');
  } catch {}
});

function renderError(message, box = resultBox) {
  box.classList.remove('hidden', 'result-success');
  box.classList.add('result-error');
  box.innerHTML = `<strong>Error:</strong> ${message}`;
}

function renderSuccess(data, box = resultBox) {
  box.classList.remove('hidden', 'result-error');
  box.classList.add('result-success');
  box.innerHTML = `<strong>Success!</strong> ${data.pushResult?.message || data.message || 'Action completed successfully.'}`;
}

// Generate Commits Form
form?.addEventListener('submit', async (event) => {
  event.preventDefault();

  const weekdayInputs = document.querySelectorAll("[data-weekday]");
  const weekdayCounts = {};
  weekdayInputs.forEach((input) => {
    weekdayCounts[input.dataset.weekday] = Number(input.value || 0);
  });

  const repoOwner = repoOwnerInput.value.trim() || (currentUser ? currentUser.login : '');
  const repoName = repoNameInput.value.trim();
  const pushToRemote = document.getElementById("pushToRemote").checked;

  const payload = {
    startDate: document.getElementById("startDate").value,
    endDate: document.getElementById("endDate").value,
    randomize: false,
    filterMode: 'all',
    selectedDays: [],
    weekdayCounts,
    branch: document.getElementById("branch").value,
    pushToRemote,
    repoOwner,
    repoName,
  };

  if (!payload.startDate || !payload.endDate) {
    renderError('Please select both a start date and an end date.');
    return;
  }
  if (pushToRemote && !repoName) {
    renderError('Repository name is required when pushing to remote.');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="ph-bold ph-spinner" style="animation: spin 1s linear infinite;"></i> Generating...';

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || "Something went wrong.");
    
    renderSuccess(data, resultBox);
  } catch (error) {
    renderError(error.message, resultBox);
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i class="ph-bold ph-lightning"></i> Generate Schedule';
  }
});

// Add spin keyframe dynamically
if (!document.getElementById('spinKeyframe')) {
  const style = document.createElement('style');
  style.id = 'spinKeyframe';
  style.innerHTML = `@keyframes spin { 100% { transform: rotate(360deg); } }`;
  document.head.appendChild(style);
}

initializeApp();
