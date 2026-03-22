# Tipsy — Agentic Micro-Tipping for Rumble Creators

Tipsy is a Chrome extension that turns passive viewing into meaningful creator support.
It watches engagement signals (watch milestones, likes, comments), makes a policy-safe tip decision, and executes tips through wallet rails with transparent user controls.

Built for hackathon judging, Tipsy demonstrates:

- Real-time client instrumentation on live video pages
- Hybrid AI + deterministic safety logic
- On-chain oriented transfer integration via WDK
- Shared + local data architecture (MongoDB Atlas + Chrome storage)
- End-to-end product polish (popup UX, history, toasts, analytics)

---

## Why this matters

Creator monetization is usually coarse (ads, subscriptions, one-off donations). Tipsy introduces **behavioral micro-support**:

- “I watched to the end” → tip
- “I liked/commented because this was valuable” → tip
- “Community goal reached” → pooled milestone payout

This creates a lightweight, continuous reward loop for creators without requiring users to manually tip every time.

---

## Core Features

### 1) Engagement-Based Auto Tipping

- Tracks watch progression and reaction events on `rumble.com`
- Fires triggers for:
  - `watch_50`
  - `watch_100` (completion threshold)
  - `like`
  - `comment`
- Applies user-configured limits (amounts, token, monthly cap, minimum video duration)

### 2) Agentic Decision Layer (Gemini + Fallback)

- Sends trigger context to Gemini (`gemini-2.0-flash`) for:
  - Should tip / skip
  - Amount and token choice
  - Human message text
  - Decision reasoning
- Uses deterministic local rules as resilience/fallback path
- Includes creator profile context derived from local tip history for personalization

### 3) Verified Tip History + UX Feedback

- Stores successful tips in local persistent history (`chrome.storage.local`)
- History tab shows creator, amount, network, recipient, timestamp
- Page-level toast notifications show success/failure/skipped outcomes in real time

### 4) Agentic Insights Tab

- Generates insight cards from tip history:
  - Spend summary
  - Trigger trends
  - Recommendations
  - Lightweight spend prediction
- Data-source aware behavior:
  - Prefers local verified tip history
  - Falls back to remote history when needed

### 5) Milestone Pooling Infrastructure

- MongoDB Atlas collections support pooled contributions and milestone release workflows
- Background alarm polling (`chrome.alarms`) checks milestone/admin signals
- Pool contribution + release events flow through the same tracking pipeline

---

## What makes Tipsy stand out

### Hybrid Intelligence, Not Blind Automation

- AI handles nuance and personalization
- Hard constraints prevent over-spend and repeat-trigger abuse
- If AI is unavailable, local rules keep product functional

### Product Trust by Design

- Real-time in-page feedback for every important outcome
- Persistent, auditable user-side history
- Clear controls for caps, amounts, network, and toggles

### Strong Technical Scope for a Hackathon

- Browser extension (MV3) + service worker orchestration
- Live DOM signal extraction + HTMX recipient discovery
- Wallet execution layer integration
- Cloud persistence + local-first UX
- Agentic analytics and decisioning in one product

---

## High-Level Architecture

```
Rumble Page
  └─ content.js
      ├─ watch/reaction listeners
      ├─ recipient discovery + candidate refresh
      └─ sends WATCH_TICK / REACTION

background.js (MV3 service worker)
  ├─ receives triggers
  ├─ builds decision context
  ├─ calls Gemini agent
  ├─ applies local safety fallback/override
  ├─ resolves recipient + executes tip via WDK
  ├─ persists local tip history
  └─ emits TIP_RESULT / page toast messages

popup/
  ├─ Now: status + quick controls
  ├─ History: local confirmed tips
  ├─ Agentic: insights/recommendations
  └─ Settings: rule tuning & budget controls

mongodb.js
  ├─ tip logging
  ├─ pool contributions
  └─ milestone/admin signal queries
```

---

## Tech Stack

- **Extension Runtime**: Chrome Extension Manifest V3
- **Language/Build**: JavaScript (ESM), Webpack
- **Wallet Layer**: `@tetherto/wdk`, `@tetherto/wdk-wallet-evm`, `@tetherto/wdk-wallet-btc`
- **AI Layer**: Gemini `gemini-2.0-flash`
- **Persistence**:
  - Local: `chrome.storage.local`, `chrome.storage.sync`, `chrome.storage.session`
  - Cloud: MongoDB Atlas Data API
- **Networks/Assets (current support path)**:
  - EVM + Bitcoin rails
  - USDT / XAUT / BTC paths in wallet module

---

## Repository Structure

```
.
├── background.js          # Trigger processing, agent calls, transfer orchestration, alarms
├── content.js             # Rumble page instrumentation + toast UI + recipient extraction
├── wdk.js                 # Wallet initialization and transfer execution
├── mongodb.js             # Atlas Data API client and queries
├── popup/
│   ├── index.html
│   ├── app.js             # Tab rendering + interactions
│   └── styles.css
├── manifest.json
├── webpack.config.js
└── PRD.md
```

---

## Setup (Local Dev)

### 1) Install dependencies

```bash
npm install
```

### 2) Configure environment

Create/update `.env` in the project root:

```env
VITE_GEMINI_API_KEY=...
VITE_ATLAS_APP_ID=...#optional
VITE_ATLAS_API_KEY=...#optional
VITE_ATLAS_DATA_SOURCE=brewtip #optional
VITE_ATLAS_DATABASE=tipsy#optional
```

> Notes
>
> - The extension can still run with local-only behavior if Gemini/Atlas credentials are missing.
> - Wallet operations require valid seed + supported network setup in Settings.

### 3) Build

```bash
npm run build
```

### 4) Load into Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this project folder
5. Open Rumble and pin the Tipsy extension

---

## Safety & Reliability Principles

- Budget-aware decisions with cap checks
- Session-level duplicate trigger suppression
- Fallback behavior when external AI is unavailable
- Local-first history to avoid UX dead zones
- Transparent outcome messages for user trust

---

## Known Constraints / Next Iterations

- Recipient resolution can fail for creators without accessible wallet metadata
- Additional chain/token paths and gas prechecks can be expanded
- A/B evaluation of “AI lift” (retention/spend efficiency) can be added for stronger quantifiable impact
- Optional richer creator preference model and per-category weighting

---

## License

Hackathon prototype / educational use.
