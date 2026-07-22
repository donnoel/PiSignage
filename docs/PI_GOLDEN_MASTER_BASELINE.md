# PI Golden Master Baseline

Last updated: 2026-07-21 20:55 PDT

## Baseline Rule

The PI Golden Master is the Beam appliance source of truth. It is not one
physical Pi by itself. The source of truth is the repo commit, built artifacts,
this versioned baseline, and the validation evidence recorded here. C5 is the
current Golden Master candidate/prototype evidence source for this baseline, but
the target state is C1-C5 all matching the promoted Golden Master except
documented identity and network fields.

Every Pi-touching change deployed to C5 must update this document before the work is considered complete. That includes changes to device-agent behavior, managed Pi scripts, systemd services or drop-ins, VLC/display/playback behavior, schedule enforcement, command-plane actions, heartbeat/current-video reporting, recovery, reset, cache, playlist, and published media behavior.

Every C1-Cx Beam Pi must be built, repaired, or updated from this PI golden master baseline. They should remain identical except intentional identity, network, screen, and location fields:

- hostname
- IP address and network route
- Beam/cloud device ID
- screen ID/name/assignment
- location/group labels
- local API keys and secrets

The previous historical snapshot is `docs/C5_GOLDEN_MODEL_SNAPSHOT_2026-07-03.md`. Use this file, not the historical snapshot, as the current PI golden master baseline.

## Golden Master Operating Model

Beam keeps the fleet boring, identical, and resilient by separating prototype
work from promoted appliance state:

1. Develop the change in the repo.
2. Build any required artifacts, especially ignored runtime artifacts such as
   `device-agent/dist/index.js`.
3. Deploy the change to the Golden Master candidate Pi, currently C5, for real
   playback, display, schedule, heartbeat, recovery, cache, and command-plane
   validation.
4. Promote the exact validated state by updating this baseline with the repo
   commit, built-artifact hashes, managed script/service hashes, runtime/package
   versions, playlist/release evidence, and live validation notes.
5. Roll the promoted managed state to every C1-Cx appliance.
6. Verify fleet parity over Tailscale and call-home evidence, not ad hoc local
   network assumptions.
7. Treat any unmanaged difference as drift until it is either removed or
   explicitly documented as an allowed identity/configuration difference.

The Golden Master candidate proves a release candidate under real appliance
conditions. This document records what was promoted. The fleet receives the
promoted state, not untracked shell history from the candidate Pi.

No shell-only fixes are allowed to become part of the Golden Master. A manual
field fix is either temporary runtime cleanup or it must be backported into repo
scripts, service definitions, setup docs, or this baseline before the fleet can
be called healthy.

Allowed per-device differences stay intentionally narrow:

- hostname
- IP addresses, Tailscale address, and network route
- Beam/cloud device ID
- screen ID/name/assignment
- location/group labels
- local API keys and secrets

Everything else in the Beam-managed appliance surface should match the promoted
baseline: scripts, systemd units, package/runtime baselines, compiled
device-agent runtime, playlist/release contract, published media set, cache
behavior, command-plane behavior, heartbeat shape, playback state reporting, and
service state.

## Reset For Deployment Contract

Reset for deployment must rebuild the managed Beam appliance surface from this PI golden master source, not from stale local Pi drift.

The reset script defaults to:

```text
--source golden-master --golden-ref main
```

In that mode, `device/pi/bin/pisignage-reset-device.sh` fetches the configured Git remote before restoring tracked managed scripts, systemd units, the first-run playlist, and first-run media assets. The cloud device-agent reset command uses this same `golden-master` source mode.

Reset intentionally preserves per-device identity and field access:

- hostname
- IP address and network settings
- SSH access and OS users
- Beam/cloud device ID
- local API keys and secrets
- screen assignment and location metadata

Reset intentionally clears runtime/publish state:

- playlist publish state
- stale first-run media files
- schedules
- player status
- heartbeat
- device-agent cache

Important packaging note: `device-agent/dist/index.js` is an ignored build artifact, so a git fetch alone does not replace that compiled runtime. When device-agent source changes, build and deploy the compiled device-agent runtime to C5 before updating this baseline, and roll that runtime to every affected C1-Cx appliance when it is reachable.

## Workstation State

- Repo: `/Users/donnoel/Development/PiSignage`
- Branch: `main`
- Base HEAD for this baseline update: `17eb0c5` (`17eb0c5 Restart VLC after display recovery`)
- This baseline update promotes playback-proof hardening and HDMI display-session playback recovery into the reproducible repo source; the playback-proof controller and schedule recovery script are installed on C1-C3 and C5 after the user-authorized rollouts below
- Dashboard URL: `https://8yyptjawdv.us-west-2.awsapprunner.com`
- Device heartbeat API URL: `https://yebxh6xyvm2nkgq3i2uw2oixda0izozg.lambda-url.us-west-2.on.aws/`

Recent changes incorporated into this baseline:

- Golden Master remote administration automation:
  - `device/pi/bin/pisignage-install-runtime.sh` installs and enables Tailscale, WayVNC, noVNC, and websockify when remote access is enabled
  - remote access is part of the appliance baseline, not a C5-only manual addition
  - the installer supports noninteractive Tailscale enrollment with an auth key supplied outside git through `PISIGNAGE_TAILSCALE_AUTHKEY`
  - the installer uses a per-device tailnet hostname such as `beam-c1`, `beam-c2`, or `beam-c5`
  - Tailscale is started with `--accept-dns=false` so it does not take over Pi DNS behavior
  - `device/pi/bin/pisignage-reset-device.sh` now preserves and re-enables the remote access services during reset when those packages are present

- Dedicated device heartbeat API:
  - device check-ins use the Lambda Function URL, not the dashboard/App Runner service
  - dashboard heartbeat reads use DynamoDB directly
  - routine heartbeat cadence is `10s` plus up to `2s` jitter
  - devices with Tailscale installed report `tailscaleIpAddress` in the heartbeat so Beam can prefer the tailnet address for remote SSH/noVNC controls while retaining the local LAN IP as fallback evidence
  - legacy App Runner heartbeat route remains only as migration compatibility for older devices until reprovisioned
- Tailscale proof:
  - C5 is joined to the test tailnet as `beam-c5`
  - C5 tailnet IPv4 address at capture: `100.66.60.59`
  - C5 tailnet DNS name at capture: `beam-c5.tail2e97b2.ts.net.`
  - Tailscale was started with `--accept-dns=false` so it does not take over Pi DNS behavior
  - production rollout must replace the temporary test tailnet with the production Beam tailnet, tags, ACLs, and account ownership
