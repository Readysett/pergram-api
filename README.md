# Per Gram — claims API

The backend behind the scanner: receipts, caps, personhood, settlement.
Runs locally with no chain connection except the passport check.

## Run it

Needs Node 22.5 or newer (`node:sqlite` is built in above that).

    npm install
    npm start          # http://localhost:8787
    npm run seed       # smoke test: cap, duplicate refusal, settlement

## What it does today

- Receipts identified by `sha256(store|txn|date|total)`, unique — one
  receipt cannot be claimed twice, by anyone.
- VeBetterPassport personhood check before any claim is accepted, cached
  six hours, failing closed if the node is unreachable.
- Weekly cap of 1500g protein per wallet, 1000g per receipt.
- Receipts must be dated within the round's claim window (5 days).
- Round settlement at `pool / total points`, with the cap scaling a
  wallet's points proportionally rather than truncating the last claim.
- Review queue for signals that should not be automatic blocks.

## Receipts

`POST /api/receipt` (multipart: `image`, plus `scanned` as JSON — a list
of barcodes and nothing else) reads a receipt and reports what it found.
It does **not** create a claim — the user confirms the matches first,
because an OCR misread that silently pays is worse than one the user can
correct.

It returns a `scan_id`. What it matched is recorded against that id, and
`POST /api/claim` prices from that record: the quantity is the matched
line's, never the request's.

The receipt is not parsed cold. Receipt lines carry no barcode and are
abbreviated per retailer (`WHEY ISO CHOC 900G`), so reading them blind
needs a corpus nobody has on day one. Instead the barcode scan says what
the product *is*, and the receipt only confirms a matching line exists
and supplies the quantity.

Matching handles the way receipts abbreviate — by dropping vowels, which
preserves letter order, so `CHDR` is a subsequence of `CHEDDAR`. A match
needs both a score above 0.25 and hits on at least two distinct tokens.
On real receipts true matches score 0.30+ with two hits and false ones
score 0.00 with none, so the thresholds are set from evidence.

`weak_identity: true` means no transaction id was found. The receipt can
then only be identified by its pixels, which a re-photograph defeats —
worth surfacing rather than pretending the claim is equally protected.

OCR is an adapter (`ocr.js`). `OCR_PROVIDER=fake` is the default and
needs no key or network; `google` uses Cloud Vision.

## What it does not do yet
- **Distribution.** Settlement computes what is owed. Paying it through
  `X2EarnRewardsPool` (`0x6Bee7DDab6c99d5B2Af0554EaEA484CE18F52631`) is
  deliberately a separate, manual step until the rest is trusted.
(Auth is done — see below.)

## Auth

Challenge-response over a wallet signature. Only the holder of the
private key can produce a signature that recovers to their address.

    POST /api/auth/nonce    { wallet }              -> { nonce, message }
    POST /api/auth/verify   { wallet, nonce, sig }  -> { token }
    POST /api/auth/logout                            (Bearer token)

Then send `Authorization: Bearer <token>` on protected routes.

Properties, each one tested in `test-auth.js`:

- **Nonces are single-use and expire in five minutes**, so a captured
  signature cannot be replayed.
- **The wallet comes from the session, never the request body.** Reading
  an address from the body and merely checking that *some* token exists
  would leave the original hole wide open.
- **Sessions are stored hashed.** A leaked database should not hand an
  attacker working tokens.
- **Every failure returns the same message.** Distinguishing "unknown
  nonce" from "already used" from "expired" is a map of the auth flow.
- **The signed message says what it does** in plain words. A prompt that
  reads "sign this hex" trains people to approve anything.

## Endpoints

    GET  /api/health                             open
    POST /api/auth/nonce                         open
    POST /api/auth/verify                        open
    POST /api/flag                               open — reports are useful either way
    GET  /api/passport/:wallet                   open
    GET  /api/me                                 auth
    POST /api/claim       { scan_id, items[] }   auth
    POST /api/receipt     multipart              auth
    GET  /api/week                               auth
    GET  /api/review                             open — should be admin-only before launch

## Nothing the client sends decides a reward

The barcode and the receipt are the whole input. Every figure that
decides a payout is derived on this side:

- The **product** is resolved from the barcode against `product_version`,
  fetching from Open Food Facts on a miss. The name matched against the
  receipt lines is the one the cache holds — matching on a name supplied
  by the caller lets a cheap barcode be bound to an expensive line.
- The **protein source** is classified by `vendor/classifier.js`, which
  is the byte-identical canonical copy from the app repo, so the two
  cannot disagree. `npm run check:classifier` fails if it drifts.
- The **rate** is derived from the footprint (`multFor`), never read off
  a client-supplied multiplier.
- The **quantity** comes from the matched receipt line. The only thing a
  caller may say about it is the answer to a question the scan asked,
  and answering can only ever lower a claim.

A request that still carries `protein_g`, `mult` or `co2` is not
rejected for it; those fields are simply never read.

### Cached classifications are versioned

Settlement is `pool / total points`, so what one barcode is worth is not
local to its claim — it moves the denominator and therefore what every
other wallet in the round earns. Two rules follow:

- Rows are **append-only**. A new reading supersedes the old one; the old
  row stays, and a claim keeps pointing at the figures it was paid on.
- Within an open round a barcode resolves to **one version for everyone**.
  A correction landing on Wednesday must not mean Monday's claimant was
  paid on a different basis. New versions take effect at the round
  boundary, where the denominator resets anyway.

