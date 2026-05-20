const screen = {
  id: "screen-lobby",
  name: "Lobby TV",
  deviceId: "device-local-demo",
  status: "Online",
  statusDetail: "Mocked status from local POC data",
  lastHeartbeat: "Just now"
};

const playlist = {
  id: "playlist-local-demo",
  name: "Local Demo Playlist",
  assetCount: 1,
  currentAsset: "PiSignage demo title card"
};

export default function DashboardPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-8">
      <header className="flex flex-col gap-2 border-b border-zinc-200 pb-6">
        <p className="text-sm font-semibold uppercase tracking-wide text-teal-700">
          Local proof of concept
        </p>
        <h1 className="text-4xl font-bold text-zinc-950">PiSignage Dashboard</h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-700">
          One mocked screen, one mocked playlist, and one local device state path.
          Cloud integrations are intentionally deferred.
        </p>
      </header>

      <section aria-labelledby="screen-heading" className="grid gap-4 md:grid-cols-[1.3fr_0.7fr]">
        <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 id="screen-heading" className="text-2xl font-semibold text-zinc-950">
                {screen.name}
              </h2>
              <p className="mt-1 text-sm text-zinc-600">Device ID: {screen.deviceId}</p>
            </div>
            <p
              aria-label={`Screen status: ${screen.status}. ${screen.statusDetail}`}
              className="w-fit rounded-full bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-800"
            >
              {screen.status}
            </p>
          </div>

          <dl className="mt-8 grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-sm font-medium text-zinc-500">Last heartbeat</dt>
              <dd className="mt-1 text-lg font-semibold text-zinc-950">{screen.lastHeartbeat}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-zinc-500">Assigned playlist</dt>
              <dd className="mt-1 text-lg font-semibold text-zinc-950">{playlist.name}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-zinc-500">Playback mode</dt>
              <dd className="mt-1 text-lg font-semibold text-zinc-950">Local image</dd>
            </div>
          </dl>
        </div>

        <aside aria-labelledby="scope-heading" className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 id="scope-heading" className="text-xl font-semibold text-zinc-950">
            Current Scope
          </h2>
          <ul className="mt-4 space-y-3 text-sm leading-6 text-zinc-700">
            <li>One account and one screen.</li>
            <li>Mocked status only.</li>
            <li>No AWS deployment.</li>
            <li>No billing, analytics, or fleet controls.</li>
          </ul>
        </aside>
      </section>

      <section aria-labelledby="playlist-heading" className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="playlist-heading" className="text-2xl font-semibold text-zinc-950">
              {playlist.name}
            </h2>
            <p className="mt-1 text-sm text-zinc-600">Playlist ID: {playlist.id}</p>
          </div>
          <p className="text-sm font-medium text-zinc-700">
            {playlist.assetCount} image asset
          </p>
        </div>

        <div className="mt-5 rounded-md border border-zinc-200 bg-zinc-50 p-4">
          <p className="text-sm font-medium text-zinc-500">Current asset</p>
          <p className="mt-1 text-lg font-semibold text-zinc-950">{playlist.currentAsset}</p>
        </div>
      </section>
    </main>
  );
}
