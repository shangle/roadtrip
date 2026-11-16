# Dangerous.Business — Coordinate Without Big Brother

100% client-side, URL-driven web app for coordinating **Road Trips**, **Bachelor & Bachelorette Parties**, **Spring Break**, and **Off-Grid Weekends** without cloud databases, accounts, or tracking.

## Core Capabilities
- **Complete Product Landing Page & 4-Step Setup Wizard:** Explains how URL-state coordination works, showcases use cases, lets visitors test-drive a live demo trip in 1 click, or guides them through creating a custom trip.
- **Modular Architecture:** Toggle any combination of **Trip Locations & Pit Stops**, **Expense Splitter**, **Shared Music Playlist** (YouTube Music, Spotify, or Apple Music), and **Crew Notes / Board** during setup or anytime mid-trip.
- **100% URL-Driven + Smart Merge:** Every update is compressed into the URL hash (`#s=...`) and merged by ID in `localStorage` so crew members can share updated links over Signal, iMessage, or WhatsApp without overwriting earlier items.
- **Optional Web Crypto AES-256-GCM Encryption:** Lock the trip with a passcode (`PBKDF2` + `AES-256-GCM`, `#e=...`) so the URL hash cannot be read without the crew's password.
