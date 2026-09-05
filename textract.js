/* AWS Textract — AnalyzeExpense.
 *
 * Third adapter, same contract as the other two: it returns a `parsed`
 * receipt and the pipeline skips every line of reading-order work.
 *
 * What it gives that Vision does not is labels. The summary fields arrive
 * already typed — TOTAL, SUBTOTAL, TAX, INVOICE_RECEIPT_DATE,
 * INVOICE_RECEIPT_ID — and the line items arrive with each description
 * already paired to its price. That removes the row reconstruction and
 * the field regexes in one go: nothing here looks for a date, it asks for
 * the field called date.
 *
 * Auth is SigV4, signed here rather than pulled in as an SDK — the same
 * choice docai.js makes with its JWT, and for the same reason: one
 * request needs one signature, not a dependency tree.
 */
import { createHmac, createHash } from "node:crypto";

const SERVICE = "textract";
const TARGET = "Textract.AnalyzeExpense";
const TIMEOUT_MS = 30_000;

/* AnalyzeExpense is synchronous and caps the document at 10MB. The
   upload cap upstream is 6MB, so this is a backstop rather than the
   binding limit — but it names the actual number if it is ever raised. */
const MAX_BYTES = 10 * 1024 * 1024;

/* ---------- signing ---------- */

const hmac = (key, msg) => createHmac("sha256", key).update(msg, "utf8").digest();
const sha256hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

function credentials() {
  const id = process.env.AWS_ACCESS_KEY_ID;
  const secret = process.env.AWS_SECRET_ACCESS_KEY;
  if (!id) throw new Error("AWS_ACCESS_KEY_ID not set");
  if (!secret) throw new Error("AWS_SECRET_ACCESS_KEY not set");
  return { id, secret, token: process.env.AWS_SESSION_TOKEN || null };
}

/**
 * Sign a request the way AWS wants it: a canonical form of the request is
 * hashed, that hash is signed with a key derived from the secret and the
 * date, and the result rides in the Authorization header.
 *
 * The signature covers the headers it lists and the body, so any of them
 * changing after signing invalidates it. That is why the header set is
 * built once here and returned whole rather than added to later.
 */
