// Triggered by a Supabase Database Webhook on INSERT into public.page_timer_log
// (see supabase-timer.sql). Posts a message to Discord naming who started the
// timer and for which page, so it doesn't only live in a table nobody checks.
//
// One-time setup:
//   1. Create a Discord webhook in the target channel (Channel Settings ->
//      Integrations -> Webhooks -> New Webhook) and copy its URL.
//   2. Pick a random string to use as a shared secret (anything unguessable).
//   3. supabase secrets set DISCORD_WEBHOOK_URL=<url from step 1> WEBHOOK_SHARED_SECRET=<string from step 2>
//   4. supabase functions deploy notify-discord-timer
//   5. In the Supabase dashboard: Database -> Webhooks -> Create a new webhook
//        Table: page_timer_log   Events: Insert
//        Type: HTTP Request      Method: POST
//        URL: <the function URL printed by step 4>
//        HTTP Headers: x-webhook-secret: <the same string from step 2>
//
// The shared secret exists because this function's URL is otherwise public —
// without it, anyone who found the URL could POST fake rows and spam the
// Discord channel with arbitrary "started_by" text.

Deno.serve(async (req) => {
  const sharedSecret = Deno.env.get("WEBHOOK_SHARED_SECRET");
  if (sharedSecret && req.headers.get("x-webhook-secret") !== sharedSecret) {
    return new Response("Forbidden", { status: 403 });
  }

  const webhookUrl = Deno.env.get("DISCORD_WEBHOOK_URL");
  if (!webhookUrl) {
    console.error("DISCORD_WEBHOOK_URL is not set");
    return new Response("Server not configured", { status: 500 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const record = payload?.record;
  if (!record) {
    return new Response("Missing record", { status: 400 });
  }

  const page = record.page;
  const startedBy = (record.started_by && String(record.started_by).trim()) || "Unknown";
  const startedAt = record.started_at ? new Date(record.started_at) : new Date();
  const timeLabel = startedAt.toLocaleString("en-GB", { timeZone: "Asia/Bangkok" });

  const content = `⏱️ **${startedBy}** started the timer for **Page ${page}** (${timeLabel})`;

  const discordResponse = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!discordResponse.ok) {
    const text = await discordResponse.text();
    console.error("Discord webhook failed:", discordResponse.status, text);
    return new Response("Discord webhook failed", { status: 502 });
  }

  return new Response("OK", { status: 200 });
});