- Remote diagnostics command plane
- Remote recovery command plane
- Remote audio mute/unmute command support
- Remote desktop prototype on C5:
  - dashboard opens a browser-based noVNC page served from the Pi on port `6080`
  - C5 runs system WayVNC on port `5900`
  - C5 runs `pisignage-remote-desktop.service`, which serves noVNC with `websockify` and bridges to `127.0.0.1:5900`
  - C5 currently uses `enable_auth=false` in `/etc/wayvnc/config` because noVNC must connect to WayVNC without the Apple Screen Sharing PAM/VeNCrypt path
  - the Beam `Show desktop` button opens the browser desktop view and queues a Pi action to pause managed VLC signage playback and the schedule timer for remote administration
  - `Show desktop` restores the Raspberry Pi desktop shell by ensuring `pcmanfm --desktop` is running, restarting `wf-panel-pi`, and waiting for both processes before reporting success, so noVNC shows the admin panel instead of a blank black desktop
  - if `Show desktop` cannot restore the desktop panel, the device-agent reports the panel log tail and resumes VLC playback automatically rather than leaving the appliance on a black remote desktop
  - the Beam `Resume playback` button queues a Pi action to restart managed VLC signage playback and restore schedule control after remote administration
  - the Beam `Restart playback` recovery action also restores schedule control so remote administration cannot leave the schedule timer paused after playback recovery
  - the browser desktop path works from both macOS and Windows clients on the same trusted network
  - until Tailscale ACLs are in place, this prototype should only be used on trusted local networks or over the test tailnet
  - C1-C5 should all carry the same remote access package and service baseline
- Remote screen snapshot command prototype:
  - captures the Pi display output with `grim`
  - compresses a small JPEG preview with `ffmpeg`
  - returns the result through the Beam command plane for operator-requested evidence
- Single audio toggle UI behavior on Screens
- Cloud schedule delivery to Pi agents
- Schedule-aware cloud heartbeat fields:
  - `scheduleState`
  - `scheduleDetail`
  - `scheduleDisplayAction`
  - `scheduleDisplayControlOk`
  - `scheduleOverrideExpiresAt`
- Remote `Open store` command support:
  - creates a local schedule override on the Pi
  - opens display/playback outside scheduled hours
  - returns to normal schedule control after the next scheduled close
- Schedule display recovery hardening:
  - after-hours schedule enforcement prefers verified `wlopm` output power control so closed screens go dark without disabling `HDMI-A-1` in the Wayland session
  - `vcgencmd display_power` is treated as a fallback and verified instead of trusted on exit status alone
  - open-hours schedule enforcement verifies `HDMI-A-1` is powered and enabled before reporting display-on success
  - if open-hours display-on verification fails, schedule enforcement restarts the user display session once, retries display power/mode recovery, and restarts VLC playback rather than leaving the service merely started from a failed display state
  - display recovery records when LightDM replaced the Wayland session and restarts VLC even when the subsequent display retry succeeds, because an already-active VLC process remains attached to the terminated compositor and `systemctl start` cannot repair it
  - screens with no assigned schedule are actively treated as open: schedule enforcement powers the display on and starts VLC instead of leaving playback unchanged
  - VLC startup explicitly powers and re-enables `HDMI-A-1` before applying the display mode
- 2026-07-10 C5 Golden Master promotion evidence:
  - managed workstation, C5 repo, and C5 installed file hashes matched for `device/pi/bin`, `device/pi/systemd/user`, `device/pi/assets`, and `device-agent/dist/index.js`
  - `pisignage-enforce-schedule.mjs` hash at promotion: `22b33850869e5ba71cba4751450029d284c0c97880abbc63e498c23826b96352`
  - `pisignage-vlc-playlist.mjs` hash at promotion: `cb176f8b2f40dbdf7ca05c6766e77b9d7e61d77f336e19e87512b5437b9f7d75`
  - `pisignage-install-runtime.sh` hash at promotion: `39fd7deac2c85fb2fde233bcf0c46e99853606ddc4abb5c9e3d34c8f9c54fa23`
  - `pisignage-reset-device.sh` hash at promotion: `fef221b2e4fd8dc1a4009746804a3c70e1e26186191e7a5aa1dae2a912abb5eb`
  - `device-agent/dist/index.js` hash at promotion: `6694b4f3e4bc79db01bc24556d47de9b07596e175fe4ce97dab4b6ccf709cbb2`
  - tracked sudoers drop-ins at promotion: `pisignage-display-recovery` hash `b04741c024603fddf13575e30abaaa43c48d340cfc499b090115ff2c1c3a0ca6`; `pisignage-reset-reboot` hash `da9cabb6a1cfdb3b288ff657dc5a7319e8c4d57a51bda4c631c7636bfe2bc8ea`
  - C5 user services were enabled and active: `pisignage-device-agent.service`, `pisignage-schedule.timer`, `pisignage-vlc.service`, and `pisignage-remote-desktop.service`
  - C5 system services were enabled and active: `wayvnc.service` and `tailscaled.service`
  - C5 runtime evidence reported `playbackState=playing`, `scheduleState=unassigned`, `scheduleDisplayAction=display-on`, and `scheduleDisplayControlOk=true`
  - display recovery now targets the appliance user's `labwc` session and uses the constrained sudoers command `/usr/bin/systemctl restart lightdm.service` for LightDM autologin recovery when that user compositor is missing, preventing open-hours recovery from settling at the login greeter
- 2026-07-11 publish-now handoff rollout evidence:
  - dashboard code was deployed through the `infra/beam` CDK image path; the CloudFormation stack reached `UPDATE_COMPLETE` and App Runner returned HTTP 200
  - the CDK diff changed only the App Runner dashboard image identifier; no new AWS services, polling paths, media transfer behavior, or routine paid API loops were introduced
  - default publish behavior remains `publishHandoffMode=playlist-boundary`
  - `Publish now` creates `publishHandoffMode=asset-boundary` releases so VLC reloads after the current asset instead of waiting for the full playlist loop
  - C1-C5 were reachable over Tailscale SSH and had `pisignage-vlc-playlist.mjs` installed into both the repo checkout and `~/.local/bin` with hash `3b8c6ad2b85e776ede0d04fd1ac1a8db15af26d6341c6a2ad9737b5de87b00d8`
  - C1-C5 reported `pisignage-vlc.service`, `pisignage-device-agent.service`, and `pisignage-schedule.timer` active after restart
  - C1-C4 reported playback `playing` on `playlist-main-playlist@4`; C5 reported playback `playing` on `playlist-most-high-holy-rabbi-jeffry@8`
