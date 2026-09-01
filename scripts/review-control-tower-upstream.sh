#!/bin/sh
set -eu

recorded_remote="https://github.com/endcorp-hq/buzz-control-tower.git"
recorded_baseline="bcd86813f735c833cb1cf44795904c8c0afe860e"
review_remote="$recorded_remote"
review_ref=""
review_baseline="$recorded_baseline"

usage() {
  printf '%s\n' \
    "Usage: $0 --ref <git-ref> [--remote <git-url>] [--baseline <commit>]" \
    "" \
    "Fetches into a temporary bare repository and prints a compatibility report." \
    "It never checks out, copies, merges, vendors, or updates BuzzFork files."
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      review_ref="$2"
      shift 2
      ;;
    --remote)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      review_remote="$2"
      shift 2
      ;;
    --baseline)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      review_baseline="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[ -n "$review_ref" ] || { usage >&2; exit 2; }

review_tmp="$(mktemp -d "${TMPDIR:-/tmp}/buzz-control-tower-review.XXXXXX")"
cleanup() {
  [ -n "$review_tmp" ] && [ -d "$review_tmp" ] && find "$review_tmp" -depth -delete
}
trap cleanup EXIT HUP INT TERM

git -C "$review_tmp" init --bare --quiet
git -C "$review_tmp" remote add upstream "$review_remote"
git -C "$review_tmp" fetch --quiet --no-tags upstream "$review_ref"
requested_sha="$(git -C "$review_tmp" rev-parse 'FETCH_HEAD^{commit}')"

git -C "$review_tmp" fetch --quiet --no-tags upstream "$review_baseline"
baseline_sha="$(git -C "$review_tmp" rev-parse 'FETCH_HEAD^{commit}')"

printf 'Control Tower upstream review (report only)\n'
printf 'Remote: %s\n' "$review_remote"
printf 'Requested ref: %s\n' "$review_ref"
printf 'Requested commit: %s\n' "$requested_sha"
printf 'Recorded baseline input: %s\n' "$review_baseline"
printf 'Resolved baseline commit: %s\n' "$baseline_sha"

printf '\nChanged commits (baseline..requested):\n'
if [ "$baseline_sha" = "$requested_sha" ]; then
  printf '(none)\n'
else
  git -C "$review_tmp" log --format='%H %s' "$baseline_sha..$requested_sha" || true
fi

printf '\nChanged files (baseline..requested):\n'
if [ "$baseline_sha" = "$requested_sha" ]; then
  printf '(none)\n'
else
  git -C "$review_tmp" diff --name-status "$baseline_sha" "$requested_sha" || true
fi

license_files="$(
  git -C "$review_tmp" ls-tree -r --name-only "$requested_sha" |
    awk '{ n=$0; sub(/^.*\//, "", n); n=tolower(n); if (n ~ /^(license|licence|copying|notice)(\..*)?$/) print $0 }'
)"
printf '\nLicense-file status at requested commit:\n'
if [ -n "$license_files" ]; then
  printf 'present\n%s\n' "$license_files"
else
  printf 'absent\n'
fi

printf '\nGuarantees:\n'
printf '%s\n' \
  '- temporary bare fetch only; no checkout into BuzzFork' \
  '- no merge, cherry-pick, patch application, vendoring, or source copy' \
  '- no baseline update and no production-state mutation' \
  '- future behavior changes require concept-by-concept independent review'
