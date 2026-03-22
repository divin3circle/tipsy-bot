const WATCH_INTERVAL_MS = 30_000;
const OVERLAY_REFRESH_MS = 10_000;

let lastWatchTick = 0;
let lastStatsSentAt = 0;
let video = null;
let overlay = null;
let overlayDismissed = false;
let currentWatchPercent = 0;
let runtimeInvalidated = false;
let bootIntervalId = null;
let overlayIntervalId = null;
let observer = null;
let htmxDiscoveryInFlight = false;
let htmxDiscoveryAt = 0;
let htmxDiscoveredCandidates = [];
let htmxInitialDiscoveryDone = false;
let toastHost = null;
let lastHeartbeatAt = 0;
let lastNoVideoLogAt = 0;
let lastNoDurationLogAt = 0;

const HTMX_DISCOVERY_INTERVAL_MS = 15_000;

function hasValidRuntime() {
  if (runtimeInvalidated) {
    return false;
  }

  try {
    return Boolean(chrome && chrome.runtime && chrome.runtime.id);
  } catch (error) {
    if (
      String(error?.message || "").includes("Extension context invalidated")
    ) {
      runtimeInvalidated = true;
      stopRuntimeLoops();
    }
    return false;
  }
}

function getVideoElement() {
  return document.querySelector("video");
}

function getVideoContext() {
  const title =
    document.querySelector("meta[property='og:title']")?.content ||
    document.querySelector("h1")?.textContent?.trim() ||
    document.title ||
    "Rumble Video";

  const creatorName =
    document.querySelector("[data-js='channel-name']")?.textContent?.trim() ||
    document.querySelector("a[href*='/c/']")?.textContent?.trim() ||
    "Unknown Creator";

  const creatorHref =
    document.querySelector("a[href*='/c/']")?.getAttribute("href") ||
    location.pathname;
  const creatorUrl = new URL(
    creatorHref || location.pathname,
    location.origin,
  ).toString();

  const creatorId = (creatorHref || "").replace(/^\//, "") || "unknown_creator";
  const recipient = getPreferredRecipientCandidate();

  return {
    title,
    creatorName,
    creatorId,
    creatorUrl,
    creatorAddress: recipient?.address || "",
    creatorAddressCandidates: getCreatorAddressCandidates(),
  };
}

function parseHxValsSafe(raw) {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeCandidateToken(token) {
  return String(token || "")
    .trim()
    .toUpperCase();
}

function normalizeCandidateNetwork(network) {
  return String(network || "")
    .trim()
    .toLowerCase();
}

function looksLikeEvmAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || "").trim());
}

function looksLikeBtcAddress(value) {
  return /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(
    String(value || "").trim(),
  );
}

