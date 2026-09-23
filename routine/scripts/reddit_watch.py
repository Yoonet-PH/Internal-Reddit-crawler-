#!/usr/bin/env python3
"""reddit-watch: find new Reddit posts that mention the watch terms, and new
comments on threads he is following.

Reads Reddit's public RSS feeds, which answer without an API key at roughly
one request a minute. The JSON endpoints return 403 without OAuth, and new
Data API keys need Reddit's manual approval, so RSS is the route until that
lands. Stdlib only.

  reddit_watch.py scan [--days N] [--all] [--peek]
  reddit_watch.py follow <thread url or id> [--note TEXT] [--from-days N]
  reddit_watch.py unfollow <thread url or id>
  reddit_watch.py following
  reddit_watch.py read <thread url or id>
  reddit_watch.py threads [--peek]

Every command prints JSON. State lives in ~/.config/reddit-watch/.
"""

import argparse
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
TERMS_FILE = SKILL_DIR / "terms.txt"
STATE_DIR = Path.home() / ".config" / "reddit-watch"
STATE_FILE = STATE_DIR / "state.json"
FOLLOW_FILE = STATE_DIR / "following.json"
CONFIG_FILE = STATE_DIR / "config.json"

UA = "macos:reddit-watch:v0.1 (personal feed reader)"
ATOM = {"a": "http://www.w3.org/2005/Atom"}
GAP = 62            # seconds between requests, the anonymous budget is one a minute
PAGE = 100          # Reddit's page cap for search
MAX_QUERY = 400     # characters per OR query
FIRST_RUN_DAYS = 14
SEEN_KEEP_DAYS = 90
EXCERPT = 700
QUIET_DAYS = 14     # followed threads with no new comment for this long get flagged

_last_request = 0.0


def now():
    return datetime.now(timezone.utc)


def parse_time(s):
    return datetime.fromisoformat(s)


def load(path, default):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def save(path, data):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(path)


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def fetch(url):
    """GET with the one a minute pacing. Waits out a 429 using Reddit's reset header."""
    global _last_request
    for attempt in range(3):
        wait = _last_request + GAP - time.time()
        if wait > 0:
            log(f"pacing {int(wait)}s")
            time.sleep(wait)
        _last_request = time.time()
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 2:
                reset = float(e.headers.get("x-ratelimit-reset") or GAP)
                log(f"429, Reddit says wait {int(reset)}s")
                time.sleep(reset + 2)
                _last_request = 0.0
                continue
            if e.code == 403:
                raise SystemExit(
                    "Reddit refused the request (403). The anonymous RSS route may have "
                    "closed; see 'If the feed stops answering' in SKILL.md."
                )
            raise


def plain(h):
    """Reddit's Atom content is HTML with a 'submitted by ... [link] [comments]' footer."""
    if "<!-- SC_ON -->" in h:
        h = h.split("<!-- SC_ON -->")[0]
    t = html.unescape(re.sub(r"<[^>]+>", " ", h))
    t = re.sub(r"\s+", " ", t).strip()
    if "<!-- SC_ON -->" not in h and " submitted by " in f" {t} ":
        t = t.rsplit("submitted by", 1)[0].strip()
    return t


def entries(xml_bytes):
    root = ET.fromstring(xml_bytes)
    out = []
    for e in root.findall("a:entry", ATOM):
        eid = e.findtext("a:id", "", ATOM)
        cat = e.find("a:category", ATOM)
        link = e.find("a:link", ATOM)
        out.append({
            "id": eid,
            "kind": {"t1_": "comment", "t3_": "post"}.get(eid[:3], "other"),
            "subreddit": cat.get("label", "") if cat is not None else "",
            "author": e.findtext("a:author/a:name", "", ATOM),
            "title": e.findtext("a:title", "", ATOM),
            "url": link.get("href", "") if link is not None else "",
            "published": e.findtext("a:published", "", ATOM) or e.findtext("a:updated", "", ATOM),
            "text": plain(e.findtext("a:content", "", ATOM)),
        })
    return out, root.findtext("a:title", "", ATOM).removesuffix(" : reddit.com")


def load_terms():
    terms, communities, muted_subs, muted_users = [], [], set(), set()
    for raw in TERMS_FILE.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        low = line.lower()
        if low.startswith("-r/"):
            muted_subs.add(low[3:])
        elif low.startswith("-u/"):
            muted_users.add(low[3:])
        elif low.startswith("r/"):
            communities.append(line[2:])
        else:
            terms.append(line.strip('"'))
    if not terms and not communities:
        raise SystemExit(f"No terms in {TERMS_FILE}")
    return terms, communities, muted_subs, muted_users


