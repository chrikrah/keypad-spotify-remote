"use strict";
// The access token, the Mac's device id and the expiry arrive in the URL fragment, which the browser
// never sends to a server. Removed from the address bar at once.
const params = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, "", location.pathname);
const token = params.get("t"), device = params.get("d"), expires = Number(params.get("e") || 0) * 1000;
const PLAY_ICON = "M8 5v14l11-7z", PAUSE_ICON = "M6 5h4v14H6zm8 0h4v14h-4z";
const $ = id => document.getElementById(id);
let playingContext = null, isPlaying = false, ended = false;

function notice(text, sub) {
  const n = $("notice");
  n.textContent = text;
  if (sub) { const s = document.createElement("small"); s.textContent = sub; n.append(s); }
  n.classList.add("show");
}

function endSession() {
  ended = true;
  notice("Session ended", "Tap the Spotify key on the keypad again");
}

async function api(path, opts = {}) {
  if (ended || Date.now() > expires) { endSession(); throw new Error("expired"); }
  const r = await fetch("https://api.spotify.com/v1" + path, {
    ...opts, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  });
  if (r.status === 401) { endSession(); throw new Error("401"); }
  if (!r.ok || r.status === 204) return null;
  return r.json().catch(() => null);
}

function image(images) {
  const list = (images || []).slice().sort((a, b) => (a.width || 0) - (b.width || 0));
  return (list.find(i => (i.width || 0) >= 200) || list[list.length - 1] || {}).url;
}

function tile(item) {
  const b = document.createElement("button");
  b.className = "tile";
  b.dataset.uri = item.uri;
  const src = image(item.images);
  const art = document.createElement(src ? "img" : "div");
  if (src) { art.src = src; art.alt = ""; art.loading = "lazy"; } else art.className = "ph";
  const name = document.createElement("span");
  name.textContent = item.name; // text only: a crafted playlist name cannot inject markup
  b.append(art, name);
  b.addEventListener("click", () => play(item.uri));
  return b;
}

function shelf(title, items) {
  const seen = new Set();
  const unique = items.filter(i => i && i.uri && !seen.has(i.uri) && seen.add(i.uri));
  if (!unique.length) return;
  const s = document.createElement("section"), h = document.createElement("h2"), row = document.createElement("div");
  h.textContent = title;
  row.className = "row";
  unique.forEach(i => row.append(tile(i)));
  s.append(h, row);
  $("shelves").append(s);
}

async function recentContexts() {
  const r = await api("/me/player/recently-played?limit=50");
  const uris = [...new Set((r?.items || []).map(i => i.context?.uri)
    .filter(u => u && /^spotify:(playlist|album):[A-Za-z0-9]+$/.test(u)))].slice(0, 12);
  const items = await Promise.all(uris.map(u => {
    const [, kind, id] = u.split(":");
    return api(`/${kind}s/${id}`).catch(() => null);
  }));
  return items.filter(Boolean);
}

function quickGrid(items) {
  const seen = new Set();
  const unique = items.filter(i => i && i.uri && !seen.has(i.uri) && seen.add(i.uri)).slice(0, 8);
  if (!unique.length) return;
  const grid = document.createElement("div");
  grid.className = "quick";
  unique.forEach(item => {
    const b = document.createElement("button");
    b.dataset.uri = item.uri;
    const src = image(item.images);
    const art = document.createElement(src ? "img" : "div");
    if (src) { art.src = src; art.alt = ""; } else art.className = "ph";
    const name = document.createElement("span");
    name.textContent = item.name;
    if (/\S{15,}/.test(item.name)) name.className = "oneline"; // a long word must not break mid-word
    b.append(art, name);
    b.addEventListener("click", () => play(item.uri));
    grid.append(b);
  });
  $("shelves").append(grid);
}

function greeting() {
  const h = new Date().getHours();
  const g = document.createElement("h1");
  g.textContent = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  $("shelves").append(g);
}

function mark() {
  document.querySelectorAll("[data-uri]").forEach(t => t.classList.toggle("playing", t.dataset.uri === playingContext));
}

async function play(uri) {
  await api(`/me/player/play?device_id=${encodeURIComponent(device)}`, {
    method: "PUT", body: JSON.stringify({ context_uri: uri }),
  });
  playingContext = uri;
  mark();
  setTimeout(refresh, 800);
}

async function refresh() {
  const s = await api("/me/player").catch(() => null);
  const item = s?.item;
  isPlaying = !!s?.is_playing;
  $("toggle-icon").setAttribute("d", isPlaying ? PAUSE_ICON : PLAY_ICON);
  document.querySelector("footer").classList.toggle("idle", !item);
  if (item) {
    $("np-title").textContent = item.name;
    $("np-artist").textContent = (item.artists || (item.show ? [item.show] : [])).map(a => a.name).join(", ");
    const art = image(item.album?.images || item.images);
    if (art) $("np-art").src = art;
  }
  playingContext = s?.context?.uri || playingContext;
  mark();
}

$("toggle").addEventListener("click", async () => {
  await api(`/me/player/${isPlaying ? "pause" : "play"}?device_id=${encodeURIComponent(device)}`, { method: "PUT" });
  setTimeout(refresh, 500);
});
$("next").addEventListener("click", async () => { await api("/me/player/next", { method: "POST" }); setTimeout(refresh, 600); });
$("prev").addEventListener("click", async () => { await api("/me/player/previous", { method: "POST" }); setTimeout(refresh, 600); });

(async () => {
  if (!token || !device) { notice("Open this from the keypad", "Tap the Spotify key"); return; }
  const [recent, playlists, albums] = await Promise.all([
    recentContexts().catch(() => []),
    api("/me/playlists?limit=50").then(r => r?.items || []).catch(() => []),
    api("/me/albums?limit=30").then(r => (r?.items || []).map(i => i.album)).catch(() => []),
  ]);
  greeting();
  quickGrid([...recent, ...playlists]);
  shelf("Your playlists", playlists);
  shelf("Saved albums", albums);
  shelf("Recently played", recent.slice(8));
  refresh();
  const timer = setInterval(() => (ended ? clearInterval(timer) : refresh()), 5000);
})();
