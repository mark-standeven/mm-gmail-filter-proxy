require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

app.post('/', async (req, res) => {
  try {
    const pubsubMessage = req.body.message;
    const rawHeaders = req.headers;

    if (!pubsubMessage || !pubsubMessage.data) {
      console.log('No data in message');
      return res.status(400).send('Bad Request');
    }

    const base64Data = pubsubMessage.data;
    const decoded = Buffer.from(base64Data, 'base64').toString();
    const payload = JSON.parse(decoded);

    const {
      emailAddress,
      historyId
    } = payload;

    const webhookUrl = process.env.FORWARD_WEBHOOK_URL;
    if (!webhookUrl) {
      console.error('Missing FORWARD_WEBHOOK_URL');
      return res.status(500).send('Missing webhook URL');
    }

    const bodyToSend = {
      emailAddress,
      historyId,
      messageId: pubsubMessage.messageId || pubsubMessage.message_id,
      publishTime: pubsubMessage.publishTime || pubsubMessage.publish_time,
      subscription: req.body.subscription || null,
      raw: {
        base64Data,
        headers: rawHeaders
      }
    };

    await axios.post(webhookUrl, bodyToSend);
    console.log('Forwarded to n8n:', bodyToSend);
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error processing Gmail push:', err);
    res.status(500).send('Internal Server Error');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Gmail filter proxy listening on port ${PORT}`);
});
