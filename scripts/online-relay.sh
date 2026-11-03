#!/usr/bin/env bash
# Online games: puts the relay (relay/) on Cloudflare and writes its address into the app
# (js/siege/online-config.js) before the web app and APK are built.
# Needs the repository secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID; without them
# the build goes ahead with online games switched off. DEPLOY=0: only look up the address.
set -uo pipefail
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "No Cloudflare secrets: online games are off in this build."
  exit 0
fi
if [ "${DEPLOY:-1}" = "1" ]; then
  (cd relay && npx -y wrangler@4 deploy) || echo "::warning::Couldn't deploy the online relay; using the one already there (if any)."
fi
sub=$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" \
  | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d;}).on("end",()=>{try{process.stdout.write(JSON.parse(s).result?.subdomain||"");}catch{}})')
if [ -z "$sub" ]; then
  echo "::warning::Couldn't find your workers.dev subdomain (open Workers & Pages in Cloudflare once to pick one). Online games are off in this build."
  exit 0
fi
url="wss://wonder-wars-relay.$sub.workers.dev"
sed -i "s#^export const RELAY = .*#export const RELAY = '$url';#" js/siege/online-config.js
echo "Online games relay: $url"
