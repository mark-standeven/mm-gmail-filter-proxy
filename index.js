const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const WEBHOOK_URL = process.env.FORWARD_WEBHOOK_URL;

if (!WEBHOOK_URL) {
  console.error('Missing FORWARD_WEBHOOK_URL');
  process.exit(1);
}

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

    // Filter for presence of emailAddress and historyId only
    if (payload.emailAddress && payload.historyId) {
      await axios.post(WEBHOOK_URL, payload);
      console.log('Forwarded to webhook');
    } else {
      console.log('Filtered out – Conditions not met');
    }

    return res.status(200).send('Processed');
  } catch (err) {
    console.error('Error processing Gmail push:', err);
    return res.status(500).send('Internal Server Error');
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Gmail filter proxy listening on port ${port}`);
});