- 2026-07-21 C5 playback advancement proof hardening:
  - active continuous playback reports `playing` only after MPRIS reports `PlaybackStatus=Playing` and the observed media position or asset advances; a fresh controller status timestamp by itself is no longer playback proof
  - startup, unavailable, non-playing, or frozen MPRIS evidence reports `checking`; the existing Beam dashboard therefore raises playback attention while a screen is scheduled open instead of showing `Looks good / No action`
  - advancement proof expires after 30 seconds without new progress and resets on playlist handoff or VLC restart
  - a closed schedule remains authoritative: C5 correctly reports `stopped`, `scheduleState=off`, `scheduleDisplayAction=display-off`, and `scheduleDisplayControlOk=true` without treating the intentional blank display as a playback fault
  - focused regression coverage is `npm run test:vlc-playback-proof`; it proves a fresh stalled status remains `checking`, position advancement becomes `playing`, and a later frozen position revokes `playing`
  - C5 repo and installed `pisignage-vlc-playlist.mjs` matched hash `14b916ef3435daa917d73e06f6318b4a465b7faf5bc07280aa74b30cf72d91db` after the C5-only deployment
  - unchanged C5 baselines were installer hash `3fc11238a4202f9c40f2570b108e829df130a6ccac68730059c9ab17722143e3`, VLC service hash `6ff1d651e227fd2a7ffd8e68a21de407da90a75cbce87a8670c5bae879ed784b`, and compiled device-agent hash `b14d8b1c23fa1c031ee2033edccb15bb66f28162a347df1d464ea605e7867e91`
  - C5 retained Node `v20.19.2`, VLC `3.0.23`, playlist `playlist-main-playlist@4`, playlist file hash `6d46f5775bfb2cfd43a0f421f81f98fb77a269e60c5a2c5d4a950206dc6d052b`, and one published asset
  - after the authorized VLC restart and immediate schedule enforcement, `pisignage-vlc.service` was inactive as expected for the closed schedule; device-agent and schedule timer remained active, HDMI-A-1 was powered off, and the 20:34 PDT cloud heartbeat reported the same intentional closed state
  - initial deployment scope was intentionally limited to C5; C1-C3 were subsequently authorized and rolled out at 20:54 PDT, while C4 remained untouched because it was offline and last seen by Tailscale four days earlier
  - C1-C3 repo and installed controller paths now match C5 and the workstation at hash `14b916ef3435daa917d73e06f6318b4a465b7faf5bc07280aa74b30cf72d91db`; the staged file passed `node --check` and exact checksum validation on every device before installation
  - C1-C3 retained Node `v20.19.2`, VLC `3.0.23`, installer hash `3fc11238a4202f9c40f2570b108e829df130a6ccac68730059c9ab17722143e3`, VLC service hash `6ff1d651e227fd2a7ffd8e68a21de407da90a75cbce87a8670c5bae879ed784b`, and device-agent hash `b14d8b1c23fa1c031ee2033edccb15bb66f28162a347df1d464ea605e7867e91`
  - after restart and immediate schedule enforcement, C1-C3 correctly returned to the closed state: VLC inactive with `Result=success` and zero restarts, device-agent and schedule timer active, and fresh heartbeats reporting `stopped`, `scheduleState=off`, `scheduleDisplayAction=display-off`, and successful display control
  - C1-C3 retained normalized playlist `playlist-main-playlist@4`, one asset, and published asset checksum `45b9a7e47a898172513f8e01b54a36eb7c25914d00099f35b99d9bf329978201`; C1-C2 raw playlist hash was `9054d56fc14fa1af31b3bad1c5ed3f1739a8fbbfd51c2ec9080fc548cf0864fe` and C3 raw playlist hash was `abbdc82cb285387011bf0b4e5ff160809516d478c4a5cdd1a3058f25c0e60831`, an allowed serialization difference with the same normalized contract
  - C4 playback-proof parity remains unverified and pending until that appliance returns online; its last verified controller baseline was the 2026-07-11 hash `3b8c6ad2b85e776ede0d04fd1ac1a8db15af26d6341c6a2ad9737b5de87b00d8`
- 2026-07-22 C5 HDMI hot-plug recovery hardening:
  - at 08:59 PDT, reseating C5's HDMI cable temporarily removed `HDMI-A-1`; schedule enforcement restarted LightDM and restored the 1920x1080 display session, but the VLC process retained its 08:01 PID and continued MPRIS advancement against the terminated Wayland compositor
  - the TV displayed the recovered compositor without video because schedule enforcement treated the successful display retry as permission to run `systemctl start`; that command was a no-op against the already-active, now-headless VLC service
  - an authorized VLC restart changed the controller PID from `658762` to `666318` and restored visible video; MPRIS position advanced, player status returned to `playing`, and playback proof returned to `advancing`
  - `pisignage-enforce-schedule.mjs` now carries display-session restart evidence through display recovery and selects `systemctl restart` for both scheduled and unassigned open states whenever LightDM was replaced
  - focused regression coverage in `npm run test:schedule` now proves an active schedule normally chooses `would-start` and the same active schedule after simulated display-session recovery chooses `would-restart`
  - workstation, C5 repo, and C5 installed `pisignage-enforce-schedule.mjs` match hash `b115e646f938bbdc45d7f090b908b2cb27390c5ad69cfe2fdc97e1ebd3f600bb`; the staged script passed `node --check` and exact checksum validation before installation
  - the installed C5 dry-run selected `systemctl --user restart pisignage-vlc.service` for the active schedule recovery case; normal schedule enforcement retained the healthy VLC PID, reported successful display control, and left visible playback advancing
  - the validated fix was committed and pushed to `github/main` as `17eb0c5` before the user-authorized C1-C3 rollout
  - C1-C3 repo and installed schedule paths were upgraded from hash `22b33850869e5ba71cba4751450029d284c0c97880abbc63e498c23826b96352` to Golden Master hash `b115e646f938bbdc45d7f090b908b2cb27390c5ad69cfe2fdc97e1ebd3f600bb`; every staged file passed `node --check` and exact checksum validation before installation
  - the installed recovery dry-run on each device selected `systemctl --user restart pisignage-vlc.service` for an active schedule after simulated display-session replacement, while normal enforcement retained each healthy VLC PID
  - C1-C3 and C5 all reported `pisignage-vlc.service`, `pisignage-device-agent.service`, and `pisignage-schedule.timer` active; `HDMI-A-1` on; schedule state `on` with successful display control; player and heartbeat state `playing`; playback proof `advancing`; and live MPRIS position advancement
  - C1-C3 and C5 retained Node `v20.19.2`, VLC `3.0.23`, controller hash `14b916ef3435daa917d73e06f6318b4a465b7faf5bc07280aa74b30cf72d91db`, installer hash `3fc11238a4202f9c40f2570b108e829df130a6ccac68730059c9ab17722143e3`, VLC service hash `6ff1d651e227fd2a7ffd8e68a21de407da90a75cbce87a8670c5bae879ed784b`, and device-agent hash `b14d8b1c23fa1c031ee2033edccb15bb66f28162a347df1d464ea605e7867e91`
  - all four reachable appliances retained `playlist-main-playlist@4`, current asset `asset-2026-03-31-ad-dad-website-ad-signage-1080p`, one published asset, and matching asset fingerprint `c4b6cc2afc968b16bc46acd869efeaf91285d743509eae468dfdd18d68a3b7d8`; raw playlist hashes differ only by previously documented serialization/runtime metadata
  - C4 was still offline and unverified during the initial C1-C3 rollout; its later power-up and completed validation are recorded below
