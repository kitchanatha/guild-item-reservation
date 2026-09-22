// Bridges this site to the Discord bot's Google Sheet queue data (Queue_Entries,
// Queue_History, คิวการ์ด/คิวประดับ) — the two systems otherwise have no connection at all
// (this site runs on Supabase, the bot's queue lives in a Google Sheet). No npm dependencies:
// talks to the Sheets REST API directly via a hand-signed service-account JWT, using only Deno's
// built-in fetch + Web Crypto — npm-package compatibility in edge functions is a real risk we'd
// rather not take on for something this central.
//
// Actions (POST body):
//   { action: "list", queueType: "Card" | "Accessory" }
//     -> { queue: [{ discordId, characterName, position }] }
//   { action: "dequeue", discordId, queueType, adminIgn }
//     -> { characterName, cooldownUntil }
//     adminIgn must be in the timer_admins table (same allowlist "who can start timer" already
//     uses) — checked server-side here, not just gated by the site's UI.
//
// One-time setup:
//   supabase secrets set GOOGLE_SERVICE_ACCOUNT_EMAIL=... GOOGLE_PRIVATE_KEY=... GOOGLE_SHEET_ID=...
//   supabase functions deploy queue-bridge --no-verify-jwt
//   (--no-verify-jwt: called with the public anon key like every other RPC here; the real
//   authorization is the timer_admins check below, not Supabase Auth)

import { createClient } from "jsr:@supabase/supabase-js@2";

const GOOGLE_SHEET_ID = Deno.env.get("GOOGLE_SHEET_ID") ?? "";
const GOOGLE_SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL") ?? "";
const GOOGLE_PRIVATE_KEY = (Deno.env.get("GOOGLE_PRIVATE_KEY") ?? "").replace(/\\n/g, "\n");

const SHEETS = {
  members: "Members",
  classes: "Classes",
  queueEntries: "Queue_Entries",
  queueHistory: "Queue_History",
  cardQueueDisplay: "คิวการ์ด",
  accessoryQueueDisplay: "คิวประดับ",
} as const;

const QUEUE_COOLDOWN_DAYS = 3;
const QUEUE_DISPLAY_MAX_ROWS = 300;

// --- hex/color ---------------------------------------------------------

function hexToRgb(hex: string): { red: number; green: number; blue: number } | null {
  if (!hex) return null;
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
  if (clean.length !== 6) return null;
  return {
    red: parseInt(clean.slice(0, 2), 16) / 255,
    green: parseInt(clean.slice(2, 4), 16) / 255,
    blue: parseInt(clean.slice(4, 6), 16) / 255,
  };
}

// --- id generation (matches src/utils/id.ts in the bot repo) ------------

function generateNextId(prefix: string, existingIds: string[]): string {
  let max = 0;
  for (const id of existingIds) {
    if (id.startsWith(prefix)) {
      const num = parseInt(id.substring(prefix.length), 10);
      if (!isNaN(num) && num > max) max = num;
    }
  }
  return `${prefix}${(max + 1).toString().padStart(6, "0")}`;
}

// --- Google service-account auth (hand-rolled, no googleapis) -----------

function base64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;

  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(GOOGLE_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(`token_exchange_failed: ${await res.text()}`);
  const data = await res.json();
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

// --- thin Sheets REST client ---------------------------------------------

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

async function sheetsFetch(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${SHEETS_API}/${GOOGLE_SHEET_ID}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`sheets_api_failed (${path}): ${res.status} ${await res.text()}`);
  return res.json();
}

async function valuesGet(token: string, range: string): Promise<string[][]> {
  const data = await sheetsFetch(token, `/values/${encodeURIComponent(range)}`);
  return data.values ?? [];
}

async function valuesUpdate(token: string, range: string, values: string[][]) {
  await sheetsFetch(token, `/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values }),
  });
}

async function valuesAppend(token: string, range: string, values: string[][]) {
  await sheetsFetch(token, `/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values }),
  });
}