def chunk(terms):
    out, cur = [], []
    for t in terms:
        if cur and len(" OR ".join(f'"{x}"' for x in cur + [t])) > MAX_QUERY:
            out.append(cur)
            cur = []
        cur.append(t)
    if cur:
        out.append(cur)
    return out


def search(terms, since, warnings):
    """One OR query for the group. If the page fills before reaching `since`, a loud
    term is crowding the rest out, so split the group and search each half."""
    q = " OR ".join(f'"{t}"' for t in terms)
    url = "https://www.reddit.com/search.rss?" + urllib.parse.urlencode(
        {"q": q, "sort": "new", "limit": PAGE})
    log(f"search {q}")
    items = [i for i in entries(fetch(url))[0] if i["kind"] == "post"]
    full = len(items) >= PAGE - 5 and items and parse_time(items[-1]["published"]) > since
    if full and len(terms) > 1:
        mid = len(terms) // 2
        return search(terms[:mid], since, warnings) + search(terms[mid:], since, warnings)
    if full:
        warnings.append(
            f'"{terms[0]}" filled a whole page ({len(items)} posts) inside the window, so '
            "older matches were missed. Scan more often, or narrow or mute the term.")
    return items


def community_posts(name):
    url = f"https://www.reddit.com/r/{urllib.parse.quote(name)}/new/.rss?limit={PAGE}"
    log(f"community r/{name}")
    return [i for i in entries(fetch(url))[0] if i["kind"] == "post"]


def matches(term, blob):
    return re.search(r"(?<!\w)" + re.escape(term) + r"(?!\w)", blob, re.I) is not None