- 2026-07-22 C4 power-up and Golden Master completion:
  - the operator confirmed C4 had only been powered down; after power-up it returned on tailnet address `100.85.111.13` and studio LAN address `192.168.1.177` with its C4 hostname, device identity, screen assignment, schedule, playlist, and secrets intact
  - the complete managed-file comparison found exactly two stale files: schedule recovery hash `22b33850869e5ba71cba4751450029d284c0c97880abbc63e498c23826b96352` and VLC controller hash `3b8c6ad2b85e776ede0d04fd1ac1a8db15af26d6341c6a2ad9737b5de87b00d8`; every other managed script, service, sudoers file, appliance asset, and compiled device-agent artifact already matched the Golden Master
  - the staged replacements passed `node --check` and exact checksum validation before C4 repo and installed paths were updated to schedule hash `b115e646f938bbdc45d7f090b908b2cb27390c5ad69cfe2fdc97e1ebd3f600bb` and controller hash `14b916ef3435daa917d73e06f6318b4a465b7faf5bc07280aa74b30cf72d91db`
  - C4's cached `Default Playlist` was already `playlist-main-playlist@4` with the expected single asset; the authorized VLC restart changed PID `1125` to `2284`, the operator confirmed visible video, direct MPRIS positions advanced, and player proof reached `playing` / `advancing` with no playback error
  - C4 retained Node `v20.19.2`, VLC `3.0.23`, the matching one-file media cache, active display and schedule control, and active VLC, device-agent, schedule timer, and remote-desktop services
  - C1-C5 now share the managed Golden Master hashes; published playlist and media payloads may differ when a screen has an intentional playlist assignment, while all other per-device differences remain limited to documented identity, network, screen, schedule, location, and operator-controlled audio fields
- 2026-07-22 VLC handoff MPRIS monitoring hardening:
  - C4 continued visible playback after its 11:39 PDT handoff to `playlist-community-vision@32`, but remained `checking` because the overlapping replacement VLC could not retain the generic `org.mpris.MediaPlayer2.vlc` name after the prior VLC stopped; the surviving process remained reachable at its PID-specific MPRIS instance name
  - the controller now probes the active child VLC's PID-specific MPRIS name first and falls back to the generic name used by a normal non-overlapping VLC startup, preserving seamless playlist handoff while keeping proof attached to the active process
  - live C4 reproduction also showed VLC returning successful but empty replies when Metadata, PlaybackStatus, and Position were requested concurrently; those properties are now read sequentially so a valid position is not discarded as unavailable
  - focused coverage in `npm run test:vlc-continuous-handoff` requires the replacement VLC's instance-specific destination and advancing proof after handoff; `npm run test:vlc-playback-proof` now rejects overlapping property requests and requires the generic-name fallback used at normal startup
  - the complete `npm run test:release-hardening` suite passed after the final correction, including all workspace type checks, schedule/cache/publish tests, VLC handoff/proof/restart tests, and local failure simulation
  - commits `497135e`, `f21c96c`, and final correction `b6db86c` were pushed to `github/main`; the final Golden Master controller hash is `05c14e5321a7e22404d6863c85a9308441ffc626cc648756f676dc0d86e34db4`
  - the rollout was deliberately stopped twice before C1-C3: first when C5 proved normal startup needed the generic-name fallback, then when C4 proved concurrent property reads could return empty responses; only the final validated controller was deployed fleet-wide
  - C1-C5 repo and installed controller paths match the final hash; the staged file passed `node --check` and exact checksum validation on every device before installation
  - C1-C5 report active VLC, device-agent, and schedule services with zero VLC restart loops, connected display outputs, successful schedule display control, heartbeat `playing`, controller `playing` / `advancing`, MPRIS `Playing`, and direct position advancement
  - C1-C3 and C5 retain intentional `playlist-main-playlist@4` payloads with one cached asset and media fingerprint `c4b6cc2afc968b16bc46acd869efeaf91285d743509eae468dfdd18d68a3b7d8`; C4's assigned `playlist-community-vision@32` payload has 29 cached assets and media fingerprint `4afa76fdf340146f0ae18bb7151e9ea5989b8dbccfa45afe81c7a53b1f7a342d`
- Network transport determinism:
  - device-agent heartbeat prefers `wlan0`, then `eth0`, then any other non-internal IPv4 address
  - Wi-Fi setup applies route metric `50` after successful Wi-Fi configuration so Wi-Fi is preferred when Ethernet and Wi-Fi are both active
- Cloud media upload/prep hardening and S3 upload path
- Strict playlist cache parity:
  - the active device-agent media cache is a mirror of the currently published playlist
  - matching cached assets are skipped by size/checksum, so adding one playlist item downloads only that new or changed file
  - after a successful release sync, stale cache files not referenced by the current playlist are pruned
  - routine check-ins still fetch only tiny release/heartbeat metadata and do not return media URLs unless an asset is missing or changed
- C5 emergency recovery cleanup after failed HDMI rescue:
  - removed stray `donnoel` line from `/boot/firmware/cmdline.txt`
  - removed temporary firmware HDMI hardening from `/boot/firmware/config.txt`
  - removed temporary HDMI recovery service drop-ins
  - restored working display path to `HDMI-A-1` at `1920x1080@60.000000`

## C5 Identity

- Hostname: `C5`
- Reachable host: `C5.local`
- Wired IP at capture: `192.168.100.34` on `eth0`
- Wi-Fi IP at capture: `192.168.100.27` on `wlan0`
- Default route: `192.168.100.1` via `wlan0`, source `192.168.100.27`
- Saved Wi-Fi route preference: `Chicane` has `ipv4.route-metric=50` and `ipv6.route-metric=50` so Wi-Fi is preferred when both transports are active
- SSH user: `donnoel`
- Cloud device ID: `device-c5-aws-pilot`
- Cloud dashboard/playlist URL: `https://8yyptjawdv.us-west-2.awsapprunner.com`
- Cloud heartbeat API URL: `https://yebxh6xyvm2nkgq3i2uw2oixda0izozg.lambda-url.us-west-2.on.aws/`
- API key: configured locally on C5 and intentionally redacted from this baseline

## Runtime Baseline

