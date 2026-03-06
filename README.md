# store.nvim.telemetry

Self-hosted telemetry service for [store.nvim](https://github.com/alex-popov-tech/store.nvim) plugin view and install tracking. Built on Cloudflare Workers + D1 (free tier compatible).

## Setup

```bash
# Install Wrangler CLI (if not installed)
npm install -g wrangler

# Authenticate with Cloudflare
wrangler login

# Create the D1 database
wrangler d1 create store-nvim-telemetry
# Copy the output database_id into wrangler.toml

# Install dependencies
npm install

# Run migrations
npm run db:migrate:local   # local dev
npm run db:migrate:remote  # production

# Start local dev server
npm run dev

# Deploy to Cloudflare Workers
npm run deploy
```

## API

### `POST /events`

Record a view or install event.

```bash
curl -X POST https://store-nvim-telemetry.alex-popov-tech.workers.dev/events \
  -H "Content-Type: application/json" \
  -d '{"plugin_full_name":"nvim-telescope/telescope.nvim","event_type":"view"}'
```

**Body:**
- `plugin_full_name` (string) — format: `author/repo`
- `event_type` (string) — `view` or `install`

**Responses:**
- `201` — event recorded
- `200 { deduplicated: true }` — duplicate within 1 hour, not counted
- `400` — invalid body or unknown plugin
- `429` — rate limit exceeded (>200 requests/minute per IP)

### `GET /stats`

Get aggregated view and install counts.

**Query parameters:**
- `plugin_full_name` (string, optional) — filter to a single plugin
- `period` (string, optional) — `all` (default), `week` (last 7 days), or `month` (last 30 days)

```bash
# All plugins, all time
curl https://store-nvim-telemetry.alex-popov-tech.workers.dev/stats

# Weekly leaderboard
curl "https://store-nvim-telemetry.alex-popov-tech.workers.dev/stats?period=week"

# Monthly stats for a single plugin
curl "https://store-nvim-telemetry.alex-popov-tech.workers.dev/stats?plugin_full_name=nvim-telescope/telescope.nvim&period=month"
```

**Response:**
```json
{
  "stats": [
    { "plugin_full_name": "nvim-telescope/telescope.nvim", "views": 142, "installs": 87 }
  ]
}
```

## Local Development

```bash
npm run dev                # start dev server at http://localhost:8787
npm run typecheck          # type check
npm run lint               # lint
```

## Scheduled Jobs

- **Hourly** (`0 * * * *`) — purges raw events older than 90 days and stale rate limit entries
- **Daily** (`0 3 * * *`) — syncs the known plugin list from [store.nvim.crawler](https://github.com/alex-popov-tech/store.nvim.crawler) releases. Only known plugins are accepted by `POST /events`.

## Privacy

IP addresses are never stored. They are hashed with SHA-256 using a daily rotating salt (`IP|YYYY-MM-DD`), making them unlinkable across days. Raw event logs are automatically purged after 90 days.
