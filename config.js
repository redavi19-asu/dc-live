window.DC_LIVE_CONFIG = {
  apiBase: ""
};

(() => {
  const queryApi = new URLSearchParams(window.location.search).get("api");
  if (queryApi) {
    try {
      localStorage.setItem("dcLiveApiBase", queryApi.replace(/\/+$/, ""));
      const clean = new URL(window.location.href);
      clean.searchParams.delete("api");
      window.history.replaceState({}, "", clean);
    } catch {}
  }
})();
