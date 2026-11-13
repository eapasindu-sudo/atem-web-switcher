'use strict';
// Endora Live Tools licence: key check with the Endora server and 7 days offline grace (optional trial).
// Same file is used by every Endora desktop app; only PRODUCT changes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const API = 'https://www.endoraweddingfilms.com/perfex_crm/endora_bridge/shop/check';
const TRIAL_DAYS = 0; // no free trial: a key is needed from the first start
const GRACE_DAYS = 7;
const RECHECK_HOURS = 12;
const DAY = 86400000;

function machineId() {
  const macs = Object.values(os.networkInterfaces()).flat().filter((n) => n && !n.internal && n.mac && n.mac !== '00:00:00:00:00:00').map((n) => n.mac).sort();
  const raw = [os.hostname(), os.platform(), os.arch(), (os.cpus()[0] || {}).model || '', macs[0] || ''].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

class Licence {
  constructor(dir, product, opts = {}) {
    this.file = path.join(dir, 'licence.json');
    this.product = product;
    this.trialDays = opts.trialDays ?? TRIAL_DAYS;
    this.fetch = opts.fetch || ((u) => fetch(u, { signal: AbortSignal.timeout(15000) }));
    this.now = opts.now || (() => Date.now());
    this.machine = opts.machine || machineId();
    this.s = this.load();
    if (!this.s.firstRun) { this.s.firstRun = this.now(); this.save(); }
  }
  load() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; } }
  save() { try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.s, null, 1)); } catch { /* read-only disk: keep in memory */ } }

  /** What the app may do right now. state: licensed | trial | expired | revoked | none */
  status() {
    const now = this.now();
    const s = this.s;
    if (s.key && s.valid) {
      if (s.expires && now > Date.parse(s.expires + 'T23:59:59')) return { state: 'expired', ok: false, key: s.key, message: 'Your licence ended on ' + s.expires + '. Buy a new licence to keep using the app.' };
      const offline = now - (s.lastOk || 0);
      if (offline > GRACE_DAYS * DAY) return { state: 'offline', ok: false, key: s.key, message: 'Connect to the internet once so the app can check your licence.' };
      return { state: 'licensed', ok: true, key: s.key, name: s.name, expires: s.expires || null };
    }
    if (s.key && s.valid === false) return { state: 'revoked', ok: false, key: s.key, message: s.reason || 'This licence key is not valid for this app.' };
    const left = Math.ceil((s.firstRun + this.trialDays * DAY - now) / DAY);
    if (left > 0) return { state: 'trial', ok: true, daysLeft: left };
    return { state: 'none', ok: false, message: this.trialDays > 0 ? 'Your free trial has ended. Enter a licence key to keep using the app.' : 'Enter your licence key to start using the app.' };
  }

  async check(key) {
    key = String(key || '').trim().toUpperCase();
    const u = API + '?key=' + encodeURIComponent(key) + '&product=' + encodeURIComponent(this.product) + '&machine=' + this.machine;
    const r = await this.fetch(u);
    const j = await r.json();
    if (!j || !j.ok) throw new Error('The licence server did not answer. Try again in a moment.');
    return j;
  }

  /** Activate a key typed by the user. Returns status(). */
  async activate(key) {
    const j = await this.check(key);
    if (!j.valid) return { state: 'invalid', ok: false, message: j.reason || 'This licence key is not valid for this app.' };
    this.s = { ...this.s, key: String(key).trim().toUpperCase(), valid: true, lastOk: this.now(), expires: j.expires || null, name: j.name || '', reason: '' };
    this.save();
    return this.status();
  }

  /** Re-check the saved key (call at start and every few hours). Network errors keep the last good answer. */
  async refresh(force = false) {
    if (!this.s.key) return this.status();
    if (!force && this.s.valid && this.now() - (this.s.lastOk || 0) < RECHECK_HOURS * 3600000) return this.status();
    try {
      const j = await this.check(this.s.key);
      if (j.valid) Object.assign(this.s, { valid: true, lastOk: this.now(), expires: j.expires || null, name: j.name || this.s.name, reason: '' });
      else Object.assign(this.s, { valid: false, reason: j.reason || '' });
      this.save();
    } catch { /* offline: grace period applies */ }
    return this.status();
  }

  remove() { delete this.s.key; delete this.s.valid; delete this.s.expires; delete this.s.lastOk; this.save(); return this.status(); }
}

module.exports = { Licence, machineId };