function getCreatorAddressCandidates() {
  const candidates = [];
  const seen = new Set();

  // Start with HTMX-discovered candidates
  for (const entry of htmxDiscoveredCandidates) {
    const candidate = toCandidate(entry, "htmx_discovery");
    if (!candidate) {
      continue;
    }

    const key = `${candidate.address}:${candidate.token}:${candidate.network}:${candidate.source}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    candidates.push(candidate);
  }

  if (candidates.length > 0) {
    console.log(
      `[Tipsy] getCreatorAddressCandidates: ${candidates.length} from HTMX discovery`,
      candidates.map((c) => `${c.network}/${c.token}`),
    );
  }

  const nodes = document.querySelectorAll(
    '[hx-vals*="address"], button[hx-vals]',
  );
  for (const node of nodes) {
    const hxVals = node.getAttribute("hx-vals");
    if (!hxVals || !hxVals.includes("address")) {
      continue;
    }

    try {
      const vals = JSON.parse(hxVals);
      const address = String(vals?.address || "").trim();
      if (!address) {
        continue;
      }

      if (!looksLikeEvmAddress(address) && !looksLikeBtcAddress(address)) {
        continue;
      }

      const token = normalizeCandidateToken(
        vals?.currency || vals?.token || "",
      );
      const network = normalizeCandidateNetwork(
        vals?.blockchain || vals?.network || "",
      );
      const key = `${address}:${token}:${network}:hx_vals`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      candidates.push({
        address,
        token,
        network,
        source: "hx_vals",
      });
    } catch {
      // ignore malformed hx-vals
    }
  }

  const bodyText = document.body?.innerText || "";
  const evmMatch = bodyText.match(/0x[a-fA-F0-9]{40}/);
  if (evmMatch?.[0]) {
    const address = evmMatch[0].trim();
    const key = `${address}:::page_text`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push({
        address,
        token: "",
        network: "",
        source: "page_text",
      });
    }
  }

  const btcMatch = bodyText.match(
    /\b(bc1[a-zA-HJ-NP-Z0-9]{25,62}|[13][a-zA-HJ-NP-Z0-9]{25,62})\b/,
  );
  if (btcMatch?.[0]) {
    const address = btcMatch[0].trim();
    const key = `${address}:::page_text`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push({
        address,
        token: "",
        network: "",
        source: "page_text",
      });
    }
  }

  return candidates;
}

function getPreferredRecipientCandidate() {
  const candidates = getCreatorAddressCandidates();
  if (!candidates.length) {
    return null;
  }

  const polygonUsdt = candidates.find(
    (item) =>
      item.network === "polygon" &&
      normalizeCandidateToken(item.token) === "USDT",
  );
  if (polygonUsdt) {
    return polygonUsdt;
  }

  const polygonAny = candidates.find((item) => item.network === "polygon");
  if (polygonAny) {
    return polygonAny;
  }

  return candidates[0];
}

function toCandidate(entry, fallbackSource = "unknown") {
  const address = String(entry?.address || "").trim();
  if (!address) {
    return null;
  }

  if (!looksLikeEvmAddress(address) && !looksLikeBtcAddress(address)) {
    return null;
  }

  return {
    address,
    token: normalizeCandidateToken(entry?.token || entry?.currency || ""),
    network: normalizeCandidateNetwork(
      entry?.network || entry?.blockchain || "",
    ),
    source: String(entry?.source || fallbackSource),
  };
}

function dedupeCandidates(list) {
  const seen = new Set();
  const out = [];

  for (const entry of list || []) {
    const candidate = toCandidate(entry, entry?.source || "candidate");
    if (!candidate) {
      continue;
    }

    const key = `${candidate.address}:${candidate.token}:${candidate.network}:${candidate.source}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    out.push(candidate);
  }

  return out;
}

function extractCandidatesFromRoot(root, source) {
  const found = [];
  const nodes = root.querySelectorAll('[hx-vals*="address"], button[hx-vals]');

  for (const node of nodes) {
    const vals = parseHxValsSafe(node.getAttribute("hx-vals"));
    if (!vals?.address) {
      continue;
    }

    const candidate = toCandidate(
      {
        address: vals.address,
        token: vals.currency || vals.token,
        network: vals.blockchain || vals.network,
        source,
      },
      source,
    );

    if (candidate) {
      found.push(candidate);
    }
  }

  return found;
}

function findTipModalButton(root) {
  const primary = root.querySelector('button[hx-get*="qr-modal"]');
  if (primary) {
    return primary;
  }

  const all = root.querySelectorAll("button[hx-get]");
  for (const node of all) {
    const hxGet = String(node.getAttribute("hx-get") || "").toLowerCase();
    if (hxGet.includes("wallet") || hxGet.includes("qr-modal")) {
      return node;
    }
  }

  return null;
}

function findAddressStepButton(root) {
  const primary = root.querySelector('button[hx-get*="qr-address"]');
  if (primary) {
    return primary;
  }

  const all = root.querySelectorAll("[hx-get]");
  for (const node of all) {
    const hxGet = String(node.getAttribute("hx-get") || "").toLowerCase();
    if (hxGet.includes("address") || hxGet.includes("wallet")) {
      return node;
    }
  }

  return null;
}

