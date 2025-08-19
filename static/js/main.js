// SPA + Auth + Routing + UI glue (original logic preserved)
const appEl = document.getElementById('app');
const sidebarEl = document.getElementById('sidebar');
const contentEl = document.getElementById('content');
const loaderEl = document.getElementById('loader');
const themeSwitch = document.getElementById('themeSwitch');
const logoutBtn = document.getElementById('logoutBtn');
const sirenEl = document.getElementById('siren');

// NEW: mobile toggle + cursor glow handles (styling-only helpers)
const menuToggleBtn = document.getElementById('menuToggle');
const cursorGlow = document.getElementById('cursorGlow');

// ---- Firebase ----
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const rtdb = firebase.database();
let idToken = null;
let currentUser = null;
let currentRole = null;

// Track admin presence in Firebase
let adminPresenceRef = null;

// Manage page-scoped intervals so we don't leak timers across routes
let pageIntervals = [];
function addInterval(fn, ms) {
  const id = setInterval(fn, ms);
  pageIntervals.push(id);
  return id;
}
function clearPageIntervals() {
  pageIntervals.forEach(clearInterval);
  pageIntervals = [];
}

// ---- Sockets ----
const socket = io('/stream', { transports: ['websocket'] });

// High-threat labels the siren should react to
const HIGH_LABELS = new Set(['weapons', 'weapon', 'other_coverings', 'otherCoverings', 'other_Coverings']);

// Debounce siren
let lastSirenAt = 0;
const SIREN_COOLDOWN_MS = 3000;

function maybePlaySiren(payload) {
  if (!sirenEl) return;
  let isHigh = false;

  if (payload && payload.label && HIGH_LABELS.has(payload.label)) {
    isHigh = true;
  } else if (payload && Array.isArray(payload.detections)) {
    isHigh = payload.detections.some(d => d && d.label && HIGH_LABELS.has(d.label));
  }

  if (!isHigh) return;

  const now = Date.now();
  if (now - lastSirenAt < SIREN_COOLDOWN_MS) return;
  lastSirenAt = now;

  try {
    sirenEl.currentTime = 0;
    sirenEl.play().catch(() => {});
  } catch (_) {}
}

socket.on('pending_detection', (payload) => {
  if (location.hash === '#/admin/alerts') {
    renderPending(payload);
  }
});

socket.on('high_threat', (payload) => {
  maybePlaySiren(payload);
});

// ---- Theme ----
themeSwitch?.addEventListener('change', (e) => {
  document.documentElement.setAttribute('data-theme', e.target.checked ? 'dark' : 'light');
  localStorage.setItem('theme', e.target.checked ? 'dark' : 'light');
});
const savedTheme = localStorage.getItem('theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);
if (savedTheme === 'dark' && themeSwitch) themeSwitch.checked = true;

function showLoader(show=true){ loaderEl?.classList.toggle('hidden', !show); }
function setSidebarVisible(vis){
  sidebarEl?.classList.toggle('hidden', !vis);
  // if we hide the sidebar (e.g., at login screen), also close mobile state & reset button
  if (!vis) {
    sidebarEl?.classList.remove('open');
    menuToggleBtn?.classList.remove('open');
  }
}
function setMenuToggleVisible(vis){
  // menu toggle is only used on mobile; we still add/remove hidden to ensure it's not clickable pre-login
  menuToggleBtn?.classList.toggle('hidden', !vis);
}

// ---- Login UI ----
function showLogin(){
  clearPageIntervals();
  setSidebarVisible(false);
  setMenuToggleVisible(false);
  contentEl.innerHTML = document.getElementById('loginTpl').innerHTML;
  const form = document.getElementById('loginForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showLoader(true);
    try {
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      await auth.signInWithEmailAndPassword(email, password);
    } catch (err) {
      alert(err.message);
    } finally { showLoader(false); }
  });
}

async function resolveRole(uid){
  const snap = await rtdb.ref('/users/' + uid).get();
  const data = snap.val() || {};
  return data.role || 'personnel';
}

// ---- API helpers ----
async function refreshIdToken(){
  if (!auth.currentUser) return null;
  idToken = await auth.currentUser.getIdToken(true);
  return idToken;
}

async function api(path, options={}){
  const token = await refreshIdToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
      ...(options.headers || {})
    },
    credentials: 'include'
  });
  if (!res.ok) {
    const text = await res.text().catch(()=>String(res.status));
    throw new Error(text || ('HTTP ' + res.status));
  }
  return res.json();
}

// ---- Routing + Auth state ----
window.addEventListener('hashchange', route);