- OS: `Debian GNU/Linux 13 (trixie)`, `DEBIAN_VERSION_FULL=13.5`
- Kernel: `Linux C5 6.18.33+rpt-rpi-v8 #1 SMP PREEMPT Debian 1:6.18.33-1+rpt1 (2026-06-01) aarch64`
- Node: `v20.19.2`
- VLC: `VLC version 3.0.23 Vetinari (3.0.23-2-0-g79128878dd)`
- Chromium: `Chromium 148.0.7778.167 built on Debian GNU/Linux 13 (trixie)`
- Remote desktop packages: `novnc` `1:1.6.0-2`, `websockify` `0.12.0+dfsg1-4+b1`
- Remote access package: `tailscale` `1.98.8`
- Schedule/display recovery hardening:
  - schedule open and VLC startup detect the `NOOP-1` headless-output state seen after scheduled close/open recovery
  - when `HDMI-A-1` is reported but disabled while `NOOP-1` is active, the appliance restarts the user display session and retries the configured HDMI output/mode
  - the appliance target remains `HDMI-A-1` at `1920x1080@60.000000`; do not blindly accept a display's preferred mode as healthy playback

## Boot And Display Baseline

`/boot/firmware/cmdline.txt` must be one single line and must not contain a forced `video=` override:

```text
console=serial0,115200 console=tty1 root=PARTUUID=58e53866-02 rootfstype=ext4 fsck.repair=yes rootwait quiet splash plymouth.ignore-serial-consoles cfg80211.ieee80211_regdom=US ds=nocloud;i=rpi-imager-1779386244658
```

`/boot/firmware/config.txt` must not contain the temporary HDMI recovery hardening block:

```text
# PiSignage HDMI recovery hardening
hdmi_force_hotplug=1
hdmi_group=1
hdmi_mode=16
config_hdmi_boost=7
```

Display state at capture:

- Output: `HDMI-A-1`
- Display: field TV on `HDMI-A-1`; `wlr-randr` reported make/model as `(null)` at this capture
- Current mode: `1920x1080 px, 60.000000 Hz`
- VLC display output: `HDMI-A-1`
- VLC display mode: `1920x1080@60.000000`
- VLC video output: `wl_shm`
- Wayland display: `wayland-0`

Physical note: during the 2026-07-04 recovery, the monitor only returned to a clean ONN/1080p handshake after the cable was moved back to the Pi port that Linux reports as `HDMI-A-1`. Leave C5 on that port unless deliberately testing display behavior. The appliance display target remains fullscreen `1920x1080@60.000000`; do not accept a lower display mode as healthy playback. If 1080p is missing after a display event, recover the HDMI/compositor mode before considering the Pi healthy.

Fleet display note: C1-C3 and C5 are ONN displays in the current pilot. C4 is a Philips TV that advertises 4K preferred modes and may require explicit return to the configured `1920x1080@60.000000` appliance target after HDMI/display wake events.

## Managed Service State

| Unit | Enabled | Active state | Substate | Notes |
| --- | --- | --- | --- | --- |
| `pisignage-device-agent.service` | enabled | active | running | Cloud command plane and heartbeat runtime |
| `pisignage-vlc.service` | enabled | active | running | VLC playback path |
| `pisignage-schedule.timer` | enabled | active | running | Runs schedule enforcement every minute |
| `pisignage-schedule.service` | static | transient | start | One-shot schedule enforcement |
| `wayvnc.service` | enabled | active | running | System WayVNC remote desktop backend on port `5900`; C5 config uses `enable_auth=false` for noVNC compatibility |
| `pisignage-remote-desktop.service` | enabled | active | running | Browser remote desktop bridge; serves noVNC on port `6080` and proxies to `127.0.0.1:5900` |
| `tailscaled.service` | enabled | active | running | Tailscale tunnel for remote administration across networks; appliance must be enrolled with its own per-device tailnet identity |
| `pisignage-player.service` | disabled | inactive | dead | Browser player fallback/experimental |
| `pisignage-kiosk.service` | disabled | inactive | dead | Browser kiosk fallback/experimental |

Allowed VLC service drop-in at capture:

```text
/home/donnoel/.config/systemd/user/pisignage-vlc.service.d/10-cloud-cache.conf
```

No temporary display recovery drop-ins should remain in either:

```text
/home/donnoel/.config/systemd/user/pisignage-vlc.service.d/
/home/donnoel/.config/systemd/user/pisignage-schedule.service.d/
```

## Current Playback Evidence

Player status path:

```text
/home/donnoel/.local/state/pisignage/player-status.json
```

Current player facts at capture:

- mode: `vlc`
- state: `playing`
- playlist path: `/home/donnoel/.local/cache/pisignage/device-agent/playlists/current.json`
- playlist ID: `playlist-main-playlist`
- playlist name: `Default Playlist`
- playlist version: `4`
- asset count in active playlist: `1`
- display output: `HDMI-A-1`
- display mode: `1920x1080@60.000000`
- audio mode: `on`
- quarantined assets: none
- last error: none
- current-video reporting fields present:
  - `currentAssetId`
  - `currentAssetPath`
  - `currentAssetDurationSeconds`

At the 2026-07-22 C1-C5 parity capture, `player-status.json` reported:

- state: `playing`
- playback proof: `advancing`
- current asset ID: `asset-2026-03-31-ad-dad-website-ad-signage-1080p`
- current asset path and duration fields present

Heartbeat path:

```text
/home/donnoel/.local/state/pisignage/heartbeat.json
```

Heartbeat facts at capture:

- device ID: `device-c5-aws-pilot`
- hostname: `C5`
- local IP: `192.168.100.27`
- app version: `0.1.0`
- current playlist ID: `playlist-main-playlist`
- playlist version: `4`
- playback state: `playing`
- network online: `true`
- heartbeat interval: `10s`
- heartbeat jitter: `2s`
- current-video heartbeat field present:
  - `currentAssetId`
- schedule heartbeat fields present:
  - `scheduleState`
  - `scheduleDetail`
  - `scheduleDisplayAction`
  - `scheduleDisplayControlOk`
  - `scheduleOverrideExpiresAt`

At the 2026-07-22 parity capture, `heartbeat.json` reported current asset ID `asset-2026-03-31-ad-dad-website-ad-signage-1080p`, `scheduleState` `on`, and `scheduleDetail` `Schedule window is active. wlopm set HDMI-A-1 on.`

## Schedule Evidence

Schedule status path:

```text
/home/donnoel/.local/state/pisignage/schedule-status.json
```

Current schedule facts at capture:

- screen ID: `screen-primary`
- schedule path: `/home/donnoel/PiSignage/sample-content/schedules.local.json`
- service: `pisignage-vlc.service`
- state: `on`
- action: `start`
- active schedule name: `Customer 5 hours`
- detail: `Schedule window is active. wlopm set HDMI-A-1 on.`
- display action: `display-on`
- display control ok: `true`
- display output: `HDMI-A-1`

