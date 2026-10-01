const configuredApi = String(window.DC_LIVE_CONFIG?.apiBase || "").replace(/\/+$/, "");
const storedApi = String(localStorage.getItem("dcLiveApiBase") || "").replace(/\/+$/, "");
const API_BASE = storedApi || configuredApi;

const state = {
  user: null,
  events: [],
  library: [],
  authMode: "login",
  recoveryMode: "none",
  socialProviders: {},
  recoveryConfigured: false,
  resetToken: "",
  masterTurnstileToken: "",
  masterWidgetId: null
};

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
const masterAuthToggle = $("#master-auth-toggle");
const masterTurnstileWrap = $("#master-turnstile-wrap");
const socialAuth = $("#social-auth");
const forgotPasswordButton = $("#forgot-password-button");
const recoveryBackButton = $("#recovery-back-button");
const authPassword = $("#auth-password");
const authPasswordConfirm = $("#auth-password-confirm");

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
  accountButton.textContent = state.user ? (state.user.role === "owner" ? "ICA MASTER" : state.user.email) : "Sign in";
  $("#viewer-state").textContent = state.user ? (state.user.role === "owner" ? "Owner session" : "Signed in") : "Guest viewer";
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

function renderMasterTurnstile() {
  state.masterTurnstileToken = "";
  if (!window.turnstile) {
    setTimeout(renderMasterTurnstile, 250);
    return;
  }
  const node = $("#master-turnstile");
  if (!node) return;
  if (state.masterWidgetId !== null) {
    try { window.turnstile.remove(state.masterWidgetId); } catch {}
  }
  state.masterWidgetId = window.turnstile.render(node, {
    sitekey: "0x4AAAAAAErtQB79-xi-UTHQ",
    theme: "dark",
    action: "ica_master_login",
    callback: token => { state.masterTurnstileToken = token || ""; authMessage.textContent = ""; },
    "expired-callback": () => { state.masterTurnstileToken = ""; },
    "error-callback": () => { state.masterTurnstileToken = ""; authMessage.textContent = "Cloudflare security check failed."; }
  });
}

function renderSocialButtons() {
  const available = Object.entries(state.socialProviders).filter(([, enabled]) => Boolean(enabled));
  document.querySelectorAll("[data-social-provider]").forEach(button => {
    const provider = button.dataset.socialProvider;
    button.hidden = !state.socialProviders[provider];
  });
  socialAuth.hidden = !available.length || state.authMode === "master" || state.recoveryMode !== "none";
}

async function loadAccountSupport() {
  try {
    const [social, recovery] = await Promise.all([
      api("/api/auth/social/status"),
      api("/api/auth/password-reset/status")
    ]);
    state.socialProviders = social.providers || {};
    state.recoveryConfigured = Boolean(recovery.configured);
  } catch {
    state.socialProviders = {};
    state.recoveryConfigured = false;
  }
  renderSocialButtons();
}

function setRecoveryMode(mode, token = "") {
  state.recoveryMode = mode;
  if (token) state.resetToken = token;

  const requesting = mode === "request";
  const resetting = mode === "reset";
  const active = requesting || resetting;

  authTitle.textContent = requesting ? "Reset password" : resetting ? "Choose a new password" : state.authMode === "register" ? "Create account" : "Sign in";
  authSubmit.textContent = requesting ? "Send reset link" : resetting ? "Reset password" : state.authMode === "master" ? "Enter as owner" : state.authMode === "register" ? "Create account" : "Sign in";

  $("#auth-email").hidden = resetting;
  $("#auth-email").required = !resetting;
  authPassword.hidden = requesting;
  authPassword.required = !requesting;
  authPassword.autocomplete = resetting ? "new-password" : state.authMode === "register" ? "new-password" : "current-password";
  authPasswordConfirm.hidden = !resetting;
  authPasswordConfirm.required = resetting;

  forgotPasswordButton.hidden = active || state.authMode !== "login" || !state.recoveryConfigured;
  recoveryBackButton.hidden = !active;
  authToggle.hidden = active || state.authMode === "master";
  masterAuthToggle.hidden = active || state.authMode === "master";
  masterTurnstileWrap.hidden = state.authMode !== "master" || active;
  renderSocialButtons();
}

