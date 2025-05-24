require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// --- Configuration from Environment Variables ---
const N8N_WEBHOOK_URL = process.env.FORWARD_WEBHOOK_URL;
const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN; // This needs Gmail AND Sheets scopes

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SHEET_RANGE = process.env.GOOGLE_SHEET_RANGE || 'Sheet1!A1'; // Default if not set

// --- State Management ---
let lastProcessedHistoryId = null; 
let isInitialisedThisRun = false; // Tracks if we've successfully initialized in current process lifetime
let initInProgress = false; // Lock for the initialization phase (reading sheet / getting profile)

// --- Queueing and Locking Mechanism State ---
let isProcessingQueue = false; // Main lock for processing the queue items one by one
const notificationQueue = []; // Queue to hold incoming notifications

// --- Gmail Access Token Function ---
async function getAccessToken() {
  try {
    const response = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    });
    return response.data.access_token;
  } catch (error) {
    console.error('Error getting access token:', error.response?.data || error.message);
    throw new Error('Failed to get Gmail access token. Check scopes if Sheets/Gmail access fails.');
  }
}

// --- Google Sheets Helper Functions ---
async function readLastHistoryIdFromSheet(accessToken) {
  if (!GOOGLE_SHEET_ID) {
    console.warn('GOOGLE_SHEET_ID not set. Cannot read from sheet.');
    return null;
  }
  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${GOOGLE_SHEET_RANGE}`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.data.values && response.data.values[0] && response.data.values[0][0]) {
      const idFromSheet = response.data.values[0][0];
      console.log(`Successfully read lastProcessedHistoryId from Sheet: ${idFromSheet}`);
      return idFromSheet;
    }
    console.log('No historyId found in Google Sheet at specified range or sheet is empty.');
    return null;
  } catch (error) {
    console.error('Error reading from Google Sheet:', error.response?.data?.error?.message || error.message);
    if (error.response?.status === 403) {
        console.error('Sheets API permission denied (403). Ensure refresh token has "https://www.googleapis.com/auth/spreadsheets" scope.');
    }
    return null;
  }
}

async function writeLastHistoryIdToSheet(accessToken, historyId) {
  if (!GOOGLE_SHEET_ID) {
    console.warn('GOOGLE_SHEET_ID not set. Cannot write to sheet.');
    return false;
  }
  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${GOOGLE_SHEET_RANGE}?valueInputOption=USER_ENTERED`;
    await axios.put(url, 
      { values: [[historyId.toString()]] },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    console.log(`Successfully wrote historyId ${historyId} to Google Sheet.`);
    return true;
  } catch (error) {
    console.error('Error writing to Google Sheet:', error.response?.data?.error?.message || error.message);
     if (error.response?.status === 403) {
        console.error('Sheets API permission denied (403). Ensure refresh token has "https://www.googleapis.com/auth/spreadsheets" scope.');
    }
    return false;
  }
}

// --- Webhook Endpoint ---
app.post('/', async (req, res) => {
  const entryTimestamp = new Date().toISOString();
  console.log(`Webhook received at ${entryTimestamp}.`);

  const pubsubMessage = req.body.message;
  if (!pubsubMessage || !pubsubMessage.data) {
    console.warn('Request body or message.data is missing.');
    // Send immediate response to Pub/Sub to acknowledge, even if bad request
    return res.status(400).send('Bad Request: Invalid Pub/Sub message format.');
  }

  try {
    const decoded = Buffer.from(pubsubMessage.data, 'base64').toString();
    const currentNotificationPayload = JSON.parse(decoded);
    const currentNotificationHistoryId = currentNotificationPayload.historyId;

    if (!currentNotificationHistoryId) {
      console.error('No historyId found in Pub/Sub payload.');
      return res.status(400).send('Bad Request: Missing historyId in payload.');
    }
    
    // Add to queue. Pass original pubsubMessage, and res for responding.
    notificationQueue.push({ res, pubsubMessage, currentNotificationPayload, currentNotificationHistoryId });
    console.log(`Notification (historyId: ${currentNotificationHistoryId}) added to queue. Queue size: ${notificationQueue.length}`);
    
    // Acknowledge quickly to Pub/Sub if another process will handle the response.
    // If processItemFromQueue handles all responses, this might not be needed.
    // For now, let processItemFromQueue handle responses. If Pub/Sub times out, then send 202 here.
    // res.status(202).send('Accepted for processing.'); // Potentially send this if processing is long

  } catch (e) {
    console.error('Error decoding/queuing Pub/Sub payload:', e.message);
    return res.status(400).send('Bad Request: Could not decode or queue Pub/Sub data.');
  }

  // Non-blocking call to start processing the queue if not already active
  processItemFromQueue(); 
});

