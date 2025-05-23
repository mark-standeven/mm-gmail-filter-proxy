require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const WEBHOOK_URL = process.env.FORWARD_WEBHOOK_URL;
const AI_LABEL_ID = 'Label_3240693713151181396'; // ai-process label ID

async function getAccessToken() {
  const response = await axios.post('https://oauth2.googleapis.com/token', {
    client_id: process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET,
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });
  return response.data.access_token;
}

app.post('/', async (req, res) => {
  try {
    const pubsubMessage = req.body.message;

    if (!pubsubMessage || !pubsubMessage.data) {
      return res.status(400).send('Bad Request: Missing message');
    }

    const decoded = Buffer.from(pubsubMessage.data, 'base64').toString();
    const payload = JSON.parse(decoded);
    const { emailAddress, historyId } = payload;

    if (!emailAddress || !historyId) {
      console.log('Missing emailAddress or historyId');
      return res.status(400).send('Bad Request: Missing fields');
    }

    const accessToken = await getAccessToken();
    const adjustedHistoryId = parseInt(historyId) - 3;

    const historyRes = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/history', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      params: {
        startHistoryId: adjustedHistoryId,
        historyTypes: ['messageAdded,labelAdded']
      }
    });

    console.log('📜 Raw Gmail history response:', JSON.stringify(historyRes.data, null, 2));

    const history = historyRes.data.history || [];
    const messageIds = [...new Set(history.flatMap(h => h.messages?.map(m => m.id) || []))];

    for (const id of messageIds) {
      const msgRes = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        params: {
          format: 'metadata'
        }
      });

      const labelIds = msgRes.data.labelIds || [];

      const hasInbox = labelIds.includes('INBOX');
      const isUnread = labelIds.includes('UNREAD');
      const hasAiProcess = labelIds.includes(AI_LABEL_ID);

      console.log(`🔍 Message ${id} – inbox: ${hasInbox}, unread: ${isUnread}, ai-process: ${hasAiProcess}`);

      if (hasInbox && isUnread && hasAiProcess) {
        const enrichedPayload = {
          emailAddress,
          historyId,
          messageId: pubsubMessage.messageId || pubsubMessage.message_id,
          publishTime: pubsubMessage.publishTime || pubsubMessage.publish_time,
          subscription: req.body.subscription || null,
          raw: {
            base64Data: pubsubMessage.data,
            headers: req.headers
          }
        };

        await axios.post(WEBHOOK_URL, enrichedPayload, {
          headers: { 'Content-Type': 'application/json' }
        });

        console.log('✅ Forwarded matching message to n8n:', id);
        break;
      } else {
        console.log(`⏭️ Skipped message ${id} – inbox: ${hasInbox}, unread: ${isUnread}, ai-process: ${hasAiProcess}`);
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Error processing Gmail push:', err.response?.data || err.message);
    res.status(500).send('Internal Server Error');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Gmail filter proxy running on port ${PORT}`);
});