`locked = 1` pins a version permanently: it is what a human review
writes, and it is never superseded automatically.

A lookup that does not settle is never cached. It is not a fact about the
product, and caching it would turn a network blip into a permanent zero.
A claim that hits one fails whole and retryable, leaving the receipt
claimable — a partial write would burn the receipt key and leave the
remaining lines unclaimable for good.

## What a round paid is written down

Settlement computed the rate and the per-wallet split, printed them, and
returned them — the only write was marking claims settled. A settled
round could not be reconstructed afterwards: the rate and the split
existed only in whatever terminal ran it.

`settle()` now writes the split to `payout` in the same transaction as
the claims it settles, and the rate beside the pool on `round`. There is
no state where claims read `settled` and no payout explains them.

    node settle.js <roundId> <poolB3TR>    settle, once
    node settle.js --show <roundId>        read it back, any time later

Re-settling is refused rather than repeated. The second run would find no
verified claims, divide a pool by nothing, and overwrite the record with
a rate of zero — so the first run's numbers stand and the error says
where to read them.

## Rate limits

Every endpoint that costs something carries two limits: per-IP, which
bounds a flood, and per-wallet, which shapes one account.

    /api/receipt    40/hr per IP     15/hr per wallet   RL_RECEIPT_*
    /api/claim     200/hr per IP     60/hr per wallet   RL_CLAIM_*
    /api/flag       60/hr per IP                        RL_FLAG_IP
    /api/passport  120/hr per IP                        RL_PASSPORT_IP

The per-IP limit is the one doing the real work. Personhood gates
*claiming*, not reading — `/api/receipt` needs only a signed-in wallet,
and wallets are free — so a per-wallet limit is bypassed by rotating
addresses. It still earns its place by stopping one real account running
away with the OCR budget by accident, but it is not what stops a
determined caller.

On `/api/receipt` the limits sit between the session check and the
upload. `requireAuth` reads a header; multer buffers up to six megabytes
before the handler sees anything, and the OCR behind it is a paid call.
A refused request should pay for none of that.

`/api/flag` and `/api/passport/:wallet` need no session at all, and each
costs something per call — a row in one case, a row plus an outbound
Thor request in the other. An unauthenticated endpoint that writes is
the most exposed thing here, whatever it writes.

Defaults are env-tunable: the right value depends on the OCR bill and on
how many people share an address, and neither is knowable from the code.

## The claim window belongs to the round

How far back a receipt may be dated is stamped on the round when it
opens, not read from a constant at claim time. Tightening the constant
therefore takes effect at the next round boundary rather than voiding
receipts mid-round that were claimable the same morning — and the round
is already the unit that prices, caps and payouts are pinned to.

Rounds opened before the column existed read NULL and keep the 30 days
they were actually run under. Reading them as anything else would
rewrite what their claimants were entitled to.

`CLAIM_WINDOW_DAYS` (default 5) sets what the *next* round is stamped
with. `/api/week` returns the open round's window so the app can say it
without hardcoding a number that is not its to hold.

## The audit log

`claim` records what a claim is worth and `payout` records what a round
paid. Neither records how either got there: a claim reading `settled`
does not say when it stopped being `verified`, or under which
settlement. For a distribution meant to be audited, the sequence is the
thing being audited.

Every state a claim or a round passes through is now an entry in
`audit`, written **inside the transaction that causes it** — the entry
and the fact commit together, so there is no claim without an entry and
no entry for a claim that rolled back.

    node audit.js --verify            check the chain
    node audit.js --claim  <id>       one claim's history
    node audit.js --round  <id>       a round, opening to payouts
    node audit.js --wallet <address>  everything touching one wallet

Two properties, enforced rather than promised:

- **Append-only.** Triggers abort any UPDATE or DELETE on the table, so
  it does not depend on every future caller remembering.
- **Tamper-evident.** Each entry carries the hash of the one before it.
  Altering a row breaks its own hash; removing one orphans its
  successor; `--verify` names the first entry that stops adding up. The
  triggers stop an honest mistake — the chain is what survives someone
  with a SQLite prompt and a reason to use it.

A claim entry carries the product version it was priced from, so the
claim can be recomputed from the cache row rather than taken on trust
from the claim row.

The log begins when it is deployed. Claims settled before that have no
entries, and `--verify` on a database from before the change reports an
intact empty chain — nothing is reconstructed backwards, because
anything reconstructed would be a guess wearing the same shape as
evidence.

## Design notes worth keeping

**Rejections stay generic.** "Already claimed" tells a farmer which field
to vary. The caller gets a flat refusal; the detail goes to the review
queue.

**Signals flag, they do not ban.** A new wallet hitting the cap within an
hour is suspicious, not proven. Automated bans on heuristics catch real
users, and one wrongly banned user complains louder than ten farmers.

**Fail closed on passport.** If the Thor node is unreachable, nobody is a
person. An outage must never become an open door.

**The rate is never fixed in advance.** The pool changes every round with
the allocation vote. A fixed B3TR-per-gram makes a growth week insolvent.

## Environment

    THOR_NODE=https://mainnet.vechain.org
    PASSPORT_ADDR=0x35a267671d8EDD607B2056A9a13E7ba7CF53c8b3
    DB_PATH=./pergram.db
    PORT=8787
