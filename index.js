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
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;

// --- State Management (In-Memory) ---
let lastProcessedHistoryId = null;
let isInitialising = true;
let initInProgress = false; // Lock for the initialization phase specifically

// --- Queueing and Locking Mechanism State ---
let isProcessingQueue = false; // Main lock for processing the queue
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
    throw new Error('Failed to get Gmail access token'); // So the caller can handle it
  }
}

// --- Webhook Endpoint ---
app.post('/', async (req, res) => {
  const entryTimestamp = new Date().toISOString();
  console.log(`Webhook received at ${entryTimestamp}. Adding to queue.`);

  const pubsubMessage = req.body.message;
  if (!pubsubMessage || !pubsubMessage.data) {
    console.warn('Warning: Pub/Sub message format invalid or no data received.');
    return res.status(400).send('Bad Request: Invalid Pub/Sub message.');
  }

  try {
    const decoded = Buffer.from(pubsubMessage.data, 'base64').toString();
    const currentNotificationPayload = JSON.parse(decoded);
    const currentNotificationHistoryId = currentNotificationPayload.historyId;

    if (!currentNotificationHistoryId) {
      console.error('Error: No historyId found in Pub/Sub payload.');
      return res.status(400).send('Bad Request: Missing historyId.');
    }
    
    // Add to queue. We pass the `res` object so the processing function can respond.
    notificationQueue.push({ res, currentNotificationPayload, currentNotificationHistoryId });
    console.log(`Notification (historyId: ${currentNotificationHistoryId}) added to queue. Queue size: ${notificationQueue.length}`);

    // Acknowledge receipt to Pub/Sub quickly if we're not immediately processing.
    // The actual success/failure response for the processing will be sent later by processItemFromQueue.
    // However, Pub/Sub expects a timely response. If processItemFromQueue sends the response, 
    // this immediate `res.status(202).send()` might not be needed or could conflict.
    // For simplicity now, let processItemFromQueue handle the response. If timeouts occur,
    // we can send an immediate 202 here and process truly async.

  } catch (e) {
    console.error('Error decoding/queuing Pub/Sub payload:', e);
    return res.status(400).send('Bad Request: Could not decode/queue Pub/Sub data.');
  }

  // Try to process the queue. Don't await it here, as app.post should return quickly.
  // The actual response to Pub/Sub will be sent by processItemFromQueue.
  processItemFromQueue(); 
});

