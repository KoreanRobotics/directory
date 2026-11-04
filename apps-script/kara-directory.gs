// KARA Directory: Google Apps Script for the form's response Sheet.
//
// Setup (once): create a blank Google Sheet, open Extensions > Apps Script,
// paste this file, set the GITHUB_TOKEN script property, and run setup().
// See the README for details.
//
// On every form submission, publish() collapses the responses to each
// person's latest one, keeps only people an organizer marked in the
// "Approved" column, drops people without consent, removal requests and rows
// marked "Hidden", removes the email and organizer columns, and commits the
// result to data/responses.csv. A GitHub Action then turns that file into
// data/people.json and redeploys the site.
//
// Approval is per person (by verified email): once approved, later updates
// from the same Google account go live without another review. If the
// NOTIFY_EMAILS script property is set (comma-separated), those addresses get
// an email when someone new is waiting for approval.

const REPO = "KoreanRobotics/directory";
const CSV_PATH = "data/responses.csv";
const TAGS_URL = "https://koreanrobotics.github.io/directory/data/tags.json";
const SITE_URL = "koreanrobotics.github.io/directory";
const CONSENT_TEXT = `I agree to have the information above listed publicly at ${SITE_URL}.`;

// ---- one-time setup ----

function setup() {
  const ss = SpreadsheetApp.getActive();
  const tags = JSON.parse(UrlFetchApp.fetch(TAGS_URL).getContentText());

  const form = FormApp.create("KARA Directory");
  form.setDescription(
    `Add yourself to the KARA member directory (https://${SITE_URL}/). ` +
    "Only what you enter here is shown, and only if you tick the consent box. Your email is never published. " +
    "New entries appear after an organizer approves them. " +
    "To update your entry, submit again; to be removed, choose \"Remove my entry\"."
  );
  try {
    form.setEmailCollectionType(FormApp.EmailCollectionType.VERIFIED);
  } catch (e) {
    form.setCollectEmail(true); // older API: then set "Verified" by hand in the form's Settings > Responses
  }
  form.setAllowResponseEdits(true);

  form.addTextItem().setTitle("Name (English)").setRequired(true);
  form.addTextItem().setTitle("Name (Korean)");
  form.addMultipleChoiceItem().setTitle("Position").setRequired(true)
    .setChoiceValues(["Student", "Postdoc", "Faculty", "Industry", "Other"]);
  form.addTextItem().setTitle("Title").setHelpText('e.g. "Ph.D. Student", "Research Scientist"');
  form.addTextItem().setTitle("Affiliation").setHelpText("University or company").setRequired(true);
  form.addTextItem().setTitle("Lab / Department");
  form.addTextItem().setTitle("City").setHelpText("Where your affiliation is; used for the map");
  form.addTextItem().setTitle("Country");
  form.addCheckboxItem().setTitle("Research areas").setChoiceValues(tags).showOtherOption(true);
  form.addTextItem().setTitle("Homepage");
  form.addTextItem().setTitle("Google Scholar");
  form.addTextItem().setTitle("LinkedIn");
  form.addTextItem().setTitle("GitHub").setHelpText("URL or username");
  form.addTextItem().setTitle("CV").setHelpText("Link to a CV you host (PDF or page)");
  form.addMultipleChoiceItem().setTitle("Action").setRequired(true)
    .setChoiceValues(["Add or update my entry", "Remove my entry"]);
  form.addCheckboxItem().setTitle("Consent").setChoiceValues([CONSENT_TEXT]);

  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  SpreadsheetApp.flush();

  ensureColumns(responseSheet()); // otherwise added on the first publish

  ScriptApp.newTrigger("publish").forSpreadsheet(ss).onFormSubmit().create();
  ScriptApp.newTrigger("publish").timeBased().everyHours(6).create(); // catches missed or failed runs

  Logger.log("Form (share this): " + form.getPublishedUrl());
  Logger.log("Form editor: " + form.getEditUrl());
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu("KARA").addItem("Publish directory now", "publish").addToUi();
}

// ---- publishing ----

function publish(e) {
  const sheet = responseSheet();
  ensureColumns(sheet);
  const range = sheet.getDataRange();
  const display = range.getDisplayValues();
  const values = range.getValues();
  const csv = buildResponsesCsv(display[0], display.slice(1), values.slice(1).map((r) => r[0]));
  commitIfChanged(csv);
  if (e && e.namedValues) notifyIfPending(e.namedValues, display[0], display.slice(1));
}

// Organizer columns, appended to the right of the form's columns.
function ensureColumns(sheet) {
  const last = sheet.getLastColumn();
  if (!last || sheet.getRange(1, 1).getValue() !== "Timestamp") return; // no responses yet
  const header = sheet.getRange(1, 1, 1, last).getDisplayValues()[0].map((h) => h.trim().toLowerCase());
  let col = last;
  for (const [name, note] of [
    ["Approved", "Organizers: put an x here to list this person. Approval carries over to their later updates."],
    ["Hidden", "Organizers: put an x here to hide this person, even if approved."],
  ]) {
    if (!header.includes(name.toLowerCase())) sheet.getRange(1, ++col).setValue(name).setNote(note);
  }
}

