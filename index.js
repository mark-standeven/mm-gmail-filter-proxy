require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// --- Configuration from Environment Variables ---
const N8N_WEBHOOK_URL = process.env.FORWARD_WEBHOOK_URL;
const GMAIL_PENDING_LABEL_ID = process.env.AI_LABEL_ID || 'Label_680711244473690816'; // Fallback for your existing AI_LABEL_ID

const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;

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

// --- Main Webhook Handler ---
app.post('/', async (req, res) => {
  console.log('Pub/Sub notification received. Processing...');

  // Log the decoded Pub/Sub message for debugging
  if (req.body.message && req.body.message.data) {
    try {
      const decoded = Buffer.from(req.body.message.data, 'base64').toString();
      console.log('Decoded Pub/Sub payload:', JSON.parse(decoded));
    } catch (e) {
      console.error('Error decoding Pub/Sub payload:', e);
      // Non-fatal for now, but good to know if decoding fails
    }
  }

  try {
    const accessToken = await getAccessToken();

    console.log(`Querying Gmail for messages with label: ${GMAIL_PENDING_LABEL_ID}`);
    const listMessagesResponse = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        q: `label:${GMAIL_PENDING_LABEL_ID}`,
        maxResults: 25, // Process up to 25 messages per trigger.
      },
    });

    const messages = listMessagesResponse.data.messages || [];

    if (messages.length === 0) {
      console.log(`No messages found with label ${GMAIL_PENDING_LABEL_ID}. Likely a 'label removed' event. Nothing to forward.`);
      return res.status(200).send('OK - No pending messages found.');
    }

    console.log(`Found ${messages.length} message(s) with label ${GMAIL_PENDING_LABEL_ID}. Preparing to forward to n8n...`);

    let successfulForwards = 0;
    let failedForwards = 0;

    for (const message of messages) {
      const messageId = message.id;
      try {
        const payloadToN8n = {
          messageId: messageId,
          gmailLabelId: GMAIL_PENDING_LABEL_ID, // So n8n knows which label to remove
          source: 'render-gmail-filter-proxy', // Identify the source
        };

        console.log(`Forwarding messageId ${messageId} to n8n: ${N8N_WEBHOOK_URL}`);
        await axios.post(N8N_WEBHOOK_URL, payloadToN8n, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000, // 15 second timeout for n8n call
        });
        console.log(`Successfully forwarded messageId ${messageId} to n8n.`);
        successfulForwards++;
      } catch (n8nError) {
        console.error(`Error forwarding messageId ${messageId} to n8n:`, n8nError.response?.data || n8nError.message);
        failedForwards++;
        // If forwarding to n8n fails, the label remains on the Gmail message.
        // It will likely be picked up again on the next trigger of this Render service.
      }
    }

    console.log(`Processing complete. Successful n8n forwards: ${successfulForwards}, Failed n8n forwards: ${failedForwards}.`);

    // If all attempts to forward messages failed, and there were messages to process,
    // it might indicate an issue with n8n. Return 503 to encourage Pub/Sub to retry.
    if (failedForwards > 0 && successfulForwards === 0 && messages.length > 0) {
      console.warn('All n8n forwards failed. Suggesting Pub/Sub retry.');
      return res.status(503).send('Service Unavailable - All n8n forwards failed.');
    }

    // Otherwise, acknowledge successful processing to Pub/Sub.
    res.status(200).send('OK - Processing complete.');

  } catch (error) {
    // This catches errors from getAccessToken() or the initial messages.list call
    console.error('Critical error in main processing logic:', error.response?.data || error.message);
    // Return 500 to Pub/Sub so it retries delivering this notification later.
    res.status(500).send('Internal Server Error - Failed to process Gmail notification.');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Gmail filter proxy (Node.js/Express) running on port ${PORT}`);
  console.log(`Watching for Gmail label ID: ${GMAIL_PENDING_LABEL_ID}`);
  console.log(`Forwarding new messages to n8n: ${N8N_WEBHOOK_URL}`);
});