Controlled schedule cycle validation on 2026-07-06:

- forced after-hours evaluation stopped `pisignage-vlc.service`
- after-hours display action used `vcgencmd display_power 0`
- `HDMI-A-1` stayed attached and enabled in `wlr-randr`
- forced open-hours evaluation used `vcgencmd display_power 1`
- `HDMI-A-1` returned at `1920x1080@60.000000`
- `pisignage-vlc.service`, `pisignage-schedule.timer`, and `pisignage-device-agent.service` were active after the cycle
- player status returned to `playing`

Controlled schedule cycle validation on 2026-07-07:

- forced after-hours evaluation stopped `pisignage-vlc.service`
- after-hours display action used `wlopm --off HDMI-A-1`
- `wlopm` reported `HDMI-A-1 off`
- `vcgencmd display_power 0` remained unreliable on this C5 and read back `display_power=1`; it is fallback-only evidence, not the close guarantee
- forced open-hours evaluation used `wlopm --on HDMI-A-1`
- `HDMI-A-1` returned at `1920x1080@60.000000`
- compositor snapshot after reopen showed fullscreen VLC playback with no desktop panel and no Wi-Fi authentication dialog visible
- follow-up heartbeat reported `playbackState: playing`, `scheduleState: on`, and `scheduleDisplayControlOk: true`
- `pisignage-vlc.service`, `pisignage-schedule.timer`, and `pisignage-device-agent.service` were active after the cycle

Natural schedule validation on 2026-07-08:

- operator observed C5 close at the scheduled close and reopen at the scheduled open
- follow-up live check at `2026-07-08T07:47:20-07:00` reported `scheduleState: on`, `playbackState: playing`, and `scheduleDetail: Schedule window is active. wlopm set HDMI-A-1 on.`
- `wlopm` reported `HDMI-A-1 on`
- `pisignage-vlc.service`, `pisignage-schedule.timer`, and `pisignage-device-agent.service` were active after the natural open

Controlled Open store validation on 2026-07-06:

- forced after-hours Open store created temporary local state `override-open`
- temporary-open detail reported: `Open store override is active until 2026-07-08T00:00:00.000Z. vcgencmd set HDMI-A-1 on.`
- display action remained `display-on`
- display control ok remained `true`
- override was cleared immediately after validation
- current schedule status returned to `state: on`
- follow-up heartbeat reported `scheduleState: on` and `scheduleOverrideExpiresAt: null`
- `pisignage-vlc.service`, `pisignage-device-agent.service`, and `pisignage-schedule.timer` stayed active

## Cache And Playlist Baseline

Playlist cache directory:

```text
/home/donnoel/.local/cache/pisignage/device-agent/playlists
```

Playlist content:

```text
playlist-main-playlist@4
1 asset
a3ac93411848d0d20f125cf8b1d36f00e3f089bfb390c6ac46674187c01deb79  normalized playlist content fingerprint
c4b6cc2afc968b16bc46acd869efeaf91285d743509eae468dfdd18d68a3b7d8  active asset hash-set fingerprint
```

Raw playlist JSON file hashes can differ across appliances because device-local runtime metadata or serialization order is not a Golden Master contract. The normalized playlist identity, version, ordered asset identity, duration, checksum, and size are the parity surface.

Asset cache directory:

```text
/home/donnoel/.local/cache/pisignage/device-agent/assets
```

Cached asset facts at the final 2026-07-22 C1-C5 parity capture:

- C1-C3 and C5: `playlist-main-playlist@4`, `1` cached file, active asset checksum `45b9a7e47a898172513f8e01b54a36eb7c25914d00099f35b99d9bf329978201`, and hash-set fingerprint `c4b6cc2afc968b16bc46acd869efeaf91285d743509eae468dfdd18d68a3b7d8`
- C4 intentional screen assignment: `playlist-community-vision@32`, `29` cached files, playlist hash `2adb8bd0fc103706490b0535e705b1a613563827a99300ae2e28cf6b22cf13c2`, and hash-set fingerprint `4afa76fdf340146f0ae18bb7151e9ea5989b8dbccfa45afe81c7a53b1f7a342d`
- cache parity contract: the asset cache must contain only files referenced by the currently published playlist
- sync behavior: matching cached files are skipped by size/checksum; missing or changed files are downloaded individually; unreferenced files are pruned after successful sync

## Managed File Hashes

Managed Pi scripts:

```text
75104faff5c772e90230edc1a9a560549f131ab63e2bb048309958aa70c30ba1  pisignage-call-home-now.sh
60f2e66f5afc2337cf4743229feabbe41cf3cb0fdfeae2dbdfc13c37431e4564  pisignage-configure-wifi.sh
b115e646f938bbdc45d7f090b908b2cb27390c5ad69cfe2fdc97e1ebd3f600bb  pisignage-enforce-schedule.mjs
c577963b8233b225a663319fb95c0411015cf85c5a1635dc2e5e76801cd92a08  pisignage-hide-desktop.sh
3fc11238a4202f9c40f2570b108e829df130a6ccac68730059c9ab17722143e3  pisignage-install-runtime.sh
87cf85f1e12fad9034cd693ba2d20dc9f538fd2f31a61f9c21e68b156e9bda87  pisignage-provision-device.sh
fef221b2e4fd8dc1a4009746804a3c70e1e26186191e7a5aa1dae2a912abb5eb  pisignage-reset-device.sh
bc01cf6dc91e857da42d753361113c7cf979c6f9486e391ba86e38c64b6e71f0  pisignage-serve-player.mjs
5ad55c8d2fb4a027693113f8c9bd2ebd92e83b1619e54468f8e997030d7a52b0  pisignage-start-display.sh
05c14e5321a7e22404d6863c85a9308441ffc626cc648756f676dc0d86e34db4  pisignage-vlc-playlist.mjs
```

Managed user services:

```text
a8e42eec9b0df56b175d9c490e55601c75d3aceb8462be0d2304cfa460a8dd28  pisignage-device-agent.service
6ff1d651e227fd2a7ffd8e68a21de407da90a75cbce87a8670c5bae879ed784b  pisignage-vlc.service
a79d98fd2a9f3dabf6314b413e9501c620862cf2253452ce198a754b6637a42e  pisignage-schedule.service
596b5adad2708f97b21c2cb38fb6798e54dd4b5e95163bfd10ea38c235b27c74  pisignage-schedule.timer
323beab51690837cc6fde5cc58277dbb5b272d167ae991953beb85e0b1741761  pisignage-player.service
7308c0a0cac88246a8e041d21a1c74e7bf88ef8a6500201237b78ee2efe7491f  pisignage-kiosk.service
efbe213d6bc3b7d38351592ff0312d7f2320f7f3919b491b6221a4b5a6cfab8c  pisignage-remote-desktop.service
```

