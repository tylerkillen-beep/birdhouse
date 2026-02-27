// ============================================================
// THE BIRDHOUSE — Google Apps Script
// Paste this entire file into your Google Apps Script editor
// Deploy as a Web App (see setup instructions below)
// ============================================================

// SETUP INSTRUCTIONS:
// 1. Open your Google Sheet
// 2. Click Extensions → Apps Script
// 3. Delete any existing code and paste this entire file
// 4. Click Save (floppy disk icon)
// 5. Click Deploy → New Deployment
// 6. Type: Web App
// 7. Execute as: Me
// 8. Who has access: Anyone
// 9. Click Deploy → Copy the Web App URL
// 10. Paste that URL into the Admin Panel on your website

// ============================================================
// CONFIGURATION — edit these to match your sheet tab names
// ============================================================
const SHEET_NAMES = {
  ORDERS:    'Orders',       // All incoming subscription signups
  DELIVERY:  'Delivery Run', // Daily delivery checklist view
  MENU:      'Menu',         // Drink menu reference
};

// Columns for the Orders sheet (in order)
const ORDER_COLUMNS = [
  'Timestamp',
  'Status',        // Active / Paused / Cancelled
  'Tier',
  'First Name',
  'Last Name',
  'Email',
  'Phone',
  'Room / Location',
  'Grade / Year',
  'Delivery Days',
  'Delivery Times',
  'Drinks',
  'Notes',
  'Payment Status', // Pending / Paid
];

// ============================================================
// MAIN — handles POST requests from the website
// ============================================================
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    ensureSheetsExist(ss);

    const ordersSheet = ss.getSheetByName(SHEET_NAMES.ORDERS);

    // Build row
    const row = [
      new Date(data.timestamp || Date.now()),
      'Active',
      formatTierName(data.tier),
      data.firstName || '',
      data.lastName  || '',
      data.email     || '',
      data.phone     || '',
      data.roomNumber || '',
      data.gradeYear || '',
      data.deliveryDays  || '',
      data.deliveryTimes || '',
      data.drinks    || '',
      data.notes     || '',
      'Pending',
    ];

    ordersSheet.appendRow(row);
    formatLastRow(ordersSheet, data.tier);
    refreshDeliverySheet(ss);
    sendConfirmationEmail(data);

    return ContentService
      .createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    console.error('doPost error:', err);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Also allow GET for testing the deployment
function doGet(e) {
  return ContentService
    .createTextOutput('✅ The Birdhouse script is live!')
    .setMimeType(ContentService.MimeType.TEXT);
}

// ============================================================
// SHEET SETUP — creates tabs and headers if they don't exist
// ============================================================
function ensureSheetsExist(ss) {
  // Orders sheet
  let orders = ss.getSheetByName(SHEET_NAMES.ORDERS);
  if (!orders) {
    orders = ss.insertSheet(SHEET_NAMES.ORDERS);
    const header = orders.getRange(1, 1, 1, ORDER_COLUMNS.length);
    header.setValues([ORDER_COLUMNS]);
    header.setBackground('#c0202a');
    header.setFontColor('#ffffff');
    header.setFontWeight('bold');
    orders.setFrozenRows(1);
    orders.setColumnWidth(1, 160);  // Timestamp
    orders.setColumnWidth(3, 120);  // Tier
    orders.setColumnWidth(12, 280); // Drinks
    orders.setColumnWidth(13, 200); // Notes
  }

  // Delivery Run sheet
  let delivery = ss.getSheetByName(SHEET_NAMES.DELIVERY);
  if (!delivery) {
    delivery = ss.insertSheet(SHEET_NAMES.DELIVERY);
    const deliveryCols = ['✓ Delivered', 'Name', 'Room', 'Tier', 'Drinks', 'Delivery Time', 'Notes'];
    const header = delivery.getRange(1, 1, 1, deliveryCols.length);
    header.setValues([deliveryCols]);
    header.setBackground('#1a1a1a');
    header.setFontColor('#ffffff');
    header.setFontWeight('bold');
    delivery.setFrozenRows(1);
  }
}

