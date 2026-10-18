# keypad-spotify-remote

A Spotify remote for a Google Nest Hub. A key on a desk keypad casts this page to the Hub; a tap on a
cover there plays it through the Spotify app on the desk Mac.

The page is static and holds no secret. The Mac passes a 1-hour Spotify access token and its own
player id in the URL fragment, which browsers never send to a server, and the page removes it from
the address bar at once. A Content Security Policy limits the page to the Spotify API and Spotify's
image hosts.

Served by GitHub Pages: https://chrikrah.github.io/keypad-spotify-remote/
