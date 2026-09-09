const configuredApi = String(window.DC_LIVE_CONFIG?.apiBase || "").replace(/\/+$/, "");
const storedApi = String(localStorage.getItem("dcLiveApiBase") || "").replace(/\/+$/, "");
const API_BASE = storedApi || configuredApi;

const state = { user: null, events: [], library: [], authMode: "login" };

const $ = selector => document.querySelector(selector);
const apiStatus = $("#api-status");
const accountButton = $("#account-button");
const grid = $("#event-grid");
const libraryGrid = $("#library-grid");
const eventsNote = $("#events-note");
const libraryNote = $("#library-note");
const modal = $("#auth-modal");
const authTitle = $("#auth-title");
const authSubmit = $("#auth-submit");
const authToggle = $("#auth-toggle");
const authMessage = $("#auth-message");

function apiUrl(path) {
  return API_BASE ? API_BASE + path : path;
}

async function api(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function money(cents, currency = "usd") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: String(currency).toUpperCase() }).format((Number(cents) || 0) / 100);
}

function dateLabel(value) {
  if (!value) return "Date TBA";
  return new Date(Number(value)).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function eventCard(event, library = false) {
  const paid = event.accessType === "paid";
  const action = library ? "Watch" : paid ? `Unlock ${money(event.priceCents, event.currency)}` : "Watch";
  const status = String(event.status || "scheduled").toUpperCase();
  const poster = event.posterUrl ? `style="background-image:linear-gradient(180deg,rgba(0,0,0,.08),rgba(0,0,0,.78)),url('${apiUrl(event.posterUrl)}')"` : "";
  return `
    <article class="event-card ${event.posterUrl ? "with-poster" : ""}" ${poster}>
      <div>
        <span class="event-status">${status}</span>
        <h3>${event.title || "Untitled event"}</h3>
        <p>${event.description || "DC Live event"}</p>
      </div>
      <div class="event-bottom">
        <span>${dateLabel(event.startsAt)}</span>
        <button class="event-action" data-slug="${event.slug}" data-library="${library ? "1" : "0"}" type="button">${action} →</button>
      </div>
    </article>`;
}

function renderEvents() {
  grid.innerHTML = state.events.length ? state.events.map(e => eventCard(e)).join("") :
    '<div class="empty-state">No public events are available yet.</div>';
}

function renderLibrary() {
  libraryGrid.innerHTML = state.library.length ? state.library.map(e => eventCard(e, true)).join("") :
    '<div class="empty-state">No unlocked events yet.</div>';
}

function updateAccountUI() {
  accountButton.textContent = state.user ? state.user.email : "Sign in";
  $("#viewer-state").textContent = state.user ? "Signed in" : "Guest viewer";
  libraryNote.textContent = state.user ? "Your active event access appears here." : "Sign in to see purchased or rented events.";
}

async function loadHealth() {
  try {
    const data = await api("/health");
    apiStatus.textContent = data.ok ? "API ONLINE" : "API ISSUE";
    apiStatus.classList.toggle("online", Boolean(data.ok));
    return true;
  } catch {
    apiStatus.textContent = API_BASE ? "API OFFLINE" : "API NOT SET";
    apiStatus.classList.remove("online");
    eventsNote.textContent = API_BASE
      ? "The Cloudflare API could not be reached."
      : "Cloudflare Worker hostname still needs to be set in config.js.";
    return false;
  }
}

async function loadMe() {
  try {
    const data = await api("/api/auth/me");
    state.user = data.user || null;
  } catch { state.user = null; }
  updateAccountUI();
}

async function loadEvents() {
  try {
    const data = await api("/api/events");
    state.events = Array.isArray(data.events) ? data.events : [];
    eventsNote.textContent = "Live data from the DC Live backend.";
    renderEvents();
  } catch (error) {
    eventsNote.textContent = error.message;
    renderEvents();
  }
}

async function loadLibrary() {
  if (!state.user) {
    state.library = [];
    renderLibrary();
    return;
  }
  try {
    const data = await api("/api/library");
    state.library = Array.isArray(data.events) ? data.events : [];
    renderLibrary();
  } catch (error) {
    libraryNote.textContent = error.message;
  }
}

function openAuth(mode = "login") {
  state.authMode = mode;
  authTitle.textContent = mode === "register" ? "Create account" : "Sign in";
  authSubmit.textContent = mode === "register" ? "Create account" : "Sign in";
  authToggle.textContent = mode === "register" ? "Already have an account? Sign in" : "Need an account? Register";
  authMessage.textContent = "";
  modal.hidden = false;
}

function closeAuth() { modal.hidden = true; }

async function authSubmitHandler(event) {
  event.preventDefault();
  authMessage.textContent = "Working…";
  try {
    const path = state.authMode === "register" ? "/api/auth/register" : "/api/auth/login";
    const data = await api(path, {
      method: "POST",
      body: JSON.stringify({ email: $("#auth-email").value.trim(), password: $("#auth-password").value })
    });
    state.user = data.user || null;
    closeAuth();
    updateAccountUI();
    await loadLibrary();
  } catch (error) {
    authMessage.textContent = error.message;
  }
}

async function selectEvent(slug, fromLibrary) {
  try {
    const data = await api(`/api/events/${encodeURIComponent(slug)}`);
    const event = data.event;
    if (!event) throw new Error("Event not found.");

    if (event.accessType === "paid" && !fromLibrary) {
      if (!state.user) return openAuth("login");
      const checkout = await api(`/api/events/${encodeURIComponent(slug)}/checkout`, { method: "POST", body: "{}" });
      if (checkout.checkoutUrl) window.location.href = checkout.checkoutUrl;
      return;
    }

    const playback = await api(`/api/events/${encodeURIComponent(slug)}/playback`, { method: "POST", body: "{}" });
    if (!playback.playbackUrl) throw new Error("Playback is not available.");

    const player = $("#video-player");
    $("#player-placeholder").hidden = true;
    player.hidden = false;
    player.src = apiUrl(playback.playbackUrl);
    $("#player-title").textContent = event.title;
    $("#player-state").textContent = "PLAYBACK AUTHORIZED";
    player.play().catch(() => {});
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    alert(error.message);
  }
}

accountButton.addEventListener("click", async () => {
  if (!state.user) return openAuth("login");
  if (confirm(`Signed in as ${state.user.email}. Sign out?`)) {
    try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch {}
    state.user = null;
    state.library = [];
    updateAccountUI();
    renderLibrary();
  }
});
$("#library-button").addEventListener("click", () => {
  if (!state.user) return openAuth("login");
  $("#library").scrollIntoView({ behavior: "smooth" });
});
$("#close-auth").addEventListener("click", closeAuth);
authToggle.addEventListener("click", () => openAuth(state.authMode === "register" ? "login" : "register"));
$("#auth-form").addEventListener("submit", authSubmitHandler);
modal.addEventListener("click", e => { if (e.target === modal) closeAuth(); });
document.addEventListener("click", e => {
  const button = e.target.closest(".event-action");
  if (button) selectEvent(button.dataset.slug, button.dataset.library === "1");
});

(async function init() {
  renderEvents();
  renderLibrary();
  const online = await loadHealth();
  if (!online) return;
  await loadMe();
  await Promise.all([loadEvents(), loadLibrary()]);
})();
