# Roadtrip Command Center

Live collaborative dashboard for **Tim, Chris, Jessica, and Nancy**:
- **Where Are We? & Are We There Yet?:** Live in-car phone GPS sharing, human-readable highway/between-cities location, route progress bar, live ETA, and multi-stop management (with one-tap Google Maps & Waze launch links).
- **Synced TripSplitter (`tripsplitter.html`):** Same-origin embedded TripSplitter pre-seeded with Tim, Chris, Jessica, and Nancy and synced live across everyone's phones.
- **Music & Car DJ:** Embedded YouTube Music playlist (`PLO6qnlYSFTDc`), collaborator invite link, live tracklist sync, plus an in-page song search & DJ queue.
- **Car Chat:** Real-time message wall stamped with where you were on the trip when posted.

## Running the Laptop Sync Server
Double-click `start_roadtrip.bat` (or run `node launcher.js`) on this laptop. It starts:
1. Local Node server on `http://127.0.0.1:3855`
2. A Cloudflare Quick Tunnel (`https://*.trycloudflare.com`)
3. Automatic Gist update so `https://dangerous.business/` connects to your laptop automatically.
