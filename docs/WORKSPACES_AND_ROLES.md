# Workspaces And Roles

Beam must support multiple client workspaces without allowing one client to see
or change another client's screens, media, playlists, schedules, activity, or
device state. "Silo" is an acceptable product shorthand, but the code and data
model should use `workspace`.

This is a production boundary, not only a navigation feature. The UI may hide
other workspaces, but every server-side read, write, publish, reset, and media
operation must enforce workspace access from the authenticated user or device
identity.

## Core Model

Users can participate in multiple workspaces. A user has one active workspace in
the dashboard session, and each workspace membership carries its own role.

Core records:

- `workspaceId`: stable opaque ID for a client workspace.
- `userId`: stable opaque ID for a dashboard user.
- `membershipId`: relationship between a user and a workspace.
- `role`: permission level for that user inside that workspace.
- `activeWorkspaceId`: the workspace currently selected in the dashboard.

Workspace-owned records:

- Screens
- Devices
- Media assets and folders
- Playlists and playlist items
- Schedules
- Activity
- Publish markers and recovery/reset state
- Settings that affect a workspace

Global platform records:

- Workspace/client records
- Platform administrator users
- Billing records, if added later
- Service-level audit events

Names are editable labels. IDs stay authoritative for relationships and access
control. A workspace rename must not break screen assignments, device mappings,
playlist membership, media references, schedules, publish targets, or activity
history.

## Roles

Start with a small role set. Add more only when an actual workflow needs it.

| Role | Scope | Permissions |
| --- | --- | --- |
| Platform Admin | Global | Create and manage workspaces, assign users, see all workspaces, support production incidents. |
| Workspace Admin | One or more workspaces | Manage workspace users, screens, devices, media, playlists, schedules, settings, publish, and recovery. |
| Content Manager | One or more workspaces | Upload and organize media, edit playlists, publish to assigned screens when allowed. |
| Operator | One or more workspaces | View status, run approved publishes and safe recovery actions, review activity. |
| Viewer | One or more workspaces | Read-only access to screens, playback status, media catalog, playlists, schedules, and activity. |
| Device Agent | One device/workspace | Non-human identity; fetch only its assigned playlist and post only its own heartbeat/status/reset result. |

Roles are evaluated per workspace. A user can be an Admin in one workspace and a
Viewer in another.

## Access Rules

Every authenticated dashboard request must derive the user's allowed workspaces
from trusted session claims or a server-side membership lookup. Browser-supplied
`workspaceId` values may select an active workspace, but they must never grant
access by themselves.

Required checks:

- List operations filter by `workspaceId`.
- Read operations verify the record belongs to an allowed workspace.
- Writes verify the user has permission in that workspace.
- Cross-record operations verify every involved record shares the same
  `workspaceId`.
- Publish validates that the playlist, screen, device, media assets, and user
  membership all match the active workspace.
- Recovery/reset validates the device and screen belong to the active workspace.
- Activity writes include `workspaceId`, `actorUserId`, `role`, and target IDs.
- Signed media URLs are generated only after workspace access is verified.
- Device playlist fetch validates the device identity and workspace binding.

Blocked behavior:

- A client user cannot list, search, preview, download, edit, publish, reset, or
  infer another workspace's assets or screens.
- A dashboard route cannot trust an arbitrary `workspaceId` from the browser.
- A media object path cannot be treated as authorization.
- A shared playlist cannot target screens from different workspaces unless a
  future explicit cross-workspace sharing feature is designed.

## Data Direction

Existing dev cloud data currently behaves like a single workspace. Introduce a
default workspace for migration, for example `workspace-beam-dev`, and attach
existing Screens, Devices, Playlists, Assets, Schedules, Activity, and
publish markers to it.

Future DynamoDB rows should include `workspaceId` in every workspace-owned item.
Where tables already use `accountId`, treat the current `beam-dev` value as the
temporary single-workspace owner until the schema is migrated. Do not use
client/workspace display names in keys or authorization decisions.