auth.onAuthStateChanged(async (user) => {
  if (!user) {
    try {
      if (adminPresenceRef) {
        await adminPresenceRef.remove();
        adminPresenceRef = null;
      }
    } catch(_) {}
    currentUser = null;
    currentRole = null;
    showLogin();
    return;
  }

  currentUser = user;
  currentRole = await resolveRole(user.uid);

  if (currentRole === 'admin') {
    adminPresenceRef = rtdb.ref('/activeAdmins/' + user.uid);
    await adminPresenceRef.set(true);
    adminPresenceRef.onDisconnect().remove();
    try {
      await api('/api/start_cameras', { method: 'POST' });
      console.log("Cameras started");
    } catch (err) {
      console.error("Could not start cameras:", err);
    }
  }

  setSidebarVisible(true);
  setMenuToggleVisible(true);
  route();
});

logoutBtn?.addEventListener('click', async ()=>{
  if (currentRole === 'admin') {
    try {
      if (adminPresenceRef) {
        await adminPresenceRef.remove();
        adminPresenceRef = null;
      }
      const snap = await rtdb.ref('/activeAdmins').get();
      if (!snap.exists()) {
        try {
          await api('/api/stop_cameras', { method: 'POST' });
          console.log("Cameras stopped (last admin logged out)");
        } catch (err) {
          console.error("Could not stop cameras:", err);
        }
      }
    } catch(_) {}
  }
  await auth.signOut();
  // UI hygiene
  setMenuToggleVisible(false);
  sidebarEl?.classList.remove('open');
  menuToggleBtn?.classList.remove('open');
});

window.addEventListener('beforeunload', async () => {
  if (currentRole === 'admin') {
    try {
      if (adminPresenceRef) {
        await adminPresenceRef.remove();
        adminPresenceRef = null;
      }
    } catch(_) {}
    try {
      navigator.sendBeacon('/api/check_stop_cameras', JSON.stringify({}));
    } catch(_) {}
  }
});

async function route(){
  clearPageIntervals();
  const hash = location.hash || '#/login';
  if (!currentUser) return showLogin();

  // Filter visible links by role
  Array.from(sidebarEl.querySelectorAll('a')).forEach(a => {
    const allowed = a.dataset.role;
    const show = !allowed || allowed === currentRole;
    a.style.display = show ? 'block' : 'none';
  });

  if (hash === '#/admin/dashboard' && currentRole === 'admin') return renderAdminDashboard();
  if (hash === '#/admin/alerts' && currentRole === 'admin') return renderAdminAlerts();
  if (hash === '#/admin/activity' && currentRole === 'admin') return renderAdminActivity();
  if (hash === '#/admin/cameras' && currentRole === 'admin') return renderAdminCameras();
  if (hash === '#/admin/settings' && currentRole === 'admin') return renderAdminSettings();
  if (hash === '#/personnel/dashboard' && currentRole === 'personnel') return renderPersonnelDashboard();
  if (hash === '#/personnel/settings' && currentRole === 'personnel') return renderPersonnelSettings();

  location.hash = currentRole === 'admin' ? '#/admin/dashboard' : '#/personnel/dashboard';
}

// ---------- Video helper ----------
function attachLiveVideo(imgEl) {
  if (!imgEl) return;
  const PLACEHOLDER_SRC = '/static/placeholder.jpg';
  const LIVE_SRC = () => '/api/video_feed?ts=' + Date.now();
  imgEl.src = PLACEHOLDER_SRC;
  imgEl.dataset.live = '0';

  const checkAndSwap = async () => {
    try {
      const data = await api('/api/status');
      const active = Number(data.camerasActive || 0);
      if (active > 0 && imgEl.dataset.live !== '1') {
        imgEl.src = LIVE_SRC();
        imgEl.dataset.live = '1';
      } else if (active === 0 && imgEl.dataset.live !== '0') {
        imgEl.src = PLACEHOLDER_SRC;
        imgEl.dataset.live = '0';
      }
    } catch (e) {
      console.debug('status poll failed', e?.message || e);
    }
  };

  checkAndSwap();
  addInterval(checkAndSwap, 2000);
  imgEl.onerror = () => {
    if (imgEl.dataset.live === '1') {
      imgEl.src = PLACEHOLDER_SRC;
      imgEl.dataset.live = '0';
    }
  };
}

// ---------- NEW: Browser webcam upload ----------
async function startBrowserCamera(videoEl) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    videoEl.srcObject = stream;
    videoEl.play();

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    async function sendFrame() {
      if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
        canvas.width = videoEl.videoWidth;
        canvas.height = videoEl.videoHeight;
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        const b64 = canvas.toDataURL('image/jpeg', 0.6);

        try {
          const res = await api('/api/upload_frame', {
            method: 'POST',
            body: JSON.stringify({ frame: b64 })
          });
          maybePlaySiren(res);
        } catch (err) {
          console.error('upload_frame failed', err.message);
        }
      }
      setTimeout(sendFrame, 1000); // 1 FPS to balance performance
    }

    sendFrame();
  } catch (err) {
    console.error('Could not access webcam:', err);
  }
}

