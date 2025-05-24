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
let initInProgress = false;

// --- Queueing and Locking Mechanism State ---
let isProcessingQueue = false;
const notificationQueue = [];

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
    throw new Error('Failed to get Gmail access token');
  }
}

// --- Webhook Endpoint ---
app.post('/', async (req, res) => {
  const entryTimestamp = new Date().toISOString();
  console.log(`Webhook received at ${entryTimestamp}. Adding to queue.`);

  const pubsubMessage = req.body.message; // Keep the original pubsubMessage object
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
    
    // Add to queue. Pass original pubsubMessage too.
    notificationQueue.push({ res, pubsubMessage, currentNotificationPayload, currentNotificationHistoryId });
    console.log(`Notification (historyId: ${currentNotificationHistoryId}) added to queue. Queue size: ${notificationQueue.length}`);

  } catch (e) {
    console.error('Error decoding/queuing Pub/Sub payload:', e);
    return res.status(400).send('Bad Request: Could not decode/queue Pub/Sub data.');
  }

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

  isProcessingQueue = true;
  // Destructure original pubsubMessage from the queued item
  const { res, pubsubMessage, currentNotificationPayload, currentNotificationHistoryId } = notificationQueue.shift(); 
  
  console.log(`Queue Worker: Dequeued notification (historyId: ${currentNotificationHistoryId}). Processing... Queue size: ${notificationQueue.length}`);

  try {
    const accessToken = await getAccessToken();

    if (isInitialising || !lastProcessedHistoryId) {
      if (initInProgress) {
        if (!res.headersSent) res.status(202).send('Accepted: Initialization in progress elsewhere.');
        isProcessingQueue = false; 
        process.nextTick(processItemFromQueue); 
        return;
      }
      initInProgress = true;
      console.log('Queue Worker: Performing first-run initialization...');
      try {
        const profileResponse = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        lastProcessedHistoryId = profileResponse.data.historyId;
        isInitialising = false;
        console.log(`Queue Worker: Initialization complete. Baseline historyId: ${lastProcessedHistoryId}.`);
        if (!res.headersSent) res.status(200).send('OK - Initialized.');
      } catch (initError) {
        console.error('Queue Worker: Critical error during initialization:', initError.response?.data || initError.message);
        if (!res.headersSent) res.status(500).send('Internal Server Error - Initialization failed.');
      } finally {
        initInProgress = false;
      }
    } else { 
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
                const gmailMsgId = messageAddedEntry.message.id; // Gmail's message ID
                if (!gmailMsgId || processedMessageIdsInBatch.has(gmailMsgId)) continue;

                console.log(`Queue Worker: Found messageAdded event for gmailMessageId: ${gmailMsgId}. Verifying...`);
                try {
                  const msgDetailsResponse = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailMsgId}`, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                    params: { format: 'minimal' },
                  });
                  const messageLabelIds = msgDetailsResponse.data.labelIds || [];
                  if (messageLabelIds.includes('INBOX')) {
                    console.log(`Queue Worker: Message ${gmailMsgId} is in INBOX. Forwarding to n8n.`);
                    const payloadToN8n = {
                      gmailMessageId: gmailMsgId, // The ID of the actual Gmail message
                      source: 'render-gmail-history-filter',
                      triggeringPubSubHistoryId: currentNotificationHistoryId,
                      pubSubMessageDetails: { // Original Pub/Sub message details
                        messageId: pubsubMessage.messageId || null, // Pub/Sub system message ID
                        publishTime: pubsubMessage.publishTime || null,
                        // You could also include the original base64 data if needed for deep debugging
                        // data: pubsubMessage.data 
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
                processedMessageIdsInBatch.add(gmailMsgId);
              }
            }
          }
        } else { console.log('Queue Worker: No new history records found.'); }

        if (newMessagesForwardedThisRun > 0) {
          console.log(`Queue Worker: Forwarded ${newMessagesForwardedThisRun} new INBOX messages.`);
        } else { console.log('Queue Worker: No new INBOX messages met criteria in this batch.'); }
        
        lastProcessedHistoryId = currentNotificationHistoryId;
        console.log(`Queue Worker: Updated lastProcessedHistoryId to: ${lastProcessedHistoryId}`);
        if (!res.headersSent) res.status(200).send('OK - Processing complete.');
      }
    }
  } catch (error) {
    console.error(`Queue Worker: Critical error processing historyId ${currentNotificationHistoryId}:`, error.response?.data || error.message);
    if (!res.headersSent) {
        res.status(500).send(`Internal Server Error - Failed processing historyId ${currentNotificationHistoryId}.`);
    }
  } finally {
    isProcessingQueue = false;
    console.log(`Queue Worker: Processing finished for historyId ${currentNotificationHistoryId}. Lock released.`);
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
