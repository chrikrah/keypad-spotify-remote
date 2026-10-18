"use strict";
// The access token, the Mac's player id, the expiry and the radio topic arrive in the URL fragment,
// which the browser never sends to a server. Removed from the address bar at once.
const params = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, "", location.pathname);
const token = params.get("t"), device = params.get("d"), expires = Number(params.get("e") || 0) * 1000;
const topic = params.get("n"); // secret ntfy topic: the only way back to the Mac, used for radio only
const STATIONS = [
  { id: "1live", name: "1LIVE", sub: "WDR" },
  { id: "euskirchen", name: "Radio Euskirchen", sub: "Lokal" },
];
const PLAY_ICON = "M8 5v14l11-7z", PAUSE_ICON = "M6 5h4v14H6zm8 0h4v14h-4z";
const HEART_OUT = "M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z";
const HEART_FULL = "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z";
const FAVS = /^chris favou?rites\s+(\d{4})\b/i;
const YEAR = String(new Date().getFullYear());
const $ = id => document.getElementById(id);
let playingContext = null, currentTrack = null, isPlaying = false, ended = false, radioOn = null;
let favPlaylist = null, favTracks = new Set();

// --- API -------------------------------------------------------------------------------------------

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

async function paged(path, max = 500) {
  const items = [];
  for (let offset = 0; offset < max; offset += 50) {
    const r = await api(`${path}${path.includes("?") ? "&" : "?"}limit=50&offset=${offset}`);
    items.push(...(r?.items || []).filter(Boolean));
    if (!r?.next) break;
  }
  return items;
}

function image(images) {
  const list = (images || []).slice().sort((a, b) => (a.width || 0) - (b.width || 0));
  return (list.find(i => (i.width || 0) >= 200) || list[list.length - 1] || {}).url;
}

// --- Building blocks ---------------------------------------------------------------------------------

function tile(item, onTap, round = false) {
  const b = document.createElement("button");
  b.className = "tile" + (round ? " round" : "");
  if (item.uri) b.dataset.uri = item.uri;
  const src = image(item.images);
  const art = document.createElement(src ? "img" : "div");
  if (src) { art.src = src; art.alt = ""; art.loading = "lazy"; } else art.className = "ph";
  const name = document.createElement("span");
  name.textContent = item.name; // text only: a crafted name cannot inject markup
  b.append(art, name);
  b.addEventListener("click", onTap);
  return b;
}

function shelf(title, nodes, id) {
  if (!nodes.length) return null;
  const s = document.createElement("section"), h = document.createElement("h2"), row = document.createElement("div");
  if (id) s.id = id;
  h.textContent = title;
  row.className = "row";
  nodes.forEach(n => row.append(n));
  s.append(h, row);
  $("shelves").append(s);
  return s;
}

function mark() {
  document.querySelectorAll("[data-uri]").forEach(t => t.classList.toggle("playing", t.dataset.uri === playingContext));
}

// --- Playback ----------------------------------------------------------------------------------------

async function play(body) {
  if (radioOn) await radio(null);
  await api(`/me/player/play?device_id=${encodeURIComponent(device)}`, { method: "PUT", body: JSON.stringify(body) });
  playingContext = body.context_uri || null;
  mark();
  setTimeout(refresh, 800);
}

async function radio(station) {
  if (!topic) return;
  await fetch("https://ntfy.sh/" + encodeURIComponent(topic), { method: "POST", body: station ? "radio:" + station : "radio:stop" });
  radioOn = station;
  document.querySelectorAll(".station").forEach(b => b.classList.toggle("on", b.dataset.station === station));
  if (station) {
    const s = STATIONS.find(x => x.id === station);
    $("np-title").textContent = s.name;
    $("np-artist").textContent = "Radio on the Mac";
    $("np-art").removeAttribute("src");
    $("toggle-icon").setAttribute("d", PAUSE_ICON);
    document.querySelector("footer").classList.remove("idle");
    currentTrack = null;
    setHeart();
  }
}