// ---------- Pages ----------
async function renderAdminDashboard(){
  contentEl.innerHTML = document.getElementById('adminDashboardTpl').innerHTML;
  const videoEl = document.getElementById('videoStream');
  if (videoEl) attachLiveVideo(videoEl);

  const { status, threatLevel, camerasActive, alertsToday } = await api('/api/status');
  setPill('statusText', status ? 'running' : 'offline', status ? 'low' : 'high');
  setPill('threatText', threatLevel, threatLevel);
  setPill('cameraCount', String(camerasActive), 'low');
  renderAlertsToday('alertsToday', alertsToday);

  addInterval(async () => {
    try {
      const data = await api('/api/status');
      setPill('statusText', data.status ? 'running' : 'offline', data.status ? 'low' : 'high');
      setPill('threatText', data.threatLevel, data.threatLevel);
      setPill('cameraCount', String(data.camerasActive), 'low');
      renderAlertsToday('alertsToday', data.alertsToday);
    } catch(e){}
  }, 2000);

  // 🔥 If we also want browser webcam mode:
  const browserCamEl = document.getElementById('browserCam');
  if (browserCamEl) {
    startBrowserCamera(browserCamEl);
  }
}

function renderAlertsToday(containerId, items){
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  (items || []).slice(0,3).forEach(i => {
    const li = document.createElement('li');
    li.textContent = `${i.label ?? i.name ?? 'event'} • cam ${i.camera} • conf ${i.conf ?? i.confidence ?? '-'}`;
    el.appendChild(li);
  });
}

function setPill(id, text, level){
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'pill ' + (level === 'high' ? 'high' : 'low');
}

async function renderPersonnelDashboard(){
  contentEl.innerHTML = document.getElementById('personnelDashboardTpl').innerHTML;
  const { status, threatLevel, camerasActive, alertsToday } = await api('/api/status');
  setPill('p_statusText', status ? 'running' : 'offline', status ? 'low' : 'high');
  setPill('p_threatText', threatLevel, threatLevel);
  setPill('p_cameraCount', String(camerasActive), 'low');
  renderAlertsToday('p_alertsToday', alertsToday);

  addInterval(async () => {
    try {
      const data = await api('/api/status');
      setPill('p_statusText', data.status ? 'running' : 'offline', data.status ? 'low' : 'high');
      setPill('p_threatText', data.threatLevel, data.threatLevel);
      setPill('p_cameraCount', String(data.camerasActive), 'low');
      renderAlertsToday('p_alertsToday', data.alertsToday);
    } catch(e){}
  }, 2000);

  // 🔥 Also allow browser webcam here if needed
  const browserCamEl = document.getElementById('p_browserCam');
  if (browserCamEl) {
    startBrowserCamera(browserCamEl);
  }
}

async function renderAdminAlerts(){
  contentEl.innerHTML = document.getElementById('adminAlertsTpl').innerHTML;
}

function renderPending(payload){
  const list = document.getElementById('pendingList');
  if (!list) return;
  const item = document.createElement('div');
  item.className = 'pending-item';
  const primary = document.createElement('div');
  const ts = new Date(payload.time*1000).toLocaleTimeString();
  const labels = payload.detections.map(d => d.label + ' (' + d.conf + ')').join(', ');
  primary.textContent = `${ts} • cam ${payload.camera} • ${labels} • threat ${payload.threatLevel}`;
  const actions = document.createElement('div');
  const btnV = document.createElement('button');
  btnV.className = 'btn verify'; btnV.textContent = 'Verify';
  const btnD = document.createElement('button');
  btnD.className = 'btn dismiss'; btnD.textContent = 'Dismiss';
  btnV.onclick = async ()=>{
    await api('/api/alerts/resolve', {
      method: 'POST',
      body: JSON.stringify({ action: 'verify', detection: { label: payload.detections[0].label, time: payload.time, camera: payload.camera, threatLevel: payload.threatLevel } })
    });
    item.remove();
  };
  btnD.onclick = async ()=>{
    await api('/api/alerts/resolve', {
      method: 'POST',
      body: JSON.stringify({ action: 'dismiss', detection: { label: payload.detections[0].label, time: payload.time, camera: payload.camera, threatLevel: payload.threatLevel } })
    });
    item.remove();
  };
  actions.append(btnV, btnD);
  item.append(primary, actions);
  list.prepend(item);
}

