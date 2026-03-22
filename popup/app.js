const state = {
  tab: "now",
  popupState: null,
  agenticInsights: null,
  expandedPoolId: null,
  poolDrafts: {},
  pendingPoolId: null,
  demoTimerId: null,
  demoElapsedSeconds: 0,
  demoProgress: 0,
  demoFired: {
    like: false,
    comment: false,
    milestone: false,
  },
  lastAgentStatusToast: {
    status: "",
    at: 0,
  },
  walletInitLoading: false,
};

const content = document.getElementById("content");
const toast = document.getElementById("toast");
const autoTipToggle = document.getElementById("autoTipToggle");

let toastTimeout;
let saveTimeout;
const DEMO_DURATION_SECONDS = 30;

for (const btn of document.querySelectorAll(".tab")) {
  btn.addEventListener("click", () => {
    for (const item of document.querySelectorAll(".tab")) {
      item.classList.remove("active");
    }
    btn.classList.add("active");
    state.tab = btn.dataset.tab;
    render();
  });
}

autoTipToggle.addEventListener("change", async () => {
  const rules = (await chrome.storage.sync.get("rules")).rules || {};
  rules.autoTipEnabled = autoTipToggle.checked;
  await chrome.storage.sync.set({ rules });
  showToast(autoTipToggle.checked ? "Auto-tip on" : "Auto-tip off");
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "AGENT_STATUS") {
    const status = String(message?.payload?.status || "");
    const now = Date.now();
    if (
      state.lastAgentStatusToast.status === status &&
      now - state.lastAgentStatusToast.at < 4500
    ) {
      return;
    }

    state.lastAgentStatusToast = { status, at: now };
    if (status === "retrying") {
      showToast("Agent unavailable, trying again...");
    } else if (status === "fallback") {
      showToast("Agent unavailable — using local rules");
    }
  }

  if (message?.type === "TIP_RESULT") {
    const status = message?.payload?.status;
    const reason = message?.payload?.reason;

    if (status === "confirmed") {
      showToast("Tip confirmed");
    } else if (status === "failed") {
      showToast("Tip failed — transfer error");
    } else if (status === "skipped") {
      showToast(
        `Tip skipped — ${String(reason || "recipient unavailable").replaceAll("_", " ")}`,
      );
    }

    loadData();
  }

  if (message?.type === "TIP_SENT") {
    loadData();
  }

  if (message?.type === "POOL_CONTRIBUTED") {
    showToast(
      `Sent ${formatMoney(message.payload?.amount)} ${message.payload?.token || "USDT"} to creator`,
    );
    loadData();
  }

  if (message?.type === "POOL_MILESTONE_REACHED") {
    showToast("Milestone reached — tracking updated");
    loadData();
  }
});

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatMoney(value) {
  return Number(value || 0).toFixed(2);
}

