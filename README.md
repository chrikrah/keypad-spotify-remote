# keypad-spotify-remote

A Spotify remote for a Google Nest Hub. A key on a desk keypad casts this page to the Hub; a tap on a
cover there plays it through the Spotify app on the desk Mac.

The page is static and holds no secret. The Mac passes a 1-hour Spotify access token and its own
player id in the URL fragment, which browsers never send to a server, and the page removes it from
the address bar at once. A Content Security Policy limits the page to its own files, the Spotify API,
Spotify's image hosts and ntfy.sh.

Radio and YouTube are not Spotify: the page posts a station or playlist id (never a URL) to a secret
ntfy.sh topic, and the Mac plays it. The Mac posts each station's song text back on a second topic.
The listening totals at the top come from the Mac too, because the Spotify Web API has none.

Station logos in `stations/` belong to their broadcasters and are shown only to identify the station.

Served by GitHub Pages: https://chrikrah.github.io/keypad-spotify-remote/