async function renderAdminActivity(){
  contentEl.innerHTML = document.getElementById('adminActivityTpl').innerHTML;
  const snap = await firebase.database().ref('/detections').get();
  const data = snap.val() || {};
  const rows = Object.values(data);
  const tbody = document.querySelector('#activityTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  rows.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.name}</td><td>${new Date(r.time*1000).toLocaleString()}</td><td>${r.camera}</td><td>${r.threatLevel}</td><td>${r.status}</td>`;
    tbody.appendChild(tr);
  });
}

async function renderAdminCameras(){
  contentEl.innerHTML = document.getElementById('adminCamerasTpl').innerHTML;
  async function refresh(){
    const cams = await api('/api/cameras');
    const list = document.getElementById('cameraList');
    if (!list) return;
    list.innerHTML = '';
    Object.entries(cams).forEach(([id, c]) => {
      const d = document.createElement('div');
      d.className = 'pending-item';
      d.textContent = `${c.name} • ${c.source} • ${c.active ? 'active' : 'inactive'}`;
      list.appendChild(d);
    });
  }
  await refresh();
  const form = document.getElementById('addCameraForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('camName').value;
    const src = document.getElementById('camSrc').value;
    await api('/api/cameras', { method: 'POST', body: JSON.stringify({ name, source: isNaN(Number(src)) ? src : Number(src) }) });
    await refresh();
  });
}

async function renderAdminSettings(){
  contentEl.innerHTML = document.getElementById('adminSettingsTpl').innerHTML;

  document.getElementById('langForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const language = document.getElementById('language').value;
    await api('/api/user_language', { method: 'POST', body: JSON.stringify({ language }) });
    alert('Language saved');
  });

  document.getElementById('addUserForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const name = document.getElementById('newName').value;
    const email = document.getElementById('newEmail').value;
    const password = document.getElementById('newPassword').value;
    const role = document.getElementById('newRole').value;
    await api('/api/add_user', { method: 'POST', body: JSON.stringify({ name, email, password, role }) });
    alert('User created');
    e.target.reset();
  });

  // Change password
  document.getElementById('adminPwForm')?.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const oldPw = document.getElementById('adminOldPw').value;
    const newPw = document.getElementById('adminNewPw').value;
    try {
      const cred = firebase.auth.EmailAuthProvider.credential(auth.currentUser.email, oldPw);
      await auth.currentUser.reauthenticateWithCredential(cred);
      await auth.currentUser.updatePassword(newPw);
      alert('Password updated successfully');
      e.target.reset();
    } catch(err) {
      alert('Error updating password: ' + err.message);
    }
  });
}

async function renderPersonnelSettings(){
  contentEl.innerHTML = document.getElementById('personnelSettingsTpl').innerHTML;

  document.getElementById('p_langForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const language = document.getElementById('p_language').value;
    await api('/api/user_language', { method: 'POST', body: JSON.stringify({ language }) });
    alert('Language saved');
  });

  // Change password
  document.getElementById('p_pwForm')?.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const oldPw = document.getElementById('p_oldPw').value;
    const newPw = document.getElementById('p_newPw').value;
    try {
      const cred = firebase.auth.EmailAuthProvider.credential(auth.currentUser.email, oldPw);
      await auth.currentUser.reauthenticateWithCredential(cred);
      await auth.currentUser.updatePassword(newPw);
      alert('Password updated successfully');
      e.target.reset();
    } catch(err) {
      alert('Error updating password: ' + err.message);
    }
  });
}

// ---- Boot ----
if (!location.hash) location.hash = '#/login';
route();

/* =========================================================
   Styling-only helpers (do not affect business logic)
========================================================= */
// Mobile sidebar toggle
menuToggleBtn?.addEventListener('click', () => {
  // Toggle off-canvas sidebar only; desktop ignores via CSS
  sidebarEl?.classList.toggle('open');
  menuToggleBtn.classList.toggle('open');
});

// Close mobile sidebar after a nav click (so it doesn't cover main screen)
sidebarEl?.querySelectorAll('a').forEach(a => {
  a.addEventListener('click', () => {
    sidebarEl?.classList.remove('open');
    menuToggleBtn?.classList.remove('open');
  });
});

// Cursor glow follow + subtle scale on interactive hover
document.addEventListener('mousemove', (e) => {
  if (!cursorGlow) return;
  cursorGlow.style.left = e.pageX + 'px';
  cursorGlow.style.top = e.pageY + 'px';
  cursorGlow.style.opacity = '1';
});
['a','button','.pill','.card'].forEach(sel => {
  document.querySelectorAll(sel).forEach(el => {
    el.addEventListener('mouseenter', () => { if (cursorGlow) cursorGlow.style.transform = 'translate(-50%, -50%) scale(1.25)'; });
    el.addEventListener('mouseleave', () => { if (cursorGlow) cursorGlow.style.transform = 'translate(-50%, -50%) scale(1)'; });
  });
});
