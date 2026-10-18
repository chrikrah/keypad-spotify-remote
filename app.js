"use strict";
// The access token, the Mac's player id, the expiry, the Mac topic and the listening totals arrive in the
// URL fragment, which the browser never sends to a server. Removed from the address bar at once.
const params = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, "", location.pathname);
let token = params.get("t"), expires = Number(params.get("e") || 0) * 1000;
const device = params.get("d");
// While music plays the Mac sends a fresh token before this one runs out, AES-GCM sealed with this key,
// so the ntfy topic only ever carries ciphertext
const sealKey = params.get("k") ? crypto.subtle.importKey("raw", b64(params.get("k")), "AES-GCM", false, ["decrypt"]) : null;
const topic = params.get("n"); // secret ntfy topic: the only way back to the Mac (radio, YouTube, song text)
const totals = params.get("s"); // "yearMinutes,decadeMinutes,firstDay" from the Mac's play ledger
// Spotify's own playlists answer 404 to new apps but still play by uri (measured), so the Mac sends their uris,
// names and covers: {"discover": [[uri, name, image]], "focus": [...], "podcasts": [...]}
const picks = (() => { try { return JSON.parse(params.get("p") || "{}"); } catch { return {}; } })();
// Ids only: the Mac maps each to its stream or URL, and ignores anything else
const RADIO = [
  ["Radio Germany", [["1live", "1LIVE"], ["euskirchen", "Euskirchen"], ["wdr2", "WDR 2"], ["wdr4", "WDR 4"],
    ["wdr5", "WDR 5"], ["koeln", "Köln"], ["dlf", "DLF"], ["swr3", "SWR3"], ["bayern3", "Bayern 3"],
    ["antenne", "Antenne"], ["bigfm", "bigFM"], ["klassik", "Klassik"]]],
  ["Radio Canada", [["cbc-toronto", "CBC Toronto"], ["newstalk1010", "Newstalk 1010"], ["q107", "Q107"],
    ["indie88", "Indie88"], ["jazzfm", "Jazz.FM91"], ["cbc-victoria", "CBC Victoria"], ["cfax", "CFAX Victoria"],
    ["cbc-vancouver", "CBC Vancouver"], ["cfox", "CFOX"], ["cbc-music", "CBC Music"]]],
  ["Radio Bay Area, California & Texas", [["kqed", "KQED"], ["kalw", "KALW"], ["kpfa", "KPFA"], ["kcsm", "KCSM"],
    ["kfjc", "KFJC"], ["kzsu", "KZSU"], ["kcrw", "KCRW"], ["laist", "LAist"], ["kusc", "KUSC"], ["kut", "KUT"],
    ["kutx", "KUTX"], ["kuhf", "Houston PM"]]],
].map(([title, list]) => [title, list.map(([id, name]) =>
  ({ id, name, kind: "radio", images: [{ url: `stations/${id}.png`, width: 256 }] }))]);
const STATIONS = RADIO.flatMap(([, list]) => list);
const YOUTUBE = [{ id: "great-music", name: "Great Music", kind: "yt", images: [{ url: "youtube/great-music.png", width: 256 }] }];
const PLAY_ICON = "M8 5v14l11-7z", PAUSE_ICON = "M6 5h4v14H6zm8 0h4v14h-4z";
const FAVS = /^chris favou?rites\s+(\d{4})\b/i;
const YEAR = String(new Date().getFullYear());
const $ = id => document.getElementById(id);
let playingContext = null, currentTrack = null, isPlaying = false, ended = false;
let shuffleOn = false, smartOn = false;
let external = null; // radio or YouTube playing on the Mac outside Spotify: { kind, id, name }
let favPlaylist = null, favIds = [];
const itemsCache = new Map(); // playlist id -> Set of track uris

// --- API -------------------------------------------------------------------------------------------

function notice(text, sub) {
  const n = $("notice");
  n.textContent = text;
  if (sub) { const s = document.createElement("small"); s.textContent = sub; n.append(s); }
  n.classList.add("show");
}

function b64(text) {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
}

