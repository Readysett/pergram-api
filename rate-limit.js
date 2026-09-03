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

/* The address to count a request against, behind a proxy that appends.
 *
 * Each proxy appends the address it received the connection from, so the
 * last entry in X-Forwarded-For is the one Railway's edge observed: the
 * real client. Anything a client writes into that header itself lands to
 * the left of it and cannot displace it, which is what makes the
 * right-hand end the only part worth trusting.
 *
 * Express's `trust proxy` looked like the way to do this and is not. As
 * a number it counts hops from the right and returns an entry further
 * left; as `true` it returns the left-most, which is the one the client
 * writes. The first was deployed and produced a different key on almost
 * every request, so the limit never counted twice against anyone and
 * thirty requests in a second all passed. Computing it here is longer
 * but says exactly what it trusts.
 */
export function clientIp(req){
  const xff = String((req.headers && req.headers['x-forwarded-for']) || '');
  const parts = xff.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length) return parts[parts.length - 1];

  /* No proxy in front — local development, or a direct connection. */
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
