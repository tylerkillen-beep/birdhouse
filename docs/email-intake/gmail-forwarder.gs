/**
 * Birdhouse order-email forwarder (Google Apps Script).
 *
 * Runs inside the Gmail inbox that Amazon and Walmart order emails are forwarded
 * to. Every few minutes it finds threads carrying the label "Birdhouse Orders",
 * posts each message to the ingest-order-email function, and takes the label off
 * once the function has taken it. A new email in the same thread gets the label
 * back from the Gmail filter, so nothing is missed. Setup: docs/email-intake.md.
 *
 * The one secret (INTAKE_SECRET) lives in Script Properties, not in this file.
 */

const ENDPOINT = 'https://ljukrhneikqbabcmcpet.supabase.co/functions/v1/ingest-order-email';
const LABEL_NAME = 'Birdhouse Orders';
const MAX_THREADS_PER_RUN = 20;

/** Run once by hand: creates the label and schedules the check every 10 minutes. */
function install() {
  if (!GmailApp.getUserLabelByName(LABEL_NAME)) GmailApp.createLabel(LABEL_NAME);
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'sendOrderEmails'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sendOrderEmails').timeBased().everyMinutes(10).create();
}

function sendOrderEmails() {
  const secret = PropertiesService.getScriptProperties().getProperty('INTAKE_SECRET');
  if (!secret) throw new Error('Add INTAKE_SECRET under Project Settings > Script Properties.');

  const label = GmailApp.getUserLabelByName(LABEL_NAME);
  if (!label) return;

  label.getThreads(0, MAX_THREADS_PER_RUN).forEach(function (thread) {
    let allTaken = true;

    thread.getMessages().forEach(function (message) {
      const plain = message.getPlainBody() || '';
      const response = UrlFetchApp.fetch(ENDPOINT, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-intake-secret': secret },
        muteHttpExceptions: true,
        payload: JSON.stringify({
          // The Message-ID header is the same every time this message is seen;
          // the function ignores one it has already read.
          message_id: message.getHeader('Message-ID') || message.getId(),
          subject: message.getSubject(),
          from: message.getFrom(),
          date: message.getDate().toISOString(),
          text: plain,
          // The HTML is only needed when the plain version came out empty.
          html: plain.length < 200 ? message.getBody() : '',
        }),
      });
      if (response.getResponseCode() !== 200) {
        allTaken = false;
        console.error('Not taken (' + response.getResponseCode() + '): ' + response.getContentText().slice(0, 300));
      }
    });

    // Leave the label on if anything failed, so the next run tries again.
    if (allTaken) thread.removeLabel(label);
  });
}
