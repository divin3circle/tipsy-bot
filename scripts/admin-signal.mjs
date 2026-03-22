#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const index = trimmed.indexOf("=");
    if (index <= 0) {
      continue;
    }

    const key = trimmed.slice(0, index).trim();
    const value = trimmed
      .slice(index + 1)
      .trim()
      .replace(/^"|"$/g, "");
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      continue;
    }

    const normalized = key.replace(/^--/, "");
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[normalized] = "true";
      continue;
    }

    args[normalized] = next;
    i += 1;
  }

  return args;
}

function toIso(input) {
  if (!input) {
    return new Date().toISOString();
  }

  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid --when value: ${input}`);
  }

  return date.toISOString();
}

async function atlasAction({
  appId,
  apiKey,
  dataSource,
  database,
  action,
  collection,
  payload,
}) {
  const url = `https://data.mongodb-api.com/app/${appId}/endpoint/data/v1/action/${action}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
      dataSource,
      database,
      collection,
      ...payload,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Atlas ${action} failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function main() {
  const root = process.cwd();
  loadDotEnv(path.join(root, ".env"));

  const appId = process.env.TIPSY_ATLAS_APP_ID || process.env.VITE_ATLAS_APP_ID;
  const apiKey =
    process.env.TIPSY_ATLAS_API_KEY || process.env.VITE_ATLAS_API_KEY;
  const dataSource =
    process.env.TIPSY_ATLAS_DATA_SOURCE ||
    process.env.VITE_ATLAS_DATA_SOURCE ||
    "brewtip";
  const database =
    process.env.TIPSY_ATLAS_DATABASE ||
    process.env.VITE_ATLAS_DATABASE ||
    "tipsy";

  if (!appId || !apiKey) {
    throw new Error(
      "Missing Atlas credentials. Set VITE_ATLAS_APP_ID and VITE_ATLAS_API_KEY in .env",
    );
  }

  const args = parseArgs(process.argv.slice(2));
  const poolId = String(args.pool || "").trim();
  const creatorId = String(args.creator || "").trim();
  const note = String(args.note || "").trim();
  const ready = String(args.ready || "true").toLowerCase() !== "false";
  const when = toIso(args.when);

  if (!poolId) {
    throw new Error("Missing --pool <poolId>");
  }

  const signal = {
    pool_id: poolId,
    creator_id: creatorId || null,
    type: "manual_release",
    status: ready ? "ready" : "pending",
    consumed: false,
    note,
    signaled_at: when,
  };

  const inserted = await atlasAction({
    appId,
    apiKey,
    dataSource,
    database,
    action: "insertOne",
    collection: "admin_signals",
    payload: { document: signal },
  });

  await atlasAction({
    appId,
    apiKey,
    dataSource,
    database,
    action: "updateOne",
    collection: "pools",
    payload: {
      filter: { _id: { $oid: poolId } },
      update: {
        $set: {
          manual_goal_met: ready,
          manual_signal_note: note,
          manual_signal_at: when,
        },
      },
    },
  });

  console.log("Admin signal submitted");
  console.log(
    JSON.stringify(
      {
        pool_id: poolId,
        creator_id: creatorId || null,
        status: ready ? "ready" : "pending",
        signal_id: inserted?.insertedId || null,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