// --- Queue Processing Logic ---
async function processItemFromQueue() {
  if (isProcessingQueue) {
    console.log('Queue Worker: Processing is already in progress by this instance.');
    return;
  }
  if (notificationQueue.length === 0) {
    console.log('Queue Worker: Queue is empty.');
    return;
  }

  isProcessingQueue = true; // Acquire lock
  const { res, pubsubMessage, currentNotificationPayload, currentNotificationHistoryId } = notificationQueue.shift(); 
  
  console.log(`Queue Worker: Dequeued notification (historyId: ${currentNotificationHistoryId}). Processing...`);

  try {
    const accessToken = await getAccessToken();

    // Initialization Logic - now involves reading from Sheet
    if (!isInitialisedThisRun) { 
      if (initInProgress) { // Another part of this instance is already initializing
        console.log('Queue Worker: Initialization already in progress. Re-queueing.');
        notificationQueue.unshift({ res, pubsubMessage, currentNotificationPayload, currentNotificationHistoryId }); // Add back to front
        isProcessingQueue = false; 
        process.nextTick(processItemFromQueue); // Allow other ticks to proceed
        return;
      }
      initInProgress = true;
      console.log('Queue Worker: Attempting to initialize lastProcessedHistoryId (first run for this instance)...');
      try {
        let idFromSheet = await readLastHistoryIdFromSheet(accessToken);
        if (idFromSheet) {
          lastProcessedHistoryId = idFromSheet;
          console.log(`Queue Worker: Initialized from Google Sheet. lastProcessedHistoryId: ${lastProcessedHistoryId}`);
        } else {
          console.log('Queue Worker: No historyId in Sheet or failed to read. Fetching current profile historyId as baseline.');
          const profileResponse = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          lastProcessedHistoryId = profileResponse.data.historyId;
          console.log(`Queue Worker: Fetched baseline historyId: ${lastProcessedHistoryId}. Attempting to write to Sheet.`);
          await writeLastHistoryIdToSheet(accessToken, lastProcessedHistoryId);
        }
        isInitialisedThisRun = true; 
        console.log(`Queue Worker: Initialization complete. Current lastProcessedHistoryId: ${lastProcessedHistoryId}.`);
        if (!res.headersSent) res.status(200).send('OK - Initialized state.');
      } catch (initError) {
        console.error('Queue Worker: Critical error during initialization:', initError.message);
        if (!res.headersSent) res.status(500).send('Internal Server Error - Initialization failed.');
      } finally {
        initInProgress = false;
      }
    } else { // Normal Processing Logic (isInitialisedThisRun is true)
      console.log(`Queue Worker: Current historyId: ${currentNotificationHistoryId}, Last processed: ${lastProcessedHistoryId}`);
      if (!lastProcessedHistoryId) { // Should not happen if isInitialisedThisRun is true
          console.error("CRITICAL: lastProcessedHistoryId is null after initialization. Re-initializing.");
          isInitialisedThisRun = false; // Force re-init
          notificationQueue.unshift({ res, pubsubMessage, currentNotificationPayload, currentNotificationHistoryId }); // Re-queue
          isProcessingQueue = false; process.nextTick(processItemFromQueue); return;
      }

      if (parseInt(currentNotificationHistoryId) <= parseInt(lastProcessedHistoryId)) {
        console.log('Queue Worker: Notification historyId is not newer. Skipping.');
        if (!res.headersSent) res.status(200).send('OK - Old or duplicate event.');
      } else {
        console.log(`Queue Worker: Fetching history from startHistoryId: ${lastProcessedHistoryId}`);
        const historyResponse = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/history', {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { startHistoryId: lastProcessedHistoryId, historyTypes: ['messageAdded'] },
        });

        const historyRecords = historyResponse.data.history || [];
        let newMessagesForwardedThisRun = 0;
        const processedGmailMessageIdsInBatch = new Set();

        if (historyRecords.length > 0) {
          console.log(`Queue Worker: Found ${historyRecords.length} history records.`);
          for (const record of historyRecords) {
            if (record.messagesAdded) {
              for (const messageAddedEntry of record.messagesAdded) {
                const gmailMsgId = messageAddedEntry.message.id;
                if (!gmailMsgId || processedGmailMessageIdsInBatch.has(gmailMsgId)) continue;
                console.log(`Queue Worker: Found messageAdded event for gmailMessageId: ${gmailMsgId}. Verifying...`);
                try {
                  const msgDetailsResponse = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailMsgId}`,{
                    headers: { Authorization: `Bearer ${accessToken}` },
                    params: { format: 'minimal' },
                  });
                  const messageLabelIds = msgDetailsResponse.data.labelIds || [];
                  if (messageLabelIds.includes('INBOX')) {
                    console.log(`Queue Worker: Message ${gmailMsgId} is in INBOX. Forwarding to n8n.`);
                    const payloadToN8n = {
                      gmailMessageId: gmailMsgId, 
                      source: 'render-gmail-history-filter',
                      triggeringPubSubHistoryId: currentNotificationHistoryId,
                      pubSubMessageDetails: { 
                        messageId: pubsubMessage.messageId || null, 
                        publishTime: pubsubMessage.publishTime || null,
                      }
                    };
                    await axios.post(N8N_WEBHOOK_URL, payloadToN8n, {
                      headers: { 'Content-Type': 'application/json' },
                      timeout: 15000,
                    });
                    console.log(`Queue Worker: Successfully forwarded gmailMessageId ${gmailMsgId} to n8n.`);
                    newMessagesForwardedThisRun++;
                  } else {
                    console.log(`Queue Worker: Message ${gmailMsgId} added but not in INBOX. Skipping.`);
                  }
                } catch (msgError) {
                  console.error(`Queue Worker: Error fetching/forwarding gmailMessageId ${gmailMsgId}:`, msgError.response?.data || msgError.message);
                }
                processedGmailMessageIdsInBatch.add(gmailMsgId);
              }
            }
          }
        } else { console.log('Queue Worker: No new history records found for this window.'); }

        if (newMessagesForwardedThisRun > 0) {
          console.log(`Queue Worker: Forwarded ${newMessagesForwardedThisRun} new INBOX messages from this history window.`);
        } else { console.log('Queue Worker: No new INBOX messages met criteria in this history window.'); }
        
        const oldHistoryId = lastProcessedHistoryId;
        lastProcessedHistoryId = currentNotificationHistoryId; // Update in-memory state
        console.log(`Queue Worker: Updated in-memory lastProcessedHistoryId from ${oldHistoryId} to: ${lastProcessedHistoryId}`);
        await writeLastHistoryIdToSheet(accessToken, lastProcessedHistoryId); // Persist to Sheet
        if (!res.headersSent) res.status(200).send('OK - Processing complete.');
      }
    }
  } catch (error) { 
    console.error(`Queue Worker: Critical error processing (Pub/Sub historyId ${currentNotificationHistoryId}):`, error.message);
    if (error.response && error.response.data) console.error("Error data:", error.response.data);
    if (!res.headersSent) {
        res.status(500).send(`Internal Server Error - Failed processing historyId ${currentNotificationHistoryId}.`);
    }
  } finally {
    isProcessingQueue = false; 
    console.log(`Queue Worker: Processing finished for (Pub/Sub historyId ${currentNotificationHistoryId}). Lock released.`);
    process.nextTick(processItemFromQueue); // Schedule check for next item
  }
}

// --- Server Start ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log(`Gmail history filter (Node.js/Express) with queue running on port ${PORT}`);
  console.log(`Forwarding new messages to n8n: ${N8N_WEBHOOK_URL}`);
  
  if (!GOOGLE_SHEET_ID) {
    console.warn('STARTUP: GOOGLE_SHEET_ID environment variable not set. HistoryId will be in-memory only for this session.');
    isInitialisedThisRun = false; 
  } else {
    console.log('STARTUP: Attempting to load initial lastProcessedHistoryId from Google Sheet...');
    initInProgress = true; // Prevent queue processing during this startup read
    try {
      const accessToken = await getAccessToken(); 
      const idFromSheet = await readLastHistoryIdFromSheet(accessToken);
      if (idFromSheet) {
        lastProcessedHistoryId = idFromSheet;
        isInitialisedThisRun = true; 
        console.log(`STARTUP: Successfully loaded lastProcessedHistoryId from Sheet: ${lastProcessedHistoryId}`);
      } else {
        console.log('STARTUP: No historyId found in Sheet or sheet not configured. Will initialize on first Pub/Sub trigger.');
        isInitialisedThisRun = false; 
      }
    } catch (e) {
      console.error('STARTUP: Error loading historyId from Sheet:', e.message);
      isInitialisedThisRun = false; 
    } finally {
        initInProgress = false;
    }
  }
  console.log(`STARTUP: Initial state: isInitialisedThisRun=${isInitialisedThisRun}, lastProcessedHistoryId=${lastProcessedHistoryId}`);
});