function openAuth(mode = "login") {
  state.authMode = mode;
  state.recoveryMode = "none";
  const master = mode === "master";
  authTitle.textContent = master ? "ICA Master Owner" : mode === "register" ? "Create account" : "Sign in";
  authSubmit.textContent = master ? "Enter as owner" : mode === "register" ? "Create account" : "Sign in";
  $("#auth-email").hidden = false;
  $("#auth-email").required = true;
  authPassword.hidden = false;
  authPassword.required = true;
  authPasswordConfirm.hidden = true;
  authPasswordConfirm.required = false;
  forgotPasswordButton.hidden = master || mode !== "login" || !state.recoveryConfigured;
  recoveryBackButton.hidden = true;
  authToggle.hidden = master;
  masterAuthToggle.hidden = master;
  masterTurnstileWrap.hidden = !master;
  authMessage.textContent = "";
  modal.hidden = false;
  renderSocialButtons();
  if (master) renderMasterTurnstile();
}

function closeAuth() {
  modal.hidden = true;
  state.recoveryMode = "none";
  authToggle.hidden = false;
  masterAuthToggle.hidden = false;
  masterTurnstileWrap.hidden = true;
  recoveryBackButton.hidden = true;
}

async function authSubmitHandler(event) {
  event.preventDefault();
  authMessage.textContent = "Working…";
  try {
    if (state.recoveryMode === "request") {
      const data = await api("/api/auth/password-reset/request", {
        method: "POST",
        body: JSON.stringify({ email: $("#auth-email").value.trim() })
      });
      authMessage.textContent = data.message || "If that account exists, a reset link will be sent.";
      return;
    }

    if (state.recoveryMode === "reset") {
      if (authPassword.value !== authPasswordConfirm.value) throw new Error("The passwords do not match.");
      const data = await api("/api/auth/password-reset/confirm", {
        method: "POST",
        body: JSON.stringify({ token: state.resetToken, password: authPassword.value })
      });
      state.resetToken = "";
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
      state.authMode = "login";
      setRecoveryMode("none");
      authMessage.textContent = data.message || "Password updated. Sign in with your new password.";
      authPassword.value = "";
      authPasswordConfirm.value = "";
      return;
    }

    const master = state.authMode === "master";
    if (master && !state.masterTurnstileToken) throw new Error("Complete the Cloudflare security check.");
    const path = master ? "/api/auth/master-login" : state.authMode === "register" ? "/api/auth/register" : "/api/auth/login";
    const data = await api(path, {
      method: "POST",
      body: JSON.stringify({
        email: $("#auth-email").value.trim(),
        password: authPassword.value,
        ...(master ? { turnstileToken: state.masterTurnstileToken } : {})
      })
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
masterAuthToggle.addEventListener("click", () => openAuth("master"));
forgotPasswordButton.addEventListener("click", () => {
  authMessage.textContent = "";
  setRecoveryMode("request");
});
recoveryBackButton.addEventListener("click", () => {
  authMessage.textContent = "";
  state.authMode = "login";
  setRecoveryMode("none");
});
document.querySelectorAll("[data-social-provider]").forEach(button => {
  button.addEventListener("click", () => {
    const provider = button.dataset.socialProvider;
    if (!provider || !state.socialProviders[provider]) return;
    window.location.assign(apiUrl("/api/auth/social/" + provider + "/start"));
  });
});
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
  await loadAccountSupport();

  const params = new URLSearchParams(window.location.search);
  const resetToken = params.get("reset_token") || "";
  const socialError = params.get("social_error") || "";
  const socialProvider = params.get("social") || "";

  await loadMe();

  if (resetToken) {
    openAuth("login");
    setRecoveryMode("reset", resetToken);
  } else if (socialError) {
    openAuth("login");
    authMessage.textContent = socialError;
  } else if (socialProvider && state.user) {
    params.delete("social");
    const query = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (query ? "?" + query : "") + window.location.hash);
  }

  await Promise.all([loadEvents(), loadLibrary()]);
})();