Managed sudoers drop-ins:

```text
b04741c024603fddf13575e30abaaa43c48d340cfc499b090115ff2c1c3a0ca6  pisignage-display-recovery
da9cabb6a1cfdb3b288ff657dc5a7319e8c4d57a51bda4c631c7636bfe2bc8ea  pisignage-reset-reboot
```

Managed appliance assets:

```text
50d0c8de376fb2760219ea9caf6c778ed421e66e731fdc5601bf6aebea124ff1  ad-dad-logo.png
feac26778e52d042e4b8c3661321498439ee45fcb1000713dfee13cc4a17e9e6  ad-dad-logo.ppm
```

Compiled device agent:

```text
b14d8b1c23fa1c031ee2033edccb15bb66f28162a347df1d464ea605e7867e91  device-agent/dist/index.js
```

These hashes supersede the 2026-07-09 13:57 baseline hashes and include the current command-plane behavior, including schedule-aware heartbeat reporting, the remote Open store action, the remote Close store action that clears the temporary open override and resumes schedule enforcement, the remote screen snapshot prototype, remote Show desktop and Resume playback actions that pause and restore schedule control, Restart playback recovery that restores schedule control, Show desktop desktop-panel restoration and verification for noVNC administration, automatic playback resume if desktop-panel restoration fails, deterministic Wi-Fi-first heartbeat address selection, Tailscale tailnet address reporting, verified `wlopm` display power control for schedule close/open, no-schedule playback enforcement that actively powers on display and starts VLC, automatic HDMI/headless-output display session recovery with VLC restart after compositor replacement, MPRIS-backed current-video reporting for continuous VLC playback, playback advancement proof before reporting continuous VLC as `playing`, PID-specific MPRIS monitoring across overlapping playlist handoffs with generic-service fallback and serialized property reads, publish-now asset-boundary handoff for VLC playlist reloads, 10-second cloud heartbeat check-ins with up to 2 seconds of jitter through the dedicated device heartbeat API, Golden Master-managed remote access installation/enrollment support, and strict device-agent cache parity that prunes stale unreferenced media after successful release sync. The playback-proof controller and schedule recovery hashes are validated and installed on C1-C5.

## Required Baseline Update Workflow

Use this workflow for every future Pi-touching C5 prototype change:

1. Make the change in the repo and build any required runtime artifacts.
2. Deploy and validate the change live on the Golden Master candidate Pi.
3. Confirm playback, display, network, heartbeat, cache, command-plane, and
   service state are healthy.
4. Update this PI golden master baseline with the repo commit, evidence, and
   hashes for the promoted state.
5. Roll the promoted managed state to the rest of C1-Cx.
6. Verify every reachable appliance against the promoted baseline by Tailscale
   and call-home evidence.
7. Note which C1-Cx appliances still need the change if any are temporarily
   unreachable.
8. Do not call the Pi work complete until this file is current and drift is
   either resolved or explicitly documented.

Repeatable release-candidate gate:

```sh
npm run check:rc-parity
```

The RC parity gate is read-only. It checks the repo release state, this baseline,
managed Pi file hashes, compiled device-agent hash, dashboard inventory evidence,
and C1-C5 live Tailscale SSH evidence when credentials are available. It must
not restart services, publish playlists, sync media, install packages, mutate
AWS, or change Pi state.

Use repo-only mode when validating baseline edits before a commit:

```sh
npm run check:rc-parity -- --repo-only
```

Minimum live validation before updating this baseline:

```text
hostname
ip -4 addr show scope global
systemctl --user status pisignage-device-agent.service --no-pager
systemctl --user status pisignage-vlc.service --no-pager
systemctl --user status pisignage-schedule.timer --no-pager
systemctl status tailscaled.service --no-pager
tailscale ip -4
wlr-randr
cat ~/.local/state/pisignage/player-status.json
cat ~/.local/state/pisignage/heartbeat.json
cat ~/.local/state/pisignage/schedule-status.json
sha256sum ~/.local/bin/pisignage-*.sh ~/.local/bin/pisignage-*.mjs
sha256sum ~/.config/systemd/user/pisignage-*.service ~/.config/systemd/user/pisignage-*.timer
sha256sum /home/donnoel/PiSignage/device-agent/dist/index.js
```

## C1-Cx Rollout Note

C1-C4 were refreshed from the then-current PI golden master baseline at the studio on 2026-07-08. On 2026-07-09, C1-C4 were updated in place with the Golden Master remote access package and service baseline:

- `tailscale` installed and `tailscaled.service` enabled/active
- `wayvnc` installed and `wayvnc.service` enabled/active
- `novnc` and `websockify` installed for the browser desktop bridge
- `pisignage-remote-desktop.service` enabled/active
- refreshed managed runtime install and reset scripts in both the repo checkout and `~/.local/bin`

Tailnet enrollment for C1-C4 was completed in the temporary test tailnet on 2026-07-09. Production provisioning must use a pre-authorized Tailscale auth key supplied outside git so a Golden Master image can enroll each Pi automatically with its own hostname.

After test-tailnet approval on 2026-07-09, C1-C5 tailnet identities were:

| Pi | Tailnet hostname | Tailnet IPv4 |
| --- | --- | --- |
| C1 | `beam-c1` | `100.108.135.20` |
| C2 | `beam-c2` | `100.95.194.15` |
| C3 | `beam-c3` | `100.86.155.95` |
| C4 | `beam-c4` | `100.85.111.13` |
| C5 | `beam-c5` | `100.66.60.59` |

Rollout payload:

```text
939d944c58a4087528a30832e1b635434098f07fd9624661773dfd37d3a56284  /tmp/beam-pi-golden-20260708-d489690.tgz
```

The rollout preserved each Pi's identity and network fields, then refreshed the Beam-managed scripts, generated user services, first-run playlist/media, and compiled device-agent runtime. The private device-agent env on C1-C4 was also corrected to use the dedicated device heartbeat API URL while preserving each device's API key value. Stale `audio.conf` VLC drop-ins that forced audio off were removed from C2-C4 so the only remaining VLC drop-in on C1-C4 is the expected cloud cache override.

Validated C1-C4 after rollout and remote access package refresh:

