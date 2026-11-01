#!/bin/sh
# One service of the trace demo. socat runs this once per connection, with
# the request on stdin and the response going to stdout; what it writes to
# stderr is the service's log. DEMO_ROLE says which service it is.

role=$DEMO_ROLE

log() { echo "$*" >&2; }

reply() {
  printf 'HTTP/1.1 %s\r\nContent-Type: application/json\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' \
    "$1" "${#2}" "$2"
  log "← $1"
}

# Calls another service and prints its body. Fails when the service can't
# be reached or doesn't answer with a 2xx.
call() {
  data='{}'
  [ -n "$3" ] && data=$3
  if [ "$1" = POST ]; then
    body=$(wget -qO- -T 3 --header 'Content-Type: application/json' --post-data "$data" "$2" 2>&1)
    code=$?
  else
    body=$(wget -qO- -T 3 "$2" 2>&1)
    code=$?
  fi
  if [ "$code" -ne 0 ]; then
    log "✕ $1 $2: $body"
    return 1
  fi
  log "→ $1 $2"
  printf '%s' "$body"
}

redis_ping() {
  pong=$(printf 'PING\r\nQUIT\r\n' | nc redis 6379 2>&1 | head -n 1 | tr -d '\r')
  log "redis says ${pong:-nothing}"
}

# The request line, the headers, then a body when there is one
read -r method path _
path=$(printf '%s' "$path" | tr -d '\r')
length=0
while read -r line; do
  line=$(printf '%s' "$line" | tr -d '\r')
  [ -z "$line" ] && break
  case $line in
    [Cc]ontent-[Ll]ength:*) length=$(printf '%s' "${line#*:}" | tr -d ' ') ;;
  esac
done
data=
[ "$length" -gt 0 ] 2>/dev/null && data=$(head -c "$length")
[ -n "$method" ] || exit 0
log "$method $path"

case "$role $method $path" in
  "gateway GET /health")
    reply "200 OK" '{"ok":true}'
    ;;
  "gateway GET /rides")
    if rides=$(call GET "http://orders:8080/orders?rider=7") && rider=$(call GET http://users:8080/users/7); then
      reply "200 OK" "{\"rider\":$rider,\"rides\":$rides}"
    else
      reply "502 Bad Gateway" '{"error":"a service behind the gateway did not answer"}'
    fi
    ;;
  "gateway POST /rides")
    if ride=$(call POST http://orders:8080/orders "$data"); then
      reply "201 Created" "$ride"
    else
      reply "502 Bad Gateway" '{"error":"orders could not book the ride"}'
    fi
    ;;
  "gateway GET /users/"*)
    if rider=$(call GET "http://users:8080$path"); then
      reply "200 OK" "$rider"
    else
      reply "502 Bad Gateway" '{"error":"users did not answer"}'
    fi
    ;;
  "orders GET /orders"*)
    redis_ping
    reply "200 OK" '[{"id":"r-104","from":"Ain Diab","to":"Maarif","status":"done"},{"id":"r-105","from":"Gauthier","to":"Anfa","status":"open"}]'
    ;;
  "orders POST /orders")
    redis_ping
    if call POST http://payments:8080/charges '{"amount":42}' >/dev/null; then
      reply "201 Created" '{"id":"r-106","status":"booked"}'
    else
      reply "502 Bad Gateway" '{"error":"payments is unreachable"}'
    fi
    ;;
  "users GET /users/"*)
    reply "200 OK" "{\"id\":\"${path#/users/}\",\"name\":\"Salma\",\"rating\":4.9}"
    ;;
  *)
    reply "404 Not Found" '{"error":"no such route"}'
    ;;
esac