async function openSeal(sealed) {
  if (!sealKey) return;
  const raw = b64(sealed);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await sealKey, raw.slice(12));
    const next = JSON.parse(new TextDecoder().decode(plain));
    if (next.e * 1000 > expires) { token = next.t; expires = next.e * 1000; }
  } catch { /* sealed for an earlier cast */ }
}

// The Mac quits the page, so the Hub shows its clock and photos again. Text only when the Mac does not answer.
function endSession() {
  if (ended) return;
  ended = true;
  if (topic) toMac("hub:quit").catch(() => {});
  setTimeout(() => notice("Session ended", "Press the Spotify key on the keypad"), topic ? 15000 : 0);
}

async function api(path, opts = {}) {
  if (ended || Date.now() > expires) { endSession(); throw new Error("expired"); }
  const r = await fetch("https://api.spotify.com/v1" + path, {
    ...opts, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  });
  if (r.status === 401) { endSession(); throw new Error("401"); }
  if (!r.ok) return null;
  if (r.status === 204) return {};
  return r.json().catch(() => ({}));
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

const toMac = message => fetch("https://ntfy.sh/" + encodeURIComponent(topic), { method: "POST", body: message });
const onMac = `?device_id=${encodeURIComponent(device)}`;

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

function shelf(title, nodes, parent = $("shelves")) {
  if (!nodes.length) return null;
  const s = document.createElement("section"), h = document.createElement("h2"), row = document.createElement("div");
  h.textContent = title;
  row.className = "row";
  nodes.forEach(n => row.append(n));
  s.append(h, row);
  parent.append(s);
  return s;
}

// Two shelves side by side, half the width each (one above the other on a narrow screen)
function split(left, right) {
  const box = document.createElement("div");
  box.className = "split";
  $("shelves").append(box);
  [left, right].forEach(([title, nodes]) => shelf(title, nodes, box));
  if (!box.children.length) box.remove();
}

// Only Spotify uris of the expected kinds pass: the fragment is ours, but a tile must never play anything else
const pick = ([uri, name, img]) => /^spotify:(playlist|show):[A-Za-z0-9]{22}$/.test(uri) &&
  ({ uri, name, images: img ? [{ url: img, width: 300 }] : [] });

function mark() {
  const on = external ? `${external.kind}:${external.id}` : playingContext;
  document.querySelectorAll("[data-uri]").forEach(t => t.classList.toggle("playing", t.dataset.uri === on));
}

// --- Playback ----------------------------------------------------------------------------------------

async function play(body) {
  if (external) await stopExternal();
  await api(`/me/player/play${onMac}`, { method: "PUT", body: JSON.stringify(body) });
  playingContext = body.context_uri || null;
  mark();
  setTimeout(refresh, 800);
}

// Playlists and artists always play shuffled (Christopher, 2026-10-18). Smart Shuffle cannot be switched on
// through the Web API (measured), so when he has it on in the Spotify app it is left alone, else plain shuffle.
async function playShuffled(uri, total) {
  const body = { context_uri: uri };
  if (total > 1) body.offset = { position: Math.floor(Math.random() * total) };
  if (!smartOn && !shuffleOn) await api(`/me/player/shuffle${onMac}&state=true`, { method: "PUT" }).catch(() => null);
  await play(body);
  // A shuffle sent while the new context loads is dropped (measured), so send it again once it plays
  await new Promise(r => setTimeout(r, 1500));
  if (!smartOn) await api(`/me/player/shuffle${onMac}&state=true`, { method: "PUT" }).catch(() => null);
}

// A podcast plays its newest episode and goes on in order, so shuffle is switched off for it
async function playShow(uri) {
  const latest = await api(`/shows/${uri.split(":")[2]}/episodes?market=from_token&limit=1`).catch(() => null);
  await api(`/me/player/shuffle${onMac}&state=false`, { method: "PUT" }).catch(() => null);
  const ep = latest?.items?.[0]?.uri;
  await play(ep ? { context_uri: uri, offset: { uri: ep } } : { context_uri: uri });
}

const playlistTotal = p => p.items?.total ?? p.tracks?.total ?? 0;

function showExternal(item, line) {
  $("np-title").textContent = item.name;
  $("np-artist").textContent = line;
  $("np-art").src = image(item.images);
  $("toggle-icon").setAttribute("d", item.kind === "radio" ? PAUSE_ICON : PLAY_ICON);
  $("spark").hidden = true;
  document.querySelector("footer").classList.remove("idle");
  currentTrack = null;
  setHeart();
}

async function startExternal(item) {
  if (external?.kind === item.kind && external.id === item.id) { await stopExternal(); refresh(); return; }
  if (isPlaying) await api(`/me/player/pause${onMac}`, { method: "PUT" }).catch(() => null);
  isPlaying = false;
  await toMac(`${item.kind}:${item.id}`);
  external = item;
  showExternal(item, item.kind === "radio" ? "Live on the Mac" : "YouTube on the Mac");
  mark();
}

async function stopExternal() {
  if (external?.kind === "radio") await toMac("radio:stop");
  external = null;
  mark();
}

// The Mac reads each station's ICY metadata and posts it to "<topic>-now". Replaying the last hours tells
// a freshly cast page what already plays.
function followMac() {
  const es = new EventSource(`https://ntfy.sh/${encodeURIComponent(topic + "-now")}/sse?since=12h`);
  es.addEventListener("message", e => {
    let now;
    try { now = JSON.parse(JSON.parse(e.data).message); } catch { return; }
    if (now.seal) { openSeal(now.seal); return; }
    if (!now.station) {
      if (external?.kind === "radio") { external = null; mark(); refresh(); }
      return;
    }
    const station = STATIONS.find(s => s.id === now.station);
    if (!station) return;
    if (external?.id !== station.id) { external = station; mark(); }
    showExternal(station, now.title || "Live on the Mac");
  });
}

async function refresh() {
  if (external) return; // the bar shows the station or YouTube
  // without additional_types an episode comes back as item null, and the bar would keep the last song
  const s = await api("/me/player?additional_types=episode").catch(() => null);
  if (external) return; // the Mac reported a station while this call was in flight
  const item = s?.item;
  isPlaying = !!s?.is_playing;
  shuffleOn = !!s?.shuffle_state;
  smartOn = !!s?.smart_shuffle;
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
  markSuggestion(s);
}

// A Smart Shuffle suggestion is a song that is not in the playlist being played. The API has no flag for
// it, so the page compares against the playlist's own items.
async function markSuggestion(s) {
  const ctx = s?.context?.uri || "", id = ctx.startsWith("spotify:playlist:") ? ctx.split(":")[2] : null;
  const uri = currentTrack;
  if (!s?.smart_shuffle || !id || !uri) { $("spark").hidden = true; return; }
  const items = await playlistItems(id).catch(() => null);
  if (uri === currentTrack) $("spark").hidden = !items || items.has(uri);
}

// --- Heart: only for a song in none of the "Chris Favorites YYYY" ------------------------------------

async function playlistItems(id) {
  if (itemsCache.has(id)) return itemsCache.get(id);
  const set = new Set();
  for (let offset = 0; offset < 5000; offset += 100) {
    // Spotify retired /tracks for new apps (403); /items nests the track under "item"
    const r = await api(`/playlists/${id}/items?limit=100&offset=${offset}`);
    if (!r) throw new Error("items");
    (r.items || []).forEach(i => i?.item?.uri && set.add(i.item.uri));
    if (!r.next) break;
  }
  itemsCache.set(id, set);
  return set;
}

const inFavorites = uri => favIds.some(id => itemsCache.get(id)?.has(uri));
const favoritesLoaded = () => favIds.every(id => itemsCache.has(id));

function setHeart() {
  $("heart").classList.toggle("gone", !currentTrack || !favoritesLoaded() || inFavorites(currentTrack));
}

async function addHeart() {
  const uri = currentTrack;
  if (!uri || inFavorites(uri)) return;
  if (!favPlaylist) { // first heart of a new year: start this year's playlist
    const body = JSON.stringify({ name: `Chris Favorites ${YEAR}`, public: false });
    favPlaylist = await api("/me/playlists", { method: "POST", body });
    if (!favPlaylist?.id) { favPlaylist = null; return; }
    favIds.push(favPlaylist.id);
    itemsCache.set(favPlaylist.id, new Set());
  }
  if (await api(`/playlists/${favPlaylist.id}/items`, { method: "POST", body: JSON.stringify({ uris: [uri] }) })) {
    itemsCache.get(favPlaylist.id).add(uri);
    setHeart();
  }
}

// --- Search with an on-screen keyboard (the Hub has none) --------------------------------------------

const KEYS = ["1234567890", "qwertzuiopü", "asdfghjklöä", "yxcvbnmß"];
const BACKSPACE = "M22 5v14H8l-6-7 6-7zm-2 2H8.9l-4.3 5 4.3 5H20zm-9.4 2.4L12 8l2.5 2.5L17 8l1.4 1.4-2.5 2.6 2.5 2.5L17 16l-2.5-2.5L12 16l-1.4-1.4 2.5-2.6z";
let query = "", searchTimer = null;

function buildKeyboard() {
  const kb = $("keyboard");
  KEYS.forEach((row, i) => {
    const r = document.createElement("div");
    r.className = "krow";
    [...row].forEach(ch => r.append(key(ch, () => type(query + ch))));
    if (i === KEYS.length - 1) r.append(key(icon(BACKSPACE, "Delete"), () => type(query.slice(0, -1)), "wide"));
    kb.append(r);
  });
  const last = document.createElement("div");
  last.className = "krow";
  last.append(key("Clear", () => type(""), "wide"), key("Space", () => type(query + " "), "space"));
  kb.append(last);
}

function icon(d, label) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), p = document.createElementNS(svg.namespaceURI, "path");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  p.setAttribute("d", d);
  svg.append(p);
  return svg;
}

