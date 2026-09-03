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
