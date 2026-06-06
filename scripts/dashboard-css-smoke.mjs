#!/usr/bin/env node

const baseUrl = process.argv[2] ?? "http://localhost:3000";
const targetUrl = new URL("/", baseUrl);

function fail(message) {
  console.error(`Dashboard CSS smoke failed: ${message}`);
  process.exit(1);
}

async function fetchText(url) {
  const response = await fetch(url);
  const text = await response.text();
  return { response, text };
}

const { response: pageResponse, text: html } = await fetchText(targetUrl);
if (!pageResponse.ok) {
  fail(`${targetUrl.href} returned ${pageResponse.status}.`);
}

const stylesheetHrefs = Array.from(html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/gi))
  .map((match) => match[1])
  .filter(Boolean);

if (stylesheetHrefs.length === 0) {
  fail("dashboard HTML did not include a stylesheet link.");
}

for (const href of stylesheetHrefs) {
  const stylesheetUrl = new URL(href, targetUrl);
  const { response, text } = await fetchText(stylesheetUrl);

  if (!response.ok) {
    fail(`${stylesheetUrl.pathname} returned ${response.status}.`);
  }

  if (text.length < 10_000 || !text.includes(".min-h-screen")) {
    fail(`${stylesheetUrl.pathname} did not look like the compiled dashboard stylesheet.`);
  }
}

console.log(`Dashboard CSS smoke passed for ${targetUrl.origin}. Checked ${stylesheetHrefs.length} stylesheet${stylesheetHrefs.length === 1 ? "" : "s"}.`);
