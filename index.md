---
layout: default
title: Beam
---

<section class="hero" aria-labelledby="hero-title">
  <div class="hero__copy">
    <p class="eyebrow">Local-first signage <span aria-hidden="true">·</span> Raspberry Pi appliances</p>
    <h1 id="hero-title">Digital signage that keeps playing.</h1>
    <p class="hero__lede">Beam combines a real operations dashboard with reusable media, playlists, screen health, manual publishing, and resilient fullscreen playback on Raspberry Pi.</p>
    <div class="hero__actions">
      <a class="button button--primary" href="{{ site.github_url }}">View on GitHub <span aria-hidden="true">↗</span></a>
      <a class="button button--quiet" href="#publish-flow">See the publish path</a>
    </div>
    <ul class="signal-list" aria-label="Project foundation">
      <li>Next.js</li><li>TypeScript</li><li>Raspberry Pi</li><li>VLC playback</li>
    </ul>
  </div>
  <aside class="status-card" aria-labelledby="build-status-title">
    <div class="status-card__topline"><span class="status-pill"><span class="status-dot" aria-hidden="true"></span>{{ site.status_label }}</span><span class="status-card__meta">Local first</span></div>
    <div class="house-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
    <p class="status-card__kicker">Current foundation</p>
    <h2 id="build-status-title">Operate from the dashboard.<br>Recover at the screen.</h2>
    <dl class="status-list">
      <div><dt>Appliance playback</dt><dd>VLC</dd></div>
      <div><dt>Playlist delivery</dt><dd>Manual publish</dd></div>
      <div><dt>Offline cache</dt><dd>Required</dd></div>
    </dl>
  </aside>
</section>

<section class="section" aria-labelledby="principles-title">
  <div class="section-heading">
    <p class="eyebrow">Operations before ornament</p>
    <h2 id="principles-title">The screen is the contract.</h2>
    <p>Beam is built around one practical promise: local playback survives ordinary failures, while the operator can see exactly what is playing, what changed, and what needs attention.</p>
  </div>
  <div class="principle-grid">
    <article class="principle-card"><span class="card-number">01</span><h3>Playback comes first</h3><p>Each Pi reads a local playlist and cached media, launches fullscreen, and recovers without waiting for the dashboard or network.</p></article>
    <article class="principle-card"><span class="card-number">02</span><h3>Publishing stays intentional</h3><p>Uploads and playlist edits save first. A deliberate publish action sends the approved state to the selected screen.</p></article>
    <article class="principle-card"><span class="card-number">03</span><h3>Status stays honest</h3><p>Heartbeat, current-video, playlist sync, temperature, throttle, uptime, and service evidence distinguish healthy, stale, and unavailable states.</p></article>
  </div>
</section>

<section class="section section--split" id="publish-flow" aria-labelledby="console-title">
  <article class="resident-card">
    <div class="resident-card__header"><div class="resident-icon" aria-hidden="true"><span></span><span></span><span></span></div><div><p class="eyebrow">Operations console</p><h2 id="console-title">Five views for the work that matters</h2></div></div>
    <p class="resident-card__summary">What’s Playing, Library, Playlists, Screens, and Scheduling keep routine operations visible without turning the pilot into an enterprise control plane.</p>
    <div class="boundary-note"><strong>One source of operational truth</strong><span>Media · Playlists · Screens · Schedules · Evidence</span></div>
    <ul class="capability-list">
      <li><span aria-hidden="true">✓</span> Reusable media and explicit playlist assignment</li>
      <li><span aria-hidden="true">✓</span> Screen inventory, diagnostics, and recovery controls</li>
      <li><span aria-hidden="true">✓</span> Current-video evidence and live screen view</li>
      <li><span aria-hidden="true">✓</span> Simple business-hours scheduling</li>
    </ul>
  </article>
  <div class="run-flow" aria-labelledby="flow-title">
    <p class="eyebrow">The controlled publish path</p><h2 id="flow-title">Save locally. Publish deliberately.</h2>
    <ol>
      <li><span>01</span><div><strong>Add media</strong><p>Upload and prepare a playback-safe asset.</p></div></li>
      <li><span>02</span><div><strong>Choose a playlist</strong><p>Assignment is always explicit.</p></div></li>
      <li><span>03</span><div><strong>Arrange playback</strong><p>Save order and settings locally.</p></div></li>
      <li><span>04</span><div><strong>Select a screen</strong><p>Confirm the intended destination.</p></div></li>
      <li><span>05</span><div><strong>Publish</strong><p>Send playlist and required media.</p></div></li>
      <li><span>06</span><div><strong>Verify</strong><p>Read playback and sync evidence back.</p></div></li>
    </ol>
  </div>
</section>

<section class="section foundation" aria-labelledby="foundation-title">
  <div><p class="eyebrow">Built to recover boringly well</p><h2 id="foundation-title">A missing network should not make a blank TV.</h2></div>
  <p>Beam keeps cached media and playlist state on every appliance, standardizes C1–C5 against a Golden Master, and treats service restart, reboot, power loss, and network loss as normal recovery cases. The AWS dev alpha remains opt-in and cannot replace the local playback contract.</p>
</section>