async function htmxFetchHtml(hxGet, hxVals) {
  if (!hxGet) {
    return "";
  }

  const params = new URLSearchParams();
  const vals = parseHxValsSafe(hxVals) || {};
  for (const [key, value] of Object.entries(vals)) {
    if (value === undefined || value === null) {
      continue;
    }
    params.set(key, String(value));
  }

  const url = new URL(hxGet, window.location.origin);
  for (const [key, value] of params.entries()) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    credentials: "include",
    headers: {
      "HX-Request": "true",
      "HX-Current-URL": window.location.href,
    },
  });

  if (!response.ok) {
    return "";
  }

  return response.text();
}

async function refreshRecipientCandidatesFromHtmx(force = false) {
  if (htmxDiscoveryInFlight) {
    return;
  }

  // On first run, bypass throttle to discover addresses ASAP
  if (!htmxInitialDiscoveryDone) {
    // Initial discovery always runs, skip throttle
  } else if (
    !force &&
    Date.now() - htmxDiscoveryAt < HTMX_DISCOVERY_INTERVAL_MS
  ) {
    console.log(
      `[Tipsy] HTMX discovery throttled, next run in ${Math.max(0, HTMX_DISCOVERY_INTERVAL_MS - (Date.now() - htmxDiscoveryAt))}ms`,
    );
    return;
  }

  htmxDiscoveryInFlight = true;
  try {
    const baseCandidates = extractCandidatesFromRoot(document, "hx_vals");
    const tipButton = findTipModalButton(document);

    if (!tipButton) {
      console.log(
        `[Tipsy] No tip button found in DOM. Found ${baseCandidates.length} candidates from hx-vals`,
      );
      htmxDiscoveredCandidates = dedupeCandidates(baseCandidates);
      htmxDiscoveryAt = Date.now();
      htmxInitialDiscoveryDone = true;
      return;
    }

    console.log(`[Tipsy] Found tip button, starting 3-step HTMX fetch...`);

    const modalHtml = await htmxFetchHtml(
      tipButton.getAttribute("hx-get"),
      tipButton.getAttribute("hx-vals"),
    );

    const parser = new DOMParser();
    const modalDoc = parser.parseFromString(modalHtml || "", "text/html");
    const modalCandidates = extractCandidatesFromRoot(modalDoc, "htmx_modal");

    let tabsCandidates = [];
    const step2Button = findAddressStepButton(modalDoc);
    if (step2Button) {
      const tabsHtml = await htmxFetchHtml(
        step2Button.getAttribute("hx-get"),
        step2Button.getAttribute("hx-vals"),
      );
      const tabsDoc = parser.parseFromString(tabsHtml || "", "text/html");
      tabsCandidates = extractCandidatesFromRoot(tabsDoc, "htmx_tabs");
    }

    htmxDiscoveredCandidates = dedupeCandidates([
      ...baseCandidates,
      ...modalCandidates,
      ...tabsCandidates,
    ]);
    htmxDiscoveryAt = Date.now();
    htmxInitialDiscoveryDone = true;
    console.log(
      `[Tipsy] HTMX discovery complete: ${htmxDiscoveredCandidates.length} candidates found`,
      htmxDiscoveredCandidates.map(
        (c) => `${c.network}/${c.token || "?"}→${c.address.slice(0, 10)}...`,
      ),
    );
  } catch (error) {
    console.error(`[Tipsy] HTMX discovery error:`, error);
    htmxDiscoveryAt = Date.now();
    htmxInitialDiscoveryDone = true;
  } finally {
    htmxDiscoveryInFlight = false;
  }
}

function parseSubscriberCount() {
  const candidates = Array.from(document.querySelectorAll("span,div,p"));
  for (const node of candidates) {
    const text = node.textContent?.trim();
    if (!text) continue;
    if (!/subscribers?/i.test(text)) continue;

    const numeric = text.match(/([\d,.]+)\s*([kKmM])?/);
    if (!numeric) continue;

    const raw = Number((numeric[1] || "0").replace(/,/g, ""));
    const suffix = (numeric[2] || "").toLowerCase();
    if (Number.isNaN(raw)) continue;

    if (suffix === "k") return Math.round(raw * 1_000);
    if (suffix === "m") return Math.round(raw * 1_000_000);
    return Math.round(raw);
  }

  return 0;
}

