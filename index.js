const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

require('dotenv').config();

const app = express();
app.use(bodyParser.json());

app.post('/', async (req, res) => {
  try {
    const pubsubMessage = req.body.message;

    if (!pubsubMessage || !pubsubMessage.data) {
      console.log('No data in message');
      return res.status(400).send('Bad Request');
    }

    const decoded = Buffer.from(pubsubMessage.data, 'base64').toString();
    const payload = JSON.parse(decoded);

    console.log('Decoded Gmail payload:', payload);

    const { emailAddress, historyId, labels = [], inbox = false, unread = false } = payload;

    // Filtering logic
    const hasLabel = labels.includes('Label_ai-process');
    if (!(inbox && unread && hasLabel)) {
      console.log('Filtered out – Conditions not met');
      return res.status(200).send('Filtered');
    }

    // Forward to n8n
    const forwardUrl = process.env.FORWARD_WEBHOOK_URL;
    if (!forwardUrl) {
      console.error('Missing FORWARD_WEBHOOK_URL');
      return res.status(500).send('Misconfigured');
    }

    const enrichedPayload = {
      ...payload,
      raw: {
        base64Data: pubsubMessage.data,
        headers: req.headers,
      },
    };

    await axios.post(forwardUrl, enrichedPayload);
    console.log('Forwarded payload to n8n');

    return res.status(200).send('Forwarded');
  } catch (err) {
    console.error('Error processing Gmail push:', err);
    return res.status(500).send('Internal Server Error');
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Gmail filter proxy listening on port ${port}`);
});