async function refresh() {
  if (radioOn) return; // the bar shows the station while the radio plays
  const s = await api("/me/player").catch(() => null);
  const item = s?.item;
  isPlaying = !!s?.is_playing;
  $("toggle-icon").setAttribute("d", isPlaying ? PAUSE_ICON : PLAY_ICON);
  document.querySelector("footer").classList.toggle("idle", !item);
  currentTrack = item?.type === "track" ? item.uri : null;
  if (item) {
    $("np-title").textContent = item.name;
    $("np-artist").textContent = (item.artists || (item.show ? [item.show] : [])).map(a => a.name).join(", ");
    const art = image(item.album?.images || item.images);
    if (art) $("np-art").src = art;
  }
  setHeart();
  playingContext = s?.context?.uri || playingContext;
  mark();
}

// --- Heart: this year's "Chris Favorites YYYY" -------------------------------------------------------

function setHeart() {
  const on = !!currentTrack && favTracks.has(currentTrack);
  $("heart-icon").setAttribute("d", on ? HEART_FULL : HEART_OUT);
  $("heart").classList.toggle("on", on);
  $("heart").setAttribute("aria-pressed", String(on));
  $("heart").disabled = !currentTrack;
}

async function loadFavTracks(playlist) {
  favTracks = new Set();
  if (!playlist) return;
  for (let offset = 0; offset < 2000; offset += 100) {
    // Spotify retired /tracks for new apps (403); /items nests the track under "item"
    const r = await api(`/playlists/${playlist.id}/items?limit=100&offset=${offset}`);
    (r?.items || []).forEach(i => i?.item?.uri && favTracks.add(i.item.uri));
    if (!r?.next) break;
  }
}

async function toggleHeart() {
  if (!currentTrack) return;
  if (!favPlaylist) { // first heart of a new year: start this year's playlist
    const body = JSON.stringify({ name: `Chris Favorites ${YEAR}`, public: false });
    favPlaylist = await api("/me/playlists", { method: "POST", body });
    if (!favPlaylist) {
      const me = await api("/me");
      favPlaylist = await api(`/users/${encodeURIComponent(me.id)}/playlists`, { method: "POST", body });
    }
    if (!favPlaylist) return;
  }
  const uri = currentTrack, has = favTracks.has(uri);
  await api(`/playlists/${favPlaylist.id}/items`, has
    ? { method: "DELETE", body: JSON.stringify({ items: [{ uri }] }) }
    : { method: "POST", body: JSON.stringify({ uris: [uri] }) });
  has ? favTracks.delete(uri) : favTracks.add(uri);
  setHeart();
}

// --- Search with an on-screen keyboard (the Hub has none) --------------------------------------------

const KEYS = ["1234567890", "qwertzuiopü", "asdfghjklöä", "yxcvbnmß"];
let query = "", searchTimer = null;

function buildKeyboard() {
  const kb = $("keyboard");
  KEYS.forEach(row => {
    const r = document.createElement("div");
    r.className = "krow";
    [...row].forEach(ch => r.append(key(ch, () => type(query + ch))));
    kb.append(r);
  });
  const last = document.createElement("div");
  last.className = "krow";
  last.append(key("Clear", () => type(""), "wide"), key("Space", () => type(query + " "), "space"), key("⌫", () => type(query.slice(0, -1)), "wide"));
  kb.append(last);
}

function key(label, onTap, cls = "") {
  const b = document.createElement("button");
  b.className = "key " + cls;
  b.textContent = label;
  b.addEventListener("click", onTap);
  return b;
}

function type(q) {
  query = q;
  $("query").textContent = q || "Search Spotify";
  $("query").classList.toggle("empty", !q);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, 350);
}

function hit(kind, item, images, sub, body) {
  const b = document.createElement("button");
  b.className = "hit";
  const src = image(images);
  const art = document.createElement(src ? "img" : "div");
  if (src) { art.src = src; art.alt = ""; } else art.className = "ph";
  if (kind === "Artist") art.classList.add("round");
  const text = document.createElement("div"), t = document.createElement("b"), s = document.createElement("span");
  t.textContent = item.name;
  s.textContent = sub ? `${kind} · ${sub}` : kind;
  text.append(t, s);
  b.append(art, text);
  b.addEventListener("click", () => { openSearch(false); play(body); });
  return b;
}