| Pi | IP | Device ID | Dedicated heartbeat API | Agent hash | Remote access services | Managed script hashes | Cloud heartbeat |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | `192.168.1.131` | `device-c1-aws-pilot` | configured | `6c206f1b457fd0eaa19127d6e2be1451201f05554c9679e8d7ab62bac4355f35` | `tailscaled`, `wayvnc`, `pisignage-remote-desktop` active | install `687ee167727965ae68bfac6e1461fa0d54d3a79e62fb85b9d09e0bf46bab583e`; reset `6e5757eebb2f1fc1b61a7570b5a9bb1e9a6fb1c33c352af2040d3031388cb082` | playing, playlist `playlist-community-vision` v32 |
| C2 | `192.168.1.64` | `device-c2-aws-pilot` | configured | `6c206f1b457fd0eaa19127d6e2be1451201f05554c9679e8d7ab62bac4355f35` | `tailscaled`, `wayvnc`, `pisignage-remote-desktop` active | install `687ee167727965ae68bfac6e1461fa0d54d3a79e62fb85b9d09e0bf46bab583e`; reset `6e5757eebb2f1fc1b61a7570b5a9bb1e9a6fb1c33c352af2040d3031388cb082` | playing, playlist `playlist-community-vision` v32 |
| C3 | `192.168.1.169` | `device-c3-aws-pilot` | configured | `6c206f1b457fd0eaa19127d6e2be1451201f05554c9679e8d7ab62bac4355f35` | `tailscaled`, `wayvnc`, `pisignage-remote-desktop` active | install `687ee167727965ae68bfac6e1461fa0d54d3a79e62fb85b9d09e0bf46bab583e`; reset `6e5757eebb2f1fc1b61a7570b5a9bb1e9a6fb1c33c352af2040d3031388cb082` | playing, playlist `playlist-community-vision` v32 |
| C4 | `192.168.1.177` | `device-c4-aws-pilot` | configured | `6c206f1b457fd0eaa19127d6e2be1451201f05554c9679e8d7ab62bac4355f35` | `tailscaled`, `wayvnc`, `pisignage-remote-desktop` active | install `687ee167727965ae68bfac6e1461fa0d54d3a79e62fb85b9d09e0bf46bab583e`; reset `6e5757eebb2f1fc1b61a7570b5a9bb1e9a6fb1c33c352af2040d3031388cb082` | playing, playlist `playlist-community-vision` v32 |

On all four Pis, `pisignage-device-agent.service`, `pisignage-vlc.service`, `pisignage-schedule.timer`, `pisignage-remote-desktop.service`, `tailscaled.service`, and `wayvnc.service` were active after the remote access package refresh. `pisignage-player.service` and `pisignage-kiosk.service` remain disabled and inactive. Forced call-home completed through the dedicated device heartbeat API on all four devices before this remote access refresh.

2026-07-10 Show desktop stabilization rollout:

| Pi | Tailnet IPv4 | Device-agent hash | Device-agent service hash | Runtime installer hash | Post-rollout service state |
| --- | --- | --- | --- | --- | --- |
| C1 | `100.108.135.20` | `6694b4f3e4bc79db01bc24556d47de9b07596e175fe4ce97dab4b6ccf709cbb2` | `2e8aaa558b8409fd55f9bdfdd0a19550868bed03628316688a5b65037f967116` | `dbc71d0eff8d95880e72c870f2f0db1e766bdde1e0170cc236ecd9a624be1200` | device-agent active; schedule timer active; VLC inactive because schedule closed |
| C2 | `100.95.194.15` | `6694b4f3e4bc79db01bc24556d47de9b07596e175fe4ce97dab4b6ccf709cbb2` | `2e8aaa558b8409fd55f9bdfdd0a19550868bed03628316688a5b65037f967116` | `dbc71d0eff8d95880e72c870f2f0db1e766bdde1e0170cc236ecd9a624be1200` | device-agent active; schedule timer active; VLC inactive because schedule closed |
| C3 | `100.86.155.95` | `6694b4f3e4bc79db01bc24556d47de9b07596e175fe4ce97dab4b6ccf709cbb2` | `2e8aaa558b8409fd55f9bdfdd0a19550868bed03628316688a5b65037f967116` | `dbc71d0eff8d95880e72c870f2f0db1e766bdde1e0170cc236ecd9a624be1200` | device-agent active; schedule timer active; VLC inactive because schedule closed |
| C4 | `100.85.111.13` | `6694b4f3e4bc79db01bc24556d47de9b07596e175fe4ce97dab4b6ccf709cbb2` | `2e8aaa558b8409fd55f9bdfdd0a19550868bed03628316688a5b65037f967116` | `dbc71d0eff8d95880e72c870f2f0db1e766bdde1e0170cc236ecd9a624be1200` | device-agent active; schedule timer active; VLC inactive because schedule closed |
| C5 | `100.66.60.59` | `6694b4f3e4bc79db01bc24556d47de9b07596e175fe4ce97dab4b6ccf709cbb2` | `2e8aaa558b8409fd55f9bdfdd0a19550868bed03628316688a5b65037f967116` | `dbc71d0eff8d95880e72c870f2f0db1e766bdde1e0170cc236ecd9a624be1200` | device-agent active; schedule timer active; VLC active after Resume playback |

C5 live validation after the rollout: Show desktop succeeded in the browser noVNC session, then Resume playback returned VLC to `active/running`; local player status and heartbeat both reported `playing` on playlist `playlist-community-vision` v32.

2026-07-11 Scheduling Close store rollout:

| Pi | Tailnet IPv4 | Device-agent hash | Device-agent state | VLC state | Schedule timer state |
| --- | --- | --- | --- | --- | --- |
| C1 | `100.108.135.20` | `b14d8b1c23fa1c031ee2033edccb15bb66f28162a347df1d464ea605e7867e91` | active | inactive | active |
| C2 | `100.95.194.15` | `b14d8b1c23fa1c031ee2033edccb15bb66f28162a347df1d464ea605e7867e91` | active | inactive | active |
| C3 | `100.86.155.95` | `b14d8b1c23fa1c031ee2033edccb15bb66f28162a347df1d464ea605e7867e91` | active | inactive | active |
| C4 | `100.85.111.13` | `b14d8b1c23fa1c031ee2033edccb15bb66f28162a347df1d464ea605e7867e91` | active | inactive | active |
| C5 | `100.66.60.59` | `b14d8b1c23fa1c031ee2033edccb15bb66f28162a347df1d464ea605e7867e91` | active | active | active |

The compiled device-agent runtime was refreshed on C1-C5 over Tailscale and `pisignage-device-agent.service` was restarted on each Pi. VLC playback was not restarted by this rollout; C1-C4 remained closed by schedule and C5 remained open/playing under the active open-store override.

The same rule applies to every future C1-Cx appliance.

For any C1-Cx Beam Pi, always reference this file first. Do not use a previous chat transcript, stale IP address, or old C5 snapshot as the appliance source of truth.

Rollout rule: copy the managed Beam runtime and generated service shape proven on C5, not C5's identity. Preserve or reprovision each Pi's hostname, network configuration, cloud device ID, screen assignment, location label, local API key, and secrets.

Known intentional per-device fields must not be copied blindly:

- hostname
- IP addresses
- cloud device ID
- screen assignment
- location label
- local API key or secrets