function safeSendMessage(message) {
  if (!hasValidRuntime()) {
    return Promise.resolve(null);
  }

  try {
    return chrome.runtime.sendMessage(message).catch((error) => {
      if (
        String(error?.message || "").includes("Extension context invalidated")
      ) {
        runtimeInvalidated = true;
        stopRuntimeLoops();
      }
      return null;
    });
  } catch (error) {
    if (
      String(error?.message || "").includes("Extension context invalidated")
    ) {
      runtimeInvalidated = true;
      stopRuntimeLoops();
      return Promise.resolve(null);
    }

    return Promise.resolve(null);
  }
}

function sendContentHeartbeat(reason = "alive", extra = {}) {
  const now = Date.now();
  if (now - lastHeartbeatAt < 10_000) {
    return;
  }

  lastHeartbeatAt = now;
  safeSendMessage({
    type: "CONTENT_HEARTBEAT",
    payload: {
      reason,
      href: location.href,
      hasVideo: Boolean(getVideoElement()),
      ...extra,
    },
  });
}

function stopRuntimeLoops() {
  if (bootIntervalId) {
    clearInterval(bootIntervalId);
    bootIntervalId = null;
  }

  if (overlayIntervalId) {
    clearInterval(overlayIntervalId);
    overlayIntervalId = null;
  }

  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

function getLiveVideoPayload() {
  const currentVideo = getVideoElement();
  const {
    title,
    creatorName,
    creatorId,
    creatorUrl,
    creatorAddress,
    creatorAddressCandidates,
  } = getVideoContext();
  const duration = Math.round(Number(currentVideo?.duration || 0));
  const percent = currentVideo?.duration
    ? Math.min(
        100,
        Math.max(0, (currentVideo.currentTime / currentVideo.duration) * 100),
      )
    : currentWatchPercent;

  return {
    title,
    creatorName,
    creatorId,
    creatorUrl,
    creatorAddress,
    creatorAddressCandidates,
    watchPercent: Math.round(Number(percent || 0)),
    durationSeconds: duration,
  };
}

function sendCreatorStats(force = false) {
  const now = Date.now();
  if (!force && now - lastStatsSentAt < 10_000) {
    return;
  }

  const { creatorId } = getVideoContext();
  lastStatsSentAt = now;

  safeSendMessage({
    type: "CREATOR_STATS",
    payload: {
      creatorId,
      subscriberCount: parseSubscriberCount(),
    },
  });
}

function sendWatchTick(force = false) {
  if (runtimeInvalidated) {
    return;
  }

  if (!video) {
    const now = Date.now();
    if (now - lastNoVideoLogAt > 10_000) {
      lastNoVideoLogAt = now;
      console.log("[Tipsy][content] WATCH_TICK skipped: no video element");
      sendContentHeartbeat("no_video");
    }
    return;
  }

  if (!video.duration || !Number.isFinite(video.duration)) {
    const now = Date.now();
    if (now - lastNoDurationLogAt > 10_000) {
      lastNoDurationLogAt = now;
      console.log(
        "[Tipsy][content] WATCH_TICK skipped: invalid video duration",
        {
          duration: video.duration,
        },
      );
      sendContentHeartbeat("no_duration", {
        duration: Number(video.duration || 0),
      });
    }
    return;
  }

  refreshRecipientCandidatesFromHtmx(false);

  const now = Date.now();
  if (!force && now - lastWatchTick < WATCH_INTERVAL_MS) {
    return;
  }

  lastWatchTick = now;
  currentWatchPercent = Math.min(
    100,
    Math.max(0, (video.currentTime / video.duration) * 100),
  );

  const {
    title,
    creatorName,
    creatorId,
    creatorUrl,
    creatorAddress,
    creatorAddressCandidates,
  } = getVideoContext();

  if (creatorAddressCandidates?.length > 0) {
    console.log(
      `[Tipsy] WATCH_TICK: sending ${creatorAddressCandidates.length} address candidates`,
      {
        preferred: creatorAddress
          ? `${creatorAddress.slice(0, 10)}...`
          : "(none)",
        candidates: creatorAddressCandidates.map(
          (c) => `${c.network}/${c.token}→${c.address.slice(0, 10)}...`,
        ),
      },
    );
  }

  safeSendMessage({
    type: "WATCH_TICK",
    payload: {
      watchPercent: currentWatchPercent,
      videoTitle: title,
      creatorName,
      creatorId,
      creatorUrl,
      creatorAddress,
      creatorAddressCandidates,
      durationSeconds: Math.round(video.duration),
    },
  });

  console.log("[Tipsy][content] WATCH_TICK sent", {
    watchPercent: Math.round(currentWatchPercent),
    creatorId,
    hasRecipient: Boolean(creatorAddress),
  });

  sendCreatorStats(true);
}

function sendReaction(reactionType) {
  if (runtimeInvalidated) {
    return;
  }

  refreshRecipientCandidatesFromHtmx(false);

  const {
    title,
    creatorName,
    creatorId,
    creatorUrl,
    creatorAddress,
    creatorAddressCandidates,
  } = getVideoContext();

  safeSendMessage({
    type: "REACTION",
    payload: {
      reactionType,
      watchPercent: currentWatchPercent,
      videoTitle: title,
      creatorName,
      creatorId,
      creatorUrl,
      creatorAddress,
      creatorAddressCandidates,
      durationSeconds: Math.round(video?.duration || 0),
    },
  });

  console.log("[Tipsy][content] REACTION sent", {
    reactionType,
    creatorId,
    hasRecipient: Boolean(creatorAddress),
  });
}

function addLikeListener() {
  const likeBtn = document.querySelector(
    "[data-js='video-like-btn'], button[aria-label*='Like'], [data-testid*='like']",
  );
  if (!likeBtn || likeBtn.dataset.tipsyBound === "1") {
    return;
  }

  likeBtn.dataset.tipsyBound = "1";
  likeBtn.addEventListener(
    "click",
    () => {
      console.log("[Tipsy][content] like click captured");
      sendReaction("like");
    },
    {
      passive: true,
    },
  );

  console.log("[Tipsy][content] like listener attached");
}

function addCommentListener() {
  const commentButton = document.querySelector(
    "[data-js='comment-submit'], button[type='submit'], button[aria-label*='Comment'], [data-testid*='comment']",
  );
  if (!commentButton || commentButton.dataset.tipsyBound === "1") {
    return;
  }

  commentButton.dataset.tipsyBound = "1";
  commentButton.addEventListener("click", () => {
    console.log("[Tipsy][content] comment click captured");
    setTimeout(() => sendReaction("comment"), 250);
  });

  console.log("[Tipsy][content] comment listener attached");
}

function createOverlay() {
  if (overlay || overlayDismissed) {
    return;
  }

  overlay = document.createElement("div");
  overlay.className = "tipsy-overlay";
  overlay.innerHTML = `
    <span class="dot"></span>
    <span class="label">0% · Next tip at 50%</span>
    <button class="close" aria-label="Dismiss">×</button>
  `;

  overlay.querySelector(".label")?.addEventListener("click", () => {
    safeSendMessage({ type: "OPEN_POPUP" });
  });

  overlay.querySelector(".dot")?.addEventListener("click", () => {
    safeSendMessage({ type: "OPEN_POPUP" });
  });

  overlay.querySelector(".close")?.addEventListener("click", (event) => {
    event.stopPropagation();
    overlayDismissed = true;
    overlay?.remove();
    overlay = null;
  });

  const player =
    video?.closest(".video-player") || video?.parentElement || document.body;
  if (!(player instanceof HTMLElement)) {
    return;
  }

  player.style.position = player.style.position || "relative";
  player.appendChild(overlay);
}

function updateOverlay() {
  if (!overlay || !video) {
    return;
  }

  currentWatchPercent = Math.min(
    100,
    Math.max(0, (video.currentTime / (video.duration || 1)) * 100),
  );
  const nextThreshold =
    currentWatchPercent < 50 ? 50 : currentWatchPercent < 95 ? 100 : "done";
  const text =
    nextThreshold === "done"
      ? `${Math.round(currentWatchPercent)}% · Threshold complete`
      : `${Math.round(currentWatchPercent)}% · Next tip at ${nextThreshold}%`;

  const label = overlay.querySelector(".label");
  if (label) {
    label.textContent = text;
  }
}

function injectStyles() {
  if (document.getElementById("tipsy-overlay-style")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "tipsy-overlay-style";
  style.textContent = `
    .tipsy-overlay {
      position: absolute;
      bottom: 16px;
      right: 16px;
      background: rgba(8, 11, 15, 0.85);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(240, 180, 41, 0.25);
      border-radius: 999px;
      padding: 6px 10px;
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
      animation: tipsy-pulse 2s ease-in-out infinite;
      display: inline-block;
    }

    .tipsy-overlay .label {
      user-select: none;
      line-height: 1;
    }

    .tipsy-overlay .close {
      border: none;
      background: transparent;
      color: #7a8499;
      font-size: 13px;
      cursor: pointer;
      line-height: 1;
      padding: 0;
      margin-left: 2px;
    }

    @keyframes tipsy-pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.4;
      }
    }

    .tipsy-toast-host {
      position: fixed;
      right: 18px;
      bottom: 22px;
      z-index: 2147483646;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
      max-width: min(360px, calc(100vw - 24px));
    }

    .tipsy-toast {
      pointer-events: auto;
      border-radius: 12px;
      padding: 12px 14px;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.32);
      border: 1px solid rgba(255, 255, 255, 0.15);
      font-family: "DM Sans", sans-serif;
      color: #f6f9ff;
      background: linear-gradient(145deg, #0d1420, #0a1018);
      opacity: 0;
      transform: translateY(10px);
      transition: opacity 180ms ease, transform 180ms ease;
    }

    .tipsy-toast.show {
      opacity: 1;
      transform: translateY(0);
    }

    .tipsy-toast.success {
      border-color: rgba(0, 212, 170, 0.55);
      box-shadow: 0 12px 28px rgba(0, 212, 170, 0.22);
    }

    .tipsy-toast.error {
      border-color: rgba(248, 113, 113, 0.65);
      box-shadow: 0 12px 28px rgba(239, 68, 68, 0.24);
    }

    .tipsy-toast.warning {
      border-color: rgba(240, 180, 41, 0.6);
      box-shadow: 0 12px 28px rgba(240, 180, 41, 0.22);
    }

    .tipsy-toast .title {
      font-size: 13px;
      font-weight: 700;
      line-height: 1.2;
      margin-bottom: 2px;
    }

    .tipsy-toast .body {
      font-size: 12px;
      line-height: 1.35;
      color: #dce7ff;
      word-break: break-word;
    }
  `;

  document.head.appendChild(style);
}

function ensureToastHost() {
  if (toastHost && document.body?.contains(toastHost)) {
    return toastHost;
  }

  toastHost = document.createElement("div");
  toastHost.className = "tipsy-toast-host";
  document.body.appendChild(toastHost);
  return toastHost;
}

function showPageToast({
  title,
  body,
  variant = "warning",
  durationMs = 5000,
}) {
  const host = ensureToastHost();
  if (!host) {
    return;
  }

  const toast = document.createElement("div");
  toast.className = `tipsy-toast ${variant}`;

  const safeTitle = String(title || "Tipsy").trim();
  const safeBody = String(body || "").trim();

  console.log("[Tipsy][toast] render", {
    title: safeTitle,
    variant,
    body: safeBody,
  });

  toast.innerHTML = `
    <div class="title">${safeTitle}</div>
    <div class="body">${safeBody}</div>
  `;

  host.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));

  setTimeout(
    () => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 220);
    },
    Math.max(1500, Number(durationMs || 0)),
  );
}