def squash(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def matched_terms(item, terms):
    """Reddit's search stems words and ignores quotes ("Clinic Sites" returns every
    nursing post about clinical sites), so a hit must contain the exact phrase or
    sit in a community named after the term."""
    blob = f'{item["title"]} {item["text"]}'
    found = [t for t in terms if matches(t, blob)]
    sub = squash(item["subreddit"].removeprefix("r/"))
    found += [f"{t} (community)" for t in terms if t not in found and squash(t) == sub]
    return found


def cmd_scan(args):
    terms, communities, muted_subs, muted_users = load_terms()
    state = load(STATE_FILE, {"lastScanISO": None, "seen": {}})
    t0 = now()
    if args.days:
        since = t0 - timedelta(days=args.days)
    elif state["lastScanISO"]:
        since = parse_time(state["lastScanISO"]) - timedelta(hours=1)
    else:
        since = t0 - timedelta(days=FIRST_RUN_DAYS)

    warnings, found, loose = [], {}, 0
    candidates = [(i, None) for group in chunk(terms) for i in search(group, since, warnings)]
    for name in communities:
        posts = community_posts(name)
        if len(posts) >= PAGE - 5 and parse_time(posts[-1]["published"]) > since:
            warnings.append(f"r/{name} posted a full page inside the window, older posts were missed.")
        candidates += [(i, f"r/{name}") for i in posts]

    for i, community in candidates:
        if parse_time(i["published"]) < since:
            continue
        if i["id"] in state["seen"] and not args.all:
            continue
        if i["subreddit"].removeprefix("r/").lower() in muted_subs:
            continue
        if i["author"].removeprefix("/u/").lower() in muted_users:
            continue
        hit = found.get(i["id"], i)
        terms_hit = matched_terms(i, terms)
        if community:
            terms_hit.append(community)
        if not terms_hit and i["id"] not in found:
            loose += 1
            continue
        hit["matched"] = sorted(set(hit.get("matched", []) + terms_hit))
        hit["text"] = i["text"][:EXCERPT]
        found[i["id"]] = hit

    hits = sorted(found.values(), key=lambda i: i["published"], reverse=True)
    if not args.peek:
        stamp = t0.isoformat()
        for h in hits:
            state["seen"].setdefault(h["id"], stamp)
        cutoff = t0 - timedelta(days=SEEN_KEEP_DAYS)
        state["seen"] = {k: v for k, v in state["seen"].items() if parse_time(v) > cutoff}
        state["lastScanISO"] = stamp
        save(STATE_FILE, state)
    json.dump({"since": since.isoformat(), "terms": terms, "communities": communities,
               "hits": hits, "droppedLoose": loose, "warnings": warnings,
               "stateWritten": not args.peek}, sys.stdout, indent=2)
    print()


def thread_id(s):
    m = re.search(r"comments/([a-z0-9]+)", s) or re.fullmatch(r"(?:t3_)?([a-z0-9]+)", s.strip())
    if not m:
        raise SystemExit(f"Not a Reddit thread url or id: {s}")
    return m.group(1)


def cmd_follow(args):
    following = load(FOLLOW_FILE, {})
    tid = thread_id(args.thread)
    start = now() - timedelta(days=args.from_days)
    following[tid] = {
        "url": args.thread if args.thread.startswith("http") else f"https://www.reddit.com/comments/{tid}/",
        "title": following.get(tid, {}).get("title", ""),
        "note": args.note or following.get(tid, {}).get("note", ""),
        "added": now().isoformat(),
        "lastCheckedISO": start.isoformat(),
        "lastActivityISO": start.isoformat(),
    }
    save(FOLLOW_FILE, following)
    json.dump({"following": tid, "from": start.isoformat()}, sys.stdout)
    print()


def cmd_unfollow(args):
    following = load(FOLLOW_FILE, {})
    tid = thread_id(args.thread)
    removed = following.pop(tid, None) is not None
    save(FOLLOW_FILE, following)
    json.dump({"unfollowed": tid, "wasFollowing": removed}, sys.stdout)
    print()


def cmd_following(args):
    json.dump(load(FOLLOW_FILE, {}), sys.stdout, indent=2)
    print()


def cmd_read(args):
    tid = thread_id(args.thread)
    items, title = entries(fetch(f"https://www.reddit.com/comments/{tid}/.rss?limit={PAGE}"))
    json.dump({"id": tid, "title": title, "entries": items}, sys.stdout, indent=2)
    print()


def cmd_threads(args):
    following = load(FOLLOW_FILE, {})
    me = load(CONFIG_FILE, {}).get("username", "").removeprefix("u/").lower()
    t0 = now()
    report = []
    for tid, t in following.items():
        url = f"https://www.reddit.com/comments/{tid}/.rss?" + urllib.parse.urlencode(
            {"sort": "new", "limit": PAGE})
        log(f"thread {tid}")
        items, feed_title = entries(fetch(url))
        if feed_title and not t.get("title"):
            t["title"] = feed_title
        after = parse_time(t["lastCheckedISO"])
        new = []
        for i in items:
            if i["kind"] != "comment" or parse_time(i["published"]) <= after:
                continue
            i["mine"] = bool(me) and i["author"].removeprefix("/u/").lower() == me
            i["text"] = i["text"][:EXCERPT]
            new.append(i)
        new.sort(key=lambda i: i["published"])
        if new:
            t["lastActivityISO"] = new[-1]["published"]
        quiet = (t0 - parse_time(t["lastActivityISO"])).days
        report.append({"id": tid, "title": t["title"], "url": t["url"], "note": t["note"],
                       "newComments": new, "daysQuiet": quiet,
                       "suggestUnfollow": not new and quiet >= QUIET_DAYS})
        if not args.peek:
            t["lastCheckedISO"] = t0.isoformat()
    if not args.peek:
        save(FOLLOW_FILE, following)
    json.dump({"threads": report, "stateWritten": not args.peek}, sys.stdout, indent=2)
    print()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan", help="new posts mentioning the terms in terms.txt")
    s.add_argument("--days", type=float, help="look back this many days instead of since the last scan")
    s.add_argument("--all", action="store_true", help="include posts already reported")
    s.add_argument("--peek", action="store_true", help="do not write state")
    s.set_defaults(fn=cmd_scan)

    f = sub.add_parser("follow", help="watch a thread for new comments")
    f.add_argument("thread")
    f.add_argument("--note", help="why it is followed, e.g. 'replied 22/09'")
    f.add_argument("--from-days", type=float, default=0, help="also report comments from the last N days")
    f.set_defaults(fn=cmd_follow)

    u = sub.add_parser("unfollow")
    u.add_argument("thread")
    u.set_defaults(fn=cmd_unfollow)

    sub.add_parser("following").set_defaults(fn=cmd_following)

    r = sub.add_parser("read", help="print a thread's post and comments")
    r.add_argument("thread")
    r.set_defaults(fn=cmd_read)

    t = sub.add_parser("threads", help="new comments on followed threads")
    t.add_argument("--peek", action="store_true", help="do not write state")
    t.set_defaults(fn=cmd_threads)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
