#!/usr/bin/env node
/**
 * netwatch — ISP drop logger for video-call upload/connectivity issues.
 * Stdlib-only Node.js CLI (no npm install).
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const execFileAsync = promisify(execFile);

const EXTERNAL_PING_TARGETS = ["1.1.1.1", "8.8.8.8", "9.9.9.9"];
const DNS_HOSTS = ["www.google.com", "www.cloudflare.com", "dns.google"];
const UPLOAD_URL = "https://speed.cloudflare.com/__up";
const CHUNK_SIZE = 256 * 1024;
const LATENCY_SPIKE_MS = 300;
const UPLOAD_STALL_FRACTION = 0.15; // below 15% of target Mbps counts as stall
const UPLOAD_WARMUP_SEC = 15; // ignore upload stalls until steady-state upload begins

const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

const GRAPH_HEIGHT = 4; // rows per chart
const AXIS_WIDTH = 10; // columns reserved on the left for axis labels
const UPLOAD_SMOOTH_SEC = 5; // upload is shown as a rolling average over this many seconds
const BLOCKS = "▁▂▃▄▅▆▇█";

class RingBuffer {
  constructor(capacity) {
    this.capacity = Math.max(10, capacity);
    this.items = [];
  }

  push(item) {
    if (this.items.length >= this.capacity) this.items.shift();
    this.items.push(item);
  }

  resize(capacity) {
    this.capacity = Math.max(10, capacity);
    while (this.items.length > this.capacity) this.items.shift();
  }
}

function graphWidth() {
  const cols = process.stdout.columns || 100;
  return Math.min(120, Math.max(30, cols - AXIS_WIDTH - 2));
}

function scaleValue(value, min, max) {
  if (value == null || Number.isNaN(value)) return 0;
  if (max <= min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/**
 * Vertical bar chart, one column per second. Returns `height` strings, top row first.
 * A column that is `outage` is drawn as a full-height red bar.
 */
function renderBarChart(samples, { height, min, max, valueFn, colorFn, outageFn }) {
  const rows = Array.from({ length: height }, () => "");
  for (const s of samples) {
    const outage = outageFn(s);
    const v = valueFn(s) ?? 0;
    const fill = outage ? height : scaleValue(v, min, max) * height;
    // Red only for seconds that belong to a confirmed drop; a 1-2 second glitch is magenta.
    const color = outage ? `${s.confirmed ? COLORS.red : COLORS.magenta}${COLORS.bold}` : colorFn(s);
    for (let row = 0; row < height; row++) {
      const fromBottom = height - 1 - row;
      const remaining = fill - fromBottom;
      let ch = " ";
      if (remaining >= 1) {
        ch = "█";
      } else if (remaining > 0 || (fromBottom === 0 && v > 0)) {
        ch = BLOCKS[Math.max(0, Math.min(7, Math.round(remaining * 8) - 1))];
      }
      rows[row] += ch === " " ? " " : `${color}${ch}${COLORS.reset}`;
    }
  }
  return rows;
}

/** Left-pad bars so the newest second is always at the right edge, and add the axis. */
function withAxis(rows, width, count, labels) {
  const pad = " ".repeat(Math.max(0, width - count));
  return rows.map((row, i) => {
    const label = (labels[i] ?? "").padStart(AXIS_WIDTH - 1);
    return `${COLORS.dim}${label}│${COLORS.reset}${pad}${row}`;
  });
}

function timeAxis(width, count) {
  const chars = Array(width).fill("─");
  const put = (text, start) => {
    for (let i = 0; i < text.length; i++) {
      if (start + i >= 0 && start + i < width) chars[start + i] = text[i];
    }
  };
  const right = " now ";
  const left = ` ${count}s ago `;
  put(right, width - right.length);
  if (count > left.length + right.length + 2) put(left, width - count);
  return `${COLORS.dim}${" ".repeat(AXIS_WIDTH - 1)}└${chars.join("")}${COLORS.reset}`;
}