function handleTipToastMessage(payload = {}) {
  const status = String(payload?.status || "").toLowerCase();
  console.log("[Tipsy][toast] received", { status, payload });

  if (status === "confirmed") {
    const amount = Number(payload?.amount_usdt || 0);
    const token = String(payload?.token_type || "USDT").toUpperCase();
    const creator = String(payload?.creator_name || "creator");
    showPageToast({
      title: "₮ Tip sent",
      body: `${amount} ${token} → ${creator}`,
      variant: "success",
      durationMs: 5200,
    });
    return;
  }

  if (status === "failed") {
    const error = String(payload?.error || "Transfer failed").trim();
    showPageToast({
      title: "Tip failed",
      body: error,
      variant: "error",
      durationMs: 6000,
    });
    return;
  }

  if (status === "cooldown") {
    const error = String(payload?.error || "Recent transfer failure").trim();
    showPageToast({
      title: "Tip paused",
      body: `${error} Retry shortly.`,
      variant: "warning",
      durationMs: 4200,
    });
    return;
  }

  if (status === "pending") {
    const error = String(
      payload?.error ||
        "Transaction already submitted to the network. Waiting for confirmation.",
    ).trim();
    showPageToast({
      title: "Tip pending",
      body: error,
      variant: "warning",
      durationMs: 5200,
    });
    return;
  }

  if (status === "unresolved" || status === "skipped") {
    const error = String(
      payload?.error || "Recipient unavailable for this creator right now.",
    ).trim();
    showPageToast({
      title: "Tip skipped",
      body: error,
      variant: "warning",
      durationMs: 4800,
    });
  }
}

