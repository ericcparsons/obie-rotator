# obie-rotator

Slack rotation bot for the Obie workspace. Fully managed through Slack — no config files, no code changes needed to add or edit rotations.

---

## How it works

Type `/rotation` in any channel to open the management menu. From there you can:

- **Create** a rotation: pick any users from the workspace, any channel, any cadence (daily / weekly / monthly), any time, any timezone
- **List** all rotations with who's up next, and trigger / edit / delete them
- Rotations fire automatically on schedule and post a message tagging the next person in queue

---

## One-time setup

### 1. Create a Slack app

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**
2. Name it `obie-rotator`, select the Obie workspace → **Create App**

### 2. Enable Socket Mode

Under **Settings > Socket Mode**:

- Toggle on **Enable Socket Mode**
- Give the token a label (e.g. `rotator-socket`) → **Generate**
- Copy the `xapp-...` token — this is `SLACK_APP_TOKEN`

### 3. Add bot token scopes

Under **Features > OAuth & Permissions > Scopes > Bot Token Scopes**, add:

| Scope           | Why                             |
| --------------- | ------------------------------- |
| `chat:write`    | Post rotation messages          |
| `commands`      | Handle slash commands           |
| `channels:read` | Resolve channel names in the UI |

Then click **Install to Workspace** at the top of that page.
Copy the `xoxb-...` bot token — this is `SLACK_BOT_TOKEN`.

### 4. Register slash commands

Under **Features > Slash Commands**, create two commands:

| Command          | Description                               |
| ---------------- | ----------------------------------------- |
| `/rotation`      | Open the rotation manager                 |
| `/rotation-next` | Manually trigger a rotation (for testing) |

For the Request URL, enter anything — Socket Mode ignores it (e.g. `https://placeholder.example.com`).

### 5. Configure

```bash
cd ~/repos/obie-rotator
cp .env.example .env
# Fill in SLACK_BOT_TOKEN and SLACK_APP_TOKEN
```

### 6. Invite the bot to channels

In any channel you want the bot to post to:

```
/invite @obie-rotator
```

### 7. Run

```bash
yarn dev       # development (auto-restarts on file changes)
yarn build && yarn start  # production
```

---

## Managing rotations

All management happens in Slack via `/rotation`. No restarts needed.

### Creating a rotation

1. Type `/rotation` → click **➕ Create rotation**
2. Fill out the modal:
   - **Name** — anything descriptive (e.g. `Prism New Issues`)
   - **Channel** — where the rotation message posts
   - **Members** — pick any workspace users; the order you select them is the rotation order
   - **Cadence** — Daily, Weekly, or Monthly
   - **Days of week** — for Weekly rotations (pick one or more)
   - **Day of month** — for Monthly rotations (1–28)
   - **Time + Timezone** — the bot handles DST automatically
3. Click **Save** — the rotation starts immediately

### Editing a rotation

`/rotation` → **📋 List rotations** → **✏ Edit** on the rotation you want to change.
The member queue resets to position 0 after an edit.

### Deleting a rotation

`/rotation` → **📋 List rotations** → **🗑 Delete** → confirm. The cron job is cancelled immediately.

### Manually triggering

`/rotation` → list → **▶ Trigger now**, or:

```
/rotation-next Prism New Issues
```

---

## Deployment

For persistent hosting (so the bot stays running):

| Option        | Notes                                                               |
| ------------- | ------------------------------------------------------------------- |
| **Railway**   | Push to GitHub, connect repo, set env vars — done. Free tier works. |
| **Fly.io**    | `fly launch` + `fly secrets set SLACK_BOT_TOKEN=...`                |
| **EC2 / VPS** | `yarn build && pm2 start dist/index.js --name obie-rotator`         |

The SQLite DB (`data/rotator.db`) persists to disk. Back it up if you care about rotation state.

---

## Architecture

```
src/
  index.ts      — Bolt app, all Slack handlers (/rotation, actions, view submissions)
  db.ts         — node:sqlite setup, schema, low-level queries
  rotations.ts  — CRUD + schedule helpers (buildCronExpression, describeSchedule)
  scheduler.ts  — Dynamic cron job management (scheduleRotation, cancelRotation)
  ui.ts         — All Block Kit payloads (modals, list view, main menu)
```

No native addons. Uses Node's built-in `node:sqlite` (available in Node 22+, stable in Node 24+).
