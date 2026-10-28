#!/usr/bin/env python3
"""Turn a Google Form responses CSV into data/people.json.

Usage:
    python scripts/sync.py responses.csv [--no-geocode] [--dry-run]

Only people whose latest response gives consent and is not a removal request
are written. Emails are used to find each person's latest response and are
never written to the repo.
"""
import argparse
import csv
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PEOPLE = ROOT / "data" / "people.json"
PLACES = ROOT / "data" / "places.csv"
TAGS = ROOT / "data" / "tags.json"

# Form question text (start of the column header) for each field.
# If a question is reworded in the form, change it here.
COLUMNS = {
    "timestamp": "Timestamp",
    "email": "Email Address",
    "name": "Name (English)",
    "name_ko": "Name (Korean)",
    "role": "Position",
    "title": "Title",
    "affiliation": "Affiliation",
    "lab": "Lab / Department",
    "city": "City",
    "country": "Country",
    "research": "Research areas",
    "homepage": "Homepage",
    "scholar": "Google Scholar",
    "linkedin": "LinkedIn",
    "github": "GitHub",
    "cv": "CV",
    "action": "Action",
    "consent": "Consent",
    "hidden": "Hidden",  # organizer-only column added to the response Sheet
}
REQUIRED = ["timestamp", "name", "affiliation", "consent"]

ROLES = {"student", "postdoc", "faculty", "industry", "other"}
SECTOR = {"student": "Academia", "postdoc": "Academia", "faculty": "Academia", "industry": "Industry"}
LINK_HOSTS = {"scholar": "scholar.google.", "linkedin": "linkedin.com", "github": "github.com"}
PLACE_FIELDS = ["affiliation", "aliases", "city", "region", "country", "lat", "lng", "needs_review"]
COUNTRIES = {"us": "USA", "united states": "USA", "united states of america": "USA",
             "korea": "South Korea", "republic of korea": "South Korea", "uk": "United Kingdom"}
USER_AGENT = "KARA-directory-sync/1.0 (https://koreanrobotics.github.io/directory/)"


def norm(s):
    s = re.sub(r"[^a-z0-9 ]", " ", s.lower())
    s = re.sub(r"^the ", "", " ".join(s.split()))
    return s


def country_name(s):
    return COUNTRIES.get(norm(s), s.strip())


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "person"


def parse_time(s):
    for fmt in ("%m/%d/%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%m/%d/%Y"):
        try:
            return datetime.strptime(s.strip(), fmt)
        except ValueError:
            pass
    raise ValueError(f"unrecognized timestamp: {s!r}")


def map_columns(header):
    idx = {}
    for field, question in COLUMNS.items():
        q = norm(question)
        for i, h in enumerate(header):
            if norm(h) == q or norm(h).startswith(q + " "):
                idx[field] = i
                break
    missing = [f for f in REQUIRED if f not in idx]
    if missing:
        sys.exit(f"Missing form columns: {', '.join(COLUMNS[f] for f in missing)}")
    return idx


def clean_url(kind, value):
    """Return (url, problem). Empty input gives (None, None)."""
    v = value.strip()
    if not v:
        return None, None
    if kind == "github" and re.fullmatch(r"[A-Za-z0-9-]+", v):
        v = "https://github.com/" + v
    if not re.match(r"https?://", v, re.I):
        v = "https://" + v
    parts = urllib.parse.urlsplit(v)
    host = parts.netloc.lower()
    if "." not in host or " " in v:
        return None, f"{kind}: not a URL ({value.strip()!r})"
    if kind in LINK_HOSTS and LINK_HOSTS[kind] not in host:
        return None, f"{kind}: expected a {LINK_HOSTS[kind]} link ({value.strip()!r})"
    return urllib.parse.urlunsplit(("https", parts.netloc, parts.path, parts.query, parts.fragment)), None


def load_places():
    with open(PLACES, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    index = {}
    for r in rows:
        for name in [r["affiliation"]] + [a for a in r["aliases"].split("|") if a]:
            index[norm(name)] = r
    return rows, index


def geocode(query):
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": query, "format": "jsonv2", "limit": 1, "addressdetails": 1, "accept-language": "en"}
    )
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    time.sleep(1.1)  # Nominatim usage policy: at most 1 request per second
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            hits = json.load(resp)
    except OSError as e:
        print(f"  geocode failed for {query!r}: {e}")
        return None
    if not hits:
        return None
    a = hits[0].get("address", {})
    return {
        "city": a.get("city") or a.get("town") or a.get("village") or a.get("county", ""),
        "region": a.get("state", ""),
        "country": country_name(a.get("country", "")),
        "lat": f"{float(hits[0]['lat']):.4f}",
        "lng": f"{float(hits[0]['lon']):.4f}",
    }


