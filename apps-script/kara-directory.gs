// KARA Directory: Google Apps Script for the form's response Sheet.
//
// Setup (once): create a blank Google Sheet, open Extensions > Apps Script,
// paste this file, set the GITHUB_TOKEN script property, and run setup().
// See the README for details.
//
// On every form submission, publish() collapses the responses to each
// person's latest one, drops people without consent, removal requests and
// rows an organizer marked in the "Hidden" column, removes the email column,
// and commits the result to data/responses.csv. A GitHub Action then turns
// that file into data/people.json and redeploys the site.

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

  const sheet = responseSheet();
  sheet.getRange(1, sheet.getLastColumn() + 1).setValue("Hidden").setNote("Organizers: put an x here to hide this person.");

  ScriptApp.newTrigger("publish").forSpreadsheet(ss).onFormSubmit().create();
  ScriptApp.newTrigger("publish").timeBased().everyHours(6).create(); // catches missed or failed runs

  Logger.log("Form (share this): " + form.getPublishedUrl());
  Logger.log("Form editor: " + form.getEditUrl());
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu("KARA").addItem("Publish directory now", "publish").addToUi();
}

// ---- publishing ----

function publish() {
  const range = responseSheet().getDataRange();
  const display = range.getDisplayValues();
  const values = range.getValues();
  const csv = buildResponsesCsv(display[0], display.slice(1), values.slice(1).map((r) => r[0]));
  commitIfChanged(csv);
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

const PRIVATE_COLUMNS = ["email address", "hidden"];

function buildResponsesCsv(header, rows, times) {
  const find = (name) => header.findIndex((h) => h.trim().toLowerCase().startsWith(name));
  const iEmail = find("email address");
  const iName = find("name (english)");
  const iAction = find("action");
  const iConsent = find("consent");
  const iHidden = find("hidden");

  const latest = new Map();
  const hidden = new Set();
  rows.forEach((r, n) => {
    if (!r.some((c) => String(c).trim())) return;
    const key = (iEmail >= 0 && r[iEmail].trim().toLowerCase()) || r[iName].trim().toLowerCase();
    if (iHidden >= 0 && r[iHidden].trim()) hidden.add(key); // hiding any row hides the person
    const t = new Date(times[n]).getTime();
    if (!latest.has(key) || t >= latest.get(key).t) latest.set(key, { t, r });
  });

  const keep = header.map((h, i) => i).filter((i) => !PRIVATE_COLUMNS.includes(header[i].trim().toLowerCase()));
  const out = [keep.map((i) => header[i])];
  for (const [key, { r }] of latest) {
    if (hidden.has(key)) continue;
    if (iAction >= 0 && r[iAction].trim().toLowerCase().startsWith("remove")) continue;
    if (iConsent < 0 || !r[iConsent].trim()) continue;
    out.push(keep.map((i) => r[i]));
  }
  const cell = (v) => (/[",\n\r]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return out.map((row) => row.map(cell).join(",")).join("\n") + "\n";
}

if (typeof module !== "undefined") module.exports = { buildResponsesCsv };
