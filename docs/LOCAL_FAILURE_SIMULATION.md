# Local Failure Simulation

These checks are safe to run without a Raspberry Pi, TV, AWS credentials, or cloud resources. They exercise the local playlist, cache, heartbeat, and player assumptions.

## Run The Helper

```sh
node scripts/local-failure-smoke.mjs
```

The helper:

- Seeds the last-known-good playlist cache.
- Runs the agent with a missing playlist path and expects cache fallback.
- Runs the agent with a malformed playlist and expects cache fallback.
- Runs the agent with an unreachable cloud playlist URL and expects the last-known-good cache, not the first-run fallback asset.
- Checks that the sample playlist asset exists locally.
- Creates a temporary stale heartbeat fixture for inspection.

It does not deploy anything and does not require credentials.

## Bad Media Playback Smoke (VLC + Browser)

```sh
npm run test:bad-playback
```

This smoke creates a temporary local fixture and verifies:

- VLC dry-run quarantines a missing video asset instead of failing the entire playlist.
- At least one remaining readable video asset is still accepted for playback.
- Browser serve-player returns explicit `404` diagnostics for missing `/assets/*` media.
- Browser serve-player returns explicit `404` diagnostics for missing `playlist.local.json`.

It does not require Raspberry Pi hardware, TV output, or AWS credentials.

## Manual Missing Playlist Check

```sh
PISIGNAGE_PLAYLIST_PATH=/tmp/pisignage-missing-playlist.json npm run agent:heartbeat
```

Expected result:

- Agent logs `playlist.read.failed`.
- Agent falls back to `device-agent/local-cache/playlists/current.json`.
- Heartbeat still writes successfully.

Run `npm run agent:heartbeat` once first if no cache exists.

## Manual Malformed Playlist Check

```sh
printf '{ "playlistId": 123 }' > /tmp/pisignage-malformed-playlist.json
PISIGNAGE_PLAYLIST_PATH=/tmp/pisignage-malformed-playlist.json npm run agent:heartbeat
```

Expected result:

- Agent rejects malformed playlist.
- Agent falls back to last-known-good cache.
- Playback cache is not erased.

## Missing Asset Check

The player should show a browser-level image failure if a playlist references a missing local asset. Today this is best checked manually:

1. Copy `sample-content/playlist.local.json` to `/tmp/playlist-missing-asset.json`.
2. Change the asset `uri` to `assets/missing.svg`.
3. Serve or copy that playlist into the player’s same-origin public directory.
4. Open `http://localhost:5173/?playlist=/playlist-missing-asset.json`.

Expected result:

- Player keeps the page loaded.
- Status still shows the selected asset ID.
- Image does not render because the asset is missing.

Future improvement:

- Add a visible player error state for image `error` events after Pi/TV basics are validated.

## Stale Heartbeat Check

The dashboard should make heartbeat age visible. To inspect a stale heartbeat shape without mutating local runtime state, run:

```sh
node scripts/local-failure-smoke.mjs
```

The script writes a temporary stale heartbeat fixture under the system temp directory and prints its path.

Future improvement:

- Add dashboard threshold logic for stale heartbeat status after the desired heartbeat interval is finalized.

## Player Refresh/Restart Check

```sh
npm run dev:player
```

Then open:

```text
http://localhost:5173/?playlist=/playlist.local.json
```

Expected result:

- Browser refresh reloads the playlist.
- Restarting the dev server keeps using the same local sample content.
- No AWS access is required.
