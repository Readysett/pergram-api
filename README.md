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
- Round settlement at `pool / total points`, with the cap scaling a
  wallet's points proportionally rather than truncating the last claim.
- Review queue for signals that should not be automatic blocks.

## Receipts

`POST /api/receipt` (multipart: `image`, plus `scanned` as JSON) reads a
receipt and reports what it found. It does **not** create a claim — the
user confirms the matches first, because an OCR misread that silently
pays is worse than one the user can correct.

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
    POST /api/claim       { receipt, items[] }   auth
    POST /api/receipt     multipart              auth
    GET  /api/week                               auth
    GET  /api/review                             open — should be admin-only before launch

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
