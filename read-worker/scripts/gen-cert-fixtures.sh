#!/usr/bin/env bash
# Generates the SEC-001 certificate-policy test fixtures: Apple-SHAPED X.509 chains
# (P-384 root CA → intermediate CA → P-256 leaf) with and without the StoreKit purpose
# marker extensions, so test/cert-policy.test.mjs can prove the verifier REJECTS a
# structurally valid Apple-rooted chain whose certificates lack the right purpose.
#
# Owner ruling 2026-07-23: this synthetic negative-proof suite closes SEC-001's test
# obligation (a genuinely Apple-issued wrong-purpose chain is practically unobtainable).
#
# Deterministic layout, throwaway keys — regenerate any time: ./scripts/gen-cert-fixtures.sh
set -euo pipefail
cd "$(dirname "$0")/.."
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
OUT=test/fixtures
mkdir -p "$OUT"

LEAF_MARKER="1.2.840.113635.100.6.11.1"     # StoreKit receipt-signing leaf marker
INTER_MARKER="1.2.840.113635.100.6.2.1"     # Apple intermediate marker
WRONG_MARKER="1.2.840.113635.100.6.11.99"   # Apple-shaped but NOT the StoreKit purpose

ext() { # $1 = extra extension lines
  cat > "$WORK/ext.cnf" <<EOF
basicConstraints=critical,$2
keyUsage=critical,$3
$1
EOF
}

sign() { # csr out signerCert signerKey extLine basicConstraints keyUsage
  ext "$5" "$6" "$7"
  openssl x509 -req -in "$1" -out "$2" -CA "$3" -CAkey "$4" -CAcreateserial \
    -days 3650 -sha384 -extfile "$WORK/ext.cnf" > /dev/null 2>&1
}

# Root CA (P-384, self-signed) — stands in for Apple Root CA - G3.
openssl ecparam -name secp384r1 -genkey -noout -out "$WORK/root.key"
openssl req -new -x509 -key "$WORK/root.key" -out "$WORK/root.pem" -days 3650 -sha384 \
  -subj "/CN=Test Apple Root CA - G3 (SYNTHETIC)" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"

# Intermediates (P-384 CA), with and without the Apple-intermediate marker.
for kind in good bad; do
  openssl ecparam -name secp384r1 -genkey -noout -out "$WORK/inter-$kind.key"
  openssl req -new -key "$WORK/inter-$kind.key" -out "$WORK/inter-$kind.csr" \
    -subj "/CN=Test Intermediate ($kind)"
done
sign "$WORK/inter-good.csr" "$WORK/inter-good.pem" "$WORK/root.pem" "$WORK/root.key" \
  "$INTER_MARKER=DER:05:00" "CA:TRUE" "keyCertSign,cRLSign"
sign "$WORK/inter-bad.csr" "$WORK/inter-bad.pem" "$WORK/root.pem" "$WORK/root.key" \
  "" "CA:TRUE" "keyCertSign,cRLSign"

# Leaves (P-256), signed by the GOOD intermediate: right marker, wrong marker, no marker.
for kind in good wrongmarker nomarker; do
  openssl ecparam -name prime256v1 -genkey -noout -out "$WORK/leaf-$kind.key"
  openssl req -new -key "$WORK/leaf-$kind.key" -out "$WORK/leaf-$kind.csr" \
    -subj "/CN=Test StoreKit Leaf ($kind)"
done
sign "$WORK/leaf-good.csr" "$WORK/leaf-good.pem" "$WORK/inter-good.pem" "$WORK/inter-good.key" \
  "$LEAF_MARKER=DER:05:00" "CA:FALSE" "digitalSignature"
sign "$WORK/leaf-wrongmarker.csr" "$WORK/leaf-wrongmarker.pem" "$WORK/inter-good.pem" "$WORK/inter-good.key" \
  "$WRONG_MARKER=DER:05:00" "CA:FALSE" "digitalSignature"
sign "$WORK/leaf-nomarker.csr" "$WORK/leaf-nomarker.pem" "$WORK/inter-good.pem" "$WORK/inter-good.key" \
  "" "CA:FALSE" "digitalSignature"
# A leaf under the UNMARKED intermediate (leaf marker correct, chain still wrong-purpose).
openssl ecparam -name prime256v1 -genkey -noout -out "$WORK/leaf-underbad.key"
openssl req -new -key "$WORK/leaf-underbad.key" -out "$WORK/leaf-underbad.csr" \
  -subj "/CN=Test StoreKit Leaf (under unmarked intermediate)"
sign "$WORK/leaf-underbad.csr" "$WORK/leaf-underbad.pem" "$WORK/inter-bad.pem" "$WORK/inter-bad.key" \
  "$LEAF_MARKER=DER:05:00" "CA:FALSE" "digitalSignature"

b64der() { openssl x509 -in "$1" -outform DER | base64; }

node - "$WORK" > "$OUT/cert-chains.json" <<'EOF'
const { execSync } = require("node:child_process");
const work = process.argv[2];
const der = (name) =>
  execSync(`openssl x509 -in "${work}/${name}.pem" -outform DER | base64`).toString().replace(/\s/g, "");
const out = {};
for (const name of ["root", "inter-good", "inter-bad",
                    "leaf-good", "leaf-wrongmarker", "leaf-nomarker", "leaf-underbad"]) {
  out[name] = der(name);
}
console.log(JSON.stringify(out, null, 2));
EOF
echo "wrote $OUT/cert-chains.json"