function renderStatusStrip(samples, width) {
  let out = " ".repeat(AXIS_WIDTH) + " ".repeat(Math.max(0, width - samples.length));
  for (const s of samples) {
    if (s.badSecond) out += `${s.confirmed ? COLORS.red : COLORS.magenta}█${COLORS.reset}`;
    else if (s.highLatency) out += `${COLORS.yellow}▓${COLORS.reset}`;
    else out += `${COLORS.green}▓${COLORS.reset}`;
  }
  return out;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visibleLength = (s) => s.replace(ANSI_RE, "").length;

/** Word-wrap a line that may contain color codes; continuation lines keep the color. */
function wrapLine(line, cols) {
  if (visibleLength(line) <= cols) return [line];
  const INDENT = "    ";
  const out = [];
  let cur = "";
  let curLen = 0;
  let active = "";
  for (const token of line.split(/( +)/)) {
    const len = visibleLength(token);
    if (curLen + len > cols && curLen > INDENT.length && token.trim() !== "") {
      out.push(cur + (active ? COLORS.reset : ""));
      cur = INDENT + active;
      curLen = INDENT.length;
    }
    if (curLen === INDENT.length && out.length > 0 && token.trim() === "") continue;
    cur += token;
    curLen += len;
    for (const code of token.match(ANSI_RE) ?? []) {
      active = code === COLORS.reset ? "" : active + code;
    }
  }
  out.push(cur);
  return out;
}

/** One plain-English sentence on what failed and where the fault most likely is. */
function explainCause({ internetDown, uploadStalled, gatewayOk, gatewayTrusted }) {
  const what = [];
  if (internetDown) what.push("the internet is not responding");
  if (uploadStalled) what.push("upload has stalled");
  const problem = what.length ? what.join(" and ") : "connection degraded";
  let where;
  if (!gatewayTrusted) {
    where = "Your router cannot be tested, so inside-vs-outside the home is unknown.";
  } else if (gatewayOk) {
    where = "Your router IS responding, which points to a problem OUTSIDE your home (ISP line/equipment).";
  } else {
    where = "Your router is NOT responding, which points to a problem INSIDE your home (Wi-Fi or cable to the router).";
  }
  return `${problem[0].toUpperCase()}${problem.slice(1)}. ${where}`;
}

class LiveDashboard {
  constructor({ logDir, gateway, gatewayLabel, gatewayTrusted, targetMbps, noUpload, minOutageSec }) {
    this.logDir = logDir;
    this.gateway = gateway;
    this.gatewayLabel = gatewayLabel;
    this.gatewayTrusted = gatewayTrusted;
    this.targetMbps = targetMbps;
    this.noUpload = noUpload;
    this.minOutageSec = minOutageSec;
    this.width = graphWidth();
    this.history = new RingBuffer(this.width);
    this.events = [];
    this.totalSeconds = 0;
    // Clear the screen once, hide the cursor; every frame then redraws from the top-left.
    process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");
    process.stdout.on("resize", () => {
      this.width = graphWidth();
      this.history.resize(this.width);
      process.stdout.write("\x1b[2J");
    });
  }

  dispose() {
    process.stdout.write("\x1b[?25h\n");
  }

  pushEvent(message, tone = "info") {
    const ts = new Date().toLocaleTimeString();
    const color =
      tone === "bad" ? COLORS.red : tone === "good" ? COLORS.green : COLORS.yellow;
    this.events.unshift(`  ${COLORS.dim}${ts}${COLORS.reset}  ${color}${message}${COLORS.reset}`);
    if (this.events.length > 4) this.events.length = 4;
  }

  update(sample, { drops, downSec, badStreak, inDrop, sinceLastDrop, runTime, gatewayFormatMs }) {
    this.totalSeconds += 1;
    this.history.push(sample);
    const items = this.history.items;
    const R = COLORS.reset;
    const B = COLORS.bold;
    const D = COLORS.dim;

    // Upload arrives in lumpy chunks, so show a short rolling average instead of raw per-second values.
    const recent = items.slice(-UPLOAD_SMOOTH_SEC);
    sample.uploadSmooth = recent.reduce((a, s) => a + s.uploadMbps, 0) / recent.length;

    const internetUp = sample.externalOk.some(Boolean);
    const repliesOk = sample.externalOk.filter(Boolean).length;
    const uploadWarming = !this.noUpload && this.totalSeconds < UPLOAD_WARMUP_SEC;

    // --- Status banner -----------------------------------------------------------------
    const cause = explainCause({
      internetDown: !internetUp,
      uploadStalled: sample.failed.includes("upload"),
      gatewayOk: sample.gatewayOk,
      gatewayTrusted: this.gatewayTrusted,
    });
    let banner;
    let bannerDetail;
    if (inDrop) {
      banner = `${COLORS.red}${B} ✖ DROP IN PROGRESS — ${badStreak}s so far${R}`;
      bannerDetail = `   ${COLORS.red}${cause}${R}`;
    } else if (badStreak > 0) {
      banner = `${COLORS.yellow}${B} ⚠ Trouble detected (${badStreak}s) — counts as a drop if it lasts ${this.minOutageSec}s${R}`;
      bannerDetail = `   ${COLORS.yellow}${cause}${R}`;
    } else {
      banner = `${COLORS.green}${B} ✔ Connection OK${R}`;
      bannerDetail = "";
    }

    // --- "Right now" readings ----------------------------------------------------------
    const router = !this.gateway
      ? `${D}not found${R}`
      : !this.gatewayTrusted
        ? `${D}cannot be tested${R}`
        : sample.gatewayOk
          ? `${COLORS.green}reachable${R} (${gatewayFormatMs(sample)})`
          : `${COLORS.red}NOT REACHABLE${R}`;
    const internet = internetUp
      ? `${COLORS.green}reachable${R}, ${sample.avgExternalMs?.toFixed(0) ?? "?"} ms round trip`
      : `${COLORS.red}NOT REACHABLE${R}`;
    const upload = this.noUpload
      ? `${D}not being tested (--no-upload)${R}`
      : uploadWarming
        ? `${D}warming up… measured from second ${UPLOAD_WARMUP_SEC}${R}`
        : `${sample.uploadSmooth.toFixed(1)} Mbps ${D}(5-second average; goal ${this.targetMbps} Mbps)${R}`;

    // --- Charts ------------------------------------------------------------------------
    const latRows = withAxis(
      renderBarChart(items, {
        height: GRAPH_HEIGHT,
        min: 0,
        max: LATENCY_SPIKE_MS,
        valueFn: (s) => s.avgExternalMs,
        colorFn: (s) => (s.highLatency ? COLORS.yellow : COLORS.blue),
        outageFn: (s) => !s.externalOk.some(Boolean),
      }),
      this.width,
      items.length,
      { 0: `${LATENCY_SPIKE_MS}+ ms`, [GRAPH_HEIGHT - 1]: "0 ms" }
    );

    const maxUp = this.targetMbps * 2;
    const upRows = this.noUpload
      ? withAxis(
          Array.from({ length: GRAPH_HEIGHT }, (_, i) => (i === 1 ? `${D}  upload test is switched off${R}` : "")),
          this.width,
          items.length,
          {}
        )
      : withAxis(
          renderBarChart(items, {
            height: GRAPH_HEIGHT,
            min: 0,
            max: maxUp,
            valueFn: (s) => s.uploadSmooth ?? s.uploadMbps,
            colorFn: () => COLORS.green,
            outageFn: (s) => s.failed.includes("upload"),
          }),
          this.width,
          items.length,
          {
            0: `${maxUp.toFixed(0)} Mbps`,
            [GRAPH_HEIGHT / 2]: `${this.targetMbps} Mbps`,
            [GRAPH_HEIGHT - 1]: "0 Mbps",
          }
        );

    const lines = [
      `${COLORS.cyan}${B}NETWATCH${R}  watching your internet connection once per second   ${D}running for ${runTime}${R}`,
      `${D}Saving to ${this.logDir} — Ctrl+C stops and writes report.html${R}`,
      "",
      banner,
      bannerDetail,
      "",
      `${B}RIGHT NOW${R}`,
      `  Your router   ${router}   ${D}(the box in your home; tested via ${this.gatewayLabel})${R}`,
      `  Internet      ${internet}   ${D}(${repliesOk} of ${sample.externalOk.length} test servers replying)${R}`,
      `  Upload        ${upload}`,
      `  Drops so far  ${B}${drops}${R}   ${D}(${formatDurationMs(downSec * 1000)} offline in total; time since last drop: ${sinceLastDrop})${R}`,
      "",
      `${B}EVENT LOG${R} ${D}(newest first). A "drop" = internet unreachable, or upload below ${(this.targetMbps * UPLOAD_STALL_FRACTION).toFixed(1)} Mbps, for ${this.minOutageSec}+ seconds in a row.${R}`,
      ...(this.events.length ? this.events : [`  ${D}no drops recorded yet${R}`]),
      "",
      `${B}INTERNET RESPONSE TIME${R}  ${D}— how long a test message takes to reach the internet and come back. Shorter bar = faster = better.${R}`,
      `${D}Yellow = over ${LATENCY_SPIKE_MS} ms (video will stutter). Full-height bar = no reply: magenta if brief (under ${this.minOutageSec}s), red if part of a drop.${R}`,
      ...latRows,
      timeAxis(this.width, items.length),
      "",
      `${B}UPLOAD SPEED${R}  ${D}— data you send out per second; this is what others receive of your video. Aim: about ${this.targetMbps} Mbps.${R}`,
      `${D}Full-height bar = nothing getting out that second: magenta if brief (under ${this.minOutageSec}s), red if part of a drop.${R}`,
      ...upRows,
      timeAxis(this.width, items.length),
      "",
      `${B}CONNECTION STATUS${R}  ${D}one block per second:${R} ${COLORS.green}▓${R} working   ${COLORS.yellow}▓${R} very slow   ${COLORS.magenta}█${R} brief glitch (under ${this.minOutageSec}s, not a drop)   ${COLORS.red}█${R} DROP`,
      renderStatusStrip(items, this.width),
    ];

    const cols = (process.stdout.columns || 100) - 1;
    let frame = lines.flatMap((l) => wrapLine(l, cols));
    const maxRows = process.stdout.rows ? process.stdout.rows - 1 : Infinity;
    if (frame.length > maxRows) {
      frame = frame.slice(0, maxRows);
      frame[maxRows - 1] = `${COLORS.yellow}▼ Window too short to show everything below — make it taller or maximize it.${R}`;
    }
    process.stdout.write("\x1b[H" + frame.map((l) => "\x1b[2K" + l).join("\n") + "\x1b[J");
  }
}

function parseDuration(str) {
  if (!str) return null;
  const m = /^(\d+(?:\.\d+)?)(s|m|h)$/i.exec(str.trim());
  if (!m) throw new Error(`Invalid duration: ${str} (use e.g. 30m, 3h, 90s)`);
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "s") return n * 1000;
  if (unit === "m") return n * 60 * 1000;
  return n * 60 * 60 * 1000;
}

function formatDurationMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function timestampDirName(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function isoLocal(d) {
  return d.toISOString();
}

async function discoverGateway() {
  try {
    const { stdout } = await execFileAsync("route", ["-n", "get", "default"]);
    const match = stdout.match(/gateway:\s*(\S+)/i);
    if (match) return match[1];
  } catch {
    /* fall through */
  }
  return null;
}

async function pingOnce(host) {
  try {
    const { stdout } = await execFileAsync("ping", ["-c", "1", "-W", "1000", host], {
      timeout: 5000,
    });
    const timeMatch = stdout.match(/time[=<]([\d.]+)\s*ms/i);
    if (timeMatch) return { ok: true, ms: parseFloat(timeMatch[1]) };
    return { ok: true, ms: null };
  } catch (err) {
    const out = err.stdout?.toString() ?? "";
    const timeMatch = out.match(/time[=<]([\d.]+)\s*ms/i);
    if (timeMatch) return { ok: true, ms: parseFloat(timeMatch[1]) };
    return { ok: false, ms: null };
  }
}

// DNS error codes that mean "the router answered us" (even if the answer was "no such name").
const DNS_REPLY_CODES = new Set([
  "ENODATA",
  "EFORMERR",
  "ESERVFAIL",
  "ENOTFOUND",
  "ENOTIMP",
  "EREFUSED",
  "EBADQUERY",
  "EBADNAME",
]);

/**
 * Ask the router itself a DNS question. "localhost" is answered by the router's
 * own memory, so a reply proves the router is alive without needing the ISP.
 */
async function routerDnsOnce(gateway) {
  const resolver = new dns.Resolver({ timeout: 1000, tries: 1 });
  resolver.setServers([gateway]);
  const start = Date.now();
  try {
    await resolver.resolve4("localhost");
    return { ok: true, ms: Date.now() - start };
  } catch (err) {
    if (DNS_REPLY_CODES.has(err.code)) return { ok: true, ms: Date.now() - start };
    return { ok: false, ms: null };
  }
}

/**
 * Pick a way to test the router. Many routers ignore ping, so fall back to
 * asking the router a DNS question. (ARP-cache checks are not used: a cached
 * entry can look fine even when the router is gone.)
 */
async function createGatewayProbe(gateway) {
  const formatMs = (sample) => (sample.gatewayMs != null ? `${sample.gatewayMs.toFixed(0)} ms` : "ok");
  if ((await pingOnce(gateway)).ok) {
    return { label: "ping", probe: () => pingOnce(gateway), formatMs };
  }
  if ((await routerDnsOnce(gateway)).ok) {
    return { label: "DNS question to router", probe: () => routerDnsOnce(gateway), formatMs };
  }
  return {
    label: "router does not answer ping or DNS",
    probe: async () => ({ ok: false, ms: null }),
    formatMs,
  };
}

let dnsHostIndex = 0;
async function dnsLookupOnce() {
  const host = DNS_HOSTS[dnsHostIndex % DNS_HOSTS.length];
  dnsHostIndex += 1;
  const start = Date.now();
  try {
    await Promise.race([
      dns.lookup(host),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500)),
    ]);
    return { ok: true, ms: Date.now() - start, host };
  } catch {
    return { ok: false, ms: null, host };
  }
}

/** Shared upload byte counter for the current wall-clock second */
class UploadProbe {
  constructor(targetMbps) {
    this.targetMbps = targetMbps;
    this.bytesThisSecond = 0;
    this.running = false;
    this._abort = null;
    this._loopPromise = null;
  }