function attachVideoListeners() {
  video = getVideoElement();
  if (!video || video.dataset.tipsyBound === "1") {
    return;
  }

  video.dataset.tipsyBound = "1";
  video.addEventListener("timeupdate", () => {
    sendWatchTick(false);
    updateOverlay();
  });

  createOverlay();
}

function boot() {
  if (runtimeInvalidated) {
    return;
  }

  injectStyles();
  attachVideoListeners();
  addLikeListener();
  addCommentListener();
  sendContentHeartbeat("boot", {
    hasBoundVideo: Boolean(video),
  });

  // Force early HTMX discovery on first boot to find creator addresses ASAP
  if (!htmxInitialDiscoveryDone) {
    console.log("[Tipsy] Boot: Triggering early HTMX discovery (force=true)");
    refreshRecipientCandidatesFromHtmx(true);
  } else {
    // On subsequent boots, use normal throttle
    refreshRecipientCandidatesFromHtmx(false);
  }

  sendWatchTick(true);
}

boot();
bootIntervalId = setInterval(boot, 2_000);
overlayIntervalId = setInterval(updateOverlay, OVERLAY_REFRESH_MS);

observer = new MutationObserver(() => {
  if (runtimeInvalidated) {
    return;
  }

  addLikeListener();
  addCommentListener();
  sendCreatorStats(false);
});

observer.observe(document.documentElement, { childList: true, subtree: true });

if (hasValidRuntime()) {
  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === "GET_VIDEO_CONTEXT") {
        sendResponse({ ok: true, payload: getLiveVideoPayload() });
        return true;
      }

      if (message?.type === "OPEN_TIP_MODAL") {
        (async () => {
          try {
            const tipButton = findTipModalButton(document);
            if (tipButton) {
              tipButton.click();
            }
            await refreshRecipientCandidatesFromHtmx(true);
            sendResponse({ ok: true, opened: Boolean(tipButton) });
          } catch (error) {
            sendResponse({
              ok: false,
              error: error?.message || "Failed to open tip modal",
            });
          }
        })();
        return true;
      }

      if (message?.type === "TIP_PAGE_TOAST") {
        console.log("[Tipsy][toast] message_event", message.payload || {});
        handleTipToastMessage(message.payload || {});
        sendResponse?.({ ok: true });
        return true;
      }

      return false;
    });
  } catch (error) {
    if (
      String(error?.message || "").includes("Extension context invalidated")
    ) {
      runtimeInvalidated = true;
      stopRuntimeLoops();
    }
  }
}