function formatAddress(address) {
  const value = String(address || "").trim();
  if (!value) {
    return "—";
  }
  if (value.length <= 16) {
    return value;
  }
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function showToast(text) {
  clearTimeout(toastTimeout);
  toast.textContent = text;
  toast.classList.remove("hidden");
  toastTimeout = setTimeout(() => toast.classList.add("hidden"), 1800);
}

function flashSavedField(element) {
  if (!(element instanceof HTMLElement)) {
    return;
  }

  element.classList.remove("saved-flash");
  void element.offsetWidth;
  element.classList.add("saved-flash");
  setTimeout(() => element.classList.remove("saved-flash"), 700);
}

function getCreatorInitials(name) {
  const raw = String(name || "Creator").trim();
  if (!raw) {
    return "CR";
  }

  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

function animateContent() {
  content.classList.remove("tab-fade");
  void content.offsetWidth;
  content.classList.add("tab-fade");
}

function relativeTime(iso) {
  const ts = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function triggerLabel(trigger) {
  if (trigger === "watch_50" || trigger === "watch_100") return "↗ Watch";
  if (trigger === "like") return "♥ Like";
  if (trigger === "comment") return "💬 Comment";
  if (trigger === "pool_release") return "🏆 Pool";
  if (trigger === "pool_contribution") return "✦ Support";
  return "• Tip";
}

function getPoolId(pool) {
  if (!pool || !pool._id) {
    return "";
  }

  if (typeof pool._id === "string") {
    return pool._id;
  }

  return pool._id.$oid || "";
}

async function loadData() {
  const data = await chrome.runtime.sendMessage({
    type: "GET_POPUP_STATE",
    payload: { wallet: "demo_wallet" },
  });
  state.popupState = data?.state || null;

  const insights = await chrome.runtime
    .sendMessage({
      type: "GET_AGENTIC_INSIGHTS",
      payload: {
        wallet:
          state.popupState?.walletStatus?.addresses?.ethereum ||
          state.popupState?.walletStatus?.addresses?.bitcoin ||
          "demo_wallet",
      },
    })
    .catch(() => null);
  state.agenticInsights = insights?.insights || null;

  if (!state.popupState?.currentVideo) {
    const liveContext = await getLiveVideoFromActiveTab();
    if (liveContext) {
      state.popupState.currentVideo = {
        title: liveContext.title || "",
        creatorName: liveContext.creatorName || "",
        watchPercent: Number(liveContext.watchPercent || 0),
        lastTip: state.popupState.currentVideo?.lastTip || null,
      };
    }
  }

  autoTipToggle.checked = Boolean(
    state.popupState?.rules?.autoTipEnabled ?? true,
  );
  syncDemoMode();
  render();
}

async function getLiveVideoFromActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if (!tabId) {
      return null;
    }

    const response = await chrome.tabs.sendMessage(tabId, {
      type: "GET_VIDEO_CONTEXT",
    });

    if (!response?.ok || !response.payload) {
      return null;
    }

    return response.payload;
  } catch {
    return null;
  }
}

function getDemoPayload(progress) {
  return {
    creatorId: "demo_creator",
    creatorName: "Demo Creator",
    videoTitle: "Tipsy Demo Stream",
    videoCategory: "demo",
    durationSeconds: 180,
    watchPercent: progress,
  };
}

async function tickDemoMode() {
  state.demoElapsedSeconds += 1;
  state.demoProgress = Math.min(
    100,
    Math.round((state.demoElapsedSeconds / DEMO_DURATION_SECONDS) * 100),
  );

  const payload = getDemoPayload(state.demoProgress);

  await chrome.storage.session.set({
    currentVideo: {
      title: payload.videoTitle,
      creatorName: payload.creatorName,
      watchPercent: state.demoProgress,
      lastTip: state.popupState?.currentVideo?.lastTip || null,
    },
  });

  if (state.demoElapsedSeconds % 5 === 0 || state.demoElapsedSeconds === 1) {
    await chrome.runtime
      .sendMessage({ type: "WATCH_TICK", payload })
      .catch(() => null);
  }

  if (!state.demoFired.like && state.demoElapsedSeconds >= 12) {
    state.demoFired.like = true;
    await chrome.runtime
      .sendMessage({
        type: "REACTION",
        payload: { ...payload, reactionType: "like" },
      })
      .catch(() => null);
  }

  if (!state.demoFired.comment && state.demoElapsedSeconds >= 20) {
    state.demoFired.comment = true;
    await chrome.runtime
      .sendMessage({
        type: "REACTION",
        payload: { ...payload, reactionType: "comment" },
      })
      .catch(() => null);
  }

  if (!state.demoFired.milestone && state.demoElapsedSeconds >= 26) {
    state.demoFired.milestone = true;
    await chrome.runtime
      .sendMessage({
        type: "DEMO_MILESTONE",
        payload: {
          creatorId: payload.creatorId,
          creatorName: payload.creatorName,
          poolBalance: Math.max(
            1,
            Number(state.popupState?.pools?.[0]?.balance_usdt || 1.25),
          ),
        },
      })
      .catch(() => null);
  }

  if (state.demoElapsedSeconds >= DEMO_DURATION_SECONDS) {
    stopDemoMode();
    showToast("Demo run complete");
  }

  await loadData();
}

function stopDemoMode() {
  if (state.demoTimerId) {
    clearInterval(state.demoTimerId);
    state.demoTimerId = null;
  }
}

function startDemoMode() {
  if (state.demoTimerId) {
    return;
  }

  state.demoElapsedSeconds = 0;
  state.demoProgress = 0;
  state.demoFired = { like: false, comment: false, milestone: false };

  tickDemoMode();
  state.demoTimerId = setInterval(() => {
    tickDemoMode();
  }, 1000);
}

function syncDemoMode() {
  const enabled = Boolean(state.popupState?.rules?.demo_mode);
  if (enabled) {
    startDemoMode();
  } else {
    stopDemoMode();
  }
}

function renderNow() {
  const video = state.popupState?.currentVideo;
  const walletStatus = state.popupState?.walletStatus || {};
  const selectedNetworks = Array.isArray(walletStatus.activeNetworks)
    ? walletStatus.activeNetworks
    : ["ethereum", "polygon", "arbitrum", "bitcoin"];
  const activeNetworks = ["ethereum", "polygon", "arbitrum", "bitcoin"];
  const addresses = walletStatus?.addresses || {};
  const resolvedNetworks = selectedNetworks.length
    ? selectedNetworks
    : activeNetworks;
  const walletReady =
    Boolean(walletStatus.initialized) &&
    resolvedNetworks.some((network) => Boolean(addresses[network]));

  const testnetKeywords = [
    "sepolia",
    "goerli",
    "holesky",
    "mumbai",
    "amoy",
    "arbitrum-goerli",
    "testnet",
  ];
  const hasTestnetByNetwork = resolvedNetworks.some((network) =>
    testnetKeywords.some((keyword) =>
      String(network).toLowerCase().includes(keyword),
    ),
  );
  const hasBtcTestnetAddress = resolvedNetworks.some((network) => {
    if (String(network).toLowerCase() !== "bitcoin") {
      return false;
    }
    const btcAddress = String(addresses.bitcoin || "")
      .trim()
      .toLowerCase();
    return btcAddress.startsWith("tb1") || /^[mn2]/.test(btcAddress);
  });
  const walletEnvironment =
    hasTestnetByNetwork || hasBtcTestnetAddress ? "Testnet" : "Mainnet";

  const chainLabels = {
    ethereum: "Ethereum",
    polygon: "Polygon",
    arbitrum: "Arbitrum",
    bitcoin: "Bitcoin",
  };

  const chainEmojis = {
    ethereum: "◇",
    polygon: "⬟",
    arbitrum: "◈",
    bitcoin: "฿",
  };

  const chainIcons = {
    ethereum: "../assets/icons/eth.png",
    polygon: "",
    arbitrum: "",
    bitcoin: "../assets/icons/btc.png",
  };

  let walletCard = "";

  if (walletReady) {
    walletCard = `
      <div class="card wallet-card" style="margin-bottom:10px;">
        <div class="label">Your Wallets</div>
        <div style="margin-top:10px; margin-bottom:10px;">
          ${resolvedNetworks
            .map((net) => {
              const label = chainLabels[net];
              const addr = addresses[net] || "";
              const emoji = chainEmojis[net];
              const iconSrc = chainIcons[net] || "";
              if (!addr) return "";
              return `<div style="margin-bottom:8px; background:var(--subtle-bg,rgba(255,255,255,0.05)); border-radius:6px; padding:8px; font-family:monospace; font-size:11px;"><div style="color:var(--gold,#ffd700); margin-bottom:3px; display:flex; align-items:center; gap:6px;"><img class="chain-icon" src="${iconSrc}" alt="${label}" width="14" height="14" style="display:inline-block; vertical-align:middle;"><span class="chain-icon-fallback" style="display:none;">${emoji}</span><strong>${label}</strong></div><div style="color:var(--secondary-text,#999); word-break:break-all; font-size:10px;">${addr}</div></div>`;
            })
            .join("")}
        </div>
        <div class="subtle" style="margin-top:8px; font-size:11px;">Wallet ready • ${walletEnvironment} • Fund these addresses to enable tipping</div>
      </div>
    `;
  } else if (!state.walletInitLoading) {
    walletCard = `
      <div class="card wallet-card" style="margin-bottom:10px;">
        <div class="label">Wallet Setup</div>
        <div class="subtle">Set up your wallet to start tipping creators</div>
        <div class="label" style="margin-top:10px;">Seed Phrase</div>
        <textarea class="json-input seed-input" placeholder="Enter 12-24 word seed phrase"></textarea>
        <div class="label" style="margin-top:10px;">Networks</div>
        <div class="wallet-network-grid">
          ${activeNetworks
            .map(
              (network) =>
                `<label class="wallet-network-option"><input type="checkbox" class="wallet-network-input" value="${network}" checked /><span>${chainLabels[network]}</span></label>`,
            )
            .join("")}
        </div>
        <div class="seed-actions">
          <button class="btn seed-generate-btn" type="button">Generate</button>
          <button class="btn seed-init-btn" type="button">Initialize</button>
        </div>
      </div>
    `;
  } else {
    walletCard = `
      <div class="card wallet-card" style="margin-bottom:10px;">
        <div class="label">Wallet Setup</div>
        <div class="subtle" style="text-align:center; padding:20px 0;">
          <div style="animation: spin 1s linear infinite; display:inline-block; font-size:24px;">⟳</div>
          <div style="margin-top:8px; font-size:12px;">Initializing wallet...</div>
        </div>
      </div>
    `;
  }

  if (!video) {
    return `${walletCard}<div class="card"><div class="subtle">Open a Rumble video to start tipping.</div></div>`;
  }

  const percent = Number(video.watchPercent || 0);
  const next = percent < 50 ? "50" : percent < 95 ? "100" : "Done";
  const lastTip = video.lastTip;
  const recipientStatus = String(video.recipientStatus || "pending");
  const recipientReason = String(
    video.recipientReason || "waiting_for_context",
  );
  const statusLabel =
    recipientStatus === "resolved"
      ? "Recipient resolved"
      : recipientStatus === "ambiguous"
        ? "Recipient ambiguous"
        : recipientStatus === "failed"
          ? "Transfer failed"
          : recipientStatus === "unresolved"
            ? "Recipient missing"
            : "Recipient pending";
  const shouldShowResolveAction =
    recipientStatus === "unresolved" || recipientStatus === "ambiguous";

  return `
    ${walletCard}
    <div class="card">
      <div class="label">Watching</div>
      <div class="title">${escapeHtml(video.title || "Untitled")}</div>
      <div class="subtle">by ${escapeHtml(video.creatorName || "Unknown Creator")}</div>
      <div class="progress"><span style="width:${Math.round(percent)}%"></span></div>
      <div class="pill"><span>⚡</span><span>Next tip at ${next}%</span></div>
      <div class="subtle" style="margin-top:8px;">${escapeHtml(statusLabel)} · ${escapeHtml(recipientReason.replaceAll("_", " "))}</div>
      ${
        shouldShowResolveAction
          ? `<button class="btn now-resolve-btn" style="margin-top:10px;width:100%;">Open tip modal to reveal wallet</button>`
          : ""
      }
      ${
        lastTip
          ? `<div class="quote shimmer">“${escapeHtml(lastTip.message)}”<div class="quote-amount amount">· $${formatMoney(lastTip.amount)} ${escapeHtml(lastTip.token)}</div>${lastTip.recipient ? `<div class="subtle" style="margin-top:6px;">${escapeHtml(String(lastTip.network || "polygon").toLowerCase())} · ${escapeHtml(formatAddress(lastTip.recipient))}</div>` : ""}</div>`
          : ""
      }
    </div>
  `;
}

function bindWalletSetupActions() {
  const seedInput = content.querySelector(".seed-input");
  const seedGenerate = content.querySelector(".seed-generate-btn");
  const seedInit = content.querySelector(".seed-init-btn");
  const networkInputs = Array.from(
    content.querySelectorAll(".wallet-network-input"),
  );

  if (seedGenerate && seedInput) {
    seedGenerate.addEventListener("click", async () => {
      seedGenerate.disabled = true;
      seedGenerate.textContent = "Generating...";
      const response = await chrome.runtime
        .sendMessage({ type: "GENERATE_SEED" })
        .catch(() => null);
      seedGenerate.disabled = false;
      seedGenerate.textContent = "Generate";

      if (!response?.success || !response?.seedPhrase) {
        showToast("Unable to generate seed");
        return;
      }

      seedInput.value = response.seedPhrase;
      flashSavedField(seedInput);
      showToast("Seed generated");
    });
  }

  if (seedInit && seedInput) {
    seedInit.addEventListener("click", async () => {
      const phrase = seedInput.value.trim();
      if (!phrase) {
        showToast("Enter a seed phrase first");
        return;
      }

      const valid = await chrome.runtime
        .sendMessage({ type: "VALIDATE_SEED", payload: { seedPhrase: phrase } })
        .catch(() => null);

      if (!valid?.valid) {
        showToast(valid?.reason || "Invalid seed phrase");
        return;
      }

      const selectedNetworks = networkInputs
        .filter((input) => input instanceof HTMLInputElement && input.checked)
        .map((input) => String(input.value || "").toLowerCase());

      if (!selectedNetworks.length) {
        showToast("Select at least one network");
        return;
      }

      state.walletInitLoading = true;
      seedInit.disabled = true;
      seedInit.textContent = "Initializing...";
      render();

      const result = await chrome.runtime
        .sendMessage({
          type: "INIT_WALLET",
          payload: {
            seedPhrase: phrase,
            networks: selectedNetworks,
          },
        })
        .catch(() => null);

      state.walletInitLoading = false;
      seedInit.disabled = false;
      seedInit.textContent = "Initialize";

      if (!result?.ok) {
        showToast(result?.error || "Wallet init failed");
        render();
        return;
      }

      flashSavedField(seedInput);
      showToast("Wallet initialized");
      await loadData();
    });
  }
}

function bindChainIconFallbacks() {
  const chainIcons = content.querySelectorAll(".chain-icon");
  for (const icon of chainIcons) {
    const src = String(icon.getAttribute("src") || "").trim();
    if (!src) {
      icon.style.display = "none";
      const emptyFallback = icon.nextElementSibling;
      if (emptyFallback instanceof HTMLElement) {
        emptyFallback.style.display = "inline";
      }
      continue;
    }

    icon.addEventListener(
      "error",
      () => {
        icon.style.display = "none";
        const fallback = icon.nextElementSibling;
        if (fallback instanceof HTMLElement) {
          fallback.style.display = "inline";
        }
      },
      { once: true },
    );
  }
}

function bindNowActions() {
  bindWalletSetupActions();
  bindChainIconFallbacks();

  const resolveButton = content.querySelector(".now-resolve-btn");
  if (!resolveButton) {
    return;
  }

  resolveButton.addEventListener("click", async () => {
    resolveButton.disabled = true;
    resolveButton.textContent = "Opening...";

    try {
      const response = await chrome.runtime.sendMessage({
        type: "OPEN_TIP_MODAL",
      });
      if (!response?.ok) {
        showToast(response?.error || "Unable to open tip modal");
      } else if (!response?.opened) {
        showToast("Tip button not found on this page");
      } else {
        showToast("Tip modal opened");
      }
    } catch {
      showToast("Unable to open tip modal");
    }

    await loadData();
  });
}

function renderExplore() {
  const localHistory = Array.isArray(state.popupState?.localTipHistory)
    ? state.popupState.localTipHistory
    : [];

  const total = localHistory.reduce(
    (sum, row) => sum + Number(row.amount || 0),
    0,
  );

  if (!localHistory.length) {
    return `
      <div class="card" style="margin-bottom:10px;">
        <div class="subtle">Local tips saved: <span class="amount">0</span></div>
      </div>
      <div class="card"><div class="subtle">No successful tips yet — once a tip confirms, amount/time/address/network will appear here.</div></div>
    `;
  }

  const items = localHistory
    .map(
      (item) => `
        <div class="feed-item">
          <div class="feed-top"><span>${triggerLabel(item.triggerType)}</span><span>$${formatMoney(item.amount)} ${escapeHtml(item.token || "USDT")}</span></div>
          <div class="subtle">${escapeHtml(item.creatorName || item.creatorId || "Creator")}</div>
          <div class="subtle" style="margin-top:6px;">${escapeHtml(String(item.network || "polygon").toLowerCase())} · ${escapeHtml(formatAddress(item.recipient))}</div>
          <div class="timestamp">${relativeTime(item.tippedAt || new Date().toISOString())}</div>
        </div>
      `,
    )
    .join("");

  return `
    <div class="card" style="margin-bottom:10px;">
      <div class="subtle">Local tips saved: <span class="amount">${localHistory.length}</span></div>
      <div class="subtle" style="margin-top:6px;">Total tipped: <span class="amount">$${formatMoney(total)}</span></div>
    </div>
    <div class="card">${items}</div>
  `;
}

async function handleContribution(poolId) {
  const amount = Number(state.poolDrafts[poolId] ?? "0");
  if (!Number.isFinite(amount) || amount <= 0) {
    showToast("Enter a valid amount");
    return;
  }

  state.pendingPoolId = poolId;
  render();
  bindExploreActions();

  const response = await chrome.runtime.sendMessage({
    type: "CONTRIBUTE_POOL",
    payload: { poolId, amount },
  });

  state.pendingPoolId = null;
  if (!response?.ok) {
    showToast(response?.error || "Contribution failed");
    render();
    bindExploreActions();
    return;
  }

  state.expandedPoolId = null;
  showToast(`Sent direct support $${formatMoney(amount)}`);
  await loadData();
}

function bindExploreActions() {
  const toggles = content.querySelectorAll(".pool-toggle-btn");
  for (const toggle of toggles) {
    toggle.addEventListener("click", () => {
      const poolId = toggle.dataset.poolId;
      if (!poolId) {
        return;
      }

      state.expandedPoolId = state.expandedPoolId === poolId ? null : poolId;
      if (!state.poolDrafts[poolId]) {
        state.poolDrafts[poolId] = "0.50";
      }
      render();
      bindExploreActions();
    });
  }

  const inputs = content.querySelectorAll(".contribute-input");
  for (const input of inputs) {
    input.addEventListener("input", () => {
      const poolId = input.dataset.poolId;
      if (!poolId) {
        return;
      }
      state.poolDrafts[poolId] = input.value;
    });
  }

  const confirms = content.querySelectorAll(".contribute-confirm-btn");
  for (const confirm of confirms) {
    confirm.addEventListener("click", () => {
      const poolId = confirm.dataset.poolId;
      if (!poolId || state.pendingPoolId) {
        return;
      }
      handleContribution(poolId);
    });
  }
}

function renderActivity() {
  const history = state.popupState?.history || [];
  const monthlyCap = Number(state.popupState?.rules?.monthly_cap || 5);
  const spent = history.reduce(
    (sum, item) => sum + Number(item.amount_usdt || 0),
    0,
  );
  const pct = Math.min(100, (spent / Math.max(monthlyCap, 1)) * 100);

  const list = history.length
    ? history
        .map(
          (item) => `
      <div class="feed-item">
        <div class="feed-top"><span>${triggerLabel(item.trigger_type)}</span><span>$${formatMoney(item.amount_usdt)} ${escapeHtml(item.token_type || "USDT")}</span></div>
        <div class="subtle">${escapeHtml(item.creator_name || item.creator_id || "Creator")}</div>
        <div class="quote" style="margin-top:8px;">“${escapeHtml(item.message || "")}”</div>
        <div class="timestamp">${relativeTime(item.tipped_at || new Date().toISOString())}</div>
      </div>
    `,
        )
        .join("")
    : `<div class="card"><div class="subtle">No tips yet — start watching Rumble.</div></div>`;

  return `
    <div class="card" style="margin-bottom:10px;">
      <div class="subtle">Spent <span class="amount">$${formatMoney(spent)}</span> of <span class="amount">$${formatMoney(monthlyCap)}</span> this month</div>
      <div class="progress"><span style="width:${pct}%;background:${pct < 50 ? "var(--teal)" : "linear-gradient(90deg, #d69820 0%, #f0b429 70%, #ffd16d 100%)"}"></span></div>
    </div>
    ${list}
  `;
}

function renderAgentic() {
  const insights = state.agenticInsights;
  const history = Array.isArray(state.popupState?.localTipHistory)
    ? state.popupState.localTipHistory
    : [];

  if (!insights) {
    return `
      <div class="card">
        <div class="label">Agentic Tipping</div>
        <div class="subtle">Analyzing tip history...</div>
      </div>
    `;
  }

  const recommendations = Array.isArray(insights.recommendations)
    ? insights.recommendations
    : [];
  const trendEntries = Object.entries(insights?.trend?.byTrigger || {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 4);

  return `
    <div class="card" style="margin-bottom:10px;">
      <div class="label">Agentic Tipping</div>
      <div class="subtle">Source: ${escapeHtml(insights.source || "local")}</div>
      <div class="title" style="font-size:14px;margin-top:6px;">${escapeHtml(insights.summary || "No summary yet")}</div>
      <div class="quote" style="margin-top:10px;">${escapeHtml(insights.prediction || "No prediction available")}</div>
      <div class="label" style="margin-top:12px;">Recommendations</div>
      ${
        recommendations.length
          ? `<ul class="agent-list">${recommendations.map((item) => `<li>${escapeHtml(String(item || ""))}</li>`).join("")}</ul>`
          : `<div class="subtle">No recommendations yet.</div>`
      }
      <div class="label" style="margin-top:12px;">Top Triggers</div>
      ${
        trendEntries.length
          ? `<div class="agent-grid">${trendEntries
              .map(
                ([key, value]) =>
                  `<div class="agent-chip"><span>${escapeHtml(triggerLabel(key))}</span><strong class="amount">$${formatMoney(value)}</strong></div>`,
              )
              .join("")}</div>`
          : `<div class="subtle">No trigger trend data yet.</div>`
      }
      <div class="subtle" style="margin-top:10px;">Tips analyzed: <span class="amount">${history.length}</span></div>
      <button class="btn agent-refresh-btn" style="margin-top:10px;width:100%;">Refresh analysis</button>
    </div>
  `;
}

function bindAgenticActions() {
  const refresh = content.querySelector(".agent-refresh-btn");
  if (!refresh) {
    return;
  }

  refresh.addEventListener("click", async () => {
    refresh.disabled = true;
    refresh.textContent = "Analyzing...";
    await loadData();
    showToast("Agentic analysis updated");
  });
}

function renderSettings() {
  const rules = state.popupState?.rules || {};
  const walletConfig = state.popupState?.walletConfig || {};
  const payoutMapJson = JSON.stringify(
    walletConfig.creatorPayoutMap || {},
    null,
    2,
  );
  const token = rules.token || "USDT";
  const network = rules.network || "polygon";
  const minVideo = Number(rules.min_video_seconds || 60);
  const demoMode = Boolean(rules.demo_mode);

  return `
    <div class="card">
      <div class="label">Auto-tip</div>
      <div class="input-row"><span>Demo Mode — for testing</span><label class="switch"><input class="demo-toggle" type="checkbox" ${demoMode ? "checked" : ""} /><span class="slider"></span></label></div>
      <div class="label">Triggers</div>
      <div class="input-row"><span>⏱ Watch 50%</span><input class="money-input" data-key="watch_50_amount" value="${formatMoney(rules.watch_50_amount || 0.25)}" /></div>
      <div class="input-row"><span>⏱ Watch 100%</span><input class="money-input" data-key="watch_100_amount" value="${formatMoney(rules.watch_100_amount || 0.5)}" /></div>
      <div class="input-row"><span>♥ Like</span><input class="money-input" data-key="like_amount" value="${formatMoney(rules.like_amount || 0.1)}" /></div>
      <div class="input-row"><span>💬 Comment</span><input class="money-input" data-key="comment_amount" value="${formatMoney(rules.comment_amount || 0.2)}" /></div>
      <div class="label" style="margin-top:14px;">Budget</div>
      <div class="input-row"><span>Monthly cap</span><input class="money-input" data-key="monthly_cap" value="${formatMoney(rules.monthly_cap || 5)}" /></div>

      <div class="token-pills">
        <button class="token-pill ${token === "USDT" ? "active" : ""}" data-token="USDT">USD₮</button>
        <button class="token-pill ${token === "XAUT" ? "active" : ""}" data-token="XAUT">XAU₮</button>
        <button class="token-pill ${token === "BTC" ? "active" : ""}" data-token="BTC">BTC</button>
      </div>

      <div class="label" style="margin-top:14px;">Network</div>
      <div class="token-pills network-pills">
        <button class="token-pill network-pill ${network === "polygon" ? "active" : ""}" data-network="polygon">Polygon</button>
        <button class="token-pill network-pill disabled" data-network="ethereum" disabled>Ethereum</button>
        <button class="token-pill network-pill disabled" data-network="solana" disabled>Solana</button>
      </div>
      <div class="subtle network-note">Demo uses Polygon only for now.</div>

      <div class="label" style="margin-top:12px;">Creator Payout Map (Optional Fallback)</div>
      <textarea class="json-input payout-map-input" data-wallet-key="creatorPayoutMap" spellcheck="false">${escapeHtml(payoutMapJson)}</textarea>
      <div class="subtle network-note">Auto-fetch from video is primary; this map is only used if no on-video wallet is found.</div>

      <div class="slider-row">
        <div class="subtle">Min video length</div>
        <div class="range-wrap">
          <input class="range" data-key="min_video_seconds" type="range" min="30" max="300" step="15" value="${minVideo}" />
          <span class="range-value">${minVideo}s</span>
        </div>
      </div>
    </div>
  `;
}

async function saveRules(updated) {
  await chrome.storage.sync.set({ rules: updated });
}

async function bindSettingsInputs() {
  const data = await chrome.storage.sync.get(["rules", "creatorPayoutMap"]);
  const rules = data.rules || {};
  const walletDraft = {
    creatorPayoutMap: data.creatorPayoutMap || {},
  };

  const inputs = content.querySelectorAll(".money-input");
  for (const input of inputs) {
    input.addEventListener("input", () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(async () => {
        const key = input.dataset.key;
        const value = Number(input.value);
        if (!key || Number.isNaN(value)) {
          return;
        }
        rules[key] = value;
        await saveRules(rules);
        flashSavedField(input);
        showToast("Saved ✓");
      }, 300);
    });
  }

  const tokenPills = content.querySelectorAll(".token-pill");
  for (const pill of tokenPills) {
    if (!pill.dataset.token) {
      continue;
    }

    pill.addEventListener("click", async () => {
      rules.token = pill.dataset.token;
      await saveRules(rules);
      flashSavedField(pill);
      showToast("Token updated");
      render();
    });
  }

  const networkPills = content.querySelectorAll(".network-pill");
  for (const pill of networkPills) {
    pill.addEventListener("click", async () => {
      const selected = pill.dataset.network;
      if (!selected) {
        return;
      }

      if (selected !== "polygon") {
        showToast("Coming soon — Polygon only in demo");
        return;
      }

      rules.network = selected;
      await saveRules(rules);
      flashSavedField(pill);
      showToast("Network set to Polygon");
      render();
    });
  }

  const demoToggle = content.querySelector(".demo-toggle");
  if (demoToggle) {
    demoToggle.addEventListener("change", async () => {
      rules.demo_mode = demoToggle.checked;
      await saveRules(rules);
      state.popupState = {
        ...state.popupState,
        rules: { ...state.popupState.rules, demo_mode: demoToggle.checked },
      };
      syncDemoMode();
      flashSavedField(demoToggle);
      showToast(demoToggle.checked ? "Demo Mode on" : "Demo Mode off");
    });
  }

  const payoutMapInput = content.querySelector(".payout-map-input");
  if (payoutMapInput) {
    payoutMapInput.addEventListener("input", () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(async () => {
        const raw = payoutMapInput.value.trim();
        if (!raw) {
          walletDraft.creatorPayoutMap = {};
          await chrome.storage.sync.set({ creatorPayoutMap: {} });
          flashSavedField(payoutMapInput);
          showToast("Payout map cleared");
          return;
        }

        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            showToast("Payout map must be a JSON object");
            return;
          }

          walletDraft.creatorPayoutMap = parsed;
          await chrome.storage.sync.set({ creatorPayoutMap: parsed });
          flashSavedField(payoutMapInput);
          showToast("Payout map saved");
        } catch {
          showToast("Invalid JSON in payout map");
        }
      }, 400);
    });
  }

  const slider = content.querySelector(".range");
  if (slider) {
    slider.addEventListener("input", () => {
      const next = Number(slider.value || 60);
      const label = content.querySelector(".range-value");
      if (label) {
        label.textContent = `${next}s`;
      }
    });

    slider.addEventListener("change", async () => {
      const next = Number(slider.value || 60);
      rules.min_video_seconds = next;
      await saveRules(rules);
      flashSavedField(slider);
      showToast("Saved ✓");
    });
  }
}

function render() {
  if (!state.popupState) {
    content.innerHTML = `
      <div class="card">
        <div class="skeleton-line lg"></div>
        <div class="skeleton-line md"></div>
        <div class="skeleton-bar"></div>
        <div class="skeleton-line sm"></div>
      </div>
    `;
    animateContent();
    return;
  }

  if (state.tab === "now") {
    content.innerHTML = renderNow();
    bindNowActions();
    animateContent();
    return;
  }

  if (state.tab === "explore") {
    content.innerHTML = renderExplore();
    animateContent();
    return;
  }

  if (state.tab === "agentic") {
    content.innerHTML = renderAgentic();
    bindAgenticActions();
    animateContent();
    return;
  }

  if (state.tab === "settings") {
    content.innerHTML = renderSettings();
    bindSettingsInputs();
    animateContent();
  }
}

loadData();
setInterval(loadData, 7000);

window.addEventListener("beforeunload", () => {
  stopDemoMode();
});