  resetSecondCounter() {
    this.bytesThisSecond = 0;
  }

  getMbpsForSecond() {
    return (this.bytesThisSecond * 8) / 1_000_000;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._loopPromise = this._runLoop();
  }

  async stop() {
    this.running = false;
    if (this._abort) this._abort.abort();
    if (this._loopPromise) await this._loopPromise.catch(() => {});
  }

  async _runLoop() {
    const bytesPerSecond = (this.targetMbps * 1_000_000) / 8;
    // Time between the START of one chunk and the start of the next, so the
    // average rate matches the target no matter how long each request takes.
    const intervalMs = (CHUNK_SIZE / bytesPerSecond) * 1000;

    while (this.running) {
      const chunk = Buffer.alloc(CHUNK_SIZE, 0xab);
      const started = Date.now();
      const abort = new AbortController();
      this._abort = abort;
      const timeout = setTimeout(() => abort.abort(), 10000);
      try {
        const res = await fetch(UPLOAD_URL, {
          method: "POST",
          body: chunk,
          signal: abort.signal,
        });
        if (res.ok || res.status < 500) {
          this.bytesThisSecond += CHUNK_SIZE;
        }
      } catch {
        /* stall — no bytes counted */
      } finally {
        clearTimeout(timeout);
      }
      const wait = intervalMs - (Date.now() - started);
      if (this.running && wait > 0) {
        await sleep(wait);
      }
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function csvEscape(val) {
  const s = String(val ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function startCaffeinate() {
  try {
    const child = spawn("caffeinate", ["-i", "-w", String(process.pid)], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    console.warn(`${COLORS.yellow}Warning: could not start caffeinate (display may sleep)${COLORS.reset}`);
  }
}

/**
 * Summarise a run of bad seconds. A check only counts as "failed" for the drop if it
 * failed in at least half of those seconds, so one stray zero-byte upload second
 * during an internet outage isn't reported as an upload stall.
 */
function summarizeStreak(streak) {
  const counts = {};
  let gatewayOkSeconds = 0;
  for (const s of streak) {
    for (const f of s.failed) counts[f] = (counts[f] ?? 0) + 1;
    if (s.gatewayOk) gatewayOkSeconds += 1;
  }
  const major = Object.keys(counts).filter((k) => counts[k] / streak.length >= 0.5);
  return {
    failedProbes: major.length ? major : Object.keys(counts),
    gatewayOkDuring: streak.length > 0 && gatewayOkSeconds / streak.length >= 0.5,
  };
}

/** Plain-English cause for an event, from the list of failed checks. */
function describeFailure(failedProbes, gatewayOk, gatewayTrusted) {
  return explainCause({
    internetDown: failedProbes.includes("external_ping"),
    uploadStalled: failedProbes.includes("upload"),
    gatewayOk,
    gatewayTrusted,
  });
}

function classifyOutage(gatewayOkDuring, gatewayProbeWorks) {
  if (!gatewayProbeWorks) return "Unknown (gateway not probeable)";
  return gatewayOkDuring ? "ISP/upstream" : "Local network";
}

function buildSampleRow(sample) {
  return [
    sample.ts,
    sample.gatewayMs ?? "",
    sample.gatewayOk ? 1 : 0,
    ...EXTERNAL_PING_TARGETS.flatMap((t, i) => [
      sample.externalMs[i] ?? "",
      sample.externalOk[i] ? 1 : 0,
    ]),
    sample.dnsOk ? 1 : 0,
    sample.dnsMs ?? "",
    sample.uploadMbps.toFixed(3),
    sample.externalLossPct.toFixed(1),
    sample.avgExternalMs ?? "",
  ].map(csvEscape).join(",");
}

const SAMPLE_HEADER =
  "timestamp,gateway_ms,gateway_ok," +
  EXTERNAL_PING_TARGETS.map((t) => `${t}_ms,${t}_ok`).join(",") +
  ",dns_ok,dns_ms,upload_mbps,external_loss_pct,avg_external_ms";

const EVENT_HEADER =
  "timestamp_start,timestamp_end,duration_sec,type,classification,failed_probes,gateway_ok_during";

function writeEventRow(ev) {
  return [
    ev.start,
    ev.end,
    ev.durationSec.toFixed(1),
    ev.type,
    ev.classification ?? "",
    ev.failedProbes.join(";"),
    ev.gatewayOkDuring ? 1 : 0,
  ].map(csvEscape).join(",");
}

function generateReport(logDir, samples, events, meta) {
  const reportPath = path.join(logDir, "report.html");
  const width = 900;
  const height = 250;
  const margin = { top: 20, right: 20, bottom: 40, left: 50 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const outages = events.filter((e) => e.type === "outage");
  const spikes = events.filter((e) => e.type === "latency_spike");
  const ispCount = outages.filter((o) => o.classification === "ISP/upstream").length;
  const localCount = outages.filter((o) => o.classification === "Local network").length;
  const totalDownMs = outages.reduce((s, o) => s + o.durationSec * 1000, 0);

  let mtbd = "—";
  if (outages.length >= 2) {
    const gaps = [];
    for (let i = 1; i < outages.length; i++) {
      gaps.push(new Date(outages[i].start) - new Date(outages[i - 1].end));
    }
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    mtbd = formatDurationMs(avg);
  } else if (outages.length === 1 && meta.runStart) {
    const first = new Date(outages[0].start) - new Date(meta.runStart);
    mtbd = `More than ${formatDurationMs(first)} (only one drop so far)`;
  }

  const n = samples.length;
  const xAt = (i) => margin.left + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const indexAtTs = (ts) => {
    const i = samples.findIndex((s) => s.ts >= ts);
    return i >= 0 ? i : Math.max(0, n - 1);
  };
  // Short runs need seconds on the time axis, otherwise every label reads the same.
  const spanMs = n > 1 ? new Date(samples[n - 1].ts) - new Date(samples[0].ts) : 0;
  const clock = (iso) =>
    new Date(iso).toLocaleTimeString(
      [],
      spanMs < 30 * 60 * 1000
        ? { hour: "numeric", minute: "2-digit", second: "2-digit" }
        : { hour: "numeric", minute: "2-digit" }
    );
  const dateTime = (iso) =>
    new Date(iso).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });

  // Upload arrives in lumpy chunks; chart a 5-second rolling average.
  const upAvg = samples.map((_, i) => {
    const win = samples.slice(Math.max(0, i - UPLOAD_SMOOTH_SEC + 1), i + 1);
    return win.reduce((a, s) => a + s.uploadMbps, 0) / win.length;
  });

  const outageRects = outages
    .map((o) => {
      const x = xAt(indexAtTs(o.start));
      const w = Math.max(3, xAt(indexAtTs(o.end)) - x);
      return `<rect x="${x.toFixed(1)}" y="${margin.top}" width="${w.toFixed(1)}" height="${plotH}" fill="rgba(220,50,50,0.30)" />`;
    })
    .join("\n");

  /** A labelled line chart (own axis, own units) with outages shaded red. */
  const buildChart = ({ values, maxVal, unit, ticks, color }) => {
    const y = (v) => margin.top + plotH - (Math.min(Math.max(v, 0), maxVal) / maxVal) * plotH;
    // Split the line wherever there is no reading (e.g. the internet was down), so it
    // never draws a misleading line across a gap.
    const segments = [];
    let run = [];
    values.forEach((v, i) => {
      if (v == null) {
        if (run.length) segments.push(run);
        run = [];
      } else {
        run.push([xAt(i), y(v)]);
      }
    });
    if (run.length) segments.push(run);
    const lineMarkup = segments
      .map((seg) =>
        seg.length === 1
          ? `<circle cx="${seg[0][0].toFixed(1)}" cy="${seg[0][1].toFixed(1)}" r="1.5" fill="${color}" />`
          : `<polyline fill="none" stroke="${color}" stroke-width="1.5" points="${seg.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ")}" />`
      )
      .join("\n");
    const grid = ticks
      .map(
        (t) =>
          `<line x1="${margin.left}" x2="${width - margin.right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="#e5e5e5" />` +
          `<text x="${margin.left - 6}" y="${(y(t) + 4).toFixed(1)}" font-size="11" text-anchor="end" fill="#555">${t} ${unit}</text>`
      )
      .join("\n");
    const xTicks =
      n < 2
        ? ""
        : [0, 1, 2, 3, 4, 5]
            .map((k) => {
              const i = Math.round((k * (n - 1)) / 5);
              return `<text x="${xAt(i).toFixed(1)}" y="${height - 10}" font-size="11" text-anchor="middle" fill="#555">${clock(samples[i].ts)}</text>`;
            })
            .join("\n");
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${grid}
  ${outageRects}
  ${lineMarkup}
  <line x1="${margin.left}" y1="${margin.top + plotH}" x2="${width - margin.right}" y2="${margin.top + plotH}" stroke="#999" />
  ${xTicks}
</svg>`;
  };

  const latencyChart = buildChart({
    values: samples.map((s) => s.avgExternalMs),
    maxVal: 300,
    unit: "ms",
    ticks: [0, 100, 200, 300],
    color: "#2563eb",
  });
  const targetMbps = meta.targetMbps ?? 3;
  const uploadChart = meta.noUpload
    ? "<p><em>The upload test was switched off for this run.</em></p>"
    : buildChart({
        values: upAvg,
        maxVal: targetMbps * 2,
        unit: "Mbps",
        ticks: [0, targetMbps, targetMbps * 2],
        color: "#16a34a",
      });

  const WHERE = {
    "ISP/upstream":
      "Outside the home. The router kept responding, so the fault is likely the ISP's line or equipment.",
    "Local network":
      "Inside the home. The router stopped responding (Wi-Fi or the cable to the router).",
  };
  const FAILED_WORDS = {
    external_ping: "Internet not responding",
    upload: "Upload stalled",
    high_latency_or_loss: "Internet very slow (over 300 ms) or losing messages",
  };
  const eventRows = events
    .map((e) => {
      const what = e.failedProbes.map((f) => FAILED_WORDS[f] ?? f).join(" + ") || "—";
      const where =
        e.type === "outage"
          ? (WHERE[e.classification] ?? "Could not tell: the router cannot be tested.")
          : "—";
      const kind = e.type === "outage" ? "<strong>DROP</strong>" : "Slow period";
      return `<tr><td>${dateTime(e.start)}</td><td>${e.durationSec.toFixed(0)} s</td><td>${kind}</td><td>${what}</td><td>${where}</td></tr>`;
    })
    .join("\n");

  const longest = outages.reduce((m, o) => Math.max(m, o.durationSec), 0);
  const firstTs = n ? samples[0].ts : null;
  const lastTs = n ? samples[n - 1].ts : null;
  const verdict = outages.length
    ? `<p class="verdict bad"><strong>${outages.length} connection drop${outages.length === 1 ? "" : "s"} detected</strong> during ${formatDurationMs(meta.runLengthMs)} of monitoring: ${formatDurationMs(totalDownMs)} offline in total, longest ${formatDurationMs(longest * 1000)}. ` +
      `Likely cause: ISP side for ${ispCount} of them, inside the home for ${localCount}.</p>`
    : `<p class="verdict ok"><strong>No connection drops detected</strong> during ${formatDurationMs(meta.runLengthMs)} of monitoring.</p>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Internet connection report</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; line-height: 1.45; }
  h1 { font-size: 1.6rem; margin-bottom: 0.2rem; }
  h2 { margin-top: 2rem; }
  .sub { color: #555; margin-top: 0; }
  .verdict { padding: 0.9rem 1rem; border-radius: 8px; font-size: 1.05rem; }
  .verdict.bad { background: #fde8e8; border: 1px solid #f5b5b5; }
  .verdict.ok { background: #e6f6ea; border: 1px solid #b5e0c0; }
  .summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
  .card { background: #f4f4f5; padding: 1rem; border-radius: 8px; }
  .card strong { display: block; font-size: 1.35rem; }
  .card small { color: #666; display: block; margin-top: 0.2rem; }
  .how { background: #f7f7fa; border: 1px solid #e2e2ea; border-radius: 8px; padding: 0.2rem 1rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  th { background: #eee; }
  .legend { font-size: 0.9rem; color: #444; margin: 0.3rem 0 0.4rem; }
  svg { max-width: 100%; height: auto; border: 1px solid #ddd; border-radius: 8px; }
  .swatch { display: inline-block; width: 1.1em; height: 0.8em; background: rgba(220,50,50,0.30); border: 1px solid #d99; vertical-align: middle; }
</style>
</head>
<body>
<h1>Internet connection report</h1>
<p class="sub">${firstTs ? `Monitored from ${dateTime(firstTs)} to ${dateTime(lastTs)}` : "No data yet"}, one check per second. Report created ${dateTime(new Date().toISOString())}.</p>
${verdict}

<div class="how">
<h3>How to read this report</h3>
<ul>
  <li>Every second this tool checks: (1) the <strong>router</strong> in the home, (2) the <strong>internet</strong> by messaging three public servers (1.1.1.1, 8.8.8.8, 9.9.9.9), and (3) <strong>upload</strong> by sending a steady ${meta.noUpload ? "" : `${targetMbps} Mbps `}stream of data, similar to a video call.</li>
  <li>A <strong>DROP</strong> is logged when the internet stops responding, or upload nearly stops, for ${meta.minOutageSec ?? "several"} or more seconds in a row. Video calls freeze during drops like these.</li>
  <li>If the router still responds during a drop, the fault is <strong>outside the home</strong> (the ISP's line or equipment). If the router stops responding too, the fault is <strong>inside the home</strong> (Wi-Fi or the cable to the router).</li>
  <li>Router checked: <code>${meta.gateway ?? "unknown"}</code>. Red shading on the charts below marks each drop.</li>
</ul>
</div>

<div class="summary">
  <div class="card"><span>Monitoring time</span><strong>${formatDurationMs(meta.runLengthMs)}</strong></div>
  <div class="card"><span>Connection drops</span><strong>${outages.length}</strong><small>failures lasting ${meta.minOutageSec ?? "several"}+ seconds</small></div>
  <div class="card"><span>Total time offline</span><strong>${formatDurationMs(totalDownMs)}</strong></div>
  <div class="card"><span>Average time between drops</span><strong>${mtbd}</strong></div>
  <div class="card"><span>Drops pointing to the ISP</span><strong>${ispCount}</strong><small>router was fine, internet was not</small></div>
  <div class="card"><span>Drops pointing to inside the home</span><strong>${localCount}</strong><small>router stopped responding too</small></div>
  <div class="card"><span>Slow periods</span><strong>${spikes.length}</strong><small>3+ seconds over 300 ms or losing messages</small></div>
</div>

<h2>Internet response time</h2>
<p class="legend">How long a test message takes to reach the internet and come back. Lower is better; over 100 ms starts to hurt video calls. <span class="swatch"></span> = a drop.</p>
${latencyChart}

<h2>Upload speed</h2>
<p class="legend">How much data is being sent out per second (5-second average). The test aims for about ${targetMbps} Mbps. When this falls to near zero, other people stop receiving your video and audio. <span class="swatch"></span> = a drop.</p>
${uploadChart}

<h2>Every drop and slow period</h2>
<table>
<thead><tr><th>Started</th><th>Lasted</th><th>Kind</th><th>What happened</th><th>Where the problem likely is</th></tr></thead>
<tbody>${eventRows || "<tr><td colspan='5'>Nothing recorded: no drops or slow periods.</td></tr>"}</tbody>
</table>
</body>
</html>`;

  fs.writeFileSync(reportPath, html, "utf8");
  return reportPath;
}

function loadSamplesFromCsv(logDir) {
  const p = path.join(logDir, "samples.csv");
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").trim().split("\n");
  if (lines.length < 2) return [];
  const samples = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    const externalOk = [];
    const externalMs = [];
    let idx = 3;
    for (let t = 0; t < EXTERNAL_PING_TARGETS.length; t++) {
      externalMs.push(parts[idx] ? parseFloat(parts[idx]) : null);
      externalOk.push(parts[idx + 1] === "1");
      idx += 2;
    }
    samples.push({
      ts: parts[0],
      gatewayMs: parts[1] ? parseFloat(parts[1]) : null,
      gatewayOk: parts[2] === "1",
      externalMs,
      externalOk,
      dnsOk: parts[idx] === "1",
      dnsMs: parts[idx + 1] ? parseFloat(parts[idx + 1]) : null,
      uploadMbps: parseFloat(parts[idx + 2]) || 0,
      externalLossPct: parseFloat(parts[idx + 3]) || 0,
      avgExternalMs: parts[idx + 4] ? parseFloat(parts[idx + 4]) : null,
    });
  }
  return samples;
}

function loadEventsFromCsv(logDir) {
  const p = path.join(logDir, "events.csv");
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").trim().split("\n");
  if (lines.length < 2) return [];
  return lines.slice(1).map((line) => {
    const parts = parseCsvLine(line);
    return {
      start: parts[0],
      end: parts[1],
      durationSec: parseFloat(parts[2]),
      type: parts[3],
      classification: parts[4] || null,
      failedProbes: parts[5] ? parts[5].split(";").filter(Boolean) : [],
      gatewayOkDuring: parts[6] === "1",
    };
  });
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

async function runMonitor(options) {
  const {
    durationMs,
    uploadMbps,
    noUpload,
    minOutageSec,
  } = options;

  const gateway = await discoverGateway();
  let gatewayProbe = null;
  let gatewayProbeWorks = false;
  if (!gateway) {
    console.warn(`${COLORS.yellow}Warning: could not detect default gateway; gateway check skipped.${COLORS.reset}`);
  } else {
    gatewayProbe = await createGatewayProbe(gateway);
    const trial = await gatewayProbe.probe();
    gatewayProbeWorks = trial.ok;
  }

  const logDir = path.join(process.cwd(), "logs", timestampDirName());
  fs.mkdirSync(logDir, { recursive: true });

  const samplesPath = path.join(logDir, "samples.csv");
  const eventsPath = path.join(logDir, "events.csv");
  fs.writeFileSync(samplesPath, SAMPLE_HEADER + "\n");
  fs.writeFileSync(eventsPath, EVENT_HEADER + "\n");
  fs.writeFileSync(
    path.join(logDir, "run.json"),
    JSON.stringify({ gateway, targetMbps: uploadMbps, noUpload, minOutageSec }, null, 2)
  );

  startCaffeinate();

  const uploadProbe = noUpload ? null : new UploadProbe(uploadMbps);
  if (uploadProbe) uploadProbe.start();

  const samples = [];
  const events = [];
  const runStart = new Date();
  let outageCount = 0;
  let lastOutageEnd = null;

  let outageState = null; // { start } while a drop of >= minOutageSec is in progress
  let consecutiveBad = 0;
  let spikeState = null;

  const meta = () => ({
    gateway,
    targetMbps: uploadMbps,
    noUpload,
    minOutageSec,
    runStart: isoLocal(runStart),
    runLengthMs: Date.now() - runStart.getTime(),
  });

  const regenerateReport = () => {
    try {
      const p = generateReport(logDir, samples, events, meta());
      return p;
    } catch (e) {
      console.error("Report error:", e.message);
      return null;
    }
  };

  let reportInterval = setInterval(() => regenerateReport(), 60_000);

  const endTime = durationMs ? runStart.getTime() + durationMs : null;

  const plainUi = options.plainUi;
  const gatewayLabel = gatewayProbe?.label ?? "no router found";

  let dashboard = null;
  if (!plainUi) {
    dashboard = new LiveDashboard({
      logDir,
      gateway,
      gatewayLabel,
      gatewayTrusted: gatewayProbeWorks,
      targetMbps: uploadMbps,
      noUpload,
      minOutageSec,
    });
  } else {
    console.log(`${COLORS.cyan}netwatch${COLORS.reset} logging to ${logDir}`);
    if (gateway) console.log(`Gateway: ${gateway} (${gatewayLabel})`);
    console.log(`${COLORS.dim}Press Ctrl+C to stop and save report.${COLORS.reset}\n`);
  }

  let shuttingDown = false;

  const flushOpenOutage = (endTs) => {
    if (!outageState || consecutiveBad < minOutageSec) return;
    const { failedProbes, gatewayOkDuring } = summarizeStreak(samples.slice(-consecutiveBad));
    const ev = {
      start: outageState.start,
      end: endTs,
      durationSec: consecutiveBad,
      type: "outage",
      classification: classifyOutage(gatewayOkDuring, gatewayProbeWorks),
      failedProbes,
      gatewayOkDuring,
    };
    events.push(ev);
    fs.appendFileSync(eventsPath, writeEventRow(ev) + "\n");
  };

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(reportInterval);
    flushOpenOutage(isoLocal(new Date()));
    if (uploadProbe) await uploadProbe.stop();
    if (dashboard) dashboard.dispose();
    const reportPath = regenerateReport();
    console.log(`${COLORS.green}Saved report:${COLORS.reset} ${reportPath}`);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });

  async function collectProbes() {
    const [gatewayResult, externalResults, dnsResult] = await Promise.all([
      gatewayProbe ? gatewayProbe.probe() : { ok: false, ms: null },
      Promise.all(EXTERNAL_PING_TARGETS.map((h) => pingOnce(h))),
      dnsLookupOnce(),
    ]);

    const externalOk = externalResults.map((r) => r.ok);
    const externalMs = externalResults.map((r) => r.ms);
    const okRtts = externalMs.filter((m) => m != null);
    const avgExternalMs = okRtts.length ? okRtts.reduce((a, b) => a + b, 0) / okRtts.length : null;
    const externalLossPct = (externalOk.filter((o) => !o).length / externalOk.length) * 100;

    const uploadMbpsVal = uploadProbe ? uploadProbe.getMbpsForSecond() : 0;
    if (uploadProbe) uploadProbe.resetSecondCounter();

    const uploadStall =
      !noUpload &&
      samples.length >= UPLOAD_WARMUP_SEC &&
      uploadMbpsVal < uploadMbps * UPLOAD_STALL_FRACTION;
    const allExternalDown = externalOk.every((o) => !o);
    const badSecond = allExternalDown || uploadStall;

    const failed = [];
    if (allExternalDown) failed.push("external_ping");
    if (uploadStall) failed.push("upload");

    return {
      ts: isoLocal(new Date()),
      gatewayOk: gatewayResult.ok,
      gatewayMs: gatewayResult.ms,
      externalOk,
      externalMs,
      dnsOk: dnsResult.ok,
      dnsMs: dnsResult.ms,
      uploadMbps: uploadMbpsVal,
      externalLossPct,
      avgExternalMs,
      badSecond,
      failed,
      highLatency:
        avgExternalMs != null && avgExternalMs > LATENCY_SPIKE_MS ||
        externalLossPct >= 66,
    };
  }

  async function onSecond(sample) {
    samples.push(sample);
    fs.appendFileSync(samplesPath, buildSampleRow(sample) + "\n");

    // Outage FSM
    if (sample.badSecond) {
      consecutiveBad += 1;
      if (!outageState && consecutiveBad >= minOutageSec) {
        const startIdx = samples.length - consecutiveBad;
        const startTs = samples[startIdx]?.ts ?? sample.ts;
        outageState = { start: startTs };
        // The whole streak so far is now a confirmed drop, so recolour it red retroactively.
        samples.slice(-consecutiveBad).forEach((s) => (s.confirmed = true));
        outageCount += 1;
        const now = summarizeStreak(samples.slice(-consecutiveBad));
        const msg = `DROP #${outageCount} STARTED. ${describeFailure(now.failedProbes, now.gatewayOkDuring, gatewayProbeWorks)}`;
        if (dashboard) dashboard.pushEvent(msg, "bad");
        else console.log(`\n${COLORS.red}*** ${msg} ***${COLORS.reset} (began ${startTs})`);
      } else if (outageState) {
        sample.confirmed = true; // drop already under way
      }
    } else {
      if (outageState && consecutiveBad >= minOutageSec) {
        // The current (good) sample is already in `samples`; the drop is the seconds before it.
        const { failedProbes, gatewayOkDuring } = summarizeStreak(
          samples.slice(-(consecutiveBad + 1), -1)
        );
        const ev = {
          start: outageState.start,
          end: sample.ts,
          durationSec: consecutiveBad,
          type: "outage",
          classification: classifyOutage(gatewayOkDuring, gatewayProbeWorks),
          failedProbes,
          gatewayOkDuring,
        };
        events.push(ev);
        fs.appendFileSync(eventsPath, writeEventRow(ev) + "\n");
        lastOutageEnd = new Date(sample.ts);
        const endMsg = `DROP #${outageCount} ENDED after ${ev.durationSec}s. ${describeFailure(ev.failedProbes, ev.gatewayOkDuring, gatewayProbeWorks)}`;
        if (dashboard) dashboard.pushEvent(endMsg, "good");
        else console.log(`${COLORS.green}*** ${endMsg} ***${COLORS.reset}`);
      }
      outageState = null;
      consecutiveBad = 0;
    }

    // Latency spike (3+ seconds high latency without full outage)
    if (sample.highLatency && !sample.badSecond) {
      if (!spikeState) {
        spikeState = { start: sample.ts, count: 1 };
      } else {
        spikeState.count += 1;
      }
    } else if (spikeState) {
      if (spikeState.count >= 3) {
        const ev = {
          start: spikeState.start,
          end: sample.ts,
          durationSec: spikeState.count,
          type: "latency_spike",
          classification: null,
          failedProbes: ["high_latency_or_loss"],
          gatewayOkDuring: sample.gatewayOk,
        };
        events.push(ev);
        fs.appendFileSync(eventsPath, writeEventRow(ev) + "\n");
      }
      spikeState = null;
    }

    const sinceLastDrop =
      lastOutageEnd != null
        ? formatDurationMs(Date.now() - lastOutageEnd.getTime())
        : formatDurationMs(Date.now() - runStart.getTime());
    const gatewayFormatMs =
      gatewayProbe?.formatMs ?? (() => "?");

    if (dashboard) {
      const downSec =
        events.filter((e) => e.type === "outage").reduce((a, e) => a + e.durationSec, 0) +
        (outageState ? consecutiveBad : 0);
      dashboard.update(sample, {
        drops: outageCount,
        downSec,
        badStreak: consecutiveBad,
        inDrop: outageState != null,
        sinceLastDrop,
        runTime: formatDurationMs(Date.now() - runStart.getTime()),
        gatewayFormatMs,
      });
    } else {
      printStatus(sample, outageCount, lastOutageEnd, runStart, gatewayFormatMs);
    }
  }

  regenerateReport();

  while (!shuttingDown) {
    if (endTime && Date.now() >= endTime) {
      await shutdown();
      break;
    }
    const tickStart = Date.now();
    try {
      const sample = await collectProbes();
      await onSecond(sample);
    } catch (e) {
      console.error("Tick error:", e.message);
    }
    const elapsed = Date.now() - tickStart;
    const wait = Math.max(0, 1000 - elapsed);
    if (wait > 0) await sleep(wait);
  }
}

function printStatus(sample, outageCount, lastOutageEnd, runStart, gatewayFormatMs) {
  const since =
    lastOutageEnd != null
      ? formatDurationMs(Date.now() - lastOutageEnd.getTime())
      : formatDurationMs(Date.now() - runStart.getTime());

  const gw = sample.gatewayOk
    ? gatewayFormatMs(sample)
    : `${COLORS.red}NOT REACHABLE${COLORS.reset}`;
  const ext = sample.externalOk.some(Boolean)
    ? `${sample.avgExternalMs?.toFixed(0) ?? "?"} ms`
    : `${COLORS.red}NOT REACHABLE${COLORS.reset}`;
  const up = `${sample.uploadMbps.toFixed(1)} Mbps`;
  const line = `${COLORS.dim}${new Date().toLocaleTimeString()}${COLORS.reset}  router: ${gw}  internet: ${ext} round trip  upload (this second): ${up}  drops so far: ${outageCount}  time since last drop: ${since}   `;
  process.stdout.write(`\r${line}`);
}

async function reportOnly(logDirArg) {
  const logDir = path.resolve(logDirArg);
  if (!fs.existsSync(logDir)) {
    console.error(`Log directory not found: ${logDir}`);
    process.exit(1);
  }
  const samples = loadSamplesFromCsv(logDir);
  const events = loadEventsFromCsv(logDir);
  const runLengthMs =
    samples.length >= 2
      ? new Date(samples[samples.length - 1].ts) - new Date(samples[0].ts)
      : 0;
  // Settings saved by the original run, so a rebuilt report reads the same as the live one.
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(path.join(logDir, "run.json"), "utf8"));
  } catch {
    /* older log folder: fall back to defaults */
  }
  const p = generateReport(logDir, samples, events, {
    gateway: saved.gateway ?? null,
    targetMbps: saved.targetMbps ?? 3,
    noUpload: saved.noUpload ?? false,
    minOutageSec: saved.minOutageSec,
    runStart: samples[0]?.ts,
    runLengthMs,
  });
  console.log(`Wrote ${p}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      duration: { type: "string" },
      "upload-mbps": { type: "string", default: "3" },
      "no-upload": { type: "boolean", default: false },
      "min-outage": { type: "string", default: "3" },
      report: { type: "string" },
      plain: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`netwatch — ISP drop logger

Usage:
  node netwatch.mjs [options]

Options:
  --duration <time>   Stop after duration (e.g. 30m, 3h, 90s)
  --upload-mbps <n>   Target upload load in Mbps (default: 3)
  --no-upload         Disable upload probe
  --min-outage <n>    Seconds of failure before logging outage (default: 3)
  --report <dir>      Rebuild report.html from an existing log folder
  --plain             Single-line status (no live graphs)
  -h, --help          Show this help
`);
    process.exit(0);
  }

  if (values.report) {
    await reportOnly(values.report);
    return;
  }

  const durationMs = values.duration ? parseDuration(values.duration) : null;
  const uploadMbps = parseFloat(values["upload-mbps"]) || 3;
  const minOutageSec = parseInt(values["min-outage"], 10) || 3;

  await runMonitor({
    durationMs,
    uploadMbps,
    noUpload: values["no-upload"],
    minOutageSec,
    plainUi: values.plain,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