function signedHeaders(region, body) {
  const { id, secret, token } = credentials();
  const host = `${SERVICE}.${region}.amazonaws.com`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20260905T183000Z
  const date = amzDate.slice(0, 8);

  const headers = {
    "content-type": "application/x-amz-json-1.1",
    host,
    "x-amz-date": amzDate,
    "x-amz-target": TARGET,
  };
  /* Temporary credentials carry a session token, and it has to be signed
     with the rest or the request is rejected as tampered with. */
  if (token) headers["x-amz-security-token"] = token;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedList = names.join(";");

  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedList,
    sha256hex(body),
  ].join("\n");

  const scope = `${date}/${region}/${SERVICE}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");

  const key = ["AWS4" + secret, date, region, SERVICE, "aws4_request"].reduce(hmac);
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");

  return {
    url: `https://${host}/`,
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${id}/${scope}, ` +
        `SignedHeaders=${signedList}, Signature=${signature}`,
    },
  };
}

/* ---------- reading what came back ---------- */

const centsFrom = (t) => {
  const m = String(t || "").match(/(-?\d{1,7}[.,]\d{2})/);
  return m ? Math.round(parseFloat(m[1].replace(",", ".")) * 100) : null;
};

const numberFrom = (t) => {
  const m = String(t || "").match(/(\d+(?:[.,]\d+)?)/);
  return m ? parseFloat(m[1].replace(",", ".")) : null;
};

/* Receipts write dates every way there is, and Textract hands back the
   text it saw rather than a normalised value. Date.parse copes with
   09/03/2026 and 2026-09-03 and "Sep 3 2026"; anything it cannot read is
   left null rather than guessed at, because a wrong date silently ages a
   receipt out of the claim window. */
function dateMs(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const ms = Date.parse(t);
  if (Number.isFinite(ms)) return ms;

  const m = t.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = "20" + y;
    const alt = Date.parse(`${y}-${String(a).padStart(2, "0")}-${String(b).padStart(2, "0")}T12:00:00Z`);
    if (Number.isFinite(alt)) return alt;
  }
  return null;
}

const fieldText = (fields, type) => {
  const f = (fields || []).find((x) => x && x.Type && x.Type.Text === type);
  return (f && f.ValueDetection && f.ValueDetection.Text) || null;
};

const fieldCurrency = (fields, type) => {
  const f = (fields || []).find((x) => x && x.Type && x.Type.Text === type);
  return (f && f.Currency && f.Currency.Code) || null;
};

/**
 * Line items, as Textract paired them.
 *
 * Descriptions bleed. A receipt line reading "You Just Saved $0" above a
 * product ends up inside that product's ITEM text, so the description
 * comes through as "You Just Saved $0 BAREBELLE PROTEIN". That is left
 * exactly as it is. The matcher tokenises and scores against a known
 * product name, so a description carrying extra words still matches on
 * the words that count — and any attempt to strip the noise would have to
 * guess which half is the product, which is the one thing that cannot be
 * got wrong quietly.
 *
 * Whitespace is collapsed, and only whitespace: a description broken
 * across two lines arrives with a newline in it, and the matcher wants
 * words rather than layout.
 */
function lineItems(groups) {
  const out = [];
  for (const group of groups || []) {
    for (const item of (group && group.LineItems) || []) {
      const f = item && item.LineItemExpenseFields;
      /* EXPENSE_ROW is the whole row as one string. It stands in when the
         row had no ITEM of its own, which is better than dropping a line
         that has a price on it. */
      const desc = fieldText(f, "ITEM") || fieldText(f, "EXPENSE_ROW");
      if (!desc || !desc.trim()) continue;

      out.push({
        text: desc.replace(/\s+/g, " ").trim(),
        cents: centsFrom(fieldText(f, "PRICE")),
        qty: numberFrom(fieldText(f, "QUANTITY")),
        product_code: fieldText(f, "PRODUCT_CODE"),
      });
    }
  }
  return out;
}

/**
 * One ExpenseDocument into the shape the pipeline already consumes.
 *
 * Textract returns the transaction id as a labelled field, so unlike the
 * Document AI path this one does not have to go looking for it in the
 * raw text. Receipt identity turns on that id — without one a receipt can
 * only be told apart by its pixels.
 */
export function readExpense(doc) {
  const summary = (doc && doc.SummaryFields) || [];

  /* The full text, for the diagnostic panel. Textract returns the blocks
     it read alongside the fields; joining the LINE blocks reproduces the
     receipt closely enough to argue with. */
  const text = ((doc && doc.Blocks) || [])
    .filter((b) => b && b.BlockType === "LINE" && b.Text)
    .map((b) => b.Text)
    .join("\n");

  return {
    source: "textract",
    store: fieldText(summary, "VENDOR_NAME"),
    purchased: dateMs(fieldText(summary, "INVOICE_RECEIPT_DATE")),
    total_cents: centsFrom(fieldText(summary, "TOTAL")),
    subtotal_cents: centsFrom(fieldText(summary, "SUBTOTAL")),
    tax_cents: centsFrom(fieldText(summary, "TAX")),
    txn: fieldText(summary, "INVOICE_RECEIPT_ID"),
    currency: fieldCurrency(summary, "TOTAL"),
    items: lineItems((doc && doc.LineItemGroups) || []),
    text,
  };
}

/* ---------- the call ---------- */

export async function analyzeExpense(buf) {
  const region = process.env.AWS_REGION || process.env.TEXTRACT_REGION || "us-east-1";

  if (buf.length > MAX_BYTES) {
    throw new Error(
      `image is ${(buf.length / 1048576).toFixed(1)}MB; AnalyzeExpense takes at most 10MB synchronously`,
    );
  }

  const body = JSON.stringify({ Document: { Bytes: buf.toString("base64") } });
  const { url, headers } = signedHeaders(region, body);

  /* Same reason as the other two adapters: fetch has no timeout of its
     own and a phone is waiting at the other end. */
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body, signal: ac.signal });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`textract timed out after ${TIMEOUT_MS / 1000}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const j = await res.json().catch(() => null);

  /* AWS names its failures, and every one of them is actionable in a
     different place: credentials that are not allowed, a document it
     cannot read, a throttle. Reporting only a status code sends you to
     the camera when the answer is in IAM. */
  if (j && (j.__type || j.Message || j.message)) {
    const kind = String(j.__type || "").split("#").pop() || "error";
    throw new Error(`textract: ${kind}: ${j.Message || j.message || "no detail"}`);
  }
  if (!res.ok) throw new Error(`textract HTTP ${res.status}`);

  const doc = j && j.ExpenseDocuments && j.ExpenseDocuments[0];
  if (!doc) throw new Error("textract returned no expense document");

  return readExpense(doc);
}
