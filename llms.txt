# Dangerous.Business — AI & LLM Integration Guide (llms.txt)

> Dangerous.Business is a 100% client-side, zero-cloud group coordination web app for road trips, bachelor/bachelorette parties, spring break, and off-grid events. All state lives inside the URL hash.

## Documentation & Key Links

- [Dangerous.Business Web App](https://dangerous.business/): Launch the zero-cloud URL-driven trip coordinator or load the live demo trip.
- [AI Agent URL Protocol & DB-Script Spec](https://dangerous.business/ai.md): Full machine-readable specification for `#s=`, `#e=`, `&ai=`, and Turing-complete `DB-Script` micro-modules.
- [Creator — shangle.me](https://shangle.me/): Created by shangle.me.

## How AI Agents (Gemini, ChatGPT, Claude, Meta AI) Can Read & Update a Trip URL

Dangerous.Business is designed for both **Carbon (human)** and **Silicon (AI agent)** users. You do NOT need an `LZString` library to create a trip or add items to an existing user's trip link!

### 1. Updating an Existing Trip URL (`&ai=` Delta Patch Parameter)
When a user shares an existing link (e.g. `https://dangerous.business/#s=N4Ig...` or `https://dangerous.business/#e=...`) and asks you to add an expense (such as from a photo of a receipt), add a route stop, post a note, or add a micro-module:

**Keep their existing `#s=...` or `#e=...` hash intact and append `&ai=<URL-encoded JSON patch>` to the end of the hash:**

```
https://dangerous.business/#s=N4IgbiBcDMA0...&ai=%7B%22addExpenses%22%3A%5B%7B%22description%22%3A%22Chili's%20Dinner%22%2C%22amount%22%3A84.50%2C%22payer%22%3A%22Michael%22%7D%5D%7D
```

When the user opens that link, Dangerous.Business automatically:
1. Decodes their existing `#s=...` (or `#e=...`) state,
2. Applies your `&ai=` JSON patch,
3. Displays the **Smart Merge Confirmation Check** showing the exact items you added, and
4. Repacks the merged result into a clean `#s=...` / `#e=...` URL.

#### Supported `&ai=` Patch JSON Schema:
```json
{
  "title": "Optional New Trip Title",
  "theme": "dark | light | unicorn | win98 | brutalist",
  "addCrew": ["Andy", "Erin"],
  "setDestination": {
    "name": "Niagara Falls",
    "label": "Niagara Falls, NY",
    "lat": 43.0962,
    "lon": -79.0377
  },
  "setLocation": {
    "whereAreWe": "On I-81 N • Near Binghamton, NY",
    "lat": 42.0987,
    "lon": -75.9180,
    "speedMph": 65,
    "reportedBy": "AI Assistant"
  },
  "addStops": [
    {
      "name": "Cooper's Seafood House",
      "label": "Scranton, PA",
      "lat": 41.4154,
      "lon": -75.6531,
      "addedBy": "AI Assistant"
    }
  ],
  "addExpenses": [
    {
      "type": "expense",
      "description": "Chili's Awesome Blossom & Drinks",
      "amount": 84.50,
      "payer": "Michael"
    },
    {
      "type": "payment",
      "description": "Repayment: Jim → Michael",
      "amount": 25.00,
      "payer": "Jim",
      "payee": "Michael"
    }
  ],
  "addNotes": [
    {
      "author": "AI Assistant",
      "text": "Added Chili's receipt ($84.50 paid by Michael)."
    }
  ],
  "addPins": [
    {
      "kind": "parking",
      "name": "Ramp Level 3, Blue Giraffe, Spot 42",
      "note": "Take the north elevator by Gate B",
      "lat": 41.4091,
      "lon": -75.6628,
      "addedBy": "Michael"
    },
    {
      "kind": "meetup",
      "name": "Main Stage Ferris Wheel Rally Point",
      "note": "Meet here at 9:30 PM if separated",
      "lat": 41.4089,
      "lon": -75.6624,
      "addedBy": "Dwight"
    }
  ],
  "addMicroModules": [
    {
      "type": "countdown",
      "title": "Christmas",
      "icon": "⏳",
      "targetTime": "2026-12-25T11:11"
    },
    {
      "type": "script",
      "title": "Custom Turing-Complete DB-Script Widget",
      "icon": "🧮",
      "code": "state count = 0\nbig (\"Score: \" + state.count) badge=\"DB-SCRIPT\"\nbtn \"+1 Point\" -> set state.count = state.count + 1",
      "data": { "count": 0 }
    },
    {
      "type": "checklist",
      "title": "Party Packing List",
      "icon": "📦",
      "items": [
        { "text": "Dundie Trophies", "done": true },
        { "text": "Orange Vod-Juice-Ka", "done": false }
      ]
    },
    {
      "type": "kv",
      "title": "Hotel & Wi-Fi Codes",
      "icon": "🔑",
      "pairs": [
        { "k": "Room", "v": "Suite 304" },
        { "k": "Gate Code", "v": "#1725" }
      ]
    },
    {
      "type": "poll",
      "title": "Where for Pizza?",
      "icon": "🍕",
      "options": [
        { "label": "Alfredo's Pizza Cafe", "votes": ["Michael", "Jim"] },
        { "label": "Pizza by Alfredo", "votes": [] }
      ]
    }
  ]
}
```

---

### 2. Creating a Brand-New Trip from Scratch (`#ai=` Full State Parameter)
If the user does not have an existing link yet, construct a new trip link using `#ai=<encodeURIComponent(JSON.stringify(payload))>`:

```
https://dangerous.business/#ai=%7B%22title%22%3A%22Dunder%20Mifflin%20Retreat%22%2C%22crew%22%3A%5B%22Michael%22%2C%22Dwight%22%2C%22Jim%22%2C%22Pam%22%5D%2C%22addExpenses%22%3A%5B%7B%22description%22%3A%22Bus%20Charter%22%2C%22amount%22%3A400%2C%22payer%22%3A%22Michael%22%7D%5D%7D
```

### 3. Example Receipt-to-URL Workflow for AI Assistants
1. User uploads a receipt image and pastes their current `https://dangerous.business/#s=...` URL.
2. Extract the merchant/description, total amount (including tax/tip), and who paid.
3. Construct the JSON patch `{"addExpenses":[{"description":"<Merchant>","amount":<Total>,"payer":"<Name>"}]}` and URL-encode it with `encodeURIComponent`.
4. Return the clickable link: `<existing_url>&ai=<encoded_patch>`.
