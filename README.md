# KARA Directory

Browse members of the Korean-American Robotics Association by school, company, research area, and location.
Live at **https://koreanrobotics.github.io/directory/**.

Listing is **opt-in**: people add themselves through a Google Form, and only those who tick the consent box appear, with only the fields they gave. Emails never leave the Google Sheet.

## How it works

```
Google Form ──> response Sheet ──(Apps Script, on each submission)──> data/responses.csv
                                                                          │
                       GitHub Action: scripts/sync.py ──> data/people.json ──> GitHub Pages
```

1. Someone submits the form (Google sign-in required, so nobody can edit another person's entry).
2. The Apps Script in `apps-script/kara-directory.gs` keeps each person's latest response, drops removal requests, people without consent, and rows an organizer marked **Hidden**, removes emails, and commits `data/responses.csv`.
3. The **Sync and deploy** Action runs `scripts/sync.py` (validates links, matches research areas, places affiliations on the map), commits `data/people.json`, and redeploys. The update is live in about two minutes.

To update an entry, a person submits the form again (or edits their response). To be removed, they choose "Remove my entry".

## Files

| File | What it is |
|---|---|
| `index.html`, `app.js`, `style.css` | The page. No build step. `FORM_URL` at the top of `app.js` shows the "Add yourself" button. |
| `data/responses.csv` | Consenting, latest responses without emails. Written by the Apps Script; don't edit. |
| `data/seed.csv` | Entries organizers add by hand (currently the organizers and advisors from the main site). Same columns as the form; a form submission with the same name replaces the row. |
| `data/people.json` | What the page shows. Written by the Action; don't edit. |
| `data/places.csv` | Affiliation → map location, with `|`-separated aliases. Edit freely. |
| `data/tags.json` | Research areas offered in the form and used as filters. |
| `scripts/sync.py` | `responses.csv` → `people.json`. Python 3 standard library only. |
| `apps-script/kara-directory.gs` | Creates the form and publishes responses. Lives in the Google Sheet. |
| `.github/workflows/deploy.yml` | Runs the sync and deploys the site on every push. |

## One-time setup

1. **GitHub token.** GitHub → Settings → Developer settings → Fine-grained tokens → Generate. Resource owner: `KoreanRobotics`; Repository access: only `KoreanRobotics/directory`; Permissions: **Contents: Read and write**. If it shows "pending", an org owner approves it under the org's Settings → Personal access tokens.
2. **Sheet + script.** Create a blank Google Sheet (e.g. "KARA Directory responses") in an account organizers share. Open Extensions → Apps Script, replace the code with `apps-script/kara-directory.gs`, and save.
3. **Store the token.** In the Apps Script editor: Project Settings → Script properties → add `GITHUB_TOKEN` with the token.
4. **Run `setup`.** Pick `setup` in the function dropdown and Run; approve the permissions. It creates the form with the right questions, links it to the Sheet, adds the **Hidden** column, and installs the triggers (on submit, plus every 6 hours as a backup). The execution log prints the form link.
5. **Check the form.** Open it from the log's editor link. Under Settings → Responses, "Collect email addresses" should be **Verified**.
6. **Turn on the button.** Put the form link in `FORM_URL` in `app.js` and push.

Run `setup` only once; running it again creates a second form.

## Organizer tasks

- **Hide someone** (spam, a request by email): put an `x` in their **Hidden** cell, then use the Sheet's **KARA → Publish directory now** menu (or wait up to 6 hours).
- **New affiliations** are looked up on OpenStreetMap and added to `data/places.csv` with `needs_review=1` (listed in each Action run's summary). Check the city and coordinates, add aliases (e.g. `UMich|Michigan`) so spellings group under one pin, and clear the flag.
- **Add someone by hand**: add a row to `data/seed.csv` and push. To remove a seed entry, delete its row (a "Remove my entry" form submission does not remove seed rows).
- **Research areas**: edit `data/tags.json`, then update the form's "Research areas" checkbox options to match exactly.
- **Rewording a form question**: also edit `COLUMNS` at the top of `scripts/sync.py`; columns are matched by the start of the question text.

Removed entries disappear from the site, but earlier versions remain in this repo's git history.

## Run locally

```
python scripts/sync.py tests/fixture.csv --no-geocode   # fake data; don't commit the result
python -m http.server 8000                              # then open http://localhost:8000
```

`sync.py` also accepts the raw Sheet export (with emails) if you ever need to sync by hand; keep that file outside the repo.