async function search() {
  const res = $("results");
  if (!query.trim()) { res.replaceChildren(); return; }
  const q = query;
  const r = await api(`/search?type=track,artist,playlist,album&limit=6&q=${encodeURIComponent(q)}`).catch(() => null);
  if (q !== query || !r) return;
  const names = list => (list || []).map(a => a.name).join(", ");
  const ok = list => (list || []).filter(Boolean);
  res.replaceChildren(
    ...ok(r.tracks?.items).map(t => hit("Song", t, t.album?.images, names(t.artists), { uris: [t.uri] })),
    ...ok(r.artists?.items).slice(0, 4).map(a => hit("Artist", a, a.images, "", { context_uri: a.uri })),
    ...ok(r.playlists?.items).slice(0, 4).map(p => hit("Playlist", p, p.images, p.owner?.display_name, { context_uri: p.uri })),
    ...ok(r.albums?.items).slice(0, 4).map(a => hit("Album", a, a.images, names(a.artists), { context_uri: a.uri })),
  );
}

function openSearch(open) {
  $("search").hidden = !open;
  if (open) type(query);
}

// --- Page ----------------------------------------------------------------------------------------------

function greet() {
  const h = new Date().getHours();
  $("greeting").textContent = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

$("toggle").addEventListener("click", async () => {
  if (radioOn) { await radio(null); setTimeout(refresh, 500); return; }
  await api(`/me/player/${isPlaying ? "pause" : "play"}?device_id=${encodeURIComponent(device)}`, { method: "PUT" });
  setTimeout(refresh, 500);
});
$("next").addEventListener("click", async () => { await api("/me/player/next", { method: "POST" }); setTimeout(refresh, 600); });
$("prev").addEventListener("click", async () => { await api("/me/player/previous", { method: "POST" }); setTimeout(refresh, 600); });
$("heart").addEventListener("click", toggleHeart);
$("open-search").addEventListener("click", () => openSearch(true));
$("close-search").addEventListener("click", () => openSearch(false));

(async () => {
  if (!token || !device) { notice("Open this from the keypad", "Tap the Spotify key"); return; }
  greet();
  buildKeyboard();
  const [playlists, artists] = await Promise.all([
    paged("/me/playlists").catch(() => []),
    api("/me/top/artists?limit=20&time_range=medium_term").then(r => r?.items || []).catch(() => []),
  ]);
  // 1. Chris Favorites, newest year first; the row is titled, so each caption is just the year
  const favs = playlists.filter(p => FAVS.test(p.name || ""))
    .map(p => ({ p, year: p.name.match(FAVS)[1] }))
    .sort((a, b) => b.year.localeCompare(a.year));
  favPlaylist = (favs.find(f => f.year === YEAR) || {}).p || null;
  shelf("Chris Favorites", favs.map(({ p, year }) => tile({ ...p, name: year }, () => play({ context_uri: p.uri }))));
  // 2. Made for you: Spotify blocks its own mixes for new apps, so this is built from his top artists
  shelf("Made for you", artists.map(a => tile(a, () => play({ context_uri: a.uri }), true)));
  // 3. Radio: played on the Mac through the secret topic; stations are ids, never URLs
  if (topic) {
    shelf("Radio", STATIONS.map(s => {
      const b = document.createElement("button");
      b.className = "station";
      b.dataset.station = s.id;
      const n = document.createElement("b"), sub = document.createElement("span");
      n.textContent = s.name; sub.textContent = s.sub;
      b.append(n, sub);
      b.addEventListener("click", async () => {
        if (radioOn === s.id) { await radio(null); return; }
        if (isPlaying) await api(`/me/player/pause?device_id=${encodeURIComponent(device)}`, { method: "PUT" }).catch(() => null);
        isPlaying = false;
        await radio(s.id);
      });
      return b;
    }));
  }
  // 4. Every other playlist
  shelf("Your playlists", playlists.filter(p => !FAVS.test(p.name || "")).map(p => tile(p, () => play({ context_uri: p.uri }))));
  loadFavTracks(favPlaylist).then(setHeart).catch(() => null);
  refresh();
  const timer = setInterval(() => (ended ? clearInterval(timer) : refresh()), 5000);
})();