function key(label, onTap, cls = "") {
  const b = document.createElement("button");
  b.className = "key " + cls;
  b.append(label);
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

function hit(kind, item, images, sub, onTap) {
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
  b.addEventListener("click", () => { openSearch(false); onTap(); });
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
    // A bare track uri answers 204 and plays nothing on the Mac app (measured); its album with an offset plays
    ...ok(r.tracks?.items).map(t => hit("Song", t, t.album?.images, names(t.artists),
      () => play({ context_uri: t.album.uri, offset: { uri: t.uri } }))),
    ...ok(r.artists?.items).slice(0, 4).map(a => hit("Artist", a, a.images, "", () => playShuffled(a.uri, 0))),
    ...ok(r.playlists?.items).slice(0, 4).map(p => hit("Playlist", p, p.images, p.owner?.display_name,
      () => playShuffled(p.uri, playlistTotal(p)))),
    ...ok(r.albums?.items).slice(0, 4).map(a => hit("Album", a, a.images, names(a.artists), () => play({ context_uri: a.uri }))),
  );
}

function openSearch(open) {
  $("search").hidden = !open;
  if (open) type(query);
}

// --- Listening stats: today live from recently-played, the totals from the Mac's ledger ----------------

function hours(min) {
  if (min < 60) return `${min} min`;
  if (min < 600) return `${Math.floor(min / 60)} h ${min % 60} min`;
  return `${Math.round(min / 60).toLocaleString("en")} h`;
}

