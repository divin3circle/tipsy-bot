# Tipsy — Smart Tipping Chrome Extension

**Product Requirements Document + Coding Agent Prompt**
Rumble Tipping Bot Track · Tether WDK · Gemini API · MongoDB Atlas · 1-Day Sprint

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Architecture](#2-architecture)
3. [User-Facing Features](#3-user-facing-features)
4. [Gemini Agent Specification](#4-gemini-agent-specification)
5. [File Structure](#5-file-structure)
6. [manifest.json](#6-manifestjson)
7. [Pool Architecture](#7-pool-architecture-how-it-really-works)
8. [UI Design Specification](#8-ui-design-specification)
9. [MongoDB Atlas Setup](#9-mongodb-atlas-setup)
10. [Launch Checklist](#10-launch-checklist)
11. [Coding Agent Prompt](#11-coding-agent-prompt)

---

## 1. Product Overview

### 1.1 What is Tipsy?

Tipsy is a Chrome extension that runs on top of Rumble video pages and brings three tipping mechanics together into one seamless experience: automatic engagement-based tipping, creator milestone bounty pools, and AI-generated personalised tip messages. It is built on Rumble's Tether Wallet Development Kit (WDK) and uses the Gemini API as its agent brain.

### 1.2 The three merged mechanics

| Mechanic                     | What it does                                                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Watch + React Tipping**    | Auto-tips a creator when the user hits watch time thresholds (e.g. 50%, 100%) or fires a reaction (like, comment). Rules are fully configurable per user.                                                         |
| **Tip Pool Party**           | The platform (you) creates named pools for creators — e.g. "Mike's 10K Sub Pool". Fans see active pools in the Explore tab and can contribute any micro-amount. The pool is held in MongoDB Atlas.                |
| **Milestone Bounty Release** | A background service worker polls Rumble for milestone signals (sub count, view count, stream event). When the milestone is hit, the agent evaluates the pool and triggers a lump-sum tip to the creator via WDK. |

### 1.3 Why Gemini as the agent?

The Gemini API (`gemini-2.0-flash`) replaces a heavyweight orchestration framework. It acts as the reasoning layer that: (1) decides whether a trigger should fire given current context, (2) calculates the right tip amount within the user's budget, and (3) writes a personalised message. This is genuine agentic behaviour — conditional logic + personalisation — without the overhead of OpenClaw or LangGraph.

### 1.4 Why a backend DB is the right call

A community pool **must** live on a shared backend. If the pool balance were stored in `chrome.storage.local`, it would be invisible to every other fan — each user would see their own private copy. MongoDB Atlas is the correct approach: it's the single source of truth that all fans' extensions read from and write to. User-specific settings (tip rules, budget cap) stay in `chrome.storage.sync` as they should. The DB only holds what needs to be shared.

---

## 2. Architecture

### 2.1 High-level component map

| Component            | Responsibility                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content.js`         | Injected into every rumble.com page. Monitors video `currentTime`, like/comment DOM events, creator metadata. Sends events to background worker.                     |
| `background.js`      | Receives events from content script. Calls Gemini API with context. Executes WDK wallet calls. Polls MongoDB Atlas via Data API for pool state and milestone status. |
| `popup/` (React app) | Extension popup UI. Shows: active triggers, pool balances, tip history, settings tabs. Built with React + Tailwind.                                                  |
| `mongodb.js`         | MongoDB Atlas Data API client (plain `fetch()` — no SDK needed, works in MV3 service workers).                                                                       |
| **MongoDB Atlas**    | Free-tier M0 cluster. Collections: `pools`, `contributions`, `tip_log`. Pools created by platform admin. Users contribute via extension.                             |
| **Rumble WDK**       | Native wallet integration on Rumble. Tipsy calls WDK methods to send USD₮, XAU₮, or BTC tips. WDK handles auth and transaction signing.                              |
| **Gemini API**       | `gemini-2.0-flash` model. Called by background worker with structured context. Returns JSON: `{ should_tip, amount, token, message, reasoning }`.                    |

### 2.2 Data flow

1. Fan opens a Rumble video page. `content.js` injects and begins monitoring.
2. Every 30 seconds and on each reaction event, `content.js` posts a context snapshot to `background.js` via `chrome.runtime.sendMessage`.
3. `background.js` assembles the agent context object (watch %, reactions fired, creator ID, user budget remaining, pool state) and calls Gemini API.
4. Gemini returns a decision JSON. If `should_tip` is true, `background.js` calls the Rumble WDK to execute the transaction.
5. The tip is logged to MongoDB `tip_log` collection and reflected in the popup UI.
6. A separate polling loop (every 60 seconds via `chrome.alarms`) checks milestone status for active pools. On milestone hit, the pool balance is released as a single creator tip.

### 2.3 MongoDB collection schema

| Collection      | Key fields                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pools`         | `_id`, `creator_id`, `creator_name`, `goal_type` (sub_count\|view_count\|manual), `goal_value`, `balance_usdt`, `status` (active\|triggered\|paid), `created_at` |
| `contributions` | `_id`, `pool_id`, `user_wallet_address`, `amount_usdt`, `contributed_at`                                                                                         |
| `tip_log`       | `_id`, `user_wallet_address`, `creator_id`, `amount_usdt`, `token_type`, `trigger_type` (watch\|like\|comment\|pool_release), `message`, `tx_hash`, `tipped_at`  |

---

## 3. User-Facing Features

### 3.1 Settings tab — configurable tipping rules

Users set their own rules. The Gemini agent respects these as hard constraints, not suggestions.

| Rule                            | Type & default                                 |
| ------------------------------- | ---------------------------------------------- |
| Watch time tip — 50% threshold  | USD₮ amount, default $0.25                     |
| Watch time tip — 100% threshold | USD₮ amount, default $0.50                     |
| Like reaction tip               | USD₮ amount, default $0.10                     |
| Comment reaction tip            | USD₮ amount, default $0.20                     |
| Monthly budget cap              | USD₮ total, default $5.00                      |
| Token preference                | USD₮ / XAU₮ / BTC (3-way toggle)               |
| Auto-tip master toggle          | On/Off global switch                           |
| Minimum video length            | Seconds before auto-tip activates, default 60s |
| Excluded creators               | Blocklist — never auto-tip these channel IDs   |

### 3.2 Explore tab — creator pools

The community pool discovery surface. The platform populates active pools via MongoDB admin insert. Users see:

- Pool name (e.g. "Mike's 10K Sub Pool")
- Creator name and avatar (fetched from Rumble)
- Progress bar: current pool balance vs. payout threshold
- Milestone description (e.g. "Pays out when Mike hits 10,000 subscribers")
- Contribute button: opens an amount input, calls WDK to move funds, writes to MongoDB `contributions` collection
- Your contribution: shows the user's personal contribution amount

### 3.3 Activity tab — tip history

A chronological feed of all tips sent. Each item shows: amount, token, creator name, trigger type (watch/like/comment/pool), the AI-generated message, and timestamp. Users can see their monthly spend vs. budget cap.

### 3.4 Now Playing overlay

While watching a video, a subtle pill-shaped overlay appears in the bottom-right corner of the Rumble player showing: current watch % and next tip threshold. Clicking it opens the popup. Injected by `content.js`, dismissible.

---

## 4. Gemini Agent Specification

### 4.1 When the agent is called

- Every 30 seconds while a video is playing (watch time evaluation)
- Immediately on a like or comment event
- When background worker detects a milestone has been hit (pool release evaluation)

### 4.2 Agent context object

```json
{
  "trigger_type": "watch_time | like | comment | milestone",
  "watch_percent": 0,
  "video_title": "string",
  "video_category": "string",
  "creator_name": "string",
  "creator_id": "string",
  "video_duration_seconds": 0,
  "reactions_this_session": { "likes": 0, "comments": 0 },
  "user_rules": {
    "watch_50_amount": 0.25,
    "watch_100_amount": 0.5,
    "like_amount": 0.1,
    "comment_amount": 0.2,
    "monthly_cap": 5.0,
    "token": "USDT",
    "min_video_seconds": 60
  },
  "budget_used_this_month": 0,
  "tips_sent_this_session": 0,
  "already_tipped_at_50": false,
  "already_tipped_at_100": false,
  "already_tipped_for_like": false,
  "already_tipped_for_comment": false,
  "pool_balance": 0,
  "pool_goal_met": false,
  "creator_milestone": "string | null"
}
```

### 4.3 Gemini system prompt

Copy this exactly into your `background.js` `systemInstruction` field:

```
You are the Tipsy tipping agent. Your job is to evaluate whether a tip should
be sent to a Rumble creator based on the user's configured rules and the
current viewing context.

RULES YOU MUST FOLLOW:
1. Never tip if budget_used_this_month >= user_rules.monthly_cap.
2. Never tip for watch_time if video_duration_seconds < user_rules.min_video_seconds.
3. Never fire the same trigger twice in a session (check already_tipped_* flags).
4. For "watch_time" trigger: tip at 50% if !already_tipped_at_50 and watch_percent >= 50.
   Tip at 100% if !already_tipped_at_100 and watch_percent >= 95.
5. For "like" trigger: tip user_rules.like_amount if !already_tipped_for_like.
6. For "comment" trigger: tip user_rules.comment_amount if !already_tipped_for_comment.
7. For "milestone" trigger: tip the full pool_balance if pool_goal_met is true.
8. Amount must never exceed the remaining budget:
   (user_rules.monthly_cap - budget_used_this_month).

PERSONALISATION:
Write a short, warm, specific tip message (max 120 chars) referencing the
video content. Be natural, not corporate. Reference the video_title or
video_category. For milestone releases, acknowledge the achievement.

RESPOND WITH VALID JSON ONLY. No markdown, no explanation outside JSON:
{
  "should_tip": true | false,
  "amount": 0.00,
  "token": "USDT | XAUT | BTC",
  "message": "string (max 120 chars)",
  "trigger_used": "watch_50 | watch_100 | like | comment | pool_release",
  "reasoning": "string (one sentence, for debug log only)"
}
```

### 4.4 Calling Gemini in background.js

````javascript
async function callTipsyAgent(context) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/` +
      `gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          {
            role: "user",
            parts: [{ text: JSON.stringify(context) }],
          },
        ],
        generation_config: { temperature: 0.3 },
      }),
    },
  );
  const data = await res.json();
  const raw = data.candidates[0].content.parts[0].text;
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}
````

---

## 5. File Structure

```
tipsy-extension/
├── manifest.json
├── background.js          # Service worker — Gemini calls, WDK calls, pool polling
├── content.js             # Injected into rumble.com — event monitoring, overlay
├── mongodb.js             # Atlas Data API client (shared module)
├── popup/
│   ├── index.html
│   ├── App.jsx            # React root with tab routing
│   ├── tabs/
│   │   ├── NowPlaying.jsx
│   │   ├── Explore.jsx    # Pool discovery
│   │   ├── Activity.jsx   # Tip history
│   │   └── Settings.jsx   # User rules
│   └── components/
│       ├── PoolCard.jsx
│       ├── TipFeedItem.jsx
│       ├── BudgetBar.jsx
│       └── TriggerRule.jsx
├── assets/
│   └── icons/             # 16, 48, 128px PNGs
└── .env
    # VITE_GEMINI_API_KEY
    # VITE_ATLAS_APP_ID
    # VITE_ATLAS_API_KEY
```

---

## 6. manifest.json

```json
{
  "manifest_version": 3,
  "name": "Tipsy",
  "version": "1.0.0",
  "description": "Smart AI-powered tipping for Rumble creators",
  "permissions": ["storage", "alarms", "scripting", "activeTab"],
  "host_permissions": ["https://*.rumble.com/*"],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["https://*.rumble.com/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_popup": "popup/index.html",
    "default_icon": {
      "16": "assets/icons/16.png",
      "48": "assets/icons/48.png"
    }
  },
  "icons": { "128": "assets/icons/128.png" }
}
```

---

## 7. Pool Architecture (How It Really Works)

### 7.1 Platform creates pools (admin side)

You (the platform) insert pool records directly into MongoDB Atlas via the Data Explorer UI or a one-off API call. No admin dashboard needed for the hackathon.

```http
POST https://data.mongodb-api.com/app/{APP_ID}/endpoint/data/v1/action/insertOne
Content-Type: application/json
api-key: {YOUR_API_KEY}

{
  "dataSource": "Cluster0",
  "database": "tipsy",
  "collection": "pools",
  "document": {
    "creator_id": "rumble_channel_mike",
    "creator_name": "Mike's Channel",
    "goal_type": "sub_count",
    "goal_value": 10000,
    "balance_usdt": 0,
    "status": "active",
    "created_at": { "$date": { "$numberLong": "1700000000000" } }
  }
}
```

### 7.2 User contributes (extension side)

1. User opens Explore tab, sees "Mike's 10K Pool" with progress bar.
2. User clicks Contribute, enters amount (e.g. $0.50 USD₮).
3. Extension calls Rumble WDK to move $0.50 from user wallet to platform escrow wallet.
4. On WDK transaction success, extension calls `contributeToPool()` which: inserts a document into `contributions` collection, and increments `pools.balance_usdt` via `$inc` in Atlas Data API `updateOne`.
5. Pool card re-polls every 10 seconds and reflects the new balance.

> **Note on realtime:** Supabase has WebSocket-based realtime. MongoDB Atlas Data API (free tier) does not expose change streams over HTTP — use a simple `setInterval` poll every 10s in the Explore tab. This is perfectly fine for a hackathon and actually simpler to implement.

### 7.3 Background worker monitors milestones

A `chrome.alarms.create('pollPools', { periodInMinutes: 1 })` fires every 60 seconds. The alarm handler in `background.js`:

- Fetches all active pools from MongoDB where `status: "active"`
- For `sub_count` milestones: scrapes the creator's Rumble page subscriber count (content script relays this via `chrome.tabs.sendMessage`)
- For `manual` milestones: polls a MongoDB `admin_signals` collection the platform can write to
- If goal is met: calls Gemini with `trigger_type: "milestone"` to generate the payout message, then calls WDK to transfer pool balance to creator, then updates pool `status` to `"paid"`

### 7.4 The escrow wallet

For the hackathon, the platform wallet is a single Tether WDK wallet you control. Pool contributions flow to it. On milestone, you call WDK from the extension to forward the balance to the creator. In production this would be a smart contract — but for demo purposes a single platform wallet is sufficient and acceptable.

> **Key demo moment:** Show judges the full flow — contribute → pool fills → milestone detected → Gemini generates message → WDK releases. Mock WDK with `console.log` first, wire real WDK after everything else works.

---

## 8. UI Design Specification

### 8.1 Aesthetic direction

Tipsy's popup should feel like a **premium fintech micro-app** — not a generic browser extension. Think: dark glass surfaces, warm amber/gold accents that echo crypto/money, razor-sharp typography with a distinctive display font. The vibe is _Bloomberg Terminal meets a beautifully designed crypto wallet_. Judges should open the popup and immediately think "this looks like a real product."

**Aesthetic keywords:** dark luxury · financial precision · warm gold accents · editorial type · controlled density

### 8.2 Design tokens

```css
:root {
  /* backgrounds */
  --bg-base: #080b0f; /* near-black, slightly blue-tinted */
  --bg-surface: #111620; /* card surface */
  --bg-elevated: #1a2030; /* hover / active state */
  --bg-overlay: rgba(255, 255, 255, 0.04);

  /* brand */
  --gold: #f0b429; /* primary accent — warm amber gold */
  --gold-dim: #8a6514; /* muted gold for secondary elements */
  --gold-glow: rgba(240, 180, 41, 0.15); /* subtle glow backgrounds */
  --teal: #0fd5a0; /* success / confirmed tip */
  --teal-dim: rgba(15, 213, 160, 0.12);

  /* text */
  --text-primary: #f0ede8; /* warm white, not pure white */
  --text-secondary: #7a8499;
  --text-tertiary: #3d4558;

  /* borders */
  --border: rgba(255, 255, 255, 0.07);
  --border-gold: rgba(240, 180, 41, 0.3);

  /* typography */
  --font-display: "Syne", sans-serif; /* bold, geometric display */
  --font-body: "DM Sans", sans-serif; /* clean, readable body */
  --font-mono: "DM Mono", monospace; /* amounts, addresses */

  /* spacing & radius */
  --radius-sm: 8px;
  --radius-md: 14px;
  --radius-lg: 20px;
  --radius-pill: 999px;
}
```

**Fonts to load (Google Fonts):**

```html
<link
  href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@400;500&display=swap"
  rel="stylesheet"
/>
```

### 8.3 Popup shell

```
┌─────────────────────────────┐  380px wide
│  ◆ Tipsy           ⚙ [●]   │  Header: logo + auto-tip toggle
│─────────────────────────────│
│                             │
│     [ Tab content ]         │  480px tall content area
│                             │
│─────────────────────────────│
│  [▶ Now] [✦ Explore]        │  Bottom tab bar
│  [↗ Activity] [⚙ Settings]  │
└─────────────────────────────┘
```

- Popup size: `380px × 560px` total
- Header: 48px, `var(--bg-surface)`, bottom border `var(--border)`
- Logo: `◆ Tipsy` — diamond glyph in `var(--gold)`, "Tipsy" in `var(--font-display)` weight 700
- Tab bar: 56px, fixed bottom, icons + labels, active tab has gold underline `2px var(--gold)` and text in `var(--gold)`

### 8.4 Now Playing tab

```
┌─────────────────────────────┐
│  WATCHING                   │  label: 10px, var(--text-tertiary), Syne uppercase
│  How to Make Sourdough      │  video title: 16px, var(--font-display), clamp 2 lines
│  by Mike's Channel          │  creator: 13px, var(--text-secondary)
│                             │
│    ████████████░░░░  64%    │  progress bar: 6px tall, gold fill, bg-elevated track
│                             │
│  ⚡ Next tip at 100% · $0.50│  pill badge: bg-gold-glow, gold text, DM Sans 12px
│                             │
│ ┌─────────────────────────┐ │
│ │ " Halfway through and   │ │  last AI message box:
│ │   already learning so   │ │  left-border 2px gold, bg-overlay
│ │   much — great video!"  │ │  italic, text-secondary 13px
│ │  · $0.25 USD₮  2m ago   │ │
│ └─────────────────────────┘ │
└─────────────────────────────┘
```

### 8.5 Explore tab (Pool cards)

Each pool card:

```
┌─────────────────────────────┐
│  [avatar] Mike's Channel    │  avatar: 36px circle, initials fallback
│           Mike's 10K Pool   │  pool name: Syne 13px, gold
│                             │
│  ████████████░░░░  $4.20    │  progress bar + balance in DM Mono
│  of $10.00 target           │  target in text-secondary
│                             │
│  🏆 Unlocks at 10K subs     │  milestone label: 11px, text-secondary
│                             │
│  You: $0.50   [Contribute ↗]│  your amount + button
└─────────────────────────────┘
```

- Card background: `var(--bg-surface)`, border `var(--border)`, `border-radius: var(--radius-md)`
- On hover: border shifts to `var(--border-gold)`, `background: var(--bg-elevated)` — smooth 150ms transition
- Contribute button: `background: var(--gold)`, `color: #080B0F`, `border-radius: var(--radius-pill)`, `font: DM Sans 500 12px`, 28px tall
- Progress bar: 4px tall, `background: var(--bg-elevated)`, fill `var(--gold)`, `border-radius: var(--radius-pill)`
- Amount text: `font-family: var(--font-mono)` — numbers always in mono

### 8.6 Activity tab

```
┌─────────────────────────────┐
│  Budget this month          │
│  ████████░░░░  $1.20/$5.00  │  BudgetBar: same gold progress style
│                             │
│  ─────────────────────────  │
│                             │
│  [↗] $0.50 USD₮             │  TipFeedItem
│      Mike's Channel · ⏱ 50% │  trigger icon + creator + trigger label
│      "Loved every minute    │  AI message: italic, text-secondary
│       of this one!"         │
│      2m ago                 │  timestamp: text-tertiary 11px
│                             │
│  [♥] $0.10 USD₮             │
│      Sarah's Kitchen · Like │
│      "This recipe looks..!" │
│      14m ago                │
└─────────────────────────────┘
```

- Feed items separated by a 1px `var(--border)` line
- Trigger icons: `↗` watch (gold), `♥` like (coral `#FF6B6B`), `💬` comment (teal), `🏆` pool release (gold, larger)
- Amount: `var(--font-mono)` weight 500, `var(--text-primary)`
- Zero state: centered illustration (simple diamond shape in gold, text below: "No tips yet — start watching Rumble")

### 8.7 Settings tab

```
┌─────────────────────────────┐
│  AUTO-TIP                   │  section label: Syne 10px uppercase, text-tertiary
│  ┌───────────────────────┐  │
│  │ Master switch    [●]  │  │  toggle: gold when on
│  └───────────────────────┘  │
│                             │
│  TRIGGERS                   │
│  ┌───────────────────────┐  │
│  │ ⏱ Watch 50%    [●]   │  │  TriggerRule row
│  │            $  [0.25]  │  │  inline amount input, 60px wide
│  ├───────────────────────┤  │
│  │ ⏱ Watch 100%   [●]   │  │
│  │            $  [0.50]  │  │
│  ├───────────────────────┤  │
│  │ ♥ Like         [●]   │  │
│  │            $  [0.10]  │  │
│  ├───────────────────────┤  │
│  │ 💬 Comment     [●]   │  │
│  │            $  [0.20]  │  │
│  └───────────────────────┘  │
│                             │
│  BUDGET                     │
│  Monthly cap   $  [5.00]    │
│  Token  [USD₮] [XAU₮] [BTC] │  3-pill selector, active pill gold bg
│  Min. video  ────●───  90s  │  range slider, gold thumb
└─────────────────────────────┘
```

- Section labels: `font-family: var(--font-display)`, 10px, uppercase, letter-spacing 0.1em, `var(--text-tertiary)`
- Rule rows: `background: var(--bg-surface)`, subtle dividers between rows, no outer border
- Toggle: 36×20px pill, `var(--gold)` when on, `var(--text-tertiary)` when off, animated thumb
- Amount inputs: right-aligned text, `var(--font-mono)`, transparent background, gold bottom border only, 60px wide
- Token pills: inactive = `var(--bg-elevated)` border `var(--border)`, active = `var(--gold)` bg `color: #080B0F`

### 8.8 Micro-interactions and motion

- **Tip fires:** A brief shimmer/flash on the Now Playing tab — the last message box animates in with `transform: translateY(8px) → 0` + `opacity: 0 → 1`, 250ms ease-out.
- **Contribute success:** Pool progress bar animates its width change over 600ms ease-in-out after a successful contribution.
- **Tab switch:** Content fades in 150ms, no slide (keeps it fast and clean).
- **Toggle:** Thumb slides 150ms with `cubic-bezier(0.34, 1.56, 0.64, 1)` (slight overshoot).
- **Button press:** `transform: scale(0.96)` on active, 80ms.

### 8.9 Rumble page overlay (content.js)

The watch progress overlay injected into the Rumble player:

```css
.tipsy-overlay {
  position: absolute;
  bottom: 16px;
  right: 16px;
  background: rgba(8, 11, 15, 0.85);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(240, 180, 41, 0.25);
  border-radius: 999px;
  padding: 6px 14px;
  font-family: "DM Sans", sans-serif;
  font-size: 12px;
  color: #f0ede8;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  z-index: 9999;
  transition: opacity 150ms;
}

.tipsy-overlay .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f0b429;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
```

Content: `● 64% · Next tip at 100%` — dot pulses gold.

---

## 9. MongoDB Atlas Setup (10 minutes)

1. Go to [mongodb.com/atlas](https://mongodb.com/atlas), create a free account, deploy a free **M0 cluster** (any region).
2. In the Atlas UI: **Database Access** → Add Database User. Create a user with Read/Write access.
3. **Network Access** → Add IP Address → Allow access from anywhere (`0.0.0.0/0`) for the hackathon.
4. **App Services** → Create a new App → Enable **Data API** → Create an API Key. Copy the **App ID** and **API Key**.
5. Create a database named `tipsy`. Create three collections: `pools`, `contributions`, `tip_log`.
6. Add indexes via **Atlas UI** (Indexes tab on each collection):

```javascript
// pools collection
{ "status": 1 }

// contributions collection
{ "pool_id": 1 }
{ "user_wallet_address": 1 }

// tip_log collection
{ "user_wallet_address": 1, "tipped_at": -1 }
```

7. Insert a test pool document via **Browse Collections → pools → Insert Document**:

```json
{
  "creator_id": "rumble_channel_mike",
  "creator_name": "Mike's Channel",
  "goal_type": "sub_count",
  "goal_value": 10000,
  "balance_usdt": 0,
  "status": "active",
  "created_at": { "$date": { "$numberLong": "1700000000000" } }
}
```

8. Add your keys to `.env`:

```
VITE_GEMINI_API_KEY=your_gemini_key_here
VITE_ATLAS_APP_ID=your_atlas_app_id_here
VITE_ATLAS_API_KEY=your_atlas_api_key_here
```

9. Test the Data API with curl before wiring it into the extension:

```bash
curl -X POST \
  https://data.mongodb-api.com/app/{YOUR_APP_ID}/endpoint/data/v1/action/find \
  -H "Content-Type: application/json" \
  -H "api-key: {YOUR_API_KEY}" \
  -d '{"dataSource":"Cluster0","database":"tipsy","collection":"pools","filter":{}}'
```

> **Why Atlas Data API and not the Node.js driver?** Chrome MV3 service workers run in a browser sandbox — they cannot use the MongoDB Node.js driver, which requires Node runtime APIs (`net`, `tls`) unavailable in the browser. The Atlas Data API is plain HTTPS: `fetch()` with an API key header. No npm install. Works perfectly in service workers.

---

## 10. Launch Checklist

| Item                                                                  | Done? |
| --------------------------------------------------------------------- | ----- |
| `manifest.json` loads in `chrome://extensions` without errors         | ☐     |
| Content script injects overlay on rumble.com video pages              | ☐     |
| `WATCH_TICK` messages reach background worker (check SW console)      | ☐     |
| Gemini API returns valid JSON (test with hardcoded context first)     | ☐     |
| Tips appear in MongoDB `tip_log` collection after triggering          | ☐     |
| Explore tab shows pools from MongoDB Atlas (10s poll)                 | ☐     |
| Contribute flow: WDK mock logs, MongoDB contribution document inserts | ☐     |
| Settings save and persist across popup open/close                     | ☐     |
| Budget cap enforced — no tips fire when cap is reached                | ☐     |
| Demo mode runs full flow in 30 seconds without a real video           | ☐     |
| Popup matches the design spec — Syne + DM Sans fonts loaded           | ☐     |
| Overlay appears on Rumble player, dismisses on click                  | ☐     |

---

## 11. Coding Agent Prompt

## 12. Recipient Resolution Demo Checklist

Use this checklist before demoing to verify the recipient guardrails and UI status flow.

- Open a Rumble video with an address candidate visible in page `hx-vals`.
- Confirm popup **Now** tab shows `Recipient resolved` before the first trigger threshold.
- Force a tip trigger (watch 50% or demo mode) and confirm a `TIP_RESULT` event with `status: confirmed` in background logs.
- Test with missing address context (page with no candidate): confirm tip is skipped and popup shows `Recipient missing` with reason.
- Test ambiguous candidates (inject two same-score addresses in dev): confirm `status: skipped` and reason `multiple_top_candidates`.
- Test invalid fallback defaults: clear valid defaults and creator map, then confirm `no_valid_recipient` skip.
- Confirm failed transfer path shows `Tip failed` (not success wording) in popup toast.
- Verify tip history only grows on confirmed transfers.

> Copy and paste everything below this line into Claude Code, Cursor, or any coding agent. Work through each step in order.

---

```
# TIPSY CHROME EXTENSION — FULL BUILD PROMPT
# Paste this into Claude Code, Cursor, or any agentic coding tool.
# Work through each STEP in order. Don't skip ahead.

## PROJECT CONTEXT
Build "Tipsy" — a Manifest V3 Chrome extension that enhances Rumble creator
tipping using the Tether WDK wallet and Gemini API as an AI agent.
This is a hackathon build — prioritise a working, beautiful demo over edge cases.

## TECH STACK
- Chrome Extension Manifest V3
- React 18 + Vite for popup UI
- Tailwind CSS for utility classes
- Gemini API (gemini-2.0-flash) — AI agent brain
- MongoDB Atlas (free M0) + Atlas Data API — shared pool state + tip log
- Rumble Tether WDK — wallet and payment execution

## DESIGN PHILOSOPHY
The popup must look like a premium fintech micro-app, not a generic extension.
Aesthetic: dark luxury finance — think Bloomberg Terminal meets a crypto wallet.
Tone: precise, warm, confident. Every pixel is intentional.

Key rules:
- NEVER use Inter, Roboto, Arial, or system fonts
- Load Google Fonts: Syne (display, 600/700/800) + DM Sans (body, 300/400/500) + DM Mono (amounts)
- Background base: #080B0F (near-black, slightly blue-tinted)
- Primary accent: #F0B429 (warm amber gold) — used for active states, CTAs, progress fills
- Success color: #0FD5A0 (teal) — confirmed tips
- Text: #F0EDE8 (warm white, not pure white) / #7A8499 (secondary)
- Cards: #111620 background, border rgba(255,255,255,0.07), border-radius 14px
- All monetary amounts in DM Mono font
- Micro-interactions on every interactive element (see Section 8.8 of PRD)
- Popup size: 380px wide × 560px tall

## STEP 1 — SCAFFOLD THE PROJECT
Create the full file structure:

tipsy-extension/
├── manifest.json
├── background.js
├── content.js
├── mongodb.js
├── popup/ (Vite React app)
│   ├── index.html         (load Google Fonts here)
│   ├── App.jsx
│   ├── tabs/
│   │   ├── NowPlaying.jsx
│   │   ├── Explore.jsx
│   │   ├── Activity.jsx
│   │   └── Settings.jsx
│   └── components/
│       ├── PoolCard.jsx
│       ├── TipFeedItem.jsx
│       ├── BudgetBar.jsx
│       └── TriggerRule.jsx
├── assets/icons/          (16.png, 48.png, 128.png — generate simple ◆ diamond logo)
└── .env                   (VITE_GEMINI_API_KEY, VITE_ATLAS_APP_ID, VITE_ATLAS_API_KEY)

Put all CSS variables from the design spec into a globals.css file imported in App.jsx.
Configure Tailwind to extend with these custom colors so they can be used as utilities.

## STEP 2 — CONTENT SCRIPT (content.js)
content.js must:
1. Find the Rumble HTML5 video element via querySelector.
2. On video "timeupdate" (throttled to every 30s), send:
   chrome.runtime.sendMessage({ type: "WATCH_TICK", payload: {
     watchPercent, videoTitle, creatorName, creatorId, durationSeconds
   }})
3. Watch for like button click (selector: [data-js="video-like-btn"]).
   Send: chrome.runtime.sendMessage({ type: "REACTION", payload: { reactionType: "like", ... }})
4. Watch for comment submit. Send same message with reactionType: "comment".
5. Inject a pill overlay into the Rumble player (bottom-right corner):
   - Style exactly per Section 8.9 of the PRD (dark glass, gold border, pulsing dot)
   - Shows: "● 64% · Next tip at 100%"
   - Updates every 10s based on current watch progress and user rules
   - Clicking it sends chrome.runtime.sendMessage({ type: "OPEN_POPUP" })
   - Has a dismiss (×) button — dismissed state persists for the session
6. Extract creator subscriber count from the page and send as:
   chrome.runtime.sendMessage({ type: "CREATOR_STATS", payload: { subscriberCount }})
   Use MutationObserver if subscriber count updates dynamically.

## STEP 3 — BACKGROUND SERVICE WORKER (background.js)
background.js must:
1. Import constants: GEMINI_API_KEY, ATLAS_APP_ID, ATLAS_API_KEY from built env.
2. Maintain in-memory session state:
   { tipped50, tipped100, tippedLike, tippedComment, tipsThisSession, currentCreatorId }
   Reset all flags when creatorId changes (new video detected).
3. On WATCH_TICK or REACTION messages:
   a. Load user rules from chrome.storage.sync.
   b. Load monthly spend from MongoDB via getMonthlySpend().
   c. Build agent context object (see Section 4.2 of PRD).
   d. Call callTipsyAgent(context) — see Section 4.4.
   e. If response.should_tip === true:
      i.  Call executeWDKTip(creatorId, amount, token, message).
      ii. Call logTip() to write to MongoDB tip_log.
      iii.Update session state flags to prevent duplicate triggers.
      iv. Send chrome.runtime.sendMessage({ type: "TIP_SENT", payload: tipData })
          so the popup can update live.
4. Set up chrome.alarms.create("pollPools", { periodInMinutes: 1 }).
5. In alarm handler:
   a. Fetch all active pools via getActivePools().
   b. For each pool, check milestone condition against latest creator stats.
   c. If goal met: call callTipsyAgent with trigger_type: "milestone",
      execute pool payout via WDK, call markPoolPaid().

## STEP 4 — MONGODB CLIENT (mongodb.js)
Use plain fetch() against the Atlas Data API. No SDK — works in MV3 service workers.

Base URL: https://data.mongodb-api.com/app/{ATLAS_APP_ID}/endpoint/data/v1/action/
Headers: { "Content-Type": "application/json", "api-key": ATLAS_API_KEY }
All requests POST with body: { dataSource: "Cluster0", database: "tipsy", collection, ... }

Export these helper functions:

getActivePools()
  → action: "find", filter: { status: "active" }
  → returns array of pool documents

contributeToPool(poolId, userWallet, amount)
  → Step 1: action "insertOne" on contributions:
     { pool_id: poolId, user_wallet_address: userWallet, amount_usdt: amount, contributed_at: new Date() }
  → Step 2: action "updateOne" on pools:
     filter: { _id: { $oid: poolId } }, update: { $inc: { balance_usdt: amount } }

markPoolPaid(poolId)
  → action "updateOne": { $set: { status: "paid" } }

logTip(tipObject)
  → action "insertOne" on tip_log collection

getTipHistory(userWallet)
  → action "find", filter: { user_wallet_address: userWallet },
     sort: { tipped_at: -1 }, limit: 50

getMonthlySpend(userWallet)
  → action "aggregate" on tip_log:
     pipeline: [
       { $match: { user_wallet_address: userWallet,
                   tipped_at: { $gte: start of current month } } },
       { $group: { _id: null, total: { $sum: "$amount_usdt" } } }
     ]
  → returns total or 0

## STEP 5 — WDK INTEGRATION (background.js)
Create executeWDKTip(creatorId, amount, token, message).
Start with a MOCK, wire real WDK after the flow is working end-to-end:

async function executeWDKTip(creatorId, amount, token, message) {
  // MOCK — replace with Rumble WDK call
  console.log("[TIPSY WDK MOCK]", { creatorId, amount, token, message });
  return { success: true, txHash: "mock_" + Date.now() };
}

## STEP 6 — GEMINI AGENT (background.js)
Implement callTipsyAgent(context) exactly as in Section 4.4 of the PRD.
Use the SYSTEM PROMPT from Section 4.3 verbatim.
Always JSON.parse the response after stripping markdown fences.
Log response.reasoning to console — never show it in the UI.

## STEP 7 — POPUP UI (React + Tailwind)

### App shell (App.jsx)
- 380×560px, bg #080B0F, no scrollbar visible
- Header: 48px — "◆ Tipsy" in Syne 700 gold + master auto-tip toggle (right)
- Bottom tab bar: 56px fixed — 4 tabs with icon + label
  Active tab: gold color + 2px gold top border on tab
  Inactive: text-[#7A8499]
- Tab content fills remaining height with overflow-y: auto, custom scrollbar
  (thin, gold, only visible on hover)
- Listen for chrome.runtime.onMessage for TIP_SENT to show a toast notification

### NowPlaying.jsx
Build exactly per Section 8.4 of PRD:
- Video info section (title in Syne 700, creator in DM Sans)
- Progress bar (6px, gold fill, animated width)
- "Next tip at X%" pill badge (gold-glow background)
- Last AI message box (left gold border, italic DM Sans, slides in on new message)
- Empty state: centered "Open a Rumble video to start tipping" in text-secondary
- Poll chrome.storage.session for current video state every 5s

### Explore.jsx
Build exactly per Section 8.5 of PRD:
- Fetch pools from MongoDB via getActivePools() on mount
- setInterval poll every 10s and refresh
- PoolCard components in a scrollable list (no grid — single column fits the 380px width)
- When Contribute is clicked: show an inline amount input that expands below the button
  (smooth height animation), with a Confirm button in gold
  On confirm: call contributeToPool(), show inline success state, refresh pool balance
- Empty state: "No active pools — check back soon"

### Activity.jsx
Build exactly per Section 8.6 of PRD:
- BudgetBar at top: "Spent $X.XX of $X.XX this month"
  Bar fills gold proportionally, turns teal (#0FD5A0) if under 50% used (feel good!)
- TipFeedItem list with trigger icons, amounts in DM Mono, AI messages in italic
- Timestamps as relative time ("2m ago", "1h ago")
- Empty state: centered ◆ diamond icon in gold + message below

### Settings.jsx
Build exactly per Section 8.7 of PRD:
- Section labels in Syne uppercase letter-spacing
- TriggerRule rows: toggle + amount input in one row, clean dividers
- Amount inputs: transparent bg, gold bottom border only, DM Mono, right-aligned
- Token pill selector: 3 pills in a row (USD₮ / XAU₮ / BTC)
- Min video length: range slider with gold thumb and track
- Debounce all saves to chrome.storage.sync (500ms)
- Show a "Saved ✓" green flash near changed fields on save

## STEP 8 — VITE BUILD CONFIG
Configure vite.config.js for MV3:
- Use vite-plugin-web-extension for proper MV3 bundling
- Output dir: dist/
- Inline VITE_* env vars at build time using import.meta.env
- Tailwind CSS configured with custom colors from design tokens

## STEP 9 — DEMO MODE
Add a Demo Mode toggle in Settings (clearly labeled "Demo Mode — for testing").
When on:
- Simulate watch progress from 0→100% over 30 seconds
- Auto-fire like event at 12 seconds
- Auto-fire comment event at 20 seconds
- Auto-fire milestone event at 26 seconds
- Each event triggers Gemini and shows the real AI response in the popup
This lets judges see the complete agent loop without needing to watch a real video.

## QUALITY BAR
- The popup must look like a real fintech product. If a screenshot of it wouldn't
  impress someone on Twitter, redesign it.
- Fonts MUST load — add a <link> to Google Fonts in popup/index.html.
- No raw JSON, no error stacks, no placeholder text in the final UI.
- Every loading state shows a skeleton loader (pulse animation, bg-elevated).
- Gemini errors → friendly toast ("Agent unavailable, trying again..."), retry once.
- All amounts: always 2 decimal places in DM Mono.
- All timestamps: relative ("2m ago") using a simple helper function.
- Extension must not modify or break Rumble page layout.
- Test in Chrome with devtools open on the service worker — zero unhandled errors.
```

---

_Good luck — ship it._
_Rumble Tipping Bot Track · USD₮ 5,000 prize pool_
