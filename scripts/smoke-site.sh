#!/bin/sh
# Smoke-tests the static site's nginx, either the built image run as a container (the site
# workflow) or a deployment: scripts/smoke-site.sh BASE_URL [--revision SHA] [--conf FILE]
#   --revision  also requires /version.txt to name that commit (the build's REVISION)
#   --conf      the nginx.conf to read the expected CSPs from (default deploy/nginx.conf)
# It checks the two 301 redirects, the shared security headers on /, /lean-coffee/ and /app/
# (and on the redirects, the 404 and the favicon), the 404 page, /favicon.ico, /healthz and
# /version.txt. Every mismatch is printed and the exit status is 1.
# scripts/smoke-site.sh --selftest checks the script's own helpers, with no server.
set -u

fails=0
tmp=$(mktemp -d) || exit 2
trap 'rm -rf "$tmp"' EXIT

fail() { printf 'FAIL %s\n' "$*" >&2; fails=$((fails + 1)); }
pass() { printf 'ok   %s\n' "$*"; }

# header_value NAME FILE: the value of the response header NAME (any case), without the CR.
header_value() {
  grep -i "^$1:" "$2" | head -n 1 | tr -d '\r' | sed 's/^[^:]*: *//'
}

# expect_equal LABEL EXPECTED ACTUAL
expect_equal() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1: expected '$2', got '$3'"; fi
}

# csp_from_conf CONF KEY: the CSP the nginx map gives KEY ('app' for ~^/app/, else default).
csp_from_conf() {
  case "$2" in
    app) sed -n 's|^ *~^/app/  *"\(.*\)";$|\1|p' "$1" | head -n 1 ;;
    *) sed -n 's|^ *default  *"\(.*\)";$|\1|p' "$1" | head -n 1 ;;
  esac
}

if [ "${1:-}" = "--selftest" ]; then
  printf 'HTTP/1.1 200 OK\r\nContent-Security-Policy: a b; c\r\nreferrer-policy: no-referrer\r\n\r\n' > "$tmp/h"
  expect_equal 'selftest: header value, exact case' 'a b; c' "$(header_value Content-Security-Policy "$tmp/h")"
  expect_equal 'selftest: header value, any case' 'no-referrer' "$(header_value Referrer-Policy "$tmp/h")"
  expect_equal 'selftest: absent header is empty' '' "$(header_value X-Content-Type-Options "$tmp/h")"
  printf '    ~^/app/  "x-app y; z";\n    default  "x-default y";\n' > "$tmp/conf"
  expect_equal 'selftest: app CSP from the map' 'x-app y; z' "$(csp_from_conf "$tmp/conf" app)"
  expect_equal 'selftest: default CSP from the map' 'x-default y' "$(csp_from_conf "$tmp/conf" default)"
  here=$(dirname "$0")
  [ -n "$(csp_from_conf "$here/../deploy/nginx.conf" app)" ] || fail 'selftest: no app CSP in deploy/nginx.conf'
  [ -n "$(csp_from_conf "$here/../deploy/nginx.conf" default)" ] || fail 'selftest: no default CSP in deploy/nginx.conf'
  [ "$fails" -eq 0 ] && exit 0 || exit 1
fi

base=${1:-}
[ -n "$base" ] || { echo 'usage: smoke-site.sh BASE_URL [--revision SHA] [--conf FILE]' >&2; exit 2; }
shift
revision=
conf="$(dirname "$0")/../deploy/nginx.conf"
while [ $# -gt 0 ]; do
  case "$1" in
    --revision) revision=${2:?--revision needs a value}; shift 2 ;;
    --conf) conf=${2:?--conf needs a value}; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
base=${base%/}

app_csp=$(csp_from_conf "$conf" app)
default_csp=$(csp_from_conf "$conf" default)
[ -n "$app_csp" ] && [ -n "$default_csp" ] || { echo "no CSP found in $conf" >&2; exit 2; }

# get PATH: fetches into $tmp/h (headers) and $tmp/b (body) and sets $status. No redirect is followed.
get() {
  status=$(curl -sS -m 20 -D "$tmp/h" -o "$tmp/b" -w '%{http_code}' "$base$1") || { fail "$1: request failed"; status=000; }
}

# check_security PATH CSP: the headers deploy/security-headers.conf adds, on the last response.
check_security() {
  expect_equal "$1 Content-Security-Policy" "$2" "$(header_value Content-Security-Policy "$tmp/h")"
  expect_equal "$1 Referrer-Policy" 'no-referrer' "$(header_value Referrer-Policy "$tmp/h")"
  expect_equal "$1 X-Content-Type-Options" 'nosniff' "$(header_value X-Content-Type-Options "$tmp/h")"
}

# Redirects: a relative Location (absolute_redirect off), with the security headers on the 301 too.
# Their CSP is the default one on purpose: the URI has no trailing slash, so the map's ~^/app/ does not match.
for pair in '/app /app/' '/lean-coffee /lean-coffee/'; do
  from=${pair% *}; to=${pair#* }
  get "$from"
  expect_equal "$from status" 301 "$status"
  expect_equal "$from Location" "$to" "$(header_value Location "$tmp/h")"
  check_security "$from" "$default_csp"
done

# The three pages: 200, the shared headers, no-cache, and each page's own CSP.
for pair in '/ default' '/lean-coffee/ default' '/app/ app'; do
  p=${pair% *}
  if [ "${pair#* }" = app ]; then csp=$app_csp; else csp=$default_csp; fi
  get "$p"
  expect_equal "$p status" 200 "$status"
  check_security "$p" "$csp"
  expect_equal "$p Cache-Control" 'no-cache' "$(header_value Cache-Control "$tmp/h")"
  grep -qi '<html' "$tmp/b" || fail "$p: body is not an HTML page"
done

# An unknown path: status 404 with the site's own page, not nginx's bare one.
get /no-such-page-rb-smoke
expect_equal '/no-such-page-rb-smoke status' 404 "$status"
grep -q 'Page not found · Retrobrew' "$tmp/b" || fail '/no-such-page-rb-smoke: body is not the site 404 page'
check_security /no-such-page-rb-smoke "$default_csp"
expect_equal '/no-such-page-rb-smoke Cache-Control' 'no-cache' "$(header_value Cache-Control "$tmp/h")"
get /app/no-such-page-rb-smoke
expect_equal '/app/no-such-page-rb-smoke status' 404 "$status"
# The default CSP, not the app one, on purpose: error_page 404 makes $uri /404.html, where the map first runs.
check_security /app/no-such-page-rb-smoke "$default_csp"

# The favicon browsers ask for by default.
get /favicon.ico
expect_equal '/favicon.ico status' 200 "$status"
expect_equal '/favicon.ico Content-Type' 'image/png' "$(header_value Content-Type "$tmp/h")"
check_security /favicon.ico "$default_csp"
[ -s "$tmp/b" ] || fail '/favicon.ico: empty body'

get /healthz
expect_equal '/healthz status' 200 "$status"
expect_equal '/healthz body' ok "$(cat "$tmp/b")"

get /version.txt
expect_equal '/version.txt status' 200 "$status"
if [ -n "$revision" ]; then
  expect_equal '/version.txt revision' "$revision" "$(tr -d '\r\n' < "$tmp/b")"
else
  [ -s "$tmp/b" ] || fail '/version.txt: empty'
fi

if [ "$fails" -ne 0 ]; then printf '%s check(s) failed against %s\n' "$fails" "$base" >&2; exit 1; fi
printf 'all checks passed against %s\n' "$base"