function stat(id, label, value) {
  $(id).hidden = value == null;
  if (value == null) return;
  $(id).querySelector("small").textContent = label;
  $(id).querySelector("b").textContent = value;
}

async function stats() {
  const midnight = new Date().setHours(0, 0, 0, 0);
  const r = await api("/me/player/recently-played?limit=50").catch(() => null);
  const ms = (r?.items || []).filter(i => Date.parse(i.played_at) >= midnight).reduce((a, i) => a + (i.track?.duration_ms || 0), 0);
  stat("st-today", "Today", hours(Math.round(ms / 60000)));
  if (!totals) return;
  const [year, decade, since] = totals.split(",");
  const first = new Date(since + "T00:00"), thisYear = Number(YEAR);
  const label = first.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(first.getFullYear() < thisYear && { year: "numeric" }) });
  // Honest labels: until the Spotify export is imported, the ledger starts days ago, not on 1 January
  stat("st-year", first > new Date(thisYear, 0, 1) ? `Since ${label}` : YEAR, hours(Number(year)));
  const decadeKnown = first.getFullYear() < thisYear;
  stat("st-decade", first > new Date(thisYear - 9, 0, 1) ? `Since ${label}` : "10 years", decadeKnown ? hours(Number(decade)) : null);
}

// --- Page ----------------------------------------------------------------------------------------------

