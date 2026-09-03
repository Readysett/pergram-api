/* Fixed-window request counters.
 *
 * Held in memory, for the same reason the database is SQLite: there is
 * one instance by design. A restart forgets the counters, which costs an
 * attacker one window and costs a real user nothing. If this ever runs on
 * more than one instance the counters stop being shared, and this file is
 * the second thing to fix after the database.
 *
 * Fixed windows, not a sliding log. A sliding window is more accurate at
 * the boundary and costs a timestamp array per key; the boundary case
 * here is someone getting a few extra nonces, which does not matter.
 */

const buckets = new Map();

/* The address to count a request against.
 *
 * Railway's edge sets x-real-ip to the address it accepted the connection
 * from, and overwrites whatever the caller sent: a request carrying a
 * forged `X-Real-IP: 9.9.9.9` arrived with the true address in its place.
 * That is what makes this header, and only this header, safe to count.
 *
 * Not X-Forwarded-For. Its right-hand end is the edge node rather than
 * the caller, and that node varies between requests — two addresses
 * appeared inside a single burst — so a limit keyed on it lands in a
 * fresh bucket every few requests and never fires. Its left-hand end is
 * the caller, but in the general case the caller writes it; here Railway
 * discards what was sent, which is a property of this host and not of
 * the header, so it is not worth depending on.
 *
 * Not the socket address either: that is the internal mesh peer, and it
 * changed on every single request.
 *
 * Behind a proxy that does not set x-real-ip, the fallback is the socket
 * address. That collapses everyone into one bucket and over-limits, which
 * is the right direction to fail: an outage is visible, a silently absent
 * limit is not — which is precisely how this shipped broken twice.
 */
export function clientIp(req){
  const real = String((req.headers && req.headers['x-real-ip']) || '').trim();
  if (real) return real;

  return (req.socket && req.socket.remoteAddress) || req.ip || '';
}

/**
 * @param {string} name      namespace, so two limits never share a bucket
 * @param {number} windowMs  how long a window lasts
 * @param {number} max       requests allowed inside one window
 * @param {function} key     req -> string; a falsy key skips the limit
 */
export function rateLimit({ name, windowMs, max, key }){
  return (req, res, next) => {
    const id = key(req);

    /* Nothing to count against. The request is still subject to whatever
       other limits it passes through, and to its own validation. */
    if (!id) return next();

    const k   = name + ':' + id;
    const now = Date.now();

    let b = buckets.get(k);
    if (!b || now >= b.reset){ b = { n: 0, reset: now + windowMs }; buckets.set(k, b); }
    b.n++;

    if (b.n > max){
      const secs = Math.max(1, Math.ceil((b.reset - now) / 1000));
      res.setHeader('Retry-After', String(secs));
      /* Same flat refusal as everywhere else: distinguishing "you are
         limited" from "that wallet is limited" maps the limits. */
      return res.status(429).json({ ok:false, error:'too many requests' });
    }
    next();
  };
}

/* Expired buckets are dead weight, and a caller rotating keys would grow
   the map without bound between sweeps. Called on a timer. */
export function sweepLimits(){
  const now = Date.now();
  for (const [k, b] of buckets) if (now >= b.reset) buckets.delete(k);
}

/* For tests. */
export function __resetLimits(){ buckets.clear(); }
export function __bucketCount(){ return buckets.size; }