async function valuesBatchUpdate(token: string, data: { range: string; values: string[][] }[]) {
  if (data.length === 0) return;
  await sheetsFetch(token, `/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "RAW", data }),
  });
}

// The base :batchUpdate endpoint (structural changes: delete rows, format cells, etc.) —
// separate from valuesBatchUpdate (plain cell values only).
async function structuralBatchUpdate(token: string, requests: unknown[]) {
  if (requests.length === 0) return;
  const res = await fetch(`${SHEETS_API}/${GOOGLE_SHEET_ID}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`sheets_batchupdate_failed: ${res.status} ${await res.text()}`);
}

let sheetIdCache: Map<string, number> | null = null;
let rowCountCache: Map<string, number> | null = null;

async function ensureSheetMeta(token: string): Promise<{ ids: Map<string, number>; rowCounts: Map<string, number> }> {
  if (sheetIdCache && rowCountCache) return { ids: sheetIdCache, rowCounts: rowCountCache };
  const res = await fetch(`${SHEETS_API}/${GOOGLE_SHEET_ID}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`sheets_meta_failed: ${res.status} ${await res.text()}`);
  const meta = await res.json();
  const ids = new Map<string, number>();
  const rowCounts = new Map<string, number>();
  for (const s of meta.sheets ?? []) {
    const title = s.properties?.title;
    const id = s.properties?.sheetId;
    if (title && id !== undefined) {
      ids.set(title, id);
      const rc = s.properties?.gridProperties?.rowCount;
      if (rc) rowCounts.set(title, rc);
    }
  }
  sheetIdCache = ids;
  rowCountCache = rowCounts;
  return { ids, rowCounts };
}

// --- domain logic (ports src/services/queue-service.ts + the repository) ---

type QueueType = "Card" | "Accessory";

interface ClassConfig {
  className: string;
  symbol: string;
  colorHex: string;
}

async function getClassConfigs(token: string): Promise<ClassConfig[]> {
  const rows = await valuesGet(token, `${SHEETS.classes}!A2:F`);
  return rows.map((r) => ({ className: r[1] ?? "", symbol: r[4] ?? "", colorHex: r[5] ?? "" }));
}

interface VisualEntry {
  discordId: string;
  position: number;
  characterName: string;
  symbol: string;
  colorHex: string | null;
}

async function buildQueueList(token: string, queueType: QueueType): Promise<VisualEntry[]> {
  const [entries, members, classConfigs] = await Promise.all([
    valuesGet(token, `${SHEETS.queueEntries}!A2:I`),
    valuesGet(token, `${SHEETS.members}!A2:H`),
    getClassConfigs(token),
  ]);
  const memberByDiscordId = new Map(members.map((r) => [r[1], { characterName: r[3] ?? "", className: r[4] ?? "" }]));
  const classByName = new Map(classConfigs.map((c) => [c.className, c]));

  return entries
    .filter((r) => r[1] === queueType && r[5] === "Active")
    .map((r) => ({ discordId: r[3], position: Number(r[4] ?? 0) }))
    .sort((a, b) => a.position - b.position)
    .map(({ discordId, position }) => {
      const m = memberByDiscordId.get(discordId);
      const cls = m ? classByName.get(m.className) : undefined;
      return {
        discordId,
        position,
        characterName: m?.characterName ?? "(unknown)",
        symbol: cls?.symbol ?? "",
        colorHex: cls?.colorHex ?? null,
      };
    });
}

// Ports GoogleSheetsQueueRepository.writeQueueList in the bot repo — full rewrite, class-colored,
// carrying forward any officer memo in column B to whoever is still in the queue at their new row.
async function writeQueueDisplay(token: string, sheetName: string, queue: VisualEntry[]) {
  const { ids, rowCounts } = await ensureSheetMeta(token);
  const sheetId = ids.get(sheetName);
  if (sheetId === undefined) return;

  const currentRowCount = rowCounts.get(sheetName) ?? 1000;
  const targetRowCount = Math.max(queue.length + 1, Math.min(QUEUE_DISPLAY_MAX_ROWS, currentRowCount));
  const requests: any[] = [];
  if (targetRowCount > currentRowCount) {
    requests.push({ appendDimension: { sheetId, dimension: "ROWS", length: targetRowCount - currentRowCount } });
    rowCounts.set(sheetName, targetRowCount);
  }
  const clearEndRow = Math.min(QUEUE_DISPLAY_MAX_ROWS, rowCounts.get(sheetName)!);

  const existing = await valuesGet(token, `${sheetName}!A2:B${clearEndRow}`);
  const memoByName = new Map<string, string>();
  for (const row of existing) {
    const name = (row[0] ?? "").trim();
    const memo = (row[1] ?? "").trim();
    if (name && memo) memoByName.set(name, memo);
  }

  requests.push(
    { updateCells: { range: { sheetId, startRowIndex: 1, endRowIndex: clearEndRow, startColumnIndex: 0, endColumnIndex: 1 }, fields: "userEnteredValue,userEnteredFormat.backgroundColor" } },
    { updateCells: { range: { sheetId, startRowIndex: 1, endRowIndex: clearEndRow, startColumnIndex: 1, endColumnIndex: 2 }, fields: "userEnteredValue" } },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
        cell: { userEnteredFormat: { backgroundColor: { red: 0.85, green: 0.85, blue: 0.85 }, textFormat: { bold: true, fontSize: 11 }, horizontalAlignment: "CENTER" } },
        fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
      },
    },
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 220 }, fields: "pixelSize" } }
  );

  queue.forEach((entry, i) => {
    const rowIndex = 1 + i;
    const text = `${entry.symbol} ${entry.characterName}`.trim();
    const color = entry.colorHex ? hexToRgb(entry.colorHex) : null;
    requests.push({
      updateCells: {
        range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 0, endColumnIndex: 1 },
        rows: [{ values: [{ userEnteredValue: { stringValue: text }, ...(color ? { userEnteredFormat: { backgroundColor: color } } : {}) }] }],
        fields: color ? "userEnteredValue,userEnteredFormat.backgroundColor" : "userEnteredValue",
      },
    });
    const memo = memoByName.get(text);
    if (memo) {
      requests.push({
        updateCells: {
          range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 1, endColumnIndex: 2 },
          rows: [{ values: [{ userEnteredValue: { stringValue: memo } }] }],
          fields: "userEnteredValue",
        },
      });
    }
  });

  await structuralBatchUpdate(token, requests);
}

async function refreshBothDisplays(token: string) {
  const [cardQueue, accessoryQueue] = await Promise.all([buildQueueList(token, "Card"), buildQueueList(token, "Accessory")]);
  await Promise.all([
    writeQueueDisplay(token, SHEETS.cardQueueDisplay, cardQueue),
    writeQueueDisplay(token, SHEETS.accessoryQueueDisplay, accessoryQueue),
  ]);
}

async function dequeueMember(token: string, discordId: string, queueType: QueueType, changedBy: string) {
  const { ids } = await ensureSheetMeta(token);
  const entriesSheetId = ids.get(SHEETS.queueEntries);
  if (entriesSheetId === undefined) throw new Error("queue_entries_sheet_missing");

  const rows = await valuesGet(token, `${SHEETS.queueEntries}!A2:I`);
  const idx = rows.findIndex((r) => r[3] === discordId && r[1] === queueType && r[5] === "Active");
  if (idx < 0) throw new Error("not_in_queue");

  const [queueEntryId, , memberId, , positionStr] = rows[idx];
  const position = Number(positionStr ?? 0);

  const now = new Date();
  const nowIso = now.toISOString();
  const cooldownUntil = new Date(now.getTime() + QUEUE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // 1. Delete the row
  await structuralBatchUpdate(token, [
    { deleteDimension: { range: { sheetId: entriesSheetId, dimension: "ROWS", startIndex: idx + 1, endIndex: idx + 2 } } },
  ]);

  // 2. Append history
  const historyIds = (await valuesGet(token, `${SHEETS.queueHistory}!A2:A`)).map((r) => r[0]).filter(Boolean);
  const historyId = generateNextId("QH", historyIds);
  await valuesAppend(token, `${SHEETS.queueHistory}!A:J`, [
    [historyId, queueEntryId, queueType, memberId, discordId, "DEQUEUE", String(position), nowIso, changedBy, cooldownUntil],
  ]);

  // 3. Reorder remaining active entries for this queue type
  const remaining = (await valuesGet(token, `${SHEETS.queueEntries}!A2:I`))
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r[1] === queueType && r[5] === "Active")
    .sort((a, b) => Number(a.r[4]) - Number(b.r[4]));

  const updates: { range: string; values: string[][] }[] = [];
  remaining.forEach(({ r, i }, order) => {
    const expected = order + 1;
    if (Number(r[4]) !== expected) {
      updates.push({ range: `${SHEETS.queueEntries}!E${i + 2}`, values: [[String(expected)]] });
      updates.push({ range: `${SHEETS.queueEntries}!I${i + 2}`, values: [[nowIso]] });
    }
  });
  await valuesBatchUpdate(token, updates);

  // 4. Refresh both display sheets so they match the new entries
  await refreshBothDisplays(token);

  const memberRow = (await valuesGet(token, `${SHEETS.members}!A2:H`)).find((r) => r[1] === discordId);
  return { characterName: memberRow?.[3] ?? "", cooldownUntil };
}

// --- weekly guild stats capture (Rating / Contribution, read off the in-game roster screen) ---
// Ports src/scripts/capture-guild-stats.ts in the bot repo to run from the browser instead of a
// terminal. Same three writes: append to GuildStats_History (permanent log), rebuild
// GuildStats_Latest (this week vs the previous capture), update Members!L:N.

const GUILD_STATS_SHEETS = { history: "GuildStats_History", latest: "GuildStats_Latest" } as const;

interface StatsEntry {
  characterName: string;
  rating: number;
  weeklyContribution: number;
  historicalContribution: number;
}

// Minimal port of coreName/namesMatch from src/utils/normalize.ts in the bot repo (Deno edge
// functions can't import across repos) — decoration/case-insensitive character-name matching.
function coreName(value: string): string {
  return (value ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\p{Mn}/gu, "")
    .replace(/[^a-z0-9ก-๙]/g, "");
}
function namesMatch(a: string, b: string): boolean {
  const aCores = new Set(a.split("/").map((s) => coreName(s.trim())).filter(Boolean));
  return b
    .split("/")
    .map((s) => coreName(s.trim()))
    .filter(Boolean)
    .some((c) => aCores.has(c));
}

async function captureGuildStats(token: string, entries: StatsEntry[]) {
  const capturedAt = new Date().toISOString().slice(0, 10);

  const historyRows = await valuesGet(token, `${GUILD_STATS_SHEETS.history}!A2:E`);
  const previousByName = new Map<string, { rating: number; historicalContribution: number; capturedAt: string }>();
  for (const [date, name, rating, , historical] of historyRows) {
    if (!date || !name || date === capturedAt) continue;
    const existing = previousByName.get(name);
    if (!existing || date > existing.capturedAt) {
      previousByName.set(name, { rating: Number(rating), historicalContribution: Number(historical), capturedAt: date });
    }
  }

  await valuesAppend(
    token,
    `${GUILD_STATS_SHEETS.history}!A:E`,
    entries.map((e) => [capturedAt, e.characterName, String(e.rating), String(e.weeklyContribution), String(e.historicalContribution)])
  );

  const { ids, rowCounts } = await ensureSheetMeta(token);
  const latestSheetId = ids.get(GUILD_STATS_SHEETS.latest);
  const currentLatestRows = rowCounts.get(GUILD_STATS_SHEETS.latest) ?? 200;
  if (latestSheetId !== undefined && currentLatestRows > 1) {
    await structuralBatchUpdate(token, [
      { updateCells: { range: { sheetId: latestSheetId, startRowIndex: 1, endRowIndex: currentLatestRows, startColumnIndex: 0, endColumnIndex: 7 }, fields: "userEnteredValue" } },
    ]);
  }

  const latestRows = entries.map((e) => {
    const prev = previousByName.get(e.characterName);
    const ratingChange = prev ? e.rating - prev.rating : "";
    const historicalChange = prev ? e.historicalContribution - prev.historicalContribution : "";
    return [e.characterName, String(e.rating), String(ratingChange), String(e.weeklyContribution), String(e.historicalContribution), String(historicalChange), capturedAt];
  });
  await valuesUpdate(token, `${GUILD_STATS_SHEETS.latest}!A2:G${latestRows.length + 1}`, latestRows);

  const memberRows = await valuesGet(token, `${SHEETS.members}!A2:D`);
  const memberUpdates: { range: string; values: string[][] }[] = [];
  const notFound: string[] = [];
  for (const e of entries) {
    const idx = memberRows.findIndex((r) => namesMatch(r[3] ?? "", e.characterName));
    if (idx < 0) {
      notFound.push(e.characterName);
      continue;
    }
    memberUpdates.push({ range: `${SHEETS.members}!L${idx + 2}:N${idx + 2}`, values: [[String(e.rating), String(e.weeklyContribution), String(e.historicalContribution)]] });
  }
  await valuesBatchUpdate(token, memberUpdates);

  const changes = entries
    .filter((e) => previousByName.has(e.characterName))
    .map((e) => ({ characterName: e.characterName, ratingChange: e.rating - previousByName.get(e.characterName)!.rating }))
    .sort((a, b) => b.ratingChange - a.ratingChange);

  return {
    capturedAt,
    historyRowsAdded: entries.length,
    membersUpdated: memberUpdates.length,
    membersNotFound: notFound,
    firstTimeCount: entries.length - changes.length,
    topGainers: changes.slice(0, 5),
    topDrops: changes.slice(-5).reverse(),
  };
}

// --- authorization: reuse the timer_admins allowlist ----------------------

async function isAuthorizedAdmin(supabase: ReturnType<typeof createClient>, ign: string | undefined): Promise<boolean> {
  if (!ign || !ign.trim()) return false;
  const { data, error } = await supabase.from("timer_admins").select("ign").eq("ign", ign.trim()).maybeSingle();
  if (error) {
    console.error("timer_admins check failed", error);
    return false;
  }
  return !!data;
}

// --- HTTP handler -----------------------------------------------------

// The site (kitchanatha.github.io) calling this function (*.supabase.co) is a cross-origin
// request — browsers require these headers on every response (including the preflight OPTIONS
// request) before they'll let the page read the result. curl/server-to-server calls don't
// enforce this, which is why a direct test can look fine while the real browser call fails.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

  try {
    if (body.action === "list") {
      const queueType: QueueType = body.queueType === "Accessory" ? "Accessory" : "Card";
      const token = await getAccessToken();
      const queue = await buildQueueList(token, queueType);
      return jsonResponse({ queue });
    }

    if (body.action === "dequeue") {
      const { discordId, queueType, adminIgn } = body;
      if (!discordId || (queueType !== "Card" && queueType !== "Accessory")) {
        return jsonResponse({ error: "invalid_request" }, 400);
      }
      const authorized = await isAuthorizedAdmin(supabase, adminIgn);
      if (!authorized) {
        return jsonResponse({ error: "not_authorized" }, 403);
      }
      const token = await getAccessToken();
      const result = await dequeueMember(token, discordId, queueType, adminIgn);
      return jsonResponse(result);
    }

    if (body.action === "capture_guild_stats") {
      const { entries, adminIgn } = body;
      const authorized = await isAuthorizedAdmin(supabase, adminIgn);
      if (!authorized) {
        return jsonResponse({ error: "not_authorized" }, 403);
      }
      if (!Array.isArray(entries) || entries.length === 0) {
        return jsonResponse({ error: "invalid_request" }, 400);
      }
      const clean: StatsEntry[] = [];
      for (const e of entries) {
        const characterName = String(e?.characterName ?? "").trim();
        const rating = Number(e?.rating);
        const weeklyContribution = Number(e?.weeklyContribution);
        const historicalContribution = Number(e?.historicalContribution);
        if (!characterName || !Number.isFinite(rating) || !Number.isFinite(weeklyContribution) || !Number.isFinite(historicalContribution)) {
          return jsonResponse({ error: "invalid_entry", entry: e }, 400);
        }
        clean.push({ characterName, rating, weeklyContribution, historicalContribution });
      }
      const token = await getAccessToken();
      const result = await captureGuildStats(token, clean);
      return jsonResponse(result);
    }

    return jsonResponse({ error: "unknown_action" }, 400);
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "unknown_error";
    return jsonResponse({ error: message }, 500);
  }
});