function notifyIfPending(named, header, rows) {
  const to = PropertiesService.getScriptProperties().getProperty("NOTIFY_EMAILS");
  if (!to) return;
  const v = (k) => String((named[k] || [""])[0]).trim();
  if (v("Action").toLowerCase().startsWith("remove") || !v("Consent")) return;
  if (isApproved(header, rows, v("Email address"))) return;
  MailApp.sendEmail(to, `KARA directory: ${v("Name (English)")} is waiting for approval`,
    `${v("Name (English)")} (${v("Affiliation")}, ${v("Email address")}) asked to be listed.\n\n` +
    `To approve, put an x in their "Approved" cell and use KARA > Publish directory now:\n` +
    SpreadsheetApp.getActive().getUrl());
}

function responseSheet() {
  const sheet = SpreadsheetApp.getActive().getSheets().find((s) => s.getFormUrl());
  if (!sheet) throw new Error("No form response sheet found. Run setup() first.");
  return sheet;
}

function commitIfChanged(csv) {
  const token = PropertiesService.getScriptProperties().getProperty("GITHUB_TOKEN");
  if (!token) throw new Error("Set the GITHUB_TOKEN script property (Project Settings > Script properties).");
  const url = `https://api.github.com/repos/${REPO}/contents/${CSV_PATH}`;
  const headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" };

  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = UrlFetchApp.fetch(url, { headers, muteHttpExceptions: true });
    let sha;
    if (cur.getResponseCode() === 200) {
      const file = JSON.parse(cur.getContentText());
      const old = Utilities.newBlob(Utilities.base64Decode(file.content.replace(/\n/g, ""))).getDataAsString("UTF-8");
      if (old === csv) return;
      sha = file.sha;
    }
    const res = UrlFetchApp.fetch(url, {
      method: "put",
      headers,
      contentType: "application/json",
      muteHttpExceptions: true,
      payload: JSON.stringify({
        message: "Update form responses",
        content: Utilities.base64Encode(csv, Utilities.Charset.UTF_8),
        sha,
      }),
    });
    const code = res.getResponseCode();
    if (code === 200 || code === 201) return;
    if (code !== 409) throw new Error(`GitHub returned ${code}: ${res.getContentText()}`);
    Utilities.sleep(2000); // someone else committed in between; retry against the new version
  }
  throw new Error("Could not commit after 3 attempts.");
}

// ---- pure logic (no Apps Script services; tested with node) ----

const PRIVATE_COLUMNS = ["email address", "approved", "hidden"];

const colFinder = (header) => (name) => header.findIndex((h) => h.trim().toLowerCase().startsWith(name));

function personKey(r, iEmail, iName) {
  return (iEmail >= 0 && r[iEmail].trim().toLowerCase()) || r[iName].trim().toLowerCase();
}

// Marked people, by email: an x in any of a person's rows counts.
function markedKeys(header, rows, column) {
  const find = colFinder(header);
  const iEmail = find("email address"), iName = find("name (english)"), iCol = find(column);
  const keys = new Set();
  if (iCol < 0) return keys;
  for (const r of rows) if (r[iCol].trim()) keys.add(personKey(r, iEmail, iName));
  return keys;
}

function isApproved(header, rows, email) {
  return markedKeys(header, rows, "approved").has(email.trim().toLowerCase());
}

function buildResponsesCsv(header, rows, times) {
  const find = colFinder(header);
  const iEmail = find("email address");
  const iName = find("name (english)");
  const iAction = find("action");
  const iConsent = find("consent");
  const approved = markedKeys(header, rows, "approved"); // no Approved column: nobody is published
  const hidden = markedKeys(header, rows, "hidden");

  const latest = new Map();
  rows.forEach((r, n) => {
    if (!r.some((c) => String(c).trim())) return;
    const key = personKey(r, iEmail, iName);
    const t = new Date(times[n]).getTime();
    if (!latest.has(key) || t >= latest.get(key).t) latest.set(key, { t, r });
  });

  const keep = header.map((h, i) => i).filter((i) => !PRIVATE_COLUMNS.includes(header[i].trim().toLowerCase()));
  const out = [keep.map((i) => header[i])];
  for (const [key, { r }] of latest) {
    if (!approved.has(key) || hidden.has(key)) continue;
    if (iAction >= 0 && r[iAction].trim().toLowerCase().startsWith("remove")) continue;
    if (iConsent < 0 || !r[iConsent].trim()) continue;
    out.push(keep.map((i) => r[i]));
  }
  const cell = (v) => (/[",\n\r]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return out.map((row) => row.map(cell).join(",")).join("\n") + "\n";
}

if (typeof module !== "undefined") module.exports = { buildResponsesCsv, isApproved };