Media storage should include workspace ownership in metadata and preferably in
object key prefixes, for example:

```text
workspaces/{workspaceId}/source/{assetId}/{fileName}
workspaces/{workspaceId}/playback/{assetId}/{fileName}
workspaces/{workspaceId}/thumbnails/{assetId}/{fileName}
```

Object key prefixes help with operations and least privilege, but the server
must still authorize by trusted record ownership before issuing signed URLs.

## Dashboard UX

Normal client users should land directly inside their workspace. If a user has
access to multiple workspaces, show a workspace switcher that changes the active
workspace without mixing data from different workspaces in one view.

The current primary sections stay the same inside a workspace:

- What's Playing
- Library
- Playlists
- Screens
- Activity
- Troubleshooting
- Settings

Platform Admin users may have an additional workspace/client management area.
That area is separate from the normal workspace operations console.

## Implementation Sequence

Current status: the dashboard has a shared default workspace ID,
`workspace-beam-dev`, a typed user session shape with memberships and a local
dev session adapter, session normalization that rejects invalid roles or an
active workspace outside the user's memberships, an active workspace context
helper, local/cloud store normalization that can attach that workspace to
existing records as they are read or written, and centralized permission helpers
for the first read, write, publish, recovery, activity, and admin guardrails.
Read paths are scoped through the active workspace while it still resolves to
the default workspace. Mutation API routes that hit workspace authorization now
return a structured `403` instead of a generic route failure, and invalid
workspace sessions can return a structured `401`. A read-only
`GET /api/workspace-session` endpoint exposes the current normalized session for
future UI integration, and `GET /api/local-inventory` now derives its response
context from that same active session path. Media library reads also return the
active session workspace/user context, and playlist assignment reads use that
same context path. Schedule, media folder, media detail, and player action
reads now use the same path as well. Media folder activity
records and local media upload/update/delete activity now use the session user
ID instead of the old hardcoded local actor. Playlist library, playlist item,
playlist assignment, and schedule add/update/remove/publish activity now use the
session user ID as well.
Player restart, recovery step, recovery run, and reboot activity records also
use the session user ID. Local media bulk-delete activity also uses the session
user ID. This does not yet load real authenticated memberships from a login
provider or expose user-driven workspace switching. The dashboard shell now
shows the current active workspace, role, and user with a read-only session
details panel, and the local dev session can show multiple available
workspaces before switching is enabled.

1. Document the workspace/role model and update product requirements.
2. Add a default workspace seed/migration for existing local and cloud data.
3. Add `workspaceId` to workspace-owned local JSON and cloud table rows.
4. Add authenticated user/session shape with memberships and active workspace.
5. Centralize server-side authorization helpers for reads, writes, publishes,
   recovery actions, media URLs, and device playlist fetch.
6. Scope dashboard queries and API route handlers by active workspace.
7. Add workspace switcher for multi-workspace users.
8. Add workspace user management for Platform Admin and Workspace Admin roles.
9. Backfill activity with actor and workspace evidence.
10. Run cross-workspace isolation tests before production use.

## Validation Expectations

Before calling workspaces production-ready:

- A user with one workspace cannot access another workspace by URL editing.
- A user with multiple workspaces sees only the active workspace's data.
- Switching workspaces clears stale client state and reloads scoped data.
- Playlist publish cannot target a screen in a different workspace.
- Media search and signed URL generation cannot leak another workspace's media.
- Device playlist fetch cannot return another workspace's playlist.
- Recovery/reset cannot operate across workspace boundaries.
- Activity logs show the correct workspace and actor.
- Existing five-system pilot data survives migration into the default
  workspace.

Current local smoke:

```bash
npm run test:workspace-auth
```

This checks the centralized role-to-permission helper, session normalization,
and local session adapter, including denied viewer/operator/content-manager
actions, invalid session rejection, and cross-workspace membership denial.