$("toggle").addEventListener("click", async () => {
  if (external) { await stopExternal(); setTimeout(refresh, 500); return; }
  await api(`/me/player/${isPlaying ? "pause" : "play"}${onMac}`, { method: "PUT" });
  setTimeout(refresh, 500);
});
$("next").addEventListener("click", async () => { await api("/me/player/next", { method: "POST" }); setTimeout(refresh, 600); });
$("prev").addEventListener("click", async () => { await api("/me/player/previous", { method: "POST" }); setTimeout(refresh, 600); });
$("heart").addEventListener("click", addHeart);
$("open-search").addEventListener("click", () => openSearch(true));
$("close-search").addEventListener("click", () => openSearch(false));

(async () => {
  if (!token || !device) { notice("Open this from the keypad", "Press the Spotify key"); return; }
  buildKeyboard();
  stats();
  const [playlists, artists] = await Promise.all([
    paged("/me/playlists").catch(() => []),
    api("/me/top/artists?limit=20&time_range=medium_term").then(r => r?.items || []).catch(() => []),
  ]);
  // 1. Chris Favorites, newest year first; the row is titled, so each caption is just the year
  const favs = playlists.filter(p => FAVS.test(p.name || ""))
    .map(p => ({ p, year: p.name.match(FAVS)[1] }))
    .sort((a, b) => b.year.localeCompare(a.year));
  favPlaylist = (favs.find(f => f.year === YEAR) || {}).p || null;
  favIds = favs.map(f => f.p.id);
  shelf("Chris Favorites", favs.map(({ p, year }) => tile({ ...p, name: year }, () => playShuffled(p.uri, playlistTotal(p)))));
  // 2. Discover (his Discover Weekly, Release Radar, Daily Mixes) beside Focus (Spotify's established playlists)
  const pickTiles = (list, onTap = p => playShuffled(p.uri, 0)) =>
    (Array.isArray(list) ? list : []).map(pick).filter(Boolean).map(p => tile(p, () => onTap(p)));
  split(["Discover", pickTiles(picks.discover)], ["Focus", pickTiles(picks.focus)]);
  // 3. Made for you: built from his top artists
  shelf("Made for you", artists.map(a => tile(a, () => playShuffled(a.uri, 0), true)));
  // 4. Radio and 6. YouTube play on the Mac through the secret topic
  const onMacTile = item => { const t = tile(item, () => startExternal(item)); t.dataset.uri = `${item.kind}:${item.id}`; return t; };
  if (topic) {
    RADIO.forEach(([title, list]) => shelf(title, list.map(onMacTile)));
  }
  // 5. Podcasts: tech and business, the newest episode first
  shelf("Podcasts: tech & business", pickTiles(picks.podcasts, p => playShow(p.uri)));
  if (topic) {
    shelf("YouTube playlists", YOUTUBE.map(onMacTile));
    followMac();
  }
  // 7. Every other playlist
  shelf("Your playlists", playlists.filter(p => !FAVS.test(p.name || "")).map(p => tile(p, () => playShuffled(p.uri, playlistTotal(p)))));
  Promise.allSettled(favIds.map(playlistItems)).then(setHeart);
  refresh();
  const timer = setInterval(() => (ended ? clearInterval(timer) : refresh()), 5000);
  const statTimer = setInterval(() => (ended ? clearInterval(statTimer) : stats()), 5 * 60000);
})();