def resolve_place(aff, city, country, rows, index, use_geocode):
    """Find (or geocode and record) the place for an affiliation. Returns a places.csv row or None."""
    hit = index.get(norm(aff))
    if hit or not use_geocode:
        return hit
    queries = [f"{aff}, {city}" if city else aff]
    if city:
        queries.append(f"{city}, {country}" if country else city)
    for q in queries:
        g = geocode(q)
        if g:
            row = {"affiliation": aff, "aliases": "", **g, "needs_review": "1"}
            rows.append(row)
            index[norm(aff)] = row
            return row
    return None


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("responses", help="CSV downloaded from the form's response Sheet")
    ap.add_argument("--no-geocode", action="store_true", help="don't look up unknown affiliations online")
    ap.add_argument("--dry-run", action="store_true", help="report changes without writing files")
    args = ap.parse_args()

    tags = json.loads(TAGS.read_text(encoding="utf-8"))
    tag_lookup = {t.lower(): t for t in tags}
    places, place_index = load_places()
    n_places = len(places)

    with open(args.responses, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader)
        col = map_columns(header)
        responses = [r for r in reader if any(c.strip() for c in r)]

    def get(row, field):
        i = col.get(field)
        return row[i].strip() if i is not None and i < len(row) else ""

    # Latest response per person (by email, falling back to name). Without an
    # email column (data/responses.csv, already collapsed by the Apps Script)
    # every row is a different person, even if two share a name.
    latest, hidden = {}, set()
    for n, r in enumerate(responses):
        key = (get(r, "email").lower() or norm(get(r, "name"))) if "email" in col else n
        if get(r, "hidden"):
            hidden.add(key)  # hiding any row hides the person
        t = parse_time(get(r, "timestamp"))
        if key not in latest or t >= latest[key][0]:
            latest[key] = (t, r)

    people, problems, unknown_tags, unplaced = [], [], set(), []
    skipped = {"no consent": 0, "removed": 0, "hidden": 0}
    for key, (t, r) in latest.items():
        name = get(r, "name")
        if key in hidden:
            skipped["hidden"] += 1
            continue
        if get(r, "action").lower().startswith("remove"):
            skipped["removed"] += 1
            continue
        if not get(r, "consent"):
            skipped["no consent"] += 1
            continue

        role = get(r, "role").lower()
        role = role if role in ROLES else "other"
        research = []
        for item in get(r, "research").split(","):
            item = item.strip()
            if item.lower() in tag_lookup:
                research.append(tag_lookup[item.lower()])
            elif item:
                unknown_tags.add(item)
        links = {}
        for kind in ("homepage", "scholar", "linkedin", "github", "cv"):
            url, problem = clean_url(kind, get(r, kind))
            if url:
                links[kind] = url
            if problem:
                problems.append(f"{name}: {problem}")

        aff = get(r, "affiliation")
        p = resolve_place(aff, get(r, "city"), get(r, "country"), places, place_index, not args.no_geocode)
        if p:
            place = {k: p[k] for k in ("city", "region", "country")}
            place.update(lat=float(p["lat"]), lng=float(p["lng"]))
            aff = p["affiliation"]  # canonical name, so aliases group on the map
        else:
            place = {"city": get(r, "city"), "region": "", "country": country_name(get(r, "country")), "lat": None, "lng": None}
            unplaced.append(f"{name} ({aff})")

        person = {
            "name": name,
            "name_ko": get(r, "name_ko"),
            "role": role,
            "title": get(r, "title"),
            "affiliation": aff,
            "sector": SECTOR.get(role, "Other"),
            "lab": get(r, "lab"),
            "research": research,
            "links": links,
            "place": place,
            "updated": t.strftime("%Y-%m-%d"),
        }
        people.append({k: v for k, v in person.items() if v not in ("", None)})

    people.sort(key=lambda p: p["name"].lower())
    seen = {}
    for p in people:
        base = slug(p["name"])
        seen[base] = seen.get(base, 0) + 1
        p["id"] = base if seen[base] == 1 else f"{base}-{seen[base]}"
    people = [{"id": p.pop("id"), **p} for p in people]

    old = {p["id"]: p for p in json.loads(PEOPLE.read_text(encoding="utf-8"))} if PEOPLE.exists() else {}
    new = {p["id"]: p for p in people}
    strip = lambda p: {k: v for k, v in p.items() if k != "updated"}
    added = sorted(new.keys() - old.keys())
    removed = sorted(old.keys() - new.keys())
    updated = sorted(i for i in new.keys() & old.keys() if strip(new[i]) != strip(old[i]))

    print(f"{len(responses)} responses -> {len(people)} listed "
          f"(skipped: {skipped['no consent']} without consent, {skipped['removed']} removed, {skipped['hidden']} hidden)")
    for label, ids in (("added", added), ("updated", updated), ("removed", removed)):
        if ids:
            print(f"  {label}: {', '.join(ids)}")
    for msg in problems:
        print(f"  dropped link - {msg}")
    if unknown_tags:
        print(f"  research areas not in tags.json (not published): {', '.join(sorted(unknown_tags))}")
    if unplaced:
        print(f"  no map location: {', '.join(unplaced)}")
    review = sorted({p["affiliation"] for p in places if p.get("needs_review")})
    if review:
        print(f"  places.csv rows to check (needs_review=1): {', '.join(review)}")

    if args.dry_run:
        print("dry run: nothing written")
        return
    PEOPLE.write_text(json.dumps(people, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    if len(places) > n_places:
        with open(PLACES, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=PLACE_FIELDS, lineterminator="\n")
            w.writeheader()
            w.writerows(places)
    print(f"wrote {PEOPLE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
