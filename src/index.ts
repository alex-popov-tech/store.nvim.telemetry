import { Hono } from "hono";
import { cors } from "hono/cors";

const PLUGIN_FULLNAME_REGEXP = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const EVENTS_RATE_LIMIT_PER_HOUR = 200;

type Bindings = { DB: D1Database };

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", cors());

async function hashIP(ip: string): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const data = new TextEncoder().encode(`${ip}|${date}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getWindowStart(): string {
  const now = new Date();
  return now.toISOString().slice(0, 16);
}

app.post("/events", async (c) => {
  let body: { plugin_full_name?: string; event_type?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const { plugin_full_name, event_type } = body;

  if (
    typeof plugin_full_name !== "string" ||
    typeof event_type !== "string" ||
    !PLUGIN_FULLNAME_REGEXP.test(plugin_full_name) ||
    (event_type !== "view" && event_type !== "install")
  ) {
    return c.json(
      {
        error:
          "Invalid body. Required: plugin_full_name (author/repo), event_type (view|install)",
      },
      400,
    );
  }

  const ip =
    c.req.header("CF-Connecting-IP") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";

  const ipHash = await hashIP(ip);
  const country = (c.req.raw.cf?.country as string) ?? "XX";
  const windowStart = getWindowStart();
  const db = c.env.DB;

  // Rate limit check
  const rateResult = await db
    .prepare(
      `INSERT INTO rate_limits (ip_hash, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT (ip_hash, window_start)
       DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(ipHash, windowStart)
    .first<{ count: number }>();

  if (rateResult && rateResult.count > EVENTS_RATE_LIMIT_PER_HOUR) {
    return c.json({ error: "Rate limit exceeded" }, 429);
  }

  // Plugin validation
  const knownPlugin = await db
    .prepare("SELECT 1 FROM plugin_names WHERE plugin_full_name = ?")
    .bind(plugin_full_name)
    .first();

  if (!knownPlugin) {
    return c.json({ error: "Unknown plugin" }, 400);
  }

  // Dedup check (same IP + plugin + event within 1 hour)
  const dedup = await db
    .prepare(
      `SELECT 1 FROM events
       WHERE ip_hash = ? AND plugin_full_name = ? AND event_type = ?
       AND created_at > datetime('now', '-1 hour')
       LIMIT 1`,
    )
    .bind(ipHash, plugin_full_name, event_type)
    .first();

  if (dedup) {
    return c.json({ ok: true, deduplicated: true }, 200);
  }

  // Insert event + update stats atomically
  await db.batch([
    db
      .prepare(
        `INSERT INTO events (plugin_full_name, event_type, ip_hash) VALUES (?, ?, ?)`,
      )
      .bind(plugin_full_name, event_type, ipHash),
    db
      .prepare(
        `INSERT INTO stats (plugin_full_name, event_type, date, count)
         VALUES (?, ?, date('now'), 1)
         ON CONFLICT (plugin_full_name, event_type, date)
         DO UPDATE SET count = count + 1`,
      )
      .bind(plugin_full_name, event_type),
    db
      .prepare(
        `INSERT INTO user_activity (ip_hash, date, country)
         VALUES (?, date('now'), ?)
         ON CONFLICT (ip_hash, date) DO NOTHING`,
      )
      .bind(ipHash, country),
  ]);

  return c.json({ ok: true }, 201);
});