// --- Queue Processing Logic ---
async function processItemFromQueue() {
  if (isProcessingQueue) {
    console.log('Queue Worker: Processing already in progress. Will wait for next tick.');
    return;
  }
  if (notificationQueue.length === 0) {
    console.log('Queue Worker: Queue is empty.');
    return;
  }

  isProcessingQueue = true; // Acquire lock
  const { res, currentNotificationPayload, currentNotificationHistoryId } = notificationQueue.shift(); // Get the oldest item
  
  console.log(`Queue Worker: Dequeued notification (historyId: ${currentNotificationHistoryId}). Processing... Queue size: ${notificationQueue.length}`);

  try {
    const accessToken = await getAccessToken();

    // Initialization Logic
    if (isInitialising || !lastProcessedHistoryId) {
      if (initInProgress) {
        console.log('Queue Worker: Initialization already in progress by another call. Re-queuing this item for safety.');
        // Re-add to front of queue if needed, or just let Pub/Sub retry this particular message later if it times out.
        // For now, we'll just respond to this specific Pub/Sub message and let the init complete.
        // The lock `isProcessingQueue` should prevent this re-entrancy on init if structured correctly.
        // Let's assume `initInProgress` helps manage the actual API call for init.
        if (!res.headersSent) res.status(202).send('Accepted: Initialization in progress elsewhere.');
        isProcessingQueue = false; // Release lock before returning
        process.nextTick(processItemFromQueue); // Check queue again
        return;
      }
      initInProgress = true;
      console.log('Queue Worker: Performing first-run initialization to get current mailbox historyId...');
      try {
        const profileResponse = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        lastProcessedHistoryId = profileResponse.data.historyId;
        isInitialising = false; // Mark as initialized
        console.log(`Queue Worker: Initialization complete. Baseline historyId: ${lastProcessedHistoryId}.`);
        if (!res.headersSent) res.status(200).send('OK - Initialized.');
      } catch (initError) {
        console.error('Queue Worker: Critical error during initialization:', initError.response?.data || initError.message);
        if (!res.headersSent) res.status(500).send('Internal Server Error - Initialization failed.');
      } finally {
        initInProgress = false;
      }
    } else { // Normal Processing Logic
      console.log(`Queue Worker: Current notification historyId: ${currentNotificationHistoryId}, Last processed: ${lastProcessedHistoryId}`);
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
        const processedMessageIdsInBatch = new Set();

        if (historyRecords.length > 0) {
          console.log(`Queue Worker: Found ${historyRecords.length} history records.`);
          for (const record of historyRecords) {
            if (record.messagesAdded) {
              for (const messageAddedEntry of record.messagesAdded) {
                const messageId = messageAddedEntry.message.id;
                if (!messageId || processedMessageIdsInBatch.has(messageId)) continue;

                console.log(`Queue Worker: Found messageAdded event for messageId: ${messageId}. Verifying...`);
                try {
                  const msgDetailsResponse = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                    params: { format: 'minimal' },
                  });
                  const messageLabelIds = msgDetailsResponse.data.labelIds || [];
                  if (messageLabelIds.includes('INBOX')) {
                    console.log(`Queue Worker: Message ${messageId} is in INBOX. Forwarding to n8n.`);
                    const payloadToN8n = { messageId: messageId, source: 'render-gmail-history-filter' };
                    await axios.post(N8N_WEBHOOK_URL, payloadToN8n, {
                      headers: { 'Content-Type': 'application/json' },
                      timeout: 15000,
                    });
                    console.log(`Queue Worker: Successfully forwarded messageId ${messageId} to n8n.`);
                    newMessagesForwardedThisRun++;
                  } else {
                    console.log(`Queue Worker: Message ${messageId} added but not in INBOX. Skipping.`);
                  }
                } catch (msgError) {
                  console.error(`Queue Worker: Error fetching/forwarding messageId ${messageId}:`, msgError.response?.data || msgError.message);
                }
                processedMessageIdsInBatch.add(messageId);
              }
            }
          }
        } else { console.log('Queue Worker: No new history records found.'); }

        if (newMessagesForwardedThisRun > 0) {
          console.log(`Queue Worker: Forwarded ${newMessagesForwardedThisRun} new INBOX messages.`);
        } else { console.log('Queue Worker: No new INBOX messages met criteria in this batch.'); }
        
        lastProcessedHistoryId = currentNotificationHistoryId; // Update state
        console.log(`Queue Worker: Updated lastProcessedHistoryId to: ${lastProcessedHistoryId}`);
        if (!res.headersSent) res.status(200).send('OK - Processing complete.');
      }
    }
  } catch (error) { // Catches errors from getAccessToken or other unhandled issues within the try block
    console.error(`Queue Worker: Critical error processing historyId ${currentNotificationHistoryId}:`, error.response?.data || error.message);
    if (!res.headersSent) {
        res.status(500).send(`Internal Server Error - Failed processing historyId ${currentNotificationHistoryId}.`);
    }
  } finally {
    isProcessingQueue = false; // Release lock
    console.log(`Queue Worker: Processing finished for historyId ${currentNotificationHistoryId}. Lock released.`);
    // Attempt to process next item in queue asynchronously
    process.nextTick(processItemFromQueue);
  }
}

// --- Server Start ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Gmail history filter (Node.js/Express) with queue running on port ${PORT}`);
  console.log(`State: isInitialising=${isInitialising}, lastProcessedHistoryId=${lastProcessedHistoryId}`);
  console.log(`Forwarding new messages to n8n: ${N8N_WEBHOOK_URL}`);
});
