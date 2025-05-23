require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const GMAIL_TOKEN = process.env.GMAIL_ACCESS_TOKEN;
const WEBHOOK_URL = process.env.FORWARD_WEBHOOK_URL;

let aiLabelId = null;

// Fetch user's labels and resolve the labelId for 'ai-process'
async function resolveLabelId() {
  try {
    const res = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
      headers: {
        Authorization: `Bearer ${GMAIL_TOKEN}`
      }
    });
    const label = res.data.labels.find(l => l.name.toLowerCase() === 'ai-process');
    if (label) {
      aiLabelId = label.id;
      console.log('✅ Resolved label ID:', aiLabelId);
    } else {
      console.warn('⚠️ ai-process label not found');
    }
  } catch (err) {
    console.error('Error fetching labels:', err.response?.data || err.message);
  }
}

// Handle Gmail Pub/Sub push
app.post('/', async (req, res) => {
  try {
    const pubsubMessage = req.body.message;

    if (!pubsubMessage || !pubsubMessage.data) {
      return res.status(400).send('Bad Request: Missing message');
    }

    const data = JSON.parse(Buffer.from(pubsubMessage.data, 'base64').toString());
    const { emailAddress, historyId } = data;

    console.log('📩 Incoming Gmail push for historyId:', historyId);

    const adjustedHistoryId = parseInt(historyId) - 1;

    // Query history for message changes
    const historyRes = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/history', {
      headers: {
        Authorization: `Bearer ${GMAIL_TOKEN}`
      },
      params: {
        startHistoryId: adjustedHistoryId,
        historyTypes: 'messageAdded'
      }
    });

    const history = historyRes.data.history || [];
    const messageIds = [...new Set(history.flatMap(h => h.messages?.map(m => m.id) || []))];

    console.log(`🔍 Checking ${messageIds.length} message(s) for label match...`);

    for (const id of messageIds) {
      const msgRes = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`, {
        headers: {
          Authorization: `Bearer ${GMAIL_TOKEN}`
        },
        params: {
          format: 'metadata'
        }
      });

      const labelIds = msgRes.data.labelIds || [];

      const hasInbox = labelIds.includes('INBOX');
      const isUnread = labelIds.includes('UNREAD');
      const hasAiProcess = aiLabelId && labelIds.includes(aiLabelId);

      if (hasInbox && isUnread && hasAiProcess) {
        console.log(`✅ Match found for messageId: ${id} — forwarding to n8n`);

        const payload = {
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

        await axios.post(WEBHOOK_URL, payload, {
          headers: { 'Content-Type': 'application/json' }
        });

        break; // only forward the first match
      } else {
        console.log(`⏭️ Skipped message ${id} — inbox: ${hasInbox}, unread: ${isUnread}, ai-process: ${hasAiProcess}`);
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Error:', err.response?.data || err.message);
    res.status(500).send('Internal Server Error');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log(`🚀 Gmail filter proxy listening on port ${PORT}`);
  await resolveLabelId();
});
