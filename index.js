require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// --- Configuration from Environment Variables ---
const N8N_WEBHOOK_URL = process.env.FORWARD_WEBHOOK_URL; // Your n8n webhook URL
const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;

// --- State Management (In-Memory) ---
let lastProcessedHistoryId = null;
let isInitialising = true; // Flag to handle first run
let initInProgress = false; // Lock to prevent concurrent initializations

// --- Gmail Access Token Function (remains the same) ---
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

// --- Main Webhook Handler ---
app.post('/', async (req, res) => {
  console.log('Pub/Sub notification received.');

  const pubsubMessage = req.body.message;
  if (!pubsubMessage || !pubsubMessage.data) {
    console.warn('Warning: Pub/Sub message format invalid or no data.');
    return res.status(400).send('Bad Request: Invalid Pub/Sub message.');
  }

  let currentNotificationPayload;
  try {
    const decoded = Buffer.from(pubsubMessage.data, 'base64').toString();
    currentNotificationPayload = JSON.parse(decoded);
    console.log('Decoded Pub/Sub payload:', currentNotificationPayload);
  } catch (e) {
    console.error('Error decoding Pub/Sub payload:', e);
    return res.status(400).send('Bad Request: Could not decode Pub/Sub data.');
  }

  const currentNotificationHistoryId = currentNotificationPayload.historyId;
  if (!currentNotificationHistoryId) {
    console.error('Error: No historyId found in Pub/Sub payload.');
    return res.status(400).send('Bad Request: Missing historyId.');
  }

  try {
    const accessToken = await getAccessToken();

    // Initialization on first valid run or if lastProcessedHistoryId is somehow lost
    if (isInitialising || !lastProcessedHistoryId) {
      if (initInProgress) {
        console.log('Initialization already in progress, waiting for it to complete.');
        return res.status(202).send('Accepted: Initialization in progress.');
      }
      initInProgress = true;
      console.log('Performing first-run initialization to get current mailbox historyId...');
      try {
        const profileResponse = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        lastProcessedHistoryId = profileResponse.data.historyId;
        isInitialising = false;
        initInProgress = false;
        console.log(`Initialization complete. Mailbox baseline historyId set to: ${lastProcessedHistoryId}. Subsequent notifications will process changes from this point.`);
        return res.status(200).send('OK - Initialized.');
      } catch (initError) {
        initInProgress = false;
        console.error('Critical error during initialization getting profile historyId:', initError.response?.data || initError.message);
        return res.status(500).send('Internal Server Error - Initialization failed.');
      }
    }

    // Normal Processing
    console.log(`Current notification historyId: ${currentNotificationHistoryId}, Last processed historyId: ${lastProcessedHistoryId}`);
    if (parseInt(currentNotificationHistoryId) <= parseInt(lastProcessedHistoryId)) {
      console.log('Notification historyId is not newer than last processed. Likely an old or duplicate event. Skipping.');
      return res.status(200).send('OK - Old or duplicate event.');
    }

    console.log(`Fetching history from startHistoryId: ${lastProcessedHistoryId}`);
    const historyResponse = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/history', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        startHistoryId: lastProcessedHistoryId,
        historyTypes: ['messageAdded'], // Only interested in new messages being added
      },
    });

    const historyRecords = historyResponse.data.history || [];
    let newMessagesFound = 0;
    const processedMessageIds = new Set(); 

    if (historyRecords.length > 0) {
      console.log(`Found ${historyRecords.length} history records.`);
      for (const record of historyRecords) {
        if (record.messagesAdded) {
          for (const messageAddedEntry of record.messagesAdded) {
            const messageId = messageAddedEntry.message.id;
            if (!messageId || processedMessageIds.has(messageId)) {
              continue; 
            }

            console.log(`Found messageAdded event for messageId: ${messageId}. Verifying details...`);
            try {
              const msgDetailsResponse = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`, {
                headers: { Authorization: `Bearer ${accessToken}` },
                params: { format: 'minimal' }, 
              });

              const messageLabelIds = msgDetailsResponse.data.labelIds || [];
              if (messageLabelIds.includes('INBOX')) { 
                console.log(`Message ${messageId} is in INBOX. Forwarding to n8n.`);
                const payloadToN8n = {
                  messageId: messageId,
                  source: 'render-gmail-history-filter',
                };
                await axios.post(N8N_WEBHOOK_URL, payloadToN8n, {
                  headers: { 'Content-Type': 'application/json' },
                  timeout: 15000,
                });
                console.log(`Successfully forwarded messageId ${messageId} to n8n.`);
                newMessagesFound++;
              } else {
                console.log(`Message ${messageId} was added but is not in INBOX. Skipping.`);
              }
            } catch (msgError) {
              console.error(`Error fetching or forwarding messageId ${messageId}:`, msgError.response?.data || msgError.message);
            }
            processedMessageIds.add(messageId);
          }
        }
      }
    } else {
      console.log('No new history records found since last processed historyId.');
    }

    if (newMessagesFound > 0) {
      console.log(`Successfully forwarded ${newMessagesFound} new INBOX messages to n8n.`);
    } else {
      console.log('No new INBOX messages met criteria for forwarding in this batch.');
    }

    lastProcessedHistoryId = currentNotificationHistoryId;
    console.log(`Updated lastProcessedHistoryId to: ${lastProcessedHistoryId}`);
    res.status(200).send('OK - Processing complete.');

  } catch (error) {
    console.error('Critical error in main processing logic:', error.response?.data || error.message);
    res.status(500).send('Internal Server Error - Failed to process Gmail notification.');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Gmail history filter (Node.js/Express) running on port ${PORT}`);
  console.log(`Initialising... Will set baseline historyId on first Pub/Sub trigger.`);
});
