#!/bin/bash
# ════════════════════════════════════════════════════════════════════
#  Rebuild docs/js/classroom-standards.js from CPALMS
# ════════════════════════════════════════════════════════════════════
#
#  Usage:  bash tools/fetch-standards.sh
#
#  CPALMS (cpalms.org) is Florida's official standards repository, run by
#  Florida State University. It retired its own API; the machine-readable
#  CASE feed now lives behind a free account at the Satchel Rosetta
#  Exchange, a third party CPALMS explicitly does not vouch for.
#
#  WHY THIS SCRAPES THE SEARCH ENDPOINT INSTEAD. ⚠
#  /Search/GetSearchStandard is the site's own public, unauthenticated
#  search — the same call the Browse Standards page makes when a teacher
#  clicks Search. No key, no account, no terms to accept, and it returns
#  the benchmark text we quote. The alternative is making every checkout
#  of a public repository register for a third-party portal to rebuild one
#  generated file. If the endpoint ever changes shape the parse will
#  return zero rows and the generator will throw rather than quietly
#  writing an empty catalogue — see the guard in gen-standards.js.
#
#  WHICH BENCHMARKS END UP IN THE FILE is tools/standards-codes.txt, a
#  hand-curated list. This script only fetches the text for them; it does
#  not decide what is in scope. Editing the catalogue means editing that
#  list, which is the point — the curation is a judgement that deserves a
#  diff, not a keyword match.
#
#  Takes about a minute. Writes nothing outside the repo except a temp dir.
# ════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

BASE=https://www.cpalms.org
XHR='X-Requested-With: XMLHttpRequest'

echo "→ grade filters"
curl -fsS -m 60 "$BASE/Search/GetStandardGradeFilters?SelectedSubjectAreas=&SelectedGrades=" \
     -H "$XHR" -o "$TMP/filters.html"

# K-8 only. The option values are per-subject grade-level ids, not grades,
# so the union of every id listed against K through 8 is what the endpoint
# wants — passing "5,6,7,8" (the grade ids) silently matches nothing.
G=$(grep -o 'data-gradelevelids="[^"]*" *>Grade: \(K\|1\|2\|3\|4\|5\|6\|7\|8\)<' "$TMP/filters.html" \
    | sed 's/.*gradelevelids="//;s/".*//' | tr ',' '\n' | sort -un | paste -sd, -)
[ -n "$G" ] || { echo "no grade ids parsed — the filter markup changed" >&2; exit 1; }

mkdir -p "$TMP/std"
for pair in 86:math 29:science 87:ela 32:social 36:art 34:music; do
  sid=${pair%%:*}; nm=${pair##*:}
  page=0; total=99999; got=0
  : > "$TMP/std/$nm.html"
  while [ $got -lt $total ] && [ $page -lt 40 ]; do
    curl -fsS -m 180 "$BASE/Search/GetSearchStandard?KeyWord=&SubjectAreaIds=$sid&GradelevelIds=$G&BokIds=&IdeaIds=&CurrentPage=$page" \
         -H "$XHR" -o "$TMP/std/.p"
    n=$(grep -c 'PreviewSliderDetail' "$TMP/std/.p" || true)
    [ "$page" -eq 0 ] && total=$(grep -o 'data-total="[0-9]*"' "$TMP/std/.p" | head -1 | grep -o '[0-9]*' || echo 0)
    cat "$TMP/std/.p" >> "$TMP/std/$nm.html"
    got=$((got + n)); page=$((page + 1))
    [ "$n" -eq 0 ] && break
  done
  echo "→ $nm: $got of $total"
done

node tools/parse-standards.js "$TMP"
node tools/gen-standards.js "$TMP" docs/js/classroom-standards.js
echo "✓ docs/js/classroom-standards.js rebuilt — now run: node tools/stamp-assets.js"
