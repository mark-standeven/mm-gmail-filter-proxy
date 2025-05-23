const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const WEBHOOK_URL = process.env.FORWARD_WEBHOOK_URL;
const AI_LABEL_ID = 'Label_3240693713151181396'; // <-- your static Gmail label ID

if (!WEBHOOK_URL) {
  console.error('Missing FORWARD_WEBHOOK_URL');
  process.exit(1);
}

app.post('/', async (req, res) => {
  try {
    const pubsubMessage = req.body.message;

    if (!pubsubMessage || !pubsubMessage.data) {
      return res.status(400).send('Bad Request: Missing message');
    }

    const decoded = Buffer.from(pubsubMessage.data, 'base64').toString();
    const payload = JSON.parse(decoded);

    console.log('📩 Decoded Gmail payload:', payload);

    // Expecting labels to be present as an array of objects
    const labels = payload.labels || [];

    const hasInbox = labels.some(l => l.id === 'INBOX');
    const isUnread = labels.some(l => l.id === 'UNREAD');
    const hasAiProcess = labels.some(l => l.id === AI_LABEL_ID);

    if (!(hasInbox && isUnread && hasAiProcess)) {
      console.log('⏭️ Filtered out – Conditions not met');
      return res.status(200).send('Filtered');
    }

    const enrichedPayload = {
      ...payload,
      messageId: pubsubMessage.messageId || pubsubMessage.message_id,
      publishTime: pubsubMessage.publishTime || pubsubMessage.publish_time,
      subscription: req.body.subscription || null,
      raw: {
        base64Data: pubsubMessage.data,
        headers: req.headers,
      }
    };

    await axios.post(WEBHOOK_URL, enrichedPayload, {
      headers: { 'Content-Type': 'application/json' }
    });

    console.log('✅ Forwarded filtered payload to n8n');
    res.status(200).send('Forwarded');
  } catch (err) {
    console.error('❌ Error:', err.response?.data || err.message);
    res.status(500).send('Internal Server Error');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Gmail proxy listening on port ${PORT}`);
});