app.get("/stats", async (c) => {
  const pluginId = c.req.query("plugin_full_name");
  const period = c.req.query("period") ?? "all";

  if (period !== "all" && period !== "week" && period !== "month") {
    return c.json(
      { error: "Invalid period. Must be: all, week, or month" },
      400,
    );
  }

  const conditions: string[] = [];
  const bindings: string[] = [];

  if (pluginId) {
    conditions.push("plugin_full_name = ?");
    bindings.push(pluginId);
  }

  if (period === "week") {
    conditions.push("date >= date('now', '-7 days')");
  } else if (period === "month") {
    conditions.push("date >= date('now', '-30 days')");
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

  const query = `
    SELECT
      plugin_full_name,
      SUM(CASE WHEN event_type = 'view' THEN count ELSE 0 END) AS views,
      SUM(CASE WHEN event_type = 'install' THEN count ELSE 0 END) AS installs
    FROM stats${where}
    GROUP BY plugin_full_name ORDER BY installs DESC`;

  const result = await c.env.DB.prepare(query)
    .bind(...bindings)
    .all<{ plugin_full_name: string; views: number; installs: number }>();

  return c.json({ stats: result.results });
});

app.get("/active-users", async (c) => {
  const period = c.req.query("period") ?? "week";
  const country = c.req.query("country");

  if (
    period !== "day" &&
    period !== "week" &&
    period !== "month" &&
    period !== "all"
  ) {
    return c.json(
      { error: "Invalid period. Must be: day, week, month, or all" },
      400,
    );
  }

  const conditions: string[] = [];
  const bindings: string[] = [];

  if (period === "day") {
    conditions.push("date >= date('now', '-1 day')");
  } else if (period === "week") {
    conditions.push("date >= date('now', '-7 days')");
  } else if (period === "month") {
    conditions.push("date >= date('now', '-30 days')");
  }

  if (country) {
    conditions.push("country = ?");
    bindings.push(country);
  }

  const where =
    conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

  const db = c.env.DB;

  const [totalResult, byCountryResult, byDateResult] = await db.batch([
    db
      .prepare(`SELECT COUNT(*) AS total_user_days FROM user_activity${where}`)
      .bind(...bindings),
    db
      .prepare(
        `SELECT country, COUNT(*) AS unique_users FROM user_activity${where} GROUP BY country ORDER BY unique_users DESC`,
      )
      .bind(...bindings),
    db
      .prepare(
        `SELECT date, COUNT(*) AS unique_users FROM user_activity${where} GROUP BY date ORDER BY date DESC`,
      )
      .bind(...bindings),
  ]);

  const total =
    (totalResult.results[0] as Record<string, number>)?.total_user_days ?? 0;

  return c.json({
    period,
    total_user_days: total,
    by_country: byCountryResult.results,
    by_date: byDateResult.results,
  });
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

async function pullPluginFullNames(): Promise<Record<string, true>> {
  const res = await fetch(
    "https://github.com/alex-popov-tech/store.nvim.crawler/releases/latest/download/db_minified.json",
  );
  if (!res.ok) {
    throw new Error(
      `Failed to fetch db_minified.json: ${res.status} ${res.statusText}`,
    );
  }

  const data = await res
    .json<{ items: { full_name: string }[] }>()
    .catch((err) => {
      throw new Error(`Failed to parse db_minified.json: ${err.message}`);
    });

  if (!data?.items || !Array.isArray(data.items)) {
    throw new Error("Invalid db_minified.json format");
  }

  return data.items
    .map((it) => it.full_name)
    .reduce(
      (acc, it) => {
        acc[it] = true;
        return acc;
      },
      {} as Record<string, true>,
    );
}

async function scheduled(
  controller: ScheduledController,
  env: { DB: D1Database },
): Promise<void> {
  const db = env.DB;

  switch (controller.cron) {
    case "0 * * * *": {
      await db.batch([
        db.prepare(
          `DELETE FROM events WHERE created_at < datetime('now', '-90 days')`,
        ),
        db.prepare(
          `DELETE FROM rate_limits WHERE window_start < datetime('now', '-1 hour')`,
        ),
        db.prepare(
          `DELETE FROM user_activity WHERE date < date('now', '-90 days')`,
        ),
      ]);
      break;
    }

    case "0 3 * * *": {
      const latest = await pullPluginFullNames();
      const saved = await db
        .prepare("SELECT plugin_full_name FROM plugin_names")
        .all<{ plugin_full_name: string }>();
      const savedSet = new Set(saved.results.map((r) => r.plugin_full_name));

      const toInsert = Object.keys(latest).filter((n) => !savedSet.has(n));
      const toDelete = [...savedSet].filter((n) => !latest[n]);

      for (let i = 0; i < toDelete.length; i += 100) {
        const chunk = toDelete.slice(i, i + 100);
        const placeholders = chunk.map(() => "?").join(", ");
        await db
          .prepare(
            `DELETE FROM plugin_names WHERE plugin_full_name IN (${placeholders})`,
          )
          .bind(...chunk)
          .run();
      }

      for (let i = 0; i < toInsert.length; i += 100) {
        const chunk = toInsert.slice(i, i + 100);
        const placeholders = chunk.map(() => "(?)").join(", ");
        await db
          .prepare(
            `INSERT INTO plugin_names (plugin_full_name) VALUES ${placeholders}`,
          )
          .bind(...chunk)
          .run();
      }
      break;
    }
  }
}

export default {
  fetch: app.fetch,
  scheduled,
};
