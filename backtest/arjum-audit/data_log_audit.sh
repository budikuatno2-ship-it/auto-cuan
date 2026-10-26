#!/usr/bin/env bash
# Read-only /data/* access-log aggregation for the security audit (A3).
# Prints only counts, paths and dates. Never prints client IPs.
set -uo pipefail
cd /var/log/nginx || exit 1
files=(autocuan_access.log autocuan_access.log.1)
for i in 2 3 4 5 6 7 8 9; do files+=("autocuan_access.log.${i}.gz"); done

echo "=== A3.1 PER-DAY /data/ REQUEST COUNTS ==="
zcat -f "${files[@]}" 2>/dev/null | awk '
{ p=$7; qi=index(p,"?"); if(qi>0) p=substr(p,1,qi-1);
  if (p ~ /^\/data\//) { day=substr($4,2,11); all[day]++;
    if (p ~ /^\/data\/bandarmologi-intel-indexes\/latest_/) lg[day]++; else nl[day]++ } }
END { for(d in all) printf "%s total=%d legit=%d nonlegit=%d\n", d, all[d], lg[d]+0, nl[d]+0 }' | sort

echo "=== A3.2 TOTAL + DISTINCT ==="
zcat -f "${files[@]}" 2>/dev/null | awk '
{ p=$7; qi=index(p,"?"); if(qi>0) p=substr(p,1,qi-1);
  if (p ~ /^\/data\//) { t++;
    if (p ~ /^\/data\/bandarmologi-intel-indexes\/latest_/) l++; else { n++; seen[p]=1 } } }
END { d=0; for(k in seen) d++; printf "all_data=%d legit=%d nonlegit=%d distinct_nonlegit_paths=%d\n", t, l+0, n+0, d }'

echo "=== A3.3 TOP 40 NON-LEGIT PATHS ==="
zcat -f "${files[@]}" 2>/dev/null | awk '
{ p=$7; qi=index(p,"?"); if(qi>0) p=substr(p,1,qi-1);
  if (p ~ /^\/data\// && p !~ /^\/data\/bandarmologi-intel-indexes\/latest_/) c[p]++ }
END { for(k in c) print c[k], k }' | sort -rn | head -40

echo "=== A3.4 NON-LEGIT DIRECTORY PREFIXES ==="
zcat -f "${files[@]}" 2>/dev/null | awk '
{ p=$7; qi=index(p,"?"); if(qi>0) p=substr(p,1,qi-1);
  if (p ~ /^\/data\// && p !~ /^\/data\/bandarmologi-intel-indexes\/latest_/) {
    n=p; sub(/\/[^/]*$/,"",n); c[n]++ } }
END { for(k in c) print c[k], k }' | sort -rn | head -20

echo "=== A3.5 LEGIT PATHS SEEN ==="
zcat -f "${files[@]}" 2>/dev/null | awk '
{ p=$7; qi=index(p,"?"); if(qi>0) p=substr(p,1,qi-1);
  if (p ~ /^\/data\/bandarmologi-intel-indexes\/latest_/) c[p]++ }
END { for(k in c) print c[k], k }' | sort -rn | head -20