// ============================================================
// DELIVERY RUN SHEET — rebuilt fresh from active orders
// ============================================================
function refreshDeliverySheet(ss) {
  const orders  = ss.getSheetByName(SHEET_NAMES.ORDERS);
  const delivery = ss.getSheetByName(SHEET_NAMES.DELIVERY);
  if (!orders || !delivery) return;

  const data = orders.getDataRange().getValues();
  if (data.length < 2) return;

  // Clear existing delivery data (keep header)
  const lastRow = delivery.getLastRow();
  if (lastRow > 1) delivery.getRange(2, 1, lastRow - 1, 7).clearContent();

  const headers = data[0];
  const statusIdx = headers.indexOf('Status');
  const firstIdx  = headers.indexOf('First Name');
  const lastIdx   = headers.indexOf('Last Name');
  const roomIdx   = headers.indexOf('Room / Location');
  const tierIdx   = headers.indexOf('Tier');
  const drinksIdx = headers.indexOf('Drinks');
  const timesIdx  = headers.indexOf('Delivery Times');
  const notesIdx  = headers.indexOf('Notes');

  const activeRows = data.slice(1).filter(row => row[statusIdx] === 'Active');

  activeRows.forEach((row, i) => {
    delivery.getRange(i + 2, 1, 1, 7).setValues([[
      '☐',
      `${row[firstIdx]} ${row[lastIdx]}`,
      row[roomIdx],
      row[tierIdx],
      row[drinksIdx],
      row[timesIdx],
      row[notesIdx],
    ]]);
  });

  // Style checkbox column
  if (activeRows.length > 0) {
    delivery.getRange(2, 1, activeRows.length, 1)
      .setHorizontalAlignment('center')
      .setFontSize(14);
  }
}

// ============================================================
// ROW FORMATTING — color-code by tier
// ============================================================
function formatLastRow(sheet, tier) {
  const lastRow = sheet.getLastRow();
  const range = sheet.getRange(lastRow, 1, 1, ORDER_COLUMNS.length);
  
  const tierColors = {
    'perch':       '#fff5f5',
    'nest':        '#ffe8e8',
    'eagles-nest': '#ffd0d0',
  };

  const bg = tierColors[tier] || '#ffffff';
  range.setBackground(bg);
  
  // Alternate lighter for readability
  if (lastRow % 2 === 0) {
    range.setBackground(shadeColor(bg, -5));
  }
}

function shadeColor(hex, percent) {
  const num = parseInt(hex.replace('#',''), 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + percent));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0xff) + percent));
  const b = Math.min(255, Math.max(0, (num & 0xff) + percent));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

// ============================================================
// CONFIRMATION EMAIL — sent to customer on signup
// ============================================================
function sendConfirmationEmail(data) {
  if (!data.email) return;

  const tierName = formatTierName(data.tier);
  const subject  = `🦅 Welcome to The Birdhouse — ${tierName} Subscription`;

  const body = `
Hi ${data.firstName},

Thanks for signing up for The Birdhouse coffee delivery!

Here's a summary of your order:

  Subscription Tier:  ${tierName}
  Delivery Location:  ${data.roomNumber}
  Delivery Days:      ${data.deliveryDays}
  Delivery Times:     ${data.deliveryTimes}
  Drinks:             ${data.drinks}
  ${data.notes ? `Notes: ${data.notes}` : ''}

Your subscription will become active once your payment is confirmed through Square.

If you have any questions or need to make changes, reply to this email or stop by The Birdhouse.

Go Eagles! 🦅
— The Birdhouse Team
Nixa High School
  `.trim();

  try {
    MailApp.sendEmail({
      to:      data.email,
      subject: subject,
      body:    body,
    });
  } catch (err) {
    console.warn('Email send failed:', err);
  }
}

// ============================================================
// UTILITY
// ============================================================
function formatTierName(tier) {
  const names = {
    'perch':       'Perch',
    'nest':        'Nest',
    'eagles-nest': "Eagle's Nest",
  };
  return names[tier] || tier || 'Unknown';
}

// ============================================================
// MANUAL TRIGGERS — run these from the Apps Script editor
// ============================================================

// Run this once after deploying to set up the sheet structure
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheetsExist(ss);
  SpreadsheetApp.getUi().alert('✅ Sheets created! Check your spreadsheet tabs.');
}

// Manually refresh the delivery run sheet
function manualRefreshDelivery() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  refreshDeliverySheet(ss);
  SpreadsheetApp.getUi().alert('✅ Delivery Run sheet refreshed!');
}

// Mark all delivery checkboxes as undelivered (run at start of each day)
function resetDeliveryChecklist() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.DELIVERY);
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const range = sheet.getRange(2, 1, lastRow - 1, 1);
    range.setValue('☐');
  }
  SpreadsheetApp.getUi().alert('✅ Delivery checklist reset for today!');
}